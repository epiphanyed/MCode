/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { SparseVectorDic } from './milvusConstants.js';

const SPARSE_VOCAB_SIZE = 1 << 20;

const TOKEN_REGEX = /[A-Za-z_$][\w$]{1,64}|[0-9a-f]{7,40}|[A-Z][A-Z0-9_]{2,}/g;

function hashToken(token: string): number {
	let hash = 2166136261;
	for (let i = 0; i < token.length; i++) {
		hash ^= token.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % SPARSE_VOCAB_SIZE;
}

export function tokenizeForSparse(text: string): string[] {
	const tokens: string[] = [];
	let match: RegExpExecArray | null;
	TOKEN_REGEX.lastIndex = 0;
	while ((match = TOKEN_REGEX.exec(text)) !== null) {
		tokens.push(match[0].toLowerCase());
	}
	return tokens;
}

/** Simple TF sparse vector for Milvus hybrid search (BM25-like keyword recall). */
export function encodeSparseVector(text: string): SparseVectorDic {
	const sparse: SparseVectorDic = {};
	const tokens = tokenizeForSparse(text);
	if (tokens.length === 0) {
		return sparse;
	}
	const tf = new Map<number, number>();
	for (const token of tokens) {
		const index = hashToken(token);
		tf.set(index, (tf.get(index) ?? 0) + 1);
	}
	const maxTf = Math.max(...tf.values());
	for (const [index, count] of tf) {
		sparse[index] = count / maxTf;
	}
	return sparse;
}
