/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { SemanticCodeChunk } from './semanticCodeChunker.js';

/** Max lines scanned upward when attaching doc comments to a symbol. */
export const MAX_LEADING_COMMENT_LINES = 40;

/** Blank lines allowed between the last comment line and the symbol. */
export const MAX_BLANK_LINES_BEFORE_SYMBOL = 1;

function isSymbolLeadingCommentLine(line: string, trimmed: string): boolean {
	if (/^\s*\/\//.test(line)) {
		return true;
	}
	if (/^\s*\/\*/.test(line)) {
		return true;
	}
	if (/^\s*\*\//.test(trimmed)) {
		return true;
	}
	if (/^\s*\*/.test(line)) {
		return true;
	}
	if (/^\s*\/\/\//.test(line)) {
		return true;
	}
	if (/^\s*#/.test(line) && !/^#!/.test(trimmed)) {
		return true;
	}
	if (/^\s*%/.test(line)) {
		return true;
	}
	return false;
}

/**
 * Find the first line (1-based) of leading doc/comment lines immediately above a symbol.
 */
export function findLeadingCommentStartLine(lines: string[], symbolStartLine: number): number {
	if (symbolStartLine <= 1) {
		return symbolStartLine;
	}

	let commentStart = symbolStartLine;
	let lineIdx = symbolStartLine - 2;
	let blankGap = 0;

	while (lineIdx >= 0 && symbolStartLine - (lineIdx + 1) <= MAX_LEADING_COMMENT_LINES) {
		const line = lines[lineIdx];
		const trimmed = line.trim();

		if (trimmed === '') {
			if (blankGap >= MAX_BLANK_LINES_BEFORE_SYMBOL) {
				break;
			}
			blankGap++;
			lineIdx--;
			continue;
		}

		blankGap = 0;

		if (!isSymbolLeadingCommentLine(line, trimmed)) {
			break;
		}

		if (/^\s*\*/.test(line) && !/^\s*\/\*/.test(line)) {
			let blockStart = lineIdx;
			while (blockStart > 0 && !/^\s*\/\*/.test(lines[blockStart])) {
				blockStart--;
			}
			commentStart = blockStart + 1;
			lineIdx = blockStart - 1;
			continue;
		}

		commentStart = lineIdx + 1;
		lineIdx--;
	}

	return commentStart;
}

export function extendChunkWithLeadingComments(
	content: string,
	chunk: Pick<SemanticCodeChunk, 'text' | 'symbolType' | 'symbolName' | 'startLine' | 'endLine' | 'partIndex' | 'partTotal'>,
): SemanticCodeChunk {
	if (chunk.symbolType === 'file') {
		return { ...chunk };
	}

	const lines = content.split('\n');
	const newStartLine = findLeadingCommentStartLine(lines, chunk.startLine);
	if (newStartLine >= chunk.startLine) {
		return { ...chunk };
	}

	const text = lines.slice(newStartLine - 1, chunk.endLine).join('\n').trim();
	return {
		...chunk,
		text,
		startLine: newStartLine,
	};
}

export function applyLeadingCommentsToChunks(content: string, chunks: SemanticCodeChunk[]): SemanticCodeChunk[] {
	return chunks.map(chunk => extendChunkWithLeadingComments(content, chunk));
}
