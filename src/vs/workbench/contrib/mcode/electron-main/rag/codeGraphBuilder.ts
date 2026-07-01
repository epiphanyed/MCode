/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import type { CodeSymbolEntry } from './ragQueryHelpers.js';
import { extractGraphEdgesWithTreeSitter } from './codeGraphTreeSitter.js';
import { canTreeSitterParse } from './treeSitterGrammarMap.js';
import {
	buildFileLevelWeightedGraph,
	buildWeightedGraphFromCodeGraph,
	communityLabelForMembers,
	groupNodesByCommunity,
	LOUVAIN_MAX_NODES,
	runLouvain,
} from './graphLouvainCommunities.js';

export type CodeGraphEdgeKind = 'imports' | 'calls' | 'inherits' | 'contains';

export interface CodeGraphNode {
	id: string;
	filePath: string;
	symbolName?: string;
	startLine?: number;
	endLine?: number;
	symbolType?: string;
	/** File-level display nodes: symbol names in this file (for search). */
	containedSymbolNames?: string[];
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

export const CODE_GRAPH_ENGINE = 'code-graph-v3';

/** Symbol-level nodes above this → file-level graph in the webview (avoids UI freeze). */
export const GRAPH_VIEW_MAX_SYMBOL_NODES = 1200;

/** File-level nodes above this → keep top hubs + 1-hop neighbors only. */
export const GRAPH_VIEW_MAX_FILE_NODES = 800;

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
const KT_IMPORT_REGEX = /^\s*import\s+([\w.*]+)(?:\s+as\s+\w+)?/gm;
const KT_CLASS_INHERIT_REGEX = /\b(?:data\s+|sealed\s+|abstract\s+|open\s+)?class\s+(\w+)\s*(?:<[^>]*>)?\s*(?:\([^)]*\))?\s*:\s*([^{]+)/g;

const CALL_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp', '.c', '.cc', '.cxx', '.py', '.kt', '.kts']);

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
			const tryExts = ext === '.kt' || ext === '.kts'
				? ['.kt', '.kts']
				: ['.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp'];
			for (const tryExt of tryExts) {
				const withExt = resolved + tryExt;
				if (CODE_EXTENSIONS.has(tryExt)) {
					if (fs.existsSync(withExt)) {
						return withExt;
					}
				}
			}
			return resolved + (ext === '.kt' || ext === '.kts' ? '.kt' : tryExts[0]);
		}
		return resolved;
	}

	if (ext === '.kt' || ext === '.kts') {
		if (workspaceRoot && /^[\w.*]+$/.test(spec)) {
			const normalizedSpec = spec.replace(/\.\*$/, '');
			const parts = normalizedSpec.split('.');
			const fileName = `${parts.pop()}.kt`;
			const dirPath = parts.join(path.sep);
			const candidates = [
				path.join(workspaceRoot, 'src', 'main', 'kotlin', dirPath, fileName),
				path.join(workspaceRoot, 'src', dirPath, fileName),
				path.join(workspaceRoot, dirPath, fileName),
			].filter(Boolean);
			for (const candidate of candidates) {
				if (fs.existsSync(candidate)) {
					return path.normalize(candidate);
				}
			}
			if (dirPath) {
				return path.normalize(candidates[0]);
			}
		}
		return null;
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
	} else if (ext === '.kt' || ext === '.kts') {
		let match: RegExpExecArray | null;
		KT_IMPORT_REGEX.lastIndex = 0;
		while ((match = KT_IMPORT_REGEX.exec(content)) !== null) {
			const resolved = resolveImportTarget(match[1], sourceFilePath, workspaceRoot);
			if (resolved) {
				targets.push(resolved);
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

const CONTAINER_SYMBOL_TYPES = new Set(['class', 'struct', 'interface', 'namespace', 'enum']);

const TS_CLASS_EXTENDS_REGEX = /class\s+(\w+)(?:\s+extends\s+([\w.]+))?/g;
const TS_CLASS_IMPLEMENTS_REGEX = /class\s+\w+\s+implements\s+([\w,\s<>]+)/g;
const CPP_CLASS_INHERIT_REGEX = /class\s+(\w+)\s*:\s*(?:public|protected|private)\s+(\w+)/g;
const PY_CLASS_BASE_REGEX = /class\s+(\w+)\s*\(\s*([\w.]+)/g;

export function isCallKeyword(name: string): boolean {
	return CALL_KEYWORDS.has(name);
}

function extractInheritsBySymbolLine(
	content: string,
	symbols: CodeSymbolEntry[],
): Map<number, Set<string>> {
	const result = new Map<number, Set<string>>();
	const classSymbols = symbols.filter(s => s.symbolType === 'class' || s.symbolType === 'interface' || s.symbolType === 'enum');
	if (classSymbols.length === 0) {
		return result;
	}

	const addBase = (className: string, baseName: string) => {
		const sym = classSymbols.find(s => s.symbolName === className);
		if (!sym || !baseName) {
			return;
		}
		const cleaned = baseName.trim().split(/[<,\s]/)[0]?.replace(/\.$/, '');
		if (!cleaned || cleaned === className) {
			return;
		}
		const set = result.get(sym.startLine) ?? new Set<string>();
		set.add(cleaned);
		result.set(sym.startLine, set);
	};

	let match: RegExpExecArray | null;
	TS_CLASS_EXTENDS_REGEX.lastIndex = 0;
	while ((match = TS_CLASS_EXTENDS_REGEX.exec(content)) !== null) {
		if (match[2]) {
			addBase(match[1], match[2]);
		}
	}
	TS_CLASS_IMPLEMENTS_REGEX.lastIndex = 0;
	while ((match = TS_CLASS_IMPLEMENTS_REGEX.exec(content)) !== null) {
		for (const part of match[1].split(',')) {
			addBase('', part); // handled below via line association
		}
	}
	// Re-run implements with class name from preceding class keyword on same line
	for (const sym of classSymbols) {
		const line = content.split('\n')[sym.startLine - 1] ?? '';
		const implMatch = /implements\s+([\w,\s<>]+)/.exec(line);
		if (implMatch) {
			for (const part of implMatch[1].split(',')) {
				const set = result.get(sym.startLine) ?? new Set<string>();
				const cleaned = part.trim().split(/[<,\s]/)[0];
				if (cleaned) {
					set.add(cleaned);
					result.set(sym.startLine, set);
				}
			}
		}
		const extMatch = /extends\s+([\w.]+)/.exec(line);
		if (extMatch) {
			const set = result.get(sym.startLine) ?? new Set<string>();
			set.add(extMatch[1].split('.').pop() ?? extMatch[1]);
			result.set(sym.startLine, set);
		}
	}

	CPP_CLASS_INHERIT_REGEX.lastIndex = 0;
	while ((match = CPP_CLASS_INHERIT_REGEX.exec(content)) !== null) {
		addBase(match[1], match[2]);
	}

	PY_CLASS_BASE_REGEX.lastIndex = 0;
	while ((match = PY_CLASS_BASE_REGEX.exec(content)) !== null) {
		addBase(match[1], match[2]);
	}

	KT_CLASS_INHERIT_REGEX.lastIndex = 0;
	while ((match = KT_CLASS_INHERIT_REGEX.exec(content)) !== null) {
		for (const part of match[2].split(',')) {
			const cleaned = part.trim().replace(/\([^)]*\)/g, '').trim().split(/[<.\s]/)[0];
			if (cleaned) {
				addBase(match[1], cleaned);
			}
		}
	}

	return result;
}

function addContainsEdgesFromSymbols(
	graph: CodeGraph,
	filePath: string,
	symbols: CodeSymbolEntry[],
): void {
	const normalized = path.normalize(filePath);
	const fileId = fileNodeId(normalized);
	const containers = symbols.filter(s => CONTAINER_SYMBOL_TYPES.has(s.symbolType));

	for (const symbol of symbols) {
		const nodeId = symbolNodeId(normalized, symbol);
		addEdge(graph, fileId, nodeId, 'contains');
	}

	for (const container of containers) {
		const containerId = symbolNodeId(normalized, container);
		for (const inner of symbols) {
			if (inner.startLine === container.startLine && inner.symbolName === container.symbolName) {
				continue;
			}
			if (inner.startLine >= container.startLine && inner.endLine <= container.endLine) {
				addEdge(graph, containerId, symbolNodeId(normalized, inner), 'contains');
			}
		}
	}
}

function addInheritEdges(
	graph: CodeGraph,
	filePath: string,
	symbols: CodeSymbolEntry[],
	inheritsByLine: Map<number, Set<string>>,
	symbolNameIndex?: Map<string, string[]>,
): void {
	const normalized = path.normalize(filePath);
	const localNames = new Set(symbols.map(s => s.symbolName).filter(Boolean) as string[]);

	for (const [startLine, baseNames] of inheritsByLine) {
		const fromSymbol = symbols.find(s => s.startLine === startLine);
		if (!fromSymbol) {
			continue;
		}
		const fromId = symbolNodeId(normalized, fromSymbol);
		for (const baseName of baseNames) {
			if (localNames.has(baseName)) {
				const local = symbols.find(s => s.symbolName === baseName && (s.symbolType === 'class' || s.symbolType === 'interface'));
				if (local) {
					addEdge(graph, fromId, symbolNodeId(normalized, local), 'inherits');
				}
				continue;
			}
			const remoteIds = symbolNameIndex?.get(baseName) ?? [];
			for (const remoteId of remoteIds.slice(0, 3)) {
				addEdge(graph, fromId, remoteId, 'inherits');
			}
		}
	}
}

const CONTAINER_OR_FUNCTION = new Set([
	'function', 'class', 'struct', 'method', 'namespace', 'interface', 'template',
]);

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
	inheritsOverride?: Map<number, Set<string>>,
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
		if (symbol.symbolName) {
			const list = symbolNameIndex?.get(symbol.symbolName) ?? [];
			if (!list.includes(nodeId)) {
				list.push(nodeId);
				symbolNameIndex?.set(symbol.symbolName, list);
			}
		}
	}

	addContainsEdgesFromSymbols(graph, normalized, symbols);

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

	const inheritsByLine = inheritsOverride ?? extractInheritsBySymbolLine(content, symbols);
	addInheritEdges(graph, normalized, symbols, inheritsByLine, symbolNameIndex);
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
	let inheritsOverride: Map<number, Set<string>> | undefined;

	if (canTreeSitterParse(filePath)) {
		try {
			const extracted = await extractGraphEdgesWithTreeSitter(content, filePath, symbols, workspaceRoot);
			if (extracted) {
				importPaths = extracted.imports;
				callsOverride = extracted.callsBySymbolLine;
				inheritsOverride = extracted.inheritsBySymbolLine;
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
		inheritsOverride,
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
			} else if (edge?.kind === 'inherits') {
				const label = neighbor.symbolName ? `extends ${neighbor.symbolName}` : 'inheritance';
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

export interface CodeGraphHubNode {
	id: string;
	degree: number;
	filePath: string;
	symbolName?: string;
	symbolType?: string;
}

export interface CodeGraphCommunity {
	id: number;
	nodeIds: string[];
	size: number;
	label: string;
	color: string;
	method: CodeGraphCommunityMethod;
	/** Present when method === 'louvain' (graph-level modularity). */
	modularity?: number;
}

export type CodeGraphCommunityMethod = 'louvain' | 'louvain-file' | 'components';

const COMMUNITY_COLORS = [
	'#5c88ff', '#ff8866', '#66cc99', '#c586c0', '#dcdcaa',
	'#4ec9b0', '#ce9178', '#569cd6', '#f48771', '#b5cea8',
	'#9cdcfe', '#d7ba7d',
];

/** Connected components fallback when Louvain is skipped or graph is empty. */
export function computeConnectedComponentCommunities(graph: CodeGraph, maxCommunities = 12): CodeGraphCommunity[] {
	const visited = new Set<string>();
	const communities: CodeGraphCommunity[] = [];
	let communityId = 0;

	for (const startId of Object.keys(graph.nodes)) {
		if (visited.has(startId)) {
			continue;
		}
		const members: string[] = [];
		const stack = [startId];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (visited.has(cur)) {
				continue;
			}
			visited.add(cur);
			members.push(cur);
			for (const neighbor of graph.adjacency[cur] ?? []) {
				if (!visited.has(neighbor)) {
					stack.push(neighbor);
				}
			}
		}
		if (members.length === 0) {
			continue;
		}
		communities.push({
			id: communityId,
			nodeIds: members,
			size: members.length,
			label: communityLabelForMembers(graph, members),
			color: COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length],
			method: 'components',
		});
		communityId++;
	}

	return communities
		.sort((a, b) => b.size - a.size)
		.slice(0, maxCommunities);
}

/** Louvain modularity communities (default); falls back to connected components on large/empty graphs. */
export function computeGraphCommunities(graph: CodeGraph, maxCommunities = 12): {
	communities: CodeGraphCommunity[];
	nodeCommunity: Record<string, number>;
	communityColors: Record<number, string>;
	method: CodeGraphCommunityMethod;
	graphModularity?: number;
} {
	const nodeCount = Object.keys(graph.nodes).length;
	if (nodeCount === 0) {
		return { communities: [], nodeCommunity: {}, communityColors: {}, method: 'components' };
	}

	if (nodeCount > LOUVAIN_MAX_NODES || graph.edges.length === 0) {
		const fileWeighted = buildFileLevelWeightedGraph(graph);
		if (fileWeighted.nodeIds.length > 1 && fileWeighted.totalEdgeWeight > 0) {
			const { assignment, modularity } = runLouvain(fileWeighted);
			const groups = groupNodesByCommunity(assignment);
			const allCommunities: CodeGraphCommunity[] = [];
			for (const [commId, memberFileIds] of groups) {
				const memberFilePaths = new Set(
					memberFileIds.map(id => path.normalize(id.replace(/::file$/, ''))),
				);
				const memberIds = Object.values(graph.nodes)
					.filter(n => memberFilePaths.has(path.normalize(n.filePath)))
					.map(n => n.id);
				if (memberIds.length === 0) {
					continue;
				}
				allCommunities.push({
					id: commId,
					nodeIds: memberIds,
					size: memberIds.length,
					label: communityLabelForMembers(graph, memberIds),
					color: COMMUNITY_COLORS[commId % COMMUNITY_COLORS.length],
					method: 'louvain-file',
					modularity,
				});
			}
			const sorted = allCommunities.sort((a, b) => b.size - a.size);
			const top = sorted.slice(0, maxCommunities);
			const nodeCommunity: Record<string, number> = {};
			const fileComm = new Map<string, number>();
			for (const [fileId, commId] of assignment) {
				fileComm.set(path.normalize(fileId.replace(/::file$/, '')), commId);
			}
			for (const [nodeId, node] of Object.entries(graph.nodes)) {
				const comm = fileComm.get(path.normalize(node.filePath));
				if (comm !== undefined) {
					nodeCommunity[nodeId] = comm;
				}
			}
			const communityColors: Record<number, string> = {};
			for (const c of allCommunities) {
				communityColors[c.id] = c.color;
			}
			return {
				communities: top,
				nodeCommunity,
				communityColors,
				method: 'louvain-file',
				graphModularity: modularity,
			};
		}
		const communities = computeConnectedComponentCommunities(graph, maxCommunities);
		return {
			communities,
			nodeCommunity: buildNodeCommunityMap(communities),
			communityColors: buildCommunityColorMap(communities),
			method: 'components',
		};
	}

	const weighted = buildWeightedGraphFromCodeGraph(graph);
	if (weighted.totalEdgeWeight <= 0) {
		const communities = computeConnectedComponentCommunities(graph, maxCommunities);
		return {
			communities,
			nodeCommunity: buildNodeCommunityMap(communities),
			communityColors: buildCommunityColorMap(communities),
			method: 'components',
		};
	}

	const { assignment, modularity } = runLouvain(weighted);
	const groups = groupNodesByCommunity(assignment);
	const allCommunities: CodeGraphCommunity[] = [];
	for (const [commId, memberIds] of groups) {
		allCommunities.push({
			id: commId,
			nodeIds: memberIds,
			size: memberIds.length,
			label: communityLabelForMembers(graph, memberIds),
			color: COMMUNITY_COLORS[commId % COMMUNITY_COLORS.length],
			method: 'louvain',
			modularity,
		});
	}

	const sorted = allCommunities.sort((a, b) => b.size - a.size);
	const top = sorted.slice(0, maxCommunities);
	const nodeCommunity: Record<string, number> = {};
	for (const [nodeId, comm] of assignment) {
		nodeCommunity[nodeId] = comm;
	}
	const communityColors: Record<number, string> = {};
	for (const c of allCommunities) {
		communityColors[c.id] = c.color;
	}

	return {
		communities: top,
		nodeCommunity,
		communityColors,
		method: 'louvain',
		graphModularity: modularity,
	};
}

function buildCommunityColorMap(communities: CodeGraphCommunity[]): Record<number, string> {
	const map: Record<number, string> = {};
	for (const c of communities) {
		map[c.id] = c.color;
	}
	return map;
}

export function buildNodeCommunityMap(communities: CodeGraphCommunity[]): Record<string, number> {
	const map: Record<string, number> = {};
	for (const community of communities) {
		for (const nodeId of community.nodeIds) {
			map[nodeId] = community.id;
		}
	}
	return map;
}

export type CodeGraphViewMode = 'full' | 'file' | 'file-sampled' | 'focus-symbol';

/** Interactive webview display scope (overview = auto file/symbol reduction). */
export type CodeGraphDisplayScope = 'overview' | 'symbols' | 'calls';

export interface CodeGraphViewOptions {
	displayScope?: CodeGraphDisplayScope;
	/** Drill into one file's symbols + 1-hop neighbors (for search / off-view symbols). */
	focusFilePath?: string;
	/** Re-run search after view reload (webview only). */
	pendingSearchQuery?: string;
}

export interface CodeGraphViewPayload {
	graph: CodeGraph;
	nodeDegrees: Record<string, number>;
	hubNodes: CodeGraphHubNode[];
	communities: CodeGraphCommunity[];
	nodeCommunity: Record<string, number>;
	communityColors: Record<number, string>;
	communityMethod: CodeGraphCommunityMethod;
	graphModularity?: number;
	architectureReport: string;
	/** How the graph was reduced for interactive display (full graph still used for RAG). */
	viewMode: CodeGraphViewMode;
	displayScope: CodeGraphDisplayScope;
	focusFilePath?: string;
	initialSearchQuery?: string;
	totalNodeCount: number;
	/** Full-graph symbol index for search when view is file-level or sampled. */
	fileSymbolIndex: Record<string, string[]>;
	/** Full-graph symbol name → file/line for Enter-to-open in webview search. */
	symbolSearchIndex: Record<string, CodeGraphSymbolLocation[]>;
}

/** Fast content hash for per-file graph incremental skip (T9). */
export function computeFileContentHash(content: string): string {
	let hash = 2166136261;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

export function buildGraphArchitectureReport(
	graph: CodeGraph,
	hubNodes: CodeGraphHubNode[],
	communities: CodeGraphCommunity[],
	communityMethod: CodeGraphCommunityMethod,
	graphModularity?: number,
): string {
	const edgeCounts: Record<string, number> = { imports: 0, calls: 0, inherits: 0, contains: 0 };
	for (const edge of graph.edges) {
		edgeCounts[edge.kind] = (edgeCounts[edge.kind] ?? 0) + 1;
	}
	const nodeCount = Object.keys(graph.nodes).length;
	const fileNodes = Object.values(graph.nodes).filter(n => n.id.endsWith('::file')).length;
	const methodLabel = communityMethod === 'louvain'
		? `Louvain modularity${graphModularity !== undefined ? ` (Q≈${graphModularity.toFixed(3)})` : ''}`
		: communityMethod === 'louvain-file'
			? `File-level Louvain${graphModularity !== undefined ? ` (Q≈${graphModularity.toFixed(3)})` : ''}`
			: 'connected components';
	const lines = [
		'# Code Graph Architecture Report (GRAPH_REPORT)',
		'',
		`- **Nodes:** ${nodeCount} (${fileNodes} files)`,
		`- **Edges:** ${graph.edges.length} — imports ${edgeCounts.imports}, calls ${edgeCounts.calls}, inherits ${edgeCounts.inherits}, contains ${edgeCounts.contains}`,
		`- **Communities:** ${communities.length} (${methodLabel}, top ${communities.length} shown)`,
		'',
		'## Top Hub Nodes (by connection degree)',
		...hubNodes.map((h, i) => {
			const label = h.symbolName ?? path.basename(h.filePath);
			return `${i + 1}. **${label}** (degree ${h.degree}) — \`${h.filePath}\``;
		}),
		'',
		`## Top Communities (${methodLabel})`,
		...communities.slice(0, 8).map((c, i) => `${i + 1}. **${c.label}** (${c.size} nodes)`),
	];
	return lines.join('\n');
}

/** Undirected degree from import/call edges (each endpoint +1). */
export function computeNodeDegrees(graph: CodeGraph): Record<string, number> {
	const degrees: Record<string, number> = {};
	for (const edge of graph.edges) {
		degrees[edge.from] = (degrees[edge.from] ?? 0) + 1;
		degrees[edge.to] = (degrees[edge.to] ?? 0) + 1;
	}
	return degrees;
}

export interface CodeGraphSymbolLocation {
	filePath: string;
	startLine: number;
	symbolName: string;
	symbolType?: string;
}

/** Map lowercase symbol name → definition locations (from full graph, for search navigation). */
export function buildSymbolSearchIndex(graph: CodeGraph): Record<string, CodeGraphSymbolLocation[]> {
	// Plain {} breaks when symbol names collide with Object.prototype keys (e.g. "constructor").
	const index: Record<string, CodeGraphSymbolLocation[]> = Object.create(null) as Record<string, CodeGraphSymbolLocation[]>;
	for (const node of Object.values(graph.nodes)) {
		if (!node.symbolName || node.symbolType === 'file' || node.id.endsWith('::file')) {
			continue;
		}
		const key = node.symbolName.toLowerCase();
		const list = index[key] ?? [];
		list.push({
			filePath: node.filePath,
			startLine: node.startLine ?? 1,
			symbolName: node.symbolName,
			symbolType: node.symbolType,
		});
		index[key] = list;
	}
	return index;
}

/** Map normalized file path → symbol names defined in that file (for file-level graph search). */
export function buildFileSymbolIndex(graph: CodeGraph): Record<string, string[]> {
	const index: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
	for (const node of Object.values(graph.nodes)) {
		if (!node.symbolName || node.symbolType === 'file' || node.id.endsWith('::file')) {
			continue;
		}
		const fp = path.normalize(node.filePath);
		const list = index[fp] ?? [];
		if (!list.includes(node.symbolName)) {
			list.push(node.symbolName);
		}
		index[fp] = list;
	}
	return index;
}

/** Collapse symbol graph to file nodes + cross-file edges for webview rendering. */
export function buildFileLevelDisplayGraph(graph: CodeGraph): CodeGraph {
	const result = createEmptyCodeGraph();
	const filePaths = new Set<string>();
	const symbolsByFile = buildFileSymbolIndex(graph);
	for (const node of Object.values(graph.nodes)) {
		filePaths.add(path.normalize(node.filePath));
	}
	for (const fp of filePaths) {
		ensureNode(result, {
			id: fileNodeId(fp),
			filePath: fp,
			symbolType: 'file',
			containedSymbolNames: symbolsByFile[fp] ?? [],
		});
	}
	const seenPairs = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.kind === 'contains') {
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
		const fromId = fileNodeId(fromFile);
		const toId = fileNodeId(toFile);
		const pairKey = `${fromId}|${toId}|${edge.kind}`;
		if (seenPairs.has(pairKey)) {
			continue;
		}
		seenPairs.add(pairKey);
		addEdge(result, fromId, toId, edge.kind);
	}
	return result;
}

/** Keep high-degree file nodes and their direct neighbors when the file graph is still too large. */
export function sampleFileLevelDisplayGraph(graph: CodeGraph, maxNodes = GRAPH_VIEW_MAX_FILE_NODES): CodeGraph {
	const nodeCount = Object.keys(graph.nodes).length;
	if (nodeCount <= maxNodes) {
		return graph;
	}
	const degrees = computeNodeDegrees(graph);
	const seedIds = Object.entries(degrees)
		.sort((a, b) => b[1] - a[1])
		.slice(0, maxNodes)
		.map(([id]) => id);
	const keep = new Set<string>(seedIds);
	for (const id of seedIds) {
		for (const neighbor of graph.adjacency[id] ?? []) {
			if (keep.size >= maxNodes) {
				break;
			}
			keep.add(neighbor);
		}
	}
	const result = createEmptyCodeGraph();
	for (const id of keep) {
		const node = graph.nodes[id];
		if (node) {
			ensureNode(result, node);
		}
	}
	for (const edge of graph.edges) {
		if (keep.has(edge.from) && keep.has(edge.to)) {
			addEdge(result, edge.from, edge.to, edge.kind);
		}
	}
	return result;
}

function extractSubgraph(graph: CodeGraph, keepIds: Set<string>): CodeGraph {
	const result = createEmptyCodeGraph();
	for (const id of keepIds) {
		const node = graph.nodes[id];
		if (node) {
			ensureNode(result, node);
		}
	}
	for (const edge of graph.edges) {
		if (keepIds.has(edge.from) && keepIds.has(edge.to)) {
			addEdge(result, edge.from, edge.to, edge.kind);
		}
	}
	return result;
}

/** Target file's symbols plus direct graph neighbors (for off-view search drill-down). */
export function buildFocusFileDisplayGraph(
	graph: CodeGraph,
	filePath: string,
	maxNodes = GRAPH_VIEW_MAX_SYMBOL_NODES,
	allowedEdgeKinds?: CodeGraphEdgeKind[],
): CodeGraph {
	const normalized = path.normalize(filePath);
	const targetIds = new Set<string>();
	for (const [id, node] of Object.entries(graph.nodes)) {
		if (path.normalize(node.filePath) === normalized && !id.endsWith('::file')) {
			targetIds.add(id);
		}
	}
	if (targetIds.size === 0) {
		targetIds.add(fileNodeId(normalized));
	}
	const keep = new Set<string>(targetIds);

	// Build custom adjacency if allowedEdgeKinds is specified
	let adjacency = graph.adjacency;
	if (allowedEdgeKinds) {
		const kindSet = new Set(allowedEdgeKinds);
		adjacency = {};
		for (const id of Object.keys(graph.nodes)) {
			adjacency[id] = [];
		}
		for (const edge of graph.edges) {
			if (kindSet.has(edge.kind)) {
				const fromList = adjacency[edge.from] ?? [];
				if (!fromList.includes(edge.to)) {
					fromList.push(edge.to);
				}
				adjacency[edge.from] = fromList;
				const toList = adjacency[edge.to] ?? [];
				if (!toList.includes(edge.from)) {
					toList.push(edge.from);
				}
				adjacency[edge.to] = toList;
			}
		}
	}

	let currentQueue = Array.from(targetIds);
	const maxHops = 15;
	for (let hop = 0; hop < maxHops; hop++) {
		const nextQueue: string[] = [];
		for (const id of currentQueue) {
			for (const neighborId of adjacency[id] ?? []) {
				if (!keep.has(neighborId)) {
					if (keep.size >= maxNodes) {
						break;
					}
					keep.add(neighborId);
					nextQueue.push(neighborId);
				}
			}
			if (keep.size >= maxNodes) {
				break;
			}
		}
		if (nextQueue.length === 0 || keep.size >= maxNodes) {
			break;
		}
		currentQueue = nextQueue;
	}

	return extractSubgraph(graph, keep);
}

/** Keep all nodes; retain only selected edge kinds (call-graph view keeps nodes visible). */
export function filterGraphEdgeKinds(graph: CodeGraph, kinds: CodeGraphEdgeKind[]): CodeGraph {
	const kindSet = new Set(kinds);
	const result = createEmptyCodeGraph();
	for (const node of Object.values(graph.nodes)) {
		ensureNode(result, node);
	}
	for (const edge of graph.edges) {
		if (kindSet.has(edge.kind)) {
			addEdge(result, edge.from, edge.to, edge.kind);
		}
	}
	return result;
}

/** Rebuild adjacency from edges (e.g. after loading legacy code_graph_map.json). */
export function rebuildGraphAdjacency(graph: CodeGraph): void {
	graph.adjacency = {};
	for (const id of Object.keys(graph.nodes)) {
		graph.adjacency[id] = [];
	}
	for (const edge of graph.edges) {
		const fromList = graph.adjacency[edge.from] ?? [];
		if (!fromList.includes(edge.to)) {
			fromList.push(edge.to);
		}
		graph.adjacency[edge.from] = fromList;
		const toList = graph.adjacency[edge.to] ?? [];
		if (!toList.includes(edge.from)) {
			toList.push(edge.from);
		}
		graph.adjacency[edge.to] = toList;
	}
}

export function ensureGraphAdjacency(graph: CodeGraph): void {
	const edgeCount = graph.edges.length;
	const adjCount = Object.values(graph.adjacency ?? {}).reduce((n, list) => n + list.length, 0);
	if (edgeCount > 0 && adjCount === 0) {
		rebuildGraphAdjacency(graph);
	}
}

export function simplifyGraphForView(
	graph: CodeGraph,
	maxSymbolNodes = GRAPH_VIEW_MAX_SYMBOL_NODES,
	maxFileNodes = GRAPH_VIEW_MAX_FILE_NODES,
): { graph: CodeGraph; viewMode: CodeGraphViewMode } {
	const totalNodeCount = Object.keys(graph.nodes).length;
	if (totalNodeCount <= maxSymbolNodes) {
		return { graph, viewMode: 'full' };
	}
	let display = buildFileLevelDisplayGraph(graph);
	let viewMode: CodeGraphViewMode = 'file';
	if (Object.keys(display.nodes).length > maxFileNodes) {
		display = sampleFileLevelDisplayGraph(display, maxFileNodes);
		viewMode = 'file-sampled';
	}
	return { graph: display, viewMode };
}

export function buildCodeGraphViewPayload(
	graph: CodeGraph,
	hubLimit = 8,
	options?: CodeGraphViewOptions,
): CodeGraphViewPayload {
	ensureGraphAdjacency(graph);
	const totalNodeCount = Object.keys(graph.nodes).length;
	const fileSymbolIndex = buildFileSymbolIndex(graph);
	const symbolSearchIndex = buildSymbolSearchIndex(graph);
	const displayScope = options?.displayScope ?? 'overview';
	const focusFilePath = options?.focusFilePath ? path.normalize(options.focusFilePath) : undefined;

	let sourceGraph = graph;
	if (focusFilePath) {
		const allowedKinds = displayScope === 'calls' ? ['calls', 'inherits'] as CodeGraphEdgeKind[] : undefined;
		sourceGraph = buildFocusFileDisplayGraph(graph, focusFilePath, GRAPH_VIEW_MAX_SYMBOL_NODES, allowedKinds);
	}

	let displayGraph: CodeGraph;
	let viewMode: CodeGraphViewMode;

	if (displayScope === 'symbols' || displayScope === 'calls' || focusFilePath) {
		const symbolCount = Object.keys(sourceGraph.nodes).length;
		if (symbolCount <= GRAPH_VIEW_MAX_SYMBOL_NODES) {
			displayGraph = sourceGraph;
			viewMode = focusFilePath ? 'focus-symbol' : 'full';
		} else {
			displayGraph = buildFileLevelDisplayGraph(sourceGraph);
			viewMode = 'file';
		}
	} else {
		({ graph: displayGraph, viewMode } = simplifyGraphForView(sourceGraph));
	}

	let callsFilterActive = false;
	if (displayScope === 'calls') {
		displayGraph = filterGraphEdgeKinds(displayGraph, ['calls', 'inherits']);
		callsFilterActive = true;
	}

	// Safety: never return an empty canvas when the index has data (e.g. calls filter with no call edges).
	if (Object.keys(displayGraph.nodes).length === 0 && totalNodeCount > 0) {
		if (focusFilePath) {
			({ graph: displayGraph, viewMode } = simplifyGraphForView(graph));
		} else if (callsFilterActive) {
			({ graph: displayGraph, viewMode } = simplifyGraphForView(sourceGraph));
		}
		callsFilterActive = false;
	}

	const nodeDegrees = computeNodeDegrees(displayGraph);
	const hubNodes = Object.entries(nodeDegrees)
		.sort((a, b) => b[1] - a[1])
		.slice(0, hubLimit)
		.map(([id, degree]) => {
			const node = displayGraph.nodes[id];
			return {
				id,
				degree,
				filePath: node?.filePath ?? id,
				symbolName: node?.symbolName,
				symbolType: node?.symbolType,
			};
		});
	const communityResult = computeGraphCommunities(displayGraph);
	let architectureReport = buildGraphArchitectureReport(
		displayGraph,
		hubNodes,
		communityResult.communities,
		communityResult.method,
		communityResult.graphModularity,
	);
	if (viewMode !== 'full') {
		const modeLabel = viewMode === 'file'
			? 'file-level'
			: viewMode === 'focus-symbol'
				? `symbol focus (${path.basename(focusFilePath ?? '')})`
				: 'sampled file-level';
		architectureReport += `\n\n> **Display note:** Showing ${Object.keys(displayGraph.nodes).length} of ${totalNodeCount} indexed nodes (${modeLabel} view for performance).`;
	}
	if (displayScope === 'calls' && callsFilterActive) {
		architectureReport += '\n\n> **Edge filter:** calls + inheritance only (imports/contains hidden).';
	} else if (displayScope === 'calls') {
		architectureReport += '\n\n> **Note:** No call/inheritance edges in current view — showing unfiltered graph.';
	}
	return {
		graph: displayGraph,
		nodeDegrees,
		hubNodes,
		communities: communityResult.communities,
		nodeCommunity: communityResult.nodeCommunity,
		communityColors: communityResult.communityColors,
		communityMethod: communityResult.method,
		graphModularity: communityResult.graphModularity,
		architectureReport,
		viewMode,
		displayScope,
		focusFilePath,
		initialSearchQuery: options?.pendingSearchQuery,
		totalNodeCount,
		fileSymbolIndex,
		symbolSearchIndex,
	};
}
