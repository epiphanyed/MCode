/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { MetadataMode, type BaseNode } from 'llamaindex';

export interface RetrievedNode {
	node: BaseNode;
	score: number;
}

const TOKEN_PATTERN = /[a-zA-Z0-9_$.]+/g;

function tokenize(text: string): Set<string> {
	const tokens = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
	return new Set(tokens.filter(t => t.length > 1));
}

function keywordOverlapScore(queryTokens: Set<string>, docTokens: Set<string>): number {
	if (queryTokens.size === 0 || docTokens.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const token of queryTokens) {
		if (docTokens.has(token)) {
			overlap++;
		}
	}
	return overlap / queryTokens.size;
}

function normalizeVectorScore(score: number, min: number, max: number): number {
	if (max <= min) {
		return score;
	}
	return (score - min) / (max - min);
}

/**
 * Hybrid rerank: vector similarity (70%) + keyword overlap (30%).
 */
export function rerankRetrievedNodes(
	query: string,
	results: RetrievedNode[],
	finalTopK: number,
): RetrievedNode[] {
	if (results.length <= finalTopK) {
		return results;
	}

	const queryTokens = tokenize(query);
	const vectorScores = results.map(r => r.score);
	const minScore = Math.min(...vectorScores);
	const maxScore = Math.max(...vectorScores);

	const reranked = results.map(result => {
		const text = result.node.getContent(MetadataMode.NONE);
		const docTokens = tokenize(text);
		const keywordScore = keywordOverlapScore(queryTokens, docTokens);
		const vectorNorm = normalizeVectorScore(result.score, minScore, maxScore);
		const combined = vectorNorm * 0.7 + keywordScore * 0.3;
		return { node: result.node, score: combined };
	});

	reranked.sort((a, b) => b.score - a.score);
	return reranked.slice(0, finalTopK);
}

function filePathFromRetrievedNode(node: BaseNode): string {
	const meta = node.metadata as Record<string, unknown>;
	return String(meta.filePath ?? '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Limit chunks per file for diversity (CTX-C5).
 * Rerank first, then pick up to maxPerFile hits per filePath.
 */
export function applyMMRDiversity(
	results: RetrievedNode[],
	finalTopK: number,
	maxPerFile = 2,
): RetrievedNode[] {
	if (results.length <= finalTopK) {
		return results;
	}
	const selected: RetrievedNode[] = [];
	const perFile = new Map<string, number>();
	const seenIds = new Set<string>();

	for (const item of results) {
		if (selected.length >= finalTopK) {
			break;
		}
		const id = String(item.node.id_ ?? '');
		if (id && seenIds.has(id)) {
			continue;
		}
		const fp = filePathFromRetrievedNode(item.node);
		if (fp) {
			const count = perFile.get(fp) ?? 0;
			if (count >= maxPerFile) {
				continue;
			}
			perFile.set(fp, count + 1);
		}
		selected.push(item);
		if (id) {
			seenIds.add(id);
		}
	}

	if (selected.length < finalTopK) {
		for (const item of results) {
			if (selected.length >= finalTopK) {
				break;
			}
			const id = String(item.node.id_ ?? '');
			if (id && seenIds.has(id)) {
				continue;
			}
			selected.push(item);
			if (id) {
				seenIds.add(id);
			}
		}
	}
	return selected;
}
