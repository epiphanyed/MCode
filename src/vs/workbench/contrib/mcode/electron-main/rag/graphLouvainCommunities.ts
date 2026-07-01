/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { CodeGraph, CodeGraphEdgeKind } from './codeGraphBuilder.js';

/** Max nodes before Louvain is skipped (latency guard for main process). */
export const LOUVAIN_MAX_NODES = 6000;

/** Default edge weights — `contains` is down-weighted so modules follow imports/calls. */
export const LOUVAIN_EDGE_WEIGHTS: Record<CodeGraphEdgeKind, number> = {
	imports: 2,
	calls: 1,
	inherits: 1.5,
	contains: 0.25,
};

export interface WeightedGraph {
	nodeIds: string[];
	neighbors: Map<string, Map<string, number>>;
	strength: Map<string, number>;
	totalEdgeWeight: number;
}

export interface LouvainResult {
	assignment: Map<string, number>;
	modularity: number;
}

/** Edge kinds used when collapsing to file-level Louvain (skip contains). */
const FILE_LEVEL_LOUVAIN_KINDS = new Set<CodeGraphEdgeKind>(['imports', 'calls', 'inherits']);

function fileLevelNodeId(filePath: string): string {
	return `${path.normalize(filePath)}::file`;
}

/** Aggregate cross-file edges for Louvain on file nodes (much smaller than symbol graph). */
export function buildFileLevelWeightedGraph(
	graph: CodeGraph,
	edgeWeights: Record<CodeGraphEdgeKind, number> = LOUVAIN_EDGE_WEIGHTS,
): WeightedGraph {
	const filePaths = new Set<string>();
	for (const node of Object.values(graph.nodes)) {
		filePaths.add(path.normalize(node.filePath));
	}
	const nodeIds = [...filePaths].map(fp => fileLevelNodeId(fp));
	const neighbors = new Map<string, Map<string, number>>();
	for (const id of nodeIds) {
		neighbors.set(id, new Map());
	}

	let totalEdgeWeight = 0;
	const seenPairs = new Set<string>();

	for (const edge of graph.edges) {
		if (!FILE_LEVEL_LOUVAIN_KINDS.has(edge.kind)) {
			continue;
		}
		const fromNode = graph.nodes[edge.from];
		const toNode = graph.nodes[edge.to];
		if (!fromNode || !toNode) {
			continue;
		}
		const fromFile = path.normalize(fromNode.filePath);
		const toFile = path.normalize(toNode.filePath);
		if (fromFile === toFile) {
			continue;
		}
		const fromId = fileLevelNodeId(fromFile);
		const toId = fileLevelNodeId(toFile);
		const pairKey = fromId < toId ? `${fromId}\0${toId}` : `${toId}\0${fromId}`;
		if (seenPairs.has(pairKey)) {
			continue;
		}
		seenPairs.add(pairKey);
		const w = edgeWeights[edge.kind] ?? 1;
		neighbors.get(fromId)!.set(toId, (neighbors.get(fromId)!.get(toId) ?? 0) + w);
		neighbors.get(toId)!.set(fromId, (neighbors.get(toId)!.get(fromId) ?? 0) + w);
		totalEdgeWeight += w;
	}

	const strength = new Map<string, number>();
	for (const id of nodeIds) {
		let s = 0;
		for (const w of neighbors.get(id)!.values()) {
			s += w;
		}
		strength.set(id, s);
	}

	return { nodeIds, neighbors, strength, totalEdgeWeight };
}

export function buildWeightedGraphFromCodeGraph(
	graph: CodeGraph,
	edgeWeights: Record<CodeGraphEdgeKind, number> = LOUVAIN_EDGE_WEIGHTS,
): WeightedGraph {
	const nodeIds = Object.keys(graph.nodes);
	const neighbors = new Map<string, Map<string, number>>();
	for (const id of nodeIds) {
		neighbors.set(id, new Map());
	}

	let totalEdgeWeight = 0;
	const seenPairs = new Set<string>();

	for (const edge of graph.edges) {
		if (!graph.nodes[edge.from] || !graph.nodes[edge.to] || edge.from === edge.to) {
			continue;
		}
		const pairKey = edge.from < edge.to ? `${edge.from}\0${edge.to}` : `${edge.to}\0${edge.from}`;
		if (seenPairs.has(pairKey)) {
			continue;
		}
		seenPairs.add(pairKey);
		const w = edgeWeights[edge.kind] ?? 1;
		neighbors.get(edge.from)!.set(edge.to, (neighbors.get(edge.from)!.get(edge.to) ?? 0) + w);
		neighbors.get(edge.to)!.set(edge.from, (neighbors.get(edge.to)!.get(edge.from) ?? 0) + w);
		totalEdgeWeight += w;
	}

	const strength = new Map<string, number>();
	for (const id of nodeIds) {
		let s = 0;
		for (const w of neighbors.get(id)!.values()) {
			s += w;
		}
		strength.set(id, s);
	}

	return { nodeIds, neighbors, strength, totalEdgeWeight };
}

/** Louvain: local modularity moves + one optional aggregation pass. */
export function runLouvain(
	graph: WeightedGraph,
	options?: { resolution?: number; maxPasses?: number },
): LouvainResult {
	const resolution = options?.resolution ?? 1;
	const maxPasses = options?.maxPasses ?? 16;

	if (graph.nodeIds.length === 0 || graph.totalEdgeWeight <= 0) {
		return { assignment: new Map(), modularity: 0 };
	}

	let assignment = louvainLocalMoves(graph, resolution, maxPasses);

	if (graph.nodeIds.length > 8) {
		const aggregated = aggregateGraph(graph, assignment);
		if (aggregated.nodeIds.length > 1 && aggregated.totalEdgeWeight > 0) {
			const level2 = louvainLocalMoves(aggregated, resolution, maxPasses);
			const composed = new Map<string, number>();
			for (const nodeId of graph.nodeIds) {
				const level1 = assignment.get(nodeId)!;
				const level2Comm = level2.get(String(level1)) ?? level1;
				composed.set(nodeId, level2Comm);
			}
			assignment = relabelCommunitiesDense(composed);
		}
	}

	const modularity = computeModularity(graph, assignment, resolution);
	return { assignment, modularity };
}

function louvainLocalMoves(
	graph: WeightedGraph,
	resolution: number,
	maxPasses: number,
): Map<string, number> {
	const m = graph.totalEdgeWeight;
	const assignment = new Map<string, number>();
	const commWeight = new Map<number, number>();

	graph.nodeIds.forEach((id, i) => {
		assignment.set(id, i);
		commWeight.set(i, graph.strength.get(id) ?? 0);
	});

	for (let pass = 0; pass < maxPasses; pass++) {
		let moved = 0;
		for (const nodeId of graph.nodeIds) {
			const currentComm = assignment.get(nodeId)!;
			const ki = graph.strength.get(nodeId) ?? 0;
			commWeight.set(currentComm, (commWeight.get(currentComm) ?? 0) - ki);

			const commEdgeWeight = new Map<number, number>();
			for (const [neighbor, weight] of graph.neighbors.get(nodeId) ?? []) {
				const nc = assignment.get(neighbor)!;
				commEdgeWeight.set(nc, (commEdgeWeight.get(nc) ?? 0) + weight);
			}

			const kiInCurrent = commEdgeWeight.get(currentComm) ?? 0;
			let bestComm = currentComm;
			let bestDelta = 0;

			for (const [candidateComm, kiIn] of commEdgeWeight) {
				if (candidateComm === currentComm) {
					continue;
				}
				const sigmaTot = commWeight.get(candidateComm) ?? 0;
				const delta =
					(kiIn - kiInCurrent) / m +
					(resolution * ki * ((commWeight.get(currentComm) ?? 0) + ki - sigmaTot)) / (2 * m * m);
				if (delta > bestDelta) {
					bestDelta = delta;
					bestComm = candidateComm;
				}
			}

			if (bestComm !== currentComm && bestDelta > 0) {
				assignment.set(nodeId, bestComm);
				moved++;
			}

			const newComm = assignment.get(nodeId)!;
			commWeight.set(newComm, (commWeight.get(newComm) ?? 0) + ki);
		}

		if (moved === 0) {
			break;
		}
	}

	return relabelCommunitiesDense(assignment);
}

function aggregateGraph(graph: WeightedGraph, assignment: Map<string, number>): WeightedGraph {
	const commSet = [...new Set(assignment.values())].sort((a, b) => a - b);
	const commNeighbors = new Map<number, Map<number, number>>();
	for (const c of commSet) {
		commNeighbors.set(c, new Map());
	}

	for (const nodeId of graph.nodeIds) {
		const fromC = assignment.get(nodeId)!;
		for (const [neighbor, weight] of graph.neighbors.get(nodeId) ?? []) {
			const toC = assignment.get(neighbor)!;
			const row = commNeighbors.get(fromC)!;
			row.set(toC, (row.get(toC) ?? 0) + weight);
		}
	}

	const nodeIds = commSet.map(String);
	const neighbors = new Map<string, Map<string, number>>();
	const strength = new Map<string, number>();
	let totalEdgeWeight = 0;
	const seen = new Set<string>();

	for (const c of commSet) {
		const id = String(c);
		neighbors.set(id, new Map());
		let s = 0;
		for (const [other, w] of commNeighbors.get(c)!) {
			neighbors.get(id)!.set(String(other), w);
			s += w;
			if (c <= other) {
				const key = `${c}:${other}`;
				if (!seen.has(key)) {
					seen.add(key);
					totalEdgeWeight += c === other ? w : w;
				}
			}
		}
		strength.set(id, s);
	}

	// totalEdgeWeight: sum upper triangle once (undirected)
	totalEdgeWeight = 0;
	for (const c of commSet) {
		for (const [other, w] of commNeighbors.get(c)!) {
			if (c <= other) {
				totalEdgeWeight += w;
			}
		}
	}

	return { nodeIds, neighbors, strength, totalEdgeWeight };
}

function relabelCommunitiesDense(assignment: Map<string, number>): Map<string, number> {
	const idMap = new Map<number, number>();
	let next = 0;
	for (const comm of assignment.values()) {
		if (!idMap.has(comm)) {
			idMap.set(comm, next++);
		}
	}
	const result = new Map<string, number>();
	for (const [nodeId, comm] of assignment) {
		result.set(nodeId, idMap.get(comm)!);
	}
	return result;
}

export function computeModularity(
	graph: WeightedGraph,
	assignment: Map<string, number>,
	resolution = 1,
): number {
	const m = graph.totalEdgeWeight;
	if (m <= 0) {
		return 0;
	}
	let q = 0;
	for (const nodeId of graph.nodeIds) {
		const ci = assignment.get(nodeId)!;
		const ki = graph.strength.get(nodeId) ?? 0;
		for (const [neighbor, weight] of graph.neighbors.get(nodeId) ?? []) {
			if (assignment.get(neighbor) === ci) {
				q += weight;
			}
		}
		q -= resolution * (ki * communityStrength(graph, assignment, ci)) / (2 * m);
	}
	return q / (2 * m);
}

function communityStrength(
	graph: WeightedGraph,
	assignment: Map<string, number>,
	commId: number,
): number {
	let s = 0;
	for (const nodeId of graph.nodeIds) {
		if (assignment.get(nodeId) === commId) {
			s += graph.strength.get(nodeId) ?? 0;
		}
	}
	return s;
}

export function groupNodesByCommunity(assignment: Map<string, number>): Map<number, string[]> {
	const groups = new Map<number, string[]>();
	for (const [nodeId, comm] of assignment) {
		const list = groups.get(comm) ?? [];
		list.push(nodeId);
		groups.set(comm, list);
	}
	return groups;
}

export function communityLabelForMembers(graph: CodeGraph, memberIds: string[]): string {
	const fileCounts = new Map<string, number>();
	for (const id of memberIds) {
		const fp = graph.nodes[id]?.filePath;
		if (fp) {
			fileCounts.set(fp, (fileCounts.get(fp) ?? 0) + 1);
		}
	}
	let topFile = memberIds[0];
	let topCount = 0;
	for (const [fp, count] of fileCounts) {
		if (count > topCount) {
			topCount = count;
			topFile = fp;
		}
	}
	const labelNode = graph.nodes[topFile];
	return labelNode?.symbolName ?? path.basename(labelNode?.filePath ?? topFile);
}

/** Build two dense cliques with a single weak bridge (for tests). */
export function buildCliqueBridgeWeightedGraph(cliqueSize: number, bridgeWeight: number): WeightedGraph {
	const nodeIds: string[] = [];
	for (let i = 0; i < cliqueSize * 2; i++) {
		nodeIds.push(`n${i}`);
	}
	const neighbors = new Map<string, Map<string, number>>();
	for (const id of nodeIds) {
		neighbors.set(id, new Map());
	}
	const addEdge = (a: string, b: string, w: number) => {
		neighbors.get(a)!.set(b, (neighbors.get(a)!.get(b) ?? 0) + w);
		neighbors.get(b)!.set(a, (neighbors.get(b)!.get(a) ?? 0) + w);
	};
	let totalEdgeWeight = 0;
	for (let i = 0; i < cliqueSize; i++) {
		for (let j = i + 1; j < cliqueSize; j++) {
			addEdge(`n${i}`, `n${j}`, 3);
			totalEdgeWeight += 3;
		}
	}
	for (let i = cliqueSize; i < cliqueSize * 2; i++) {
		for (let j = i + 1; j < cliqueSize * 2; j++) {
			addEdge(`n${i}`, `n${j}`, 3);
			totalEdgeWeight += 3;
		}
	}
	addEdge(`n${cliqueSize - 1}`, `n${cliqueSize}`, bridgeWeight);
	totalEdgeWeight += bridgeWeight;

	const strength = new Map<string, number>();
	for (const id of nodeIds) {
		let s = 0;
		for (const w of neighbors.get(id)!.values()) {
			s += w;
		}
		strength.set(id, s);
	}
	return { nodeIds, neighbors, strength, totalEdgeWeight };
}
