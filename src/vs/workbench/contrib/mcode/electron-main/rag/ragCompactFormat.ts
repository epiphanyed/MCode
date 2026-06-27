/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

const DEFAULT_MAX_LINES = 48;
const HEAD_LINES = 28;
const TAIL_LINES = 8;

function collapseLargeBraces(text: string): string {
	return text.replace(/\{[\s\S]*?\}/g, block => {
		if (block.length <= 160 || block.split('\n').length <= 4) {
			return block;
		}
		const lines = block.split('\n');
		const open = lines[0] ?? '{';
		const close = lines[lines.length - 1] ?? '}';
		return `${open}\n  /* ... ${lines.length - 2} lines ... */\n${close}`;
	});
}

/** Compact long code chunks for RAG injection (CTX-C3). */
export function compactCodeContent(text: string, maxLines = DEFAULT_MAX_LINES): string {
	const trimmed = text.trim();
	if (!trimmed) {
		return trimmed;
	}
	const lines = trimmed.split('\n');
	let body = trimmed;
	if (lines.length > maxLines) {
		const head = lines.slice(0, HEAD_LINES).join('\n');
		const tail = lines.slice(-TAIL_LINES).join('\n');
		const omitted = lines.length - HEAD_LINES - TAIL_LINES;
		body = `${head}\n/* ... ${omitted} lines omitted ... */\n${tail}`;
	}
	return collapseLargeBraces(body);
}
