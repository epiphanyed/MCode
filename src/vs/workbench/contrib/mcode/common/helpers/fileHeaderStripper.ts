/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Max lines scanned when detecting a leading license/copyright banner. */
export const MAX_FILE_HEADER_LINES = 80;

const HEADER_KEYWORD =
	/(?:copyright|©|\(c\)|license|licensed under|all rights reserved|spdx-license-identifier|permission is hereby|redistribution|without warranty|@file\b|@author\b|@copyright\b|@license\b|apache license|mit license|mozilla public)/i;

export interface FileHeaderStripResult {
	/** Content with leading header removed (may equal input). */
	body: string;
	/** Number of lines removed from the top of the original file. */
	headerLineCount: number;
}

function isDecorativeCommentLine(trimmed: string): boolean {
	if (/^(\/\/|#)[-=/*\s]{4,}$/.test(trimmed)) {
		return true;
	}
	if (/^\/\/-{3,}/.test(trimmed)) {
		return true;
	}
	if (/^\*\s*[-=]{3,}\s*$/.test(trimmed)) {
		return true;
	}
	return false;
}

function looksLikeCodeLine(trimmed: string): boolean {
	if (/^(import|export|package|using|namespace|#pragma|#include|#ifndef|#define|@(?:interface|implementation|class)\b|module\b|class\b|struct\b|enum\b|function\b|def\b|public\b|private\b|protected\b)/.test(trimmed)) {
		return true;
	}
	if (/^[\w$][\w$.<>,\s]*\s+[\w$]+\s*\(/.test(trimmed)) {
		return true;
	}
	return false;
}

function isHeaderCommentLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return true;
	}
	if (HEADER_KEYWORD.test(line)) {
		return true;
	}
	if (isDecorativeCommentLine(trimmed)) {
		return true;
	}
	if (/^\s*(\/\/|#|\/\*|\*|\*\/)/.test(line)) {
		return !looksLikeCodeLine(trimmed);
	}
	return false;
}

function regionLooksLikeHeader(region: string): boolean {
	return HEADER_KEYWORD.test(region);
}

/**
 * Detect and remove leading copyright / license file headers.
 * Used for RAG indexing and read_file tool output to LLM.
 */
export function stripLeadingFileHeader(content: string): FileHeaderStripResult {
	const lines = content.split('\n');
	if (lines.length === 0) {
		return { body: content, headerLineCount: 0 };
	}

	let end = 0;
	while (end < lines.length && lines[end].trim() === '') {
		end++;
	}
	if (end >= lines.length) {
		return { body: content, headerLineCount: 0 };
	}

	const scanStart = end;
	let cursor = end;

	if (/^\s*\/\*/.test(lines[cursor])) {
		let blockEnd = cursor;
		while (blockEnd < lines.length && !/\*\//.test(lines[blockEnd])) {
			blockEnd++;
		}
		if (blockEnd < lines.length) {
			blockEnd++;
		}
		const block = lines.slice(cursor, blockEnd).join('\n');
		if (regionLooksLikeHeader(block)) {
			cursor = blockEnd;
			while (cursor < lines.length && lines[cursor].trim() === '') {
				cursor++;
			}
		}
	}

	while (cursor < lines.length && cursor - scanStart < MAX_FILE_HEADER_LINES) {
		const line = lines[cursor];
		if (line.trim() === '') {
			cursor++;
			continue;
		}
		if (isHeaderCommentLine(line)) {
			cursor++;
			continue;
		}
		break;
	}

	if (cursor <= scanStart) {
		return { body: content, headerLineCount: 0 };
	}

	const strippedRegion = lines.slice(scanStart, cursor).join('\n');
	if (!regionLooksLikeHeader(strippedRegion)) {
		return { body: content, headerLineCount: 0 };
	}

	const body = lines.slice(cursor).join('\n');
	return { body, headerLineCount: cursor };
}

export function offsetChunkLineNumbers<T extends { startLine: number; endLine: number }>(
	chunks: T[],
	lineOffset: number,
): T[] {
	if (lineOffset <= 0) {
		return chunks;
	}
	return chunks.map(chunk => ({
		...chunk,
		startLine: chunk.startLine + lineOffset,
		endLine: chunk.endLine + lineOffset,
	}));
}

/** Strip header when reading from the start of a file; add a short omission note for the LLM. */
export function stripFileHeaderForToolOutput(content: string, fromStartOfFile: boolean): string {
	if (!fromStartOfFile) {
		return content;
	}
	const { body, headerLineCount } = stripLeadingFileHeader(content);
	if (headerLineCount <= 0) {
		return content;
	}
	return `/* (${headerLineCount} lines of copyright/license header omitted) */\n\n${body}`;
}
