/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { CodeSymbolEntry } from './ragQueryHelpers.js';
import { extractGraphEdgesWithTreeSitter } from './codeGraphTreeSitter.js';
import { canTreeSitterParse } from './treeSitterChunker.js';

export type CodeGraphEdgeKind = 'imports' | 'calls';

export interface CodeGraphNode {
	id: string;
	filePath: string;
	symbolName?: string;
	startLine?: number;
	endLine?: number;
	symbolType?: string;
}

export interface CodeGraphEdge {
	from: string;
	to: string;
	kind: CodeGraphEdgeKind;
}

export interface CodeGraph {
	nodes: Record<string, CodeGraphNode>;
	edges: CodeGraphEdge[];
	/** node id → neighbor node ids (undirected expansion set) */
	adjacency: Record<string, string[]>;
}

export const CODE_GRAPH_ENGINE = 'code-graph-v2';

export function createEmptyCodeGraph(): CodeGraph {
	return { nodes: {}, edges: [], adjacency: {} };
}

export function symbolNodeId(filePath: string, symbol: CodeSymbolEntry): string {
	const name = symbol.symbolName ?? `line${symbol.startLine}`;
	return `${path.normalize(filePath)}::${symbol.startLine}::${name}`;
}

export function fileNodeId(filePath: string): string {
	return `${path.normalize(filePath)}::file`;
}

function addEdge(graph: CodeGraph, from: string, to: string, kind: CodeGraphEdgeKind): void {
	if (from === to) {
		return;
	}
	graph.edges.push({ from, to, kind });
	const fromList = graph.adjacency[from] ?? [];
	if (!fromList.includes(to)) {
		fromList.push(to);
		graph.adjacency[from] = fromList;
	}
	const toList = graph.adjacency[to] ?? [];
	if (!toList.includes(from)) {
		toList.push(from);
		graph.adjacency[to] = toList;
	}
}

function ensureNode(graph: CodeGraph, node: CodeGraphNode): void {
	graph.nodes[node.id] = node;
}

const TS_IMPORT_REGEX = /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/gm;
const TS_REQUIRE_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CPP_INCLUDE_REGEX = /#\s*include\s+[<"]([^>"]+)[>"]/g;
const PY_IMPORT_REGEX = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

const CALL_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp', '.c', '.cc', '.cxx', '.py']);

export function resolveImportTarget(
	importSpec: string,
	sourceFilePath: string,
	workspaceRoot?: string,
): string | null {
	const spec = importSpec.trim();
	if (spec.length === 0 || spec.startsWith('http')) {
		return null;
	}

	const ext = path.extname(sourceFilePath).toLowerCase();
	const sourceDir = path.dirname(sourceFilePath);

	if (ext === '.py') {
		const modulePath = spec.replace(/\./g, '/');
		const candidates = [
			path.join(sourceDir, `${modulePath}.py`),
			workspaceRoot ? path.join(workspaceRoot, `${modulePath}.py`) : '',
			workspaceRoot ? path.join(workspaceRoot, modulePath, '__init__.py') : '',
		].filter(Boolean);
		for (const candidate of candidates) {
			if (candidate && path.isAbsolute(candidate)) {
				return path.normalize(candidate);
			}
		}
		return null;
	}

	if (spec.startsWith('.')) {
		let resolved = path.normalize(path.join(sourceDir, spec));
		if (!path.extname(resolved)) {
			for (const tryExt of ['.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp']) {
				const withExt = resolved + tryExt;
				if (CODE_EXTENSIONS.has(tryExt)) {
					return withExt;
				}
			}
		}
		return resolved;
	}

	if (ext === '.cpp' || ext === '.h' || ext === '.hpp' || ext === '.c') {
		const headerName = path.basename(spec);
		const local = path.normalize(path.join(sourceDir, headerName));
		if (workspaceRoot) {
			return local;
		}
		return local;
	}

	return null;
}

function extractImports(
	content: string,
	sourceFilePath: string,
	workspaceRoot?: string,
): string[] {
	const ext = path.extname(sourceFilePath).toLowerCase();
	const targets: string[] = [];

	if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
		let match: RegExpExecArray | null;
		TS_IMPORT_REGEX.lastIndex = 0;
		while ((match = TS_IMPORT_REGEX.exec(content)) !== null) {
			const resolved = resolveImportTarget(match[1], sourceFilePath, workspaceRoot);
			if (resolved) {
				targets.push(resolved);
			}
		}
		TS_REQUIRE_REGEX.lastIndex = 0;
		while ((match = TS_REQUIRE_REGEX.exec(content)) !== null) {
			const resolved = resolveImportTarget(match[1], sourceFilePath, workspaceRoot);
			if (resolved) {
				targets.push(resolved);
			}
		}
	} else if (['.cpp', '.h', '.hpp', '.c', '.cc', '.cxx'].includes(ext)) {
		let match: RegExpExecArray | null;
		CPP_INCLUDE_REGEX.lastIndex = 0;
		while ((match = CPP_INCLUDE_REGEX.exec(content)) !== null) {
			const resolved = resolveImportTarget(match[1], sourceFilePath, workspaceRoot);
			if (resolved) {
				targets.push(resolved);
			}
		}
	} else if (ext === '.py') {
		let match: RegExpExecArray | null;
		PY_IMPORT_REGEX.lastIndex = 0;
		while ((match = PY_IMPORT_REGEX.exec(content)) !== null) {
			const mod = match[1] ?? match[2];
			if (mod) {
				const resolved = resolveImportTarget(mod, sourceFilePath, workspaceRoot);
				if (resolved) {
					targets.push(resolved);
				}
			}
		}
	}

	return targets;
}

function extractCallsInRange(content: string, startLine: number, endLine: number): Set<string> {
	const lines = content.split('\n');
	const slice = lines.slice(Math.max(startLine - 1, 0), endLine).join('\n');
	const names = new Set<string>();
	let match: RegExpExecArray | null;
	CALL_REGEX.lastIndex = 0;
	while ((match = CALL_REGEX.exec(slice)) !== null) {
		const name = match[1];
		if (name && !isCallKeyword(name)) {
			names.add(name);
		}
	}
	return names;
}

const CALL_KEYWORDS = new Set([
	'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'delete', 'sizeof', 'typeof',
	'void', 'int', 'float', 'double', 'char', 'bool', 'class', 'struct', 'enum', 'union',
	'namespace', 'template', 'typedef', 'using', 'static', 'const', 'virtual', 'override',
	'public', 'private', 'protected', 'this', 'super', 'function', 'async', 'await',
]);

const CONTAINER_OR_FUNCTION = new Set([
	'function', 'class', 'struct', 'method', 'namespace', 'interface', 'template',
]);

export function isCallKeyword(name: string): boolean {
	return CALL_KEYWORDS.has(name);
}

/** Build symbol-name → node id index from an existing graph (for cross-file call resolution). */
export function buildSymbolNameIndex(graph: CodeGraph): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const node of Object.values(graph.nodes)) {
		if (!node.symbolName) {
			continue;
		}
		const list = index.get(node.symbolName) ?? [];
		list.push(node.id);
		index.set(node.symbolName, list);
	}
	return index;
}

/**
 * Extract imports/calls edges for one file and merge into the workspace graph.
 */
export function mergeFileIntoCodeGraph(
	graph: CodeGraph,
	filePath: string,
	content: string,
	symbols: CodeSymbolEntry[],
	workspaceRoot?: string,
	symbolNameIndex?: Map<string, string[]>,
	importPaths?: string[],
	callsOverride?: Map<number, Set<string>>,
): void {
	const normalized = path.normalize(filePath);
	const fileId = fileNodeId(normalized);
	ensureNode(graph, { id: fileId, filePath: normalized });

	for (const symbol of symbols) {
		const nodeId = symbolNodeId(normalized, symbol);
		ensureNode(graph, {
			id: nodeId,
			filePath: normalized,
			symbolName: symbol.symbolName,
			startLine: symbol.startLine,
			endLine: symbol.endLine,
			symbolType: symbol.symbolType,
		});
		addEdge(graph, fileId, nodeId, 'calls');
		if (symbol.symbolName) {
			const list = symbolNameIndex?.get(symbol.symbolName) ?? [];
			if (!list.includes(nodeId)) {
				list.push(nodeId);
				symbolNameIndex?.set(symbol.symbolName, list);
			}
		}
	}

	const imports = importPaths ?? extractImports(content, normalized, workspaceRoot);
	for (const importPath of imports) {
		const targetId = fileNodeId(importPath);
		ensureNode(graph, { id: targetId, filePath: importPath });
		addEdge(graph, fileId, targetId, 'imports');
	}

	const localNames = new Set(symbols.map(s => s.symbolName).filter(Boolean) as string[]);
	for (const symbol of symbols) {
		if (!CONTAINER_OR_FUNCTION.has(symbol.symbolType)) {
			continue;
		}
		const fromId = symbolNodeId(normalized, symbol);
		const calls = callsOverride?.get(symbol.startLine) ?? extractCallsInRange(content, symbol.startLine, symbol.endLine);
		for (const callee of calls) {
			if (localNames.has(callee)) {
				const local = symbols.find(s => s.symbolName === callee);
				if (local) {
					addEdge(graph, fromId, symbolNodeId(normalized, local), 'calls');
				}
				continue;
			}
			const remoteIds = symbolNameIndex?.get(callee) ?? [];
			for (const remoteId of remoteIds.slice(0, 3)) {
				addEdge(graph, fromId, remoteId, 'calls');
			}
		}
	}
}

/** Merge file graph edges using tree-sitter when available (P10-2), regex fallback otherwise. */
export async function mergeFileIntoCodeGraphAsync(
	graph: CodeGraph,
	filePath: string,
	content: string,
	symbols: CodeSymbolEntry[],
	workspaceRoot?: string,
	symbolNameIndex?: Map<string, string[]>,
): Promise<void> {
	let importPaths: string[] | undefined;
	let callsOverride: Map<number, Set<string>> | undefined;

	if (canTreeSitterParse(filePath)) {
		try {
			const extracted = await extractGraphEdgesWithTreeSitter(content, filePath, symbols, workspaceRoot);
			if (extracted) {
				importPaths = extracted.imports;
				callsOverride = extracted.callsBySymbolLine;
			}
		} catch (err) {
			console.warn(`[RAG] tree-sitter graph extraction failed for ${filePath}, using regex fallback:`, err);
		}
	}

	mergeFileIntoCodeGraph(
		graph,
		filePath,
		content,
		symbols,
		workspaceRoot,
		symbolNameIndex,
		importPaths,
		callsOverride,
	);
}

/** Remove all nodes/edges belonging to a file from the graph. */
export function purgeFileFromCodeGraph(graph: CodeGraph, filePath: string): void {
	const normalized = path.normalize(filePath);
	const prefix = `${normalized}::`;
	const toRemove = Object.keys(graph.nodes).filter(id => id === fileNodeId(normalized) || id.startsWith(prefix));
	const removeSet = new Set(toRemove);

	graph.edges = graph.edges.filter(e => !removeSet.has(e.from) && !removeSet.has(e.to));
	for (const id of toRemove) {
		delete graph.nodes[id];
		delete graph.adjacency[id];
	}
	for (const [nodeId, neighbors] of Object.entries(graph.adjacency)) {
		graph.adjacency[nodeId] = neighbors.filter(n => !removeSet.has(n));
	}
}

export interface GraphExpansionSeed {
	filePath: string;
	startLine?: number;
	symbolName?: string;
}

export interface GraphExpansionHit {
	nodeId: string;
	filePath: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	symbolType?: string;
	kind: CodeGraphEdgeKind;
}

/** Collect graph neighbors for vector retrieval seeds (1–2 hops, P10-3). */
export function expandGraphNeighbors(
	graph: CodeGraph,
	seeds: GraphExpansionSeed[],
	maxNeighbors = 6,
	hops = 1,
): GraphExpansionHit[] {
	const hopCount = Math.min(Math.max(1, hops), 2);
	const hits: GraphExpansionHit[] = [];
	const seen = new Set<string>();
	let frontier = seeds;

	for (let hop = 0; hop < hopCount; hop++) {
		const nextFrontier: GraphExpansionSeed[] = [];

		for (const seed of frontier) {
			let seedId: string | undefined;
			if (seed.startLine !== undefined) {
				const name = seed.symbolName ?? `line${seed.startLine}`;
				seedId = `${path.normalize(seed.filePath)}::${seed.startLine}::${name}`;
			} else {
				seedId = fileNodeId(seed.filePath);
			}

			const neighbors = graph.adjacency[seedId] ?? [];
			for (const neighborId of neighbors) {
				if (seen.has(neighborId)) {
					continue;
				}
				const node = graph.nodes[neighborId];
				if (!node || node.startLine === undefined || node.endLine === undefined) {
					continue;
				}
				seen.add(neighborId);
				const edge = graph.edges.find(e =>
					(e.from === seedId && e.to === neighborId) || (e.to === seedId && e.from === neighborId),
				);
				hits.push({
					nodeId: neighborId,
					filePath: node.filePath,
					startLine: node.startLine,
					endLine: node.endLine,
					symbolName: node.symbolName,
					symbolType: node.symbolType,
					kind: edge?.kind ?? 'calls',
				});
				nextFrontier.push({
					filePath: node.filePath,
					startLine: node.startLine,
					symbolName: node.symbolName,
				});
				if (hits.length >= maxNeighbors) {
					return hits;
				}
			}
		}

		if (hits.length >= maxNeighbors || nextFrontier.length === 0) {
			break;
		}
		frontier = nextFrontier;
	}

	return hits;
}

export type RelatedFileDependencyKind = 'imports' | 'imported_by' | 'calls';

export interface RelatedFileDependency {
	filePath: string;
	kind: RelatedFileDependencyKind;
	reason: string;
}

/** First-hop file dependencies from the code graph (Phase 9). */
export function getRelatedFilesFromGraph(
	graph: CodeGraph,
	filePath: string,
	maxResults = 8,
): RelatedFileDependency[] {
	const normalized = path.normalize(filePath);
	const fileId = fileNodeId(normalized);
	const nodeIds = Object.keys(graph.nodes).filter(
		id => id === fileId || id.startsWith(`${normalized}::`),
	);

	const deps: RelatedFileDependency[] = [];
	const seen = new Set<string>();

	const add = (targetPath: string, kind: RelatedFileDependencyKind, reason: string) => {
		const p = path.normalize(targetPath);
		if (p === normalized || seen.has(p)) {
			return;
		}
		seen.add(p);
		deps.push({ filePath: p, kind, reason });
	};

	for (const nodeId of nodeIds) {
		for (const neighborId of graph.adjacency[nodeId] ?? []) {
			const edge = graph.edges.find(e =>
				(e.from === nodeId && e.to === neighborId) || (e.to === nodeId && e.from === neighborId),
			);
			const neighbor = graph.nodes[neighborId];
			if (!neighbor?.filePath) {
				continue;
			}
			if (edge?.kind === 'imports') {
				add(neighbor.filePath, 'imports', 'import dependency');
			} else if (edge?.kind === 'calls') {
				const label = neighbor.symbolName ? `symbol ${neighbor.symbolName}` : 'related symbol';
				add(neighbor.filePath, 'calls', label);
			}
		}
	}

	for (const edge of graph.edges) {
		if (edge.kind !== 'imports') {
			continue;
		}
		const target = graph.nodes[edge.to];
		const source = graph.nodes[edge.from];
		if (target?.filePath === normalized && source?.filePath) {
			add(source.filePath, 'imported_by', 'depends on this file');
		}
	}

	return deps.slice(0, maxResults);
}
