/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RagContextBundle, RagContextMergeOptions, RagContextMergeResult } from '../mcodeRagTypes.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { ragLogBody, ragLogStage } from './ragDebugLog.js';

export const DEFAULT_MAX_TOTAL_CHARS = 12_000;
export const DEFAULT_LSP_BUDGET_RATIO = 0.3;
export const DEFAULT_GIT_MAX_CHARS = 2_000;
const NO_CONTEXT_PREFIX = 'No context found';

/** Split vector context into independently budgeted chunks. */
const VECTOR_CHUNK_SPLIT_RE = /\n+(?=(?:--- (?:FILE|GRAPH \w+|LINKED CODE):|## ))/;

const GIT_CHUNK_HEADER_RE = /^## (?:Unstaged|Staged|Diff|Recent commits|Git status)/;

function normalizeForDedup(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').toLowerCase();
}

function isNearDuplicate(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	const shorter = a.length <= b.length ? a : b;
	const longer = a.length <= b.length ? b : a;
	if (!shorter || !longer.includes(shorter)) {
		return false;
	}
	return shorter.length / longer.length >= 0.7;
}

function dedupeLspSnippets(snippets: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const snippet of snippets) {
		const trimmed = snippet.trim();
		if (!trimmed) {
			continue;
		}
		const key = normalizeForDedup(trimmed);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(trimmed);
	}
	return unique;
}

function buildLspSection(snippets: string[], budget: number): { text: string; keys: Set<string> } {
	const keys = new Set<string>();
	const parts: string[] = [];
	let used = 0;
	for (const snippet of snippets) {
		const block = snippet + '\n\n';
		if (used + block.length > budget) {
			break;
		}
		parts.push(snippet);
		keys.add(normalizeForDedup(snippet));
		used += block.length;
	}
	return { text: parts.join('\n\n'), keys };
}

export function filePathsFromStagingSelections(selections: StagingSelectionItem[] | null | undefined): string[] {
	if (!selections?.length) {
		return [];
	}
	const paths = new Set<string>();
	for (const s of selections) {
		paths.add(s.uri.fsPath);
	}
	return [...paths];
}

export function splitVectorContext(vector: string): string[] {
	if (!vector.trim()) {
		return [];
	}
	return vector.split(VECTOR_CHUNK_SPLIT_RE).map(c => c.trim()).filter(Boolean);
}

export function isGitContextChunk(chunk: string): boolean {
	if (GIT_CHUNK_HEADER_RE.test(chunk)) {
		return true;
	}
	if (chunk.startsWith('--- FILE:') || chunk.startsWith('--- GRAPH') || chunk.startsWith('--- LINKED CODE:')) {
		return false;
	}
	return /git diff|git log|uncommitted changes|working tree/i.test(chunk);
}

export function extractFilePathFromChunk(chunk: string): string | undefined {
	const match = chunk.match(/^--- (?:FILE|GRAPH \w+|LINKED CODE): ([^\s(]+)/);
	return match?.[1];
}

export function isExcludedFilePath(filePath: string, excludeFilePaths: string[]): boolean {
	if (!excludeFilePaths.length) {
		return false;
	}
	const norm = normalizePath(filePath);
	for (const excluded of excludeFilePaths) {
		const exNorm = normalizePath(excluded);
		if (norm === exNorm || norm.startsWith(`${exNorm}/`) || exNorm.endsWith(`/${norm}`)) {
			return true;
		}
	}
	return false;
}

function partitionVectorChunks(vector: string): { gitChunks: string[]; codeChunks: string[] } {
	const gitChunks: string[] = [];
	const codeChunks: string[] = [];
	for (const chunk of splitVectorContext(vector)) {
		if (isGitContextChunk(chunk)) {
			gitChunks.push(chunk);
		} else {
			codeChunks.push(chunk);
		}
	}
	return { gitChunks, codeChunks };
}

function fillChunksWithinBudget(
	chunks: string[],
	budget: number,
	opts: {
		lspKeys: Set<string>;
		excludeFilePaths: string[];
	},
): string {
	const kept: string[] = [];
	let used = 0;
	for (const chunk of chunks) {
		const filePath = extractFilePathFromChunk(chunk);
		if (filePath && isExcludedFilePath(filePath, opts.excludeFilePaths)) {
			continue;
		}

		const body = chunk.replace(/^--- (?:FILE|GRAPH \w+|LINKED CODE):[^\n]*---\n?/, '');
		const bodyKey = normalizeForDedup(body);
		let duplicate = opts.lspKeys.has(bodyKey);
		if (!duplicate) {
			for (const lspKey of opts.lspKeys) {
				if (isNearDuplicate(bodyKey, lspKey)) {
					duplicate = true;
					break;
				}
			}
		}
		if (duplicate) {
			continue;
		}

		const separator = kept.length ? 2 : 0;
		const remaining = budget - used - separator;
		if (remaining <= 0) {
			break;
		}
		if (chunk.length <= remaining) {
			kept.push(chunk);
			used += separator + chunk.length;
		} else {
			kept.push(chunk.slice(0, remaining));
			break;
		}
	}
	return kept.join('\n\n');
}

export function mergeRagContexts(
	bundle: RagContextBundle,
	options?: RagContextMergeOptions,
): RagContextMergeResult {
	const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
	const lspBudgetRatio = options?.lspBudgetRatio ?? DEFAULT_LSP_BUDGET_RATIO;
	const gitMaxChars = options?.gitMaxChars ?? DEFAULT_GIT_MAX_CHARS;
	const excludeFilePaths = bundle.excludeFilePaths ?? options?.excludeFilePaths ?? [];

	let vector = bundle.vectorContext?.trim() ?? '';
	if (vector.startsWith(NO_CONTEXT_PREFIX)) {
		vector = '';
	}

	const { gitChunks, codeChunks } = partitionVectorChunks(vector);
	ragLogStage(
		'merge',
		`input vectorChars=${vector.length} lspSnippets=${bundle.lspSnippets.length} `
		+ `gitChunks=${gitChunks.length} codeChunks=${codeChunks.length} maxTotal=${maxTotalChars}`,
	);
	if (vector) {
		ragLogBody('merge', 'input vectorContext (full)', vector);
	}
	for (let i = 0; i < bundle.lspSnippets.length; i++) {
		ragLogBody('merge', `input lspSnippet[${i}] (full)`, bundle.lspSnippets[i]);
	}
	const gitText = fillChunksWithinBudget(gitChunks, gitMaxChars, {
		lspKeys: new Set(),
		excludeFilePaths: [],
	});

	const afterGitBudget = Math.max(0, maxTotalChars - gitText.length);
	const lspBudget = Math.floor(afterGitBudget * lspBudgetRatio);
	const vectorBudget = afterGitBudget - lspBudget;

	const uniqueLsp = dedupeLspSnippets(bundle.lspSnippets);
	const { text: lspText, keys: lspKeys } = buildLspSection(uniqueLsp, lspBudget);

	const vectorText = fillChunksWithinBudget(codeChunks, vectorBudget, {
		lspKeys,
		excludeFilePaths,
	});

	const sections: string[] = [];
	if (lspText) {
		sections.push(`[LSP Context]:\n${lspText}`);
	}
	if (gitText) {
		sections.push(`[Git Context]:\n${gitText}`);
	}
	if (vectorText) {
		sections.push(`[RAG Context]:\n${vectorText}`);
	}

	const merged = sections.join('\n\n');
	ragLogStage(
		'merge',
		`budgets lsp=${lspBudget} vector=${vectorBudget} git=${gitMaxChars} `
		+ `out lspChars=${lspText.length} gitChars=${gitText.length} vectorChars=${vectorText.length} total=${merged.length}`,
	);
	if (lspText) {
		ragLogBody('merge', 'LSP section', lspText);
	}
	if (gitText) {
		ragLogBody('merge', 'Git section', gitText);
	}
	if (vectorText) {
		ragLogBody('merge', 'RAG section', vectorText);
	}
	ragLogBody('merge', 'mergedContext', merged);

	return {
		merged,
		hasLsp: !!lspText,
		hasVector: !!vectorText || !!gitText,
	};
}
