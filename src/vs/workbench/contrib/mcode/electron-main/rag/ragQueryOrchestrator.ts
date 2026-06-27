/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import { MetadataMode } from 'llamaindex';
import type { RagQueryOptions } from '../../common/mcodeRagTypes.js';
import { isGitRelatedQuery } from './gitDynamicContext.js';
import { MILVUS_PARTITIONS } from './milvusConstants.js';
import type { RetrievedNode } from './ragReranker.js';
import type { CodeSymbolEntry } from './ragQueryHelpers.js';
import {
	expandGraphNeighbors,
	type CodeGraph,
	type GraphExpansionSeed,
} from './codeGraphBuilder.js';

export type RagRouteTarget = 'code' | 'git' | 'doc' | 'all';

export interface RagOrchestratorOptions {
	/** Split complex queries into sub-questions. Default true. */
	useSubQuestions?: boolean;
	/** Use LLM to split sub-questions (falls back to heuristic). Default false. */
	useLlmSubQuestions?: boolean;
	/** Route retrieval to code/git/doc partitions. Default true. */
	useRouter?: boolean;
	/** Expand vector hits via code graph neighbors. Default true. */
	useGraphExpand?: boolean;
	/** Graph expansion hop count (1–2). Default 1. */
	graphExpandHops?: number;
	/** Max graph-expanded snippets. Default 4. */
	graphExpandMax?: number;
	/** Follow doc linkedFiles to source code. Default true. */
	useDocLinkedCode?: boolean;
	/** Max linked-code snippets from doc hits. Default 3. */
	docLinkedMax?: number;
}

export type RagQueryComplexity = 'simple' | 'complex';

const COMPLEX_RAG_PATTERNS: RegExp[] = [
	/(?:整个|全部|跨(?:模块|文件)|多个模块|架构|依赖图|all\s+(?:files|modules)|across\s+(?:the|multiple)|architecture|dependency\s+graph|refactor\s+(?:the|whole)\s+(?:project|codebase))/i,
	/(?:以及|并且|同时|and\s+also).{12,}/i,
	/\?\s*.*\?/,
];

/** Heuristic: simple explain / short queries skip heavy orchestration (CTX-B1). */
export function classifyRagQueryComplexity(query: string): RagQueryComplexity {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return 'simple';
	}
	if (COMPLEX_RAG_PATTERNS.some(p => p.test(trimmed))) {
		return 'complex';
	}
	if (trimmed.length >= 100 && splitSubQuestions(trimmed).length > 1) {
		return 'complex';
	}
	if (/^(?:解释|说明|翻译|what\s+is|what's|explain|describe|how\s+to\s+read|简要)/i.test(trimmed)) {
		return 'simple';
	}
	if (trimmed.length <= 80) {
		return 'simple';
	}
	return 'complex';
}

export function applyIntentOrchestration(
	query: string,
	orch: Required<RagOrchestratorOptions>,
	enabled: boolean,
): Required<RagOrchestratorOptions> {
	if (!enabled || classifyRagQueryComplexity(query) === 'complex') {
		return orch;
	}
	return {
		...orch,
		useSubQuestions: false,
		useGraphExpand: false,
	};
}

/** Append a section if it fits the remaining assembly char budget (CTX-B2). */
export function appendSectionWithinBudget(sections: string[], piece: string, budgetRemaining: number): number {
	if (budgetRemaining <= 0 || !piece.trim()) {
		return budgetRemaining;
	}
	const separator = sections.length > 0 ? 2 : 0;
	const need = separator + piece.length;
	if (need > budgetRemaining) {
		return budgetRemaining;
	}
	sections.push(piece);
	return budgetRemaining - need;
}

export const defaultRagOrchestratorOptions: Required<RagOrchestratorOptions> = {
	useSubQuestions: true,
	useLlmSubQuestions: false,
	useRouter: true,
	useGraphExpand: true,
	graphExpandHops: 1,
	graphExpandMax: 4,
	useDocLinkedCode: true,
	docLinkedMax: 3,
};

const DOC_INTENT_PATTERNS: RegExp[] = [
	/\b(?:readme|documentation|docs?|markdown|design\s+doc)\b/i,
	/(?:文档|说明|方案|设计|README|手册|教程)/,
	/\b\.md\b/i,
];

const CODE_INTENT_PATTERNS: RegExp[] = [
	/\b(?:function|class|method|implement|refactor|bug|fix|api|module)\b/i,
	/(?:函数|类|方法|实现|代码|模块|接口|重构|修复)/,
	/\.(?:ts|tsx|js|jsx|cpp|h|hpp|py|c|java)\b/i,
];

const SUBQUESTION_SPLIT = /\s*(?:;|；|以及|并且|(?:,?\s*and\s+)|(?:,\s*同时))\s+/i;

/** Heuristic RouterQueryEngine: route query to code / git / doc index partitions. */
export function routeQueryTargets(query: string): RagRouteTarget[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return ['all'];
	}

	const targets = new Set<RagRouteTarget>();
	if (isGitRelatedQuery(trimmed)) {
		targets.add('git');
	}
	if (DOC_INTENT_PATTERNS.some(p => p.test(trimmed))) {
		targets.add('doc');
	}
	if (CODE_INTENT_PATTERNS.some(p => p.test(trimmed)) || targets.size === 0) {
		targets.add('code');
	}

	if (targets.size >= 3) {
		return ['all'];
	}
	return [...targets];
}

export function targetsToMilvusPartitions(targets: RagRouteTarget[]): string[] {
	if (targets.includes('all')) {
		return Object.values(MILVUS_PARTITIONS);
	}
	const partitions = new Set<string>();
	for (const target of targets) {
		if (target === 'code') {
			partitions.add(MILVUS_PARTITIONS.code_chunk);
		} else if (target === 'git') {
			partitions.add(MILVUS_PARTITIONS.git_commit);
		} else if (target === 'doc') {
			partitions.add(MILVUS_PARTITIONS.doc_chunk);
		}
	}
	return partitions.size > 0 ? [...partitions] : Object.values(MILVUS_PARTITIONS);
}

/** Map router targets to local SQLite doc_type values for filtered vector search. */
export function targetsToLocalDocTypes(targets: RagRouteTarget[]): string[] | undefined {
	if (targets.includes('all')) {
		return undefined;
	}
	const docTypes = new Set<string>();
	for (const target of targets) {
		if (target === 'code') {
			docTypes.add('code_chunk');
		} else if (target === 'git') {
			docTypes.add('git_commit');
		} else if (target === 'doc') {
			docTypes.add('doc_chunk');
		}
	}
	return docTypes.size > 0 ? [...docTypes] : undefined;
}

export function docTypeMatchesRoute(docType: string, targets: RagRouteTarget[]): boolean {
	if (targets.includes('all')) {
		return true;
	}
	if (docType === 'git_commit') {
		return targets.includes('git');
	}
	if (docType === 'doc_chunk') {
		return targets.includes('doc');
	}
	return targets.includes('code');
}

/** Oversample factor for local index when Router post-filters by docType (P10-1). */
export const LOCAL_ROUTER_OVERSAMPLE_FACTOR = 4;
export const LOCAL_ROUTER_OVERSAMPLE_MIN_EXTRA = 8;
export const LOCAL_ROUTER_OVERSAMPLE_MAX = 64;

/**
 * Local VectorStoreIndex has no partitions; retrieve extra candidates before docType filter.
 */
export function computeLocalRouterRetrieveTopK(
	baseTopK: number,
	routeTargets: RagRouteTarget[],
	useRouter: boolean,
): number {
	if (!useRouter || routeTargets.includes('all')) {
		return baseTopK;
	}
	const oversampled = Math.max(baseTopK * LOCAL_ROUTER_OVERSAMPLE_FACTOR, baseTopK + LOCAL_ROUTER_OVERSAMPLE_MIN_EXTRA);
	return Math.min(oversampled, LOCAL_ROUTER_OVERSAMPLE_MAX);
}

export function filterRetrievedByRoute(
	scored: RetrievedNode[],
	routeTargets: RagRouteTarget[],
	maxResults: number,
): RetrievedNode[] {
	if (routeTargets.includes('all')) {
		return scored.slice(0, maxResults);
	}
	const filtered: RetrievedNode[] = [];
	for (const item of scored) {
		const docType = String((item.node.metadata as Record<string, unknown>).docType ?? 'code_chunk');
		if (docTypeMatchesRoute(docType, routeTargets)) {
			filtered.push(item);
			if (filtered.length >= maxResults) {
				break;
			}
		}
	}
	return filtered;
}

/** Heuristic SubQuestionQueryEngine: split multi-clause questions. */
export function splitSubQuestions(query: string, maxParts = 3): string[] {
	const trimmed = query.trim();
	if (trimmed.length < 60) {
		return [trimmed];
	}

	const parts = trimmed
		.split(SUBQUESTION_SPLIT)
		.map(p => p.trim())
		.filter(p => p.length >= 12);

	if (parts.length <= 1) {
		return [trimmed];
	}
	return parts.slice(0, maxParts);
}

export const LLM_SUBQUESTION_TIMEOUT_MS = 8000;

/** Optional LLM sub-question split with heuristic fallback (P10-4). */
export async function splitSubQuestionsWithLlm(
	query: string,
	llmComplete: (prompt: string) => Promise<string>,
	maxParts = 3,
	timeoutMs = LLM_SUBQUESTION_TIMEOUT_MS,
): Promise<string[]> {
	const fallback = splitSubQuestions(query, maxParts);
	if (fallback.length > 1) {
		// still try LLM for potentially better splits on long queries
	} else if (query.trim().length < 60) {
		return fallback;
	}

	try {
		const prompt = [
			'Split the user question into up to',
			String(maxParts),
			'independent search queries for a code repository.',
			'Return one query per line, no numbering or bullets.',
			'Question:',
			query.trim(),
		].join(' ');

		const raw = await Promise.race([
			llmComplete(prompt),
			new Promise<string>((_, reject) => setTimeout(() => reject(new Error('LLM sub-question timeout')), timeoutMs)),
		]);

		const lines = raw
			.split('\n')
			.map(line => line.replace(/^[\d\-*.)]+\s*/, '').trim())
			.filter(line => line.length >= 12);

		if (lines.length >= 2) {
			return lines.slice(0, maxParts);
		}
	} catch {
		// heuristic fallback
	}

	return fallback;
}

export function dedupeRetrievedNodes(nodes: RetrievedNode[]): RetrievedNode[] {
	const seen = new Set<string>();
	const result: RetrievedNode[] = [];
	for (const item of nodes) {
		const id = String(item.node.id_ ?? '');
		const meta = item.node.metadata as Record<string, unknown>;
		const key = id || `${meta.filePath ?? ''}::${meta.startLine ?? ''}::${item.node.getContent(MetadataMode.NONE).slice(0, 80)}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(item);
	}
	return result;
}

function seedsFromRetrievedNodes(nodes: RetrievedNode[]): GraphExpansionSeed[] {
	const seeds: GraphExpansionSeed[] = [];
	for (const { node } of nodes) {
		const meta = node.metadata as Record<string, unknown>;
		if (String(meta.docType ?? '') !== 'code_chunk') {
			continue;
		}
		const filePath = String(meta.filePath ?? '');
		if (!filePath) {
			continue;
		}
		seeds.push({
			filePath,
			startLine: typeof meta.startLine === 'number' ? meta.startLine : undefined,
			symbolName: meta.symbolName ? String(meta.symbolName) : undefined,
		});
	}
	return seeds;
}

export interface GraphExpandedSnippet {
	filePath: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	symbolType?: string;
	text: string;
	kind: string;
}

/** PropertyGraph-style multi-hop expansion after vector retrieval. */
export async function expandRetrievalWithGraph(
	graph: CodeGraph | null,
	retrieved: RetrievedNode[],
	readFileLines: (filePath: string, startLine: number, endLine: number) => Promise<string>,
	maxNeighbors: number,
	hops = 1,
): Promise<GraphExpandedSnippet[]> {
	if (!graph || Object.keys(graph.nodes).length === 0) {
		return [];
	}

	const seeds = seedsFromRetrievedNodes(retrieved);
	if (seeds.length === 0) {
		return [];
	}

	const neighbors = expandGraphNeighbors(graph, seeds, maxNeighbors, hops);
	const snippets: GraphExpandedSnippet[] = [];

	for (const hit of neighbors) {
		try {
			const text = await readFileLines(hit.filePath, hit.startLine, hit.endLine);
			if (!text.trim()) {
				continue;
			}
			snippets.push({
				filePath: hit.filePath,
				startLine: hit.startLine,
				endLine: hit.endLine,
				symbolName: hit.symbolName,
				symbolType: hit.symbolType,
				text: text.trim(),
				kind: hit.kind,
			});
		} catch {
			// skip unreadable neighbors
		}
	}
	return snippets;
}

export function formatGraphExpandedSnippet(snippet: GraphExpandedSnippet): string {
	const label = snippet.symbolName
		? `${snippet.symbolType ?? 'symbol'}: ${snippet.symbolName}`
		: 'related code';
	return `--- GRAPH ${snippet.kind.toUpperCase()}: ${snippet.filePath} (${label}, L${snippet.startLine}-${snippet.endLine}) ---\n${snippet.text}`;
}

/** Collect linkedFiles paths from doc_chunk retrieval hits. */
export function collectLinkedFilesFromDocNodes(nodes: RetrievedNode[], workspaceRoot?: string): string[] {
	const linked = new Set<string>();
	for (const { node } of nodes) {
		const meta = node.metadata as Record<string, unknown>;
		if (String(meta.docType ?? '') !== 'doc_chunk') {
			continue;
		}
		const files = meta.linkedFiles;
		if (!Array.isArray(files)) {
			continue;
		}
		for (const raw of files) {
			const rel = String(raw);
			if (workspaceRoot && !path.isAbsolute(rel)) {
				linked.add(path.normalize(path.join(workspaceRoot, rel)));
			} else {
				linked.add(path.normalize(rel));
			}
		}
	}
	return [...linked];
}

export interface LinkedCodeSnippet {
	filePath: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	text: string;
}

/** Code-Doc hybrid recall: doc mentions → linked source symbols. */
export async function buildLinkedCodeSnippets(
	linkedPaths: string[],
	codeSymbolMap: Record<string, CodeSymbolEntry[]>,
	readFileLines: (filePath: string, startLine: number, endLine: number) => Promise<string>,
	maxSnippets: number,
): Promise<LinkedCodeSnippet[]> {
	const snippets: LinkedCodeSnippet[] = [];

	for (const filePath of linkedPaths) {
		const symbols = codeSymbolMap[filePath];
		if (!symbols?.length) {
			continue;
		}
		const topSymbols = symbols
			.filter(s => s.symbolName && ['function', 'class', 'struct', 'interface'].includes(s.symbolType))
			.slice(0, 2);

		for (const symbol of topSymbols) {
			try {
				const text = await readFileLines(filePath, symbol.startLine, symbol.endLine);
				if (!text.trim()) {
					continue;
				}
				snippets.push({
					filePath,
					startLine: symbol.startLine,
					endLine: symbol.endLine,
					symbolName: symbol.symbolName,
					text: text.trim(),
				});
				if (snippets.length >= maxSnippets) {
					return snippets;
				}
			} catch {
				// skip
			}
		}
	}
	return snippets;
}

export function formatLinkedCodeSnippet(snippet: LinkedCodeSnippet): string {
	const label = snippet.symbolName ?? 'symbol';
	return `--- LINKED CODE: ${snippet.filePath} (${label}, L${snippet.startLine}-${snippet.endLine}) ---\n${snippet.text}`;
}

export function mergeOrchestratorOptions(options?: RagQueryOptions): Required<RagOrchestratorOptions> {
	return {
		...defaultRagOrchestratorOptions,
		useSubQuestions: options?.useSubQuestions ?? defaultRagOrchestratorOptions.useSubQuestions,
		useLlmSubQuestions: options?.useLlmSubQuestions ?? defaultRagOrchestratorOptions.useLlmSubQuestions,
		useRouter: options?.useRouter ?? defaultRagOrchestratorOptions.useRouter,
		useGraphExpand: options?.useGraphExpand ?? defaultRagOrchestratorOptions.useGraphExpand,
		graphExpandHops: options?.graphExpandHops ?? defaultRagOrchestratorOptions.graphExpandHops,
		graphExpandMax: options?.graphExpandMax ?? defaultRagOrchestratorOptions.graphExpandMax,
		useDocLinkedCode: options?.useDocLinkedCode ?? defaultRagOrchestratorOptions.useDocLinkedCode,
		docLinkedMax: options?.docLinkedMax ?? defaultRagOrchestratorOptions.docLinkedMax,
	};
}
