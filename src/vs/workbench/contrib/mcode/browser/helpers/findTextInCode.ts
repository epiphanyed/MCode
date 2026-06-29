/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type FindTextInCodeResult = readonly [startLine: number, endLine: number] | 'Not found' | 'Not unique';

export type FindTextInCodeOptions = {
	/** 1-indexed inclusive starting line for search */
	startingAtLine?: number;
	/** When true, only try exact match (after newline normalization). */
	strictOnly?: boolean;
};

const numLinesOfStr = (str: string) => str.split('\n').length;

export function normalizeLineEndings(s: string): string {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function removeWhitespaceExceptNewlines(str: string): string {
	return str.replace(/[^\S\n]+/g, '');
}

export function trimLinesTrailingWhitespace(s: string): string {
	return s.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');
}

export function trimTrailingEmptyLines(s: string): string {
	const lines = s.split('\n');
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines.join('\n');
}

/** Strip accidental ``` wrappers LLMs sometimes put inside ORIGINAL blocks. */
export function stripCodeFenceWrapper(s: string): string {
	const trimmed = s.trim();
	const match = /^```[^\n]*\n([\s\S]*?)```\s*$/.exec(trimmed);
	return match ? match[1] : s;
}

export function sanitizeSearchReplaceOrig(orig: string): string {
	return trimTrailingEmptyLines(stripCodeFenceWrapper(normalizeLineEndings(orig)));
}

/** Normalize markdown list/heading prefixes so "- Title" can match "## Title". */
export function relaxMarkdownLine(line: string): string {
	return line.trim()
		.replace(/^#{1,6}\s+/, '')
		.replace(/^[-*+]\s+/, '')
		.replace(/^\d+\.\s+/, '')
		.trim();
}

function startingAtCharIdx(fileContents: string, startingAtLine?: number): number {
	if (startingAtLine === undefined) {
		return 0;
	}
	return fileContents.split('\n').slice(0, startingAtLine).join('\n').length;
}

function returnLineRange(fileContents: string, idx: number, matchText: string): FindTextInCodeResult {
	const startLine = numLinesOfStr(fileContents.substring(0, idx + 1));
	const endLine = startLine + numLinesOfStr(matchText) - 1;
	return [startLine, endLine] as const;
}

function findUniqueSubstringIndex(needle: string, haystack: string, fromIdx: number): number | 'Not found' | 'Not unique' {
	const idx = haystack.indexOf(needle, fromIdx);
	if (idx === -1) {
		return 'Not found';
	}
	if (haystack.lastIndexOf(needle) !== idx) {
		return 'Not unique';
	}
	return idx;
}

function findLineSequenceMatch(
	searchText: string,
	fileContents: string,
	relaxLine: (line: string) => string,
	startingAtLine?: number,
): FindTextInCodeResult {
	const searchLines = searchText.split('\n');
	if (searchLines.length === 0) {
		return 'Not found';
	}
	const fileLines = fileContents.split('\n');
	const relaxedSearch = searchLines.map(relaxLine);
	const startFrom = startingAtLine !== undefined ? Math.max(0, startingAtLine - 1) : 0;
	const matchStarts: number[] = [];

	for (let i = startFrom; i <= fileLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			if (relaxLine(fileLines[i + j] ?? '') !== relaxedSearch[j]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			matchStarts.push(i);
		}
	}

	if (matchStarts.length === 0) {
		return 'Not found';
	}
	if (matchStarts.length > 1) {
		return 'Not unique';
	}
	return [matchStarts[0] + 1, matchStarts[0] + searchLines.length];
}

function uniqueSearchVariants(text: string): string[] {
	const normalized = sanitizeSearchReplaceOrig(text);
	const variants = [
		normalized,
		trimLinesTrailingWhitespace(normalized),
		trimTrailingEmptyLines(normalized),
		trimTrailingEmptyLines(trimLinesTrailingWhitespace(normalized)),
	];
	return [...new Set(variants.filter(v => v.length > 0 || text === ''))];
}

/** Find `text` in `fileContents`; returns 1-indexed inclusive line range. */
export function findTextInCode(
	text: string,
	fileContents: string,
	opts?: FindTextInCodeOptions,
): FindTextInCodeResult {
	const startingAtLine = opts?.startingAtLine;
	const strictOnly = opts?.strictOnly ?? false;
	const rawFile = normalizeLineEndings(fileContents);
	const searchVariants = uniqueSearchVariants(text);

	for (const search of searchVariants) {
		const fromIdx = startingAtCharIdx(rawFile, startingAtLine);
		const idx = findUniqueSubstringIndex(search, rawFile, fromIdx);
		if (typeof idx === 'number') {
			return returnLineRange(rawFile, idx, search);
		}
		if (idx === 'Not unique') {
			return 'Not unique';
		}
	}

	if (strictOnly) {
		return 'Not found';
	}

	for (const search of searchVariants) {
		const wsSearch = removeWhitespaceExceptNewlines(search);
		const wsFile = removeWhitespaceExceptNewlines(rawFile);
		const fromIdx = startingAtCharIdx(wsFile, startingAtLine);
		const idx = findUniqueSubstringIndex(wsSearch, wsFile, fromIdx);
		if (typeof idx === 'number') {
			return returnLineRange(wsFile, idx, wsSearch);
		}
		if (idx === 'Not unique') {
			return 'Not unique';
		}
	}

	for (const search of searchVariants) {
		const trimmedSearch = search.split('\n').map(l => l.trim()).join('\n');
		const trimmedFile = rawFile.split('\n').map(l => l.trim()).join('\n');
		const fromIdx = startingAtCharIdx(trimmedFile, startingAtLine);
		const idx = findUniqueSubstringIndex(trimmedSearch, trimmedFile, fromIdx);
		if (typeof idx === 'number') {
			return returnLineRange(trimmedFile, idx, trimmedSearch);
		}
		if (idx === 'Not unique') {
			return 'Not unique';
		}
	}

	for (const search of searchVariants) {
		const res = findLineSequenceMatch(search, rawFile, relaxMarkdownLine, startingAtLine);
		if (res !== 'Not found') {
			return res;
		}
	}

	for (const search of searchVariants) {
		const res = findLineSequenceMatch(search, rawFile, line => line.trim(), startingAtLine);
		if (res !== 'Not found') {
			return res;
		}
	}

	return 'Not found';
}

/** When ORIGINAL fails, show nearby file lines to help the agent self-correct. */
export function suggestFileContextForFailedMatch(
	searchText: string,
	fileContents: string,
	contextLines = 3,
): string | null {
	const fileLines = normalizeLineEndings(fileContents).split('\n');
	const searchLines = sanitizeSearchReplaceOrig(searchText).split('\n').filter(l => relaxMarkdownLine(l).length >= 2);
	if (searchLines.length === 0) {
		return null;
	}

	const needle = relaxMarkdownLine(searchLines[0]);
	for (let i = 0; i < fileLines.length; i++) {
		const relaxed = relaxMarkdownLine(fileLines[i]);
		if (relaxed === needle || relaxed.includes(needle) || needle.includes(relaxed)) {
			const start = Math.max(0, i - 1);
			const end = Math.min(fileLines.length, i + contextLines + 1);
			return fileLines.slice(start, end)
				.map((line, j) => `${start + j + 1}: ${line}`)
				.join('\n');
		}
	}
	return null;
}
