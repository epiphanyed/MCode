/*--------------------------------------------------------------------------------------

 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.

 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.

 *--------------------------------------------------------------------------------------*/



/** Max chars per console.log line chunk when redirecting to a file (full body is split, never dropped). */

export const LOG_CHUNK_SIZE = 12_000;



/** @deprecated Use {@link LOG_CHUNK_SIZE}. */

export const RAG_LOG_BODY_MAX = LOG_CHUNK_SIZE;



/**

 * Log long text without dropping content: one line if short, otherwise sequential [part i/n] chunks.

 */

function isTestEnv(): boolean {
	return typeof (globalThis as any).suite === 'function' || typeof (globalThis as any).test === 'function';
}

export function logLongText(tag: string, text: string | null | undefined, chunkSize = LOG_CHUNK_SIZE): void {

	if (isTestEnv()) {
		return;
	}

	const body = text ?? '';

	if (body.length === 0) {

		console.log(`${tag}: (empty)`);

		return;

	}

	if (body.length <= chunkSize) {

		console.log(`${tag} chars=${body.length}:\n${body}`);

		return;

	}

	const parts = Math.ceil(body.length / chunkSize);

	console.log(`${tag} chars=${body.length} (${parts} parts, full body below):`);

	for (let i = 0; i < parts; i++) {

		const chunk = body.slice(i * chunkSize, (i + 1) * chunkSize);

		console.log(`${tag} [part ${i + 1}/${parts}]:\n${chunk}`);

	}

}



export function ragLogStage(stage: string, message: string): void {

	if (isTestEnv()) {
		return;
	}

	console.log(`[RAG][${stage}] ${message}`);

}



export function ragLogElapsed(stage: string, label: string, startMs: number): void {

	if (isTestEnv()) {
		return;
	}

	console.log(`[RAG][${stage}] ${label} +${Date.now() - startMs}ms`);

}



export function ragLogJson(stage: string, label: string, value: unknown): void {

	let json: string;

	try {

		json = JSON.stringify(value, null, 2);

	} catch {

		json = String(value);

	}

	logLongText(`[RAG][${stage}] ${label}`, json);

}



/** Log a full text body for a pipeline stage (never truncated — only split across log lines). */

export function ragLogBody(stage: string, label: string, text: string | null | undefined): void {

	logLongText(`[RAG][${stage}] ${label}`, text);

}



/** @deprecated Use {@link ragLogBody}. */

export function ragLogPreview(stage: string, label: string, text: string | null | undefined, _chunkSize?: number): void {

	ragLogBody(stage, label, text);

}



export interface RagRetrievedNodeSummaryInput {

	node: { id_?: string; metadata?: Record<string, unknown> };

	score: number;

}



/** One-line metadata per node (all nodes, no cap). */

export function summarizeRetrievedNodes(nodes: RagRetrievedNodeSummaryInput[]): string {

	if (nodes.length === 0) {

		return '(none)';

	}

	return nodes.map((n, i) => {

		const meta = n.node.metadata ?? {};

		const filePath = String(meta.filePath ?? n.node.id_ ?? '?');

		const docType = String(meta.docType ?? '');

		const startLine = meta.startLine;

		const endLine = meta.endLine;

		const loc = startLine != null && endLine != null ? `:${startLine}-${endLine}` : '';

		return `#${i} score=${n.score.toFixed(3)} type=${docType} ${filePath}${loc}`;

	}).join('\n  ');

}



/** Log every retrieved node with full text content (for redirected diagnostic logs). */

export function ragLogNodes<T extends RagRetrievedNodeSummaryInput>(

	stage: string,

	label: string,

	nodes: T[],

	contentFor: (node: T, index: number) => string,

): void {

	ragLogStage(stage, `${label}: count=${nodes.length}`);

	if (nodes.length === 0) {

		return;

	}

	const parts = nodes.map((n, i) => {

		const meta = n.node.metadata ?? {};

		const filePath = String(meta.filePath ?? n.node.id_ ?? '?');

		const docType = String(meta.docType ?? '');

		const startLine = meta.startLine;

		const endLine = meta.endLine;

		const loc = startLine != null && endLine != null ? `:${startLine}-${endLine}` : '';

		const header = `#${i} score=${n.score.toFixed(3)} type=${docType} ${filePath}${loc}`;

		const content = contentFor(n, i);

		return content ? `${header}\n${content}` : header;

	});

	ragLogBody(stage, label, parts.join('\n---\n'));

}


