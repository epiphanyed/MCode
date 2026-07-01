/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import { offsetChunkLineNumbers, stripLeadingFileHeader } from './fileHeaderStripper.js';
import { applyLeadingCommentsToChunks } from './symbolLeadingComments.js';
import { chunkJava } from './javaSemanticChunker.js';
import { loadTreeSitterChunkerModule, isTreeSitterRuntimeReady } from './treeSitterLazy.js';
import { isTreeSitterWasmAbortError } from './treeSitterRuntime.js';
import { recordTreeSitterDefer, type TreeSitterIndexPass, isTreeSitterDeferred } from './treeSitterDeferRetry.js';
import { canTreeSitterParse } from './treeSitterGrammarMap.js';

export interface SemanticCodeChunk {
	text: string;
	symbolType: string;
	symbolName?: string;
	startLine: number;
	endLine: number;
	partIndex?: number;
	partTotal?: number;
}

/** Maximum lines per chunk before secondary split (Phase 3). */
export const MAX_SYMBOL_LINES = 512;

type LanguageFamily = 'cpp' | 'typescript' | 'javascript' | 'python' | 'scilab' | 'matlab' | 'java' | 'go' | 'rust' | 'csharp' | 'ruby' | 'kotlin' | 'unknown';

const EXT_TO_LANGUAGE: Record<string, LanguageFamily> = {
	'.c': 'cpp',
	'.h': 'cpp',
	'.cpp': 'cpp',
	'.hpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.py': 'python',
	'.sci': 'scilab',
	'.sce': 'scilab',
	'.m': 'matlab',
	'.java': 'java',
	'.go': 'go',
	'.rs': 'rust',
	'.cs': 'csharp',
	'.rb': 'ruby',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
};

interface PatternDef {
	type: string;
	regex: RegExp;
	hasBlock?: boolean;
	endAtSemicolon?: boolean;
	endAtLine?: boolean;
	isArrow?: boolean;
}

const CPP_PATTERNS: PatternDef[] = [
	{ type: 'struct', regex: /\b(?:typedef\s+)?struct(?:\s+[\w:]+)?\s*\{/g, hasBlock: true },
	{ type: 'class', regex: /\b(?:template\s*<[^>]*>\s*)?class\s+[\w:]+\s*(?:final\s*)?\{/g, hasBlock: true },
	{ type: 'enum', regex: /\b(?:enum\s+class|enum\s+struct|enum)\s+[\w:]+\s*(?::\s*[\w:]+\s*)?\{/g, hasBlock: true },
	{ type: 'union', regex: /\bunion\s+[\w:]+\s*\{/g, hasBlock: true },
	{ type: 'namespace', regex: /\bnamespace\s+[\w:]+\s*\{/g, hasBlock: true },
	{ type: 'function', regex: /\b(?:virtual\s+|static\s+|inline\s+|explicit\s+)*[\w:~*<>&\s]+\s+[\w:]+\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:=\s*0\s*)?(?:override\s*)?\s*;/g, endAtSemicolon: true },
	{ type: 'function', regex: /\b[\w:~*<>&\s]+\s+[\w:]+\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{/g, hasBlock: true },
];

const TS_PATTERNS: PatternDef[] = [
	{ type: 'function', regex: /\bexport\s+default\s+(?:async\s+)?function\s*[\w$]*\s*\(/g, hasBlock: true },
	{ type: 'function', regex: /\b(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*[<(]/g, hasBlock: true },
	{ type: 'function', regex: /(?:^|[;\n}])\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=;]+)?\s*=>/gm, hasBlock: true, isArrow: true },
	{ type: 'class', regex: /\b(?:export\s+)?(?:abstract\s+)?class\s+[\w$]+(?:\s+extends\s+[\w$.]+)?(?:\s+implements\s+[\w$.,\s]+)?\s*\{/g, hasBlock: true },
	{ type: 'interface', regex: /\b(?:export\s+)?interface\s+[\w$]+(?:\s+extends\s+[\w$.,\s]+)?\s*\{/g, hasBlock: true },
	{ type: 'enum', regex: /\b(?:export\s+)?(?:const\s+)?enum\s+[\w$]+\s*\{/g, hasBlock: true },
	{ type: 'type', regex: /\b(?:export\s+)?type\s+[\w$]+\s*=[^;{]+(?:\{[^]*?\}|[^;]+);/g, endAtSemicolon: true },
	{ type: 'method', regex: /^\s*(?:public|private|protected|static|async|readonly|\*)*\s*[\w$]+\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/gm, hasBlock: true },
];

const JS_PATTERNS: PatternDef[] = [
	{ type: 'function', regex: /\bexport\s+default\s+(?:async\s+)?function\s*[\w$]*\s*\(/g, hasBlock: true },
	{ type: 'function', regex: /\b(?:export\s+)?(?:async\s+)?function\s+[\w$]+\s*\(/g, hasBlock: true },
	{ type: 'function', regex: /(?:^|[;\n}])\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/gm, hasBlock: true, isArrow: true },
	{ type: 'class', regex: /\b(?:export\s+)?class\s+[\w$]+(?:\s+extends\s+[\w$.]+)?\s*\{/g, hasBlock: true },
	{ type: 'method', regex: /^\s*(?:async\s+)?[\w$]+\s*\([^)]*\)\s*\{/gm, hasBlock: true },
];

const KT_MODIFIER = '(?:(?:private|public|protected|internal|external|override|suspend|inline|tailrec|operator|infix|data|sealed|abstract|open|const|lateinit|final)\\s+)*';

const KT_PATTERNS: PatternDef[] = [
	{ type: 'enum', regex: /\benum\s+class\s+[\w$]+/g, hasBlock: true },
	{ type: 'interface', regex: new RegExp(`\\b${KT_MODIFIER}interface\\s+[\\w$]+`, 'g'), hasBlock: true },
	{ type: 'class', regex: new RegExp(`\\b${KT_MODIFIER}(?:data\\s+|sealed\\s+|abstract\\s+|open\\s+)?(?:class|object)\\s+[\\w$]+`, 'g'), hasBlock: true },
	{ type: 'function', regex: new RegExp(`\\b${KT_MODIFIER}fun\\s+[\\w$` + '`' + `]+`, 'g'), hasBlock: true },
	{ type: 'function', regex: new RegExp(`\\b${KT_MODIFIER}fun\\s+[\\w$` + '`' + `]+\\s*(?:\\([^)]*\\))?\\s*=`, 'g'), endAtLine: true },
	{ type: 'property', regex: /\b(?:val|var)\s+[\w$]+(?:\s*:[^=]+)?\s*=[^\n{]+/g, endAtLine: true },
	{ type: 'property', regex: /\b(?:val|var)\s+[\w$]+(?:\s*:[^={]+)?\s*\{/g, hasBlock: true },
];

function getLanguageFamily(filePath: string): LanguageFamily {
	return EXT_TO_LANGUAGE[path.extname(filePath).toLowerCase()] ?? 'unknown';
}

function getPatterns(family: LanguageFamily): PatternDef[] {
	switch (family) {
		case 'cpp': return CPP_PATTERNS;
		case 'typescript': return TS_PATTERNS;
		case 'javascript': return JS_PATTERNS;
		case 'kotlin': return KT_PATTERNS;
		default: return [];
	}
}

function lineNumberAt(content: string, index: number): number {
	return content.slice(0, index).split('\n').length;
}

function extractSymbolName(matchText: string, type: string): string | undefined {
	const patterns: Record<string, RegExp> = {
		struct: /\bstruct(?:\s+[\w:]+)?\s+([\w:]+)/,
		class: /\b(?:class|object)\s+([\w:$]+)/,
		enum: /\b(?:enum\s+class|enum\s+struct|enum)\s+([\w:$]+)/,
		union: /\bunion\s+([\w:]+)/,
		namespace: /\bnamespace\s+([\w:]+)/,
		function: /\b(?:const|let|var)\s+([\w$]+)\s*=|\b(?:function|fun)\s+([\w:$]+)|\b([\w:$]+)\s*\(/,
		interface: /\binterface\s+([\w$]+)/,
		property: /\b(?:val|var)\s+([\w$]+)/,
		record: /\brecord\s+([\w$]+)/,
		type: /\btype\s+([\w$]+)/,
		method: /\b([\w$]+)\s*\(/,
	};
	const pattern = patterns[type];
	if (!pattern) {
		return undefined;
	}
	const m = matchText.match(pattern);
	return m?.[1] || m?.[2] || m?.[3];
}

function findBlockEnd(content: string, openBraceIndex: number): number {
	let depth = 0;
	let i = openBraceIndex;
	let inString: '"' | "'" | '`' | null = null;
	let inLineComment = false;
	let inBlockComment = false;

	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];

		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
			}
			i++;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (inString) {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === inString) {
				inString = null;
			}
			i++;
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			inString = ch;
			i++;
			continue;
		}

		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
		i++;
	}
	return content.length;
}

function findSemicolonEnd(content: string, startIndex: number): number {
	let i = startIndex;
	let depthBrace = 0;
	let inString: '"' | "'" | '`' | null = null;
	while (i < content.length) {
		const ch = content[i];
		if (inString) {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === inString) {
				inString = null;
			}
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			inString = ch;
			i++;
			continue;
		}
		if (ch === '{') {
			depthBrace++;
		} else if (ch === '}') {
			depthBrace--;
		} else if (ch === ';' && depthBrace === 0) {
			return i + 1;
		}
		i++;
	}
	return content.length;
}

function resolveMatchEnd(content: string, matchStart: number, pattern: PatternDef): number | null {
	if (pattern.endAtSemicolon) {
		return findSemicolonEnd(content, matchStart);
	}
	if (pattern.endAtLine) {
		const nl = content.indexOf('\n', matchStart);
		return nl === -1 ? content.length : nl + 1;
	}
	if (!pattern.hasBlock) {
		return null;
	}

	if (pattern.isArrow) {
		const arrowIndex = content.indexOf('=>', matchStart);
		if (arrowIndex === -1) {
			return null;
		}
		const afterArrow = content.slice(arrowIndex + 2);
		const trimmed = afterArrow.trimStart();
		if (trimmed.startsWith('{')) {
			const braceIndex = arrowIndex + 2 + (afterArrow.length - trimmed.length);
			return findBlockEnd(content, braceIndex);
		}
		return findSemicolonEnd(content, matchStart);
	}

	const braceIndex = content.indexOf('{', matchStart);
	if (braceIndex === -1) {
		return null;
	}
	return findBlockEnd(content, braceIndex);
}

function overlaps(a: SemanticCodeChunk, bStart: number, bEnd: number, content: string): boolean {
	const aStart = content.indexOf(a.text);
	if (aStart === -1) {
		return false;
	}
	const aEnd = aStart + a.text.length;
	return !(bEnd <= aStart || bStart >= aEnd);
}

function chunkWithPatterns(content: string, patterns: PatternDef[]): SemanticCodeChunk[] {
	const chunks: SemanticCodeChunk[] = [];

	for (const pattern of patterns) {
		pattern.regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.regex.exec(content)) !== null) {
			const matchStart = match.index;
			const matchEnd = resolveMatchEnd(content, matchStart, pattern);
			if (matchEnd === null) {
				continue;
			}

			const text = content.slice(matchStart, matchEnd).trim();
			if (text.length < 8) {
				continue;
			}

			const startLine = lineNumberAt(content, matchStart);
			const endLine = lineNumberAt(content, matchEnd - 1);
			if (chunks.some(c => overlaps(c, matchStart, matchEnd, content))) {
				continue;
			}

			chunks.push({
				text,
				symbolType: pattern.type,
				symbolName: extractSymbolName(text, pattern.type),
				startLine,
				endLine,
			});
		}
	}

	chunks.sort((a, b) => a.startLine - b.startLine);
	return chunks;
}

function chunkPython(content: string): SemanticCodeChunk[] {
	const lines = content.split('\n');
	const chunks: SemanticCodeChunk[] = [];
	const headerPattern = /^(\s*)(?:async\s+)?(?:def|class)\s+([\w$]+)/;

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(headerPattern);
		if (!match) {
			continue;
		}
		const indent = match[1].length;
		const symbolType = lines[i].includes('class ') ? 'class' : 'function';
		const symbolName = match[2];
		let end = i + 1;
		while (end < lines.length) {
			const line = lines[end];
			if (line.trim() === '') {
				end++;
				continue;
			}
			const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
			if (lineIndent <= indent && /^\s*(?:async\s+)?(?:def|class)\s+/.test(line)) {
				break;
			}
			if (lineIndent <= indent && line.trim() !== '') {
				break;
			}
			end++;
		}
		const text = lines.slice(i, end).join('\n').trim();
		if (text.length >= 8) {
			chunks.push({
				text,
				symbolType,
				symbolName,
				startLine: i + 1,
				endLine: end,
			});
		}
		i = end - 1;
	}
	return chunks;
}

function chunkScilab(content: string): SemanticCodeChunk[] {
	const lines = content.split('\n');
	const chunks: SemanticCodeChunk[] = [];
	const headerPattern = /^\s*function\s+(?:(?:\[[^\]]+\]|[\w$]+)\s*=\s*)?([\w$]+)\s*(?:\(|$)/i;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*(?:\/\/|#)/.test(line)) {
			continue;
		}
		const match = line.match(headerPattern);
		if (!match) {
			continue;
		}
		const symbolName = match[1];
		let depth = 1;
		let end = i + 1;
		while (end < lines.length) {
			const currentLine = lines[end];
			// 1. Skip fully commented lines
			if (/^\s*(?:\/\/|#)/.test(currentLine)) {
				end++;
				continue;
			}
			// 2. Clean comments and strings from the line to avoid false matches
			const cleanLine = currentLine.split('//')[0].split('#')[0]
				.replace(/"[^"]*"/g, '')
				.replace(/'[^']*'/g, '');

			// 3. Track depth of functions
			if (/\bfunction\b/i.test(cleanLine)) {
				depth++;
			} else if (/\bendfunction\b/i.test(cleanLine)) {
				depth--;
				if (depth === 0) {
					end++;
					break;
				}
			}
			end++;
		}
		const text = lines.slice(i, end).join('\n').trim();
		if (text.length >= 8) {
			chunks.push({
				text,
				symbolType: 'function',
				symbolName,
				startLine: i + 1,
				endLine: end,
			});
		}
		i = end - 1;
	}
	return chunks;
}

function findMatlabBlockEnd(lines: string[], startIndex: number): number {
	const openPattern = /^\s*(function|classdef|methods|properties|events|enumeration|if|for|while|switch|try|parfor|spmd)\b/i;
	let depth = 1;
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*%/.test(line)) {
			continue;
		}
		if (/^\s*end(\s|$|%|;)/i.test(line)) {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
			continue;
		}
		if (openPattern.test(line)) {
			depth++;
		}
	}
	return lines.length;
}

function parseMatlabSymbol(line: string): { symbolType: string; symbolName: string } | null {
	const classMatch = line.match(/^\s*classdef\s+([\w$]+)/i);
	if (classMatch) {
		return { symbolType: 'class', symbolName: classMatch[1] };
	}
	const funcMatch = line.match(/^\s*function\s+(?:(?:\[[^\]]+\]|[\w$]+)\s*=\s*)?([\w$]+)/i);
	if (funcMatch) {
		return { symbolType: 'function', symbolName: funcMatch[1] };
	}
	return null;
}

function chunkMatlab(content: string): SemanticCodeChunk[] {
	const lines = content.split('\n');
	const chunks: SemanticCodeChunk[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*%/.test(line)) {
			continue;
		}
		const symbol = parseMatlabSymbol(line);
		if (!symbol) {
			continue;
		}
		const end = findMatlabBlockEnd(lines, i);
		const text = lines.slice(i, end).join('\n').trim();
		if (text.length >= 8) {
			chunks.push({
				text,
				symbolType: symbol.symbolType,
				symbolName: symbol.symbolName,
				startLine: i + 1,
				endLine: end,
			});
		}
		i = end - 1;
	}
	return chunks;
}

function splitLargeChunk(chunk: SemanticCodeChunk, maxLines: number): SemanticCodeChunk[] {
	const lineCount = chunk.endLine - chunk.startLine + 1;
	if (lineCount <= maxLines) {
		return [chunk];
	}

	const lines = chunk.text.split('\n');
	const parts: SemanticCodeChunk[] = [];
	let start = 0;

	while (start < lines.length) {
		const remaining = lines.length - start;
		if (remaining <= maxLines) {
			const text = lines.slice(start).join('\n').trim();
			if (text.length >= 8) {
				parts.push({
					...chunk,
					text,
					startLine: chunk.startLine + start,
					endLine: chunk.startLine + lines.length - 1,
				});
			}
			break;
		}

		let cut = start + maxLines;
		let bestCut = cut;
		for (let i = cut; i > start + Math.floor(maxLines / 2); i--) {
			if (lines[i - 1]?.trim() === '') {
				bestCut = i;
				break;
			}
		}

		const partLines = lines.slice(start, bestCut);
		const text = partLines.join('\n').trim();
		if (text.length >= 8) {
			parts.push({
				...chunk,
				text,
				startLine: chunk.startLine + start,
				endLine: chunk.startLine + bestCut - 1,
			});
		}
		start = bestCut;
	}

	if (parts.length <= 1) {
		return parts.length === 1 ? parts : [chunk];
	}

	return parts.map((part, index) => ({
		...part,
		partIndex: index + 1,
		partTotal: parts.length,
	}));
}

function applyLargeChunkSplit(content: string, chunks: SemanticCodeChunk[], maxLines = MAX_SYMBOL_LINES): SemanticCodeChunk[] {
	const withComments = applyLeadingCommentsToChunks(content, chunks);
	const result: SemanticCodeChunk[] = [];
	for (const chunk of withComments) {
		result.push(...splitLargeChunk(chunk, maxLines));
	}
	return result;
}

/**
 * Split source code into semantic units (functions, structs, classes, etc.).
 * Falls back to a single whole-file chunk when no symbols are detected.
 */
export function chunkCodeSemantically(content: string, filePath: string, maxSymbolLines = MAX_SYMBOL_LINES): SemanticCodeChunk[] {
	const family = getLanguageFamily(filePath);

	if (family === 'python') {
		const pyChunks = chunkPython(content);
		if (pyChunks.length > 0) {
			return applyLargeChunkSplit(content, pyChunks, maxSymbolLines);
		}
	}

	if (family === 'java') {
		const javaChunks = chunkJava(content);
		if (javaChunks.length > 0) {
			return applyLargeChunkSplit(content, javaChunks, maxSymbolLines);
		}
	}

	if (family === 'scilab') {
		const sciChunks = chunkScilab(content);
		if (sciChunks.length > 0) {
			return applyLargeChunkSplit(content, sciChunks, maxSymbolLines);
		}
	}

	if (family === 'matlab') {
		const mChunks = chunkMatlab(content);
		if (mChunks.length > 0) {
			return applyLargeChunkSplit(content, mChunks, maxSymbolLines);
		}
	}

	const patterns = getPatterns(family);
	if (patterns.length > 0) {
		const chunks = chunkWithPatterns(content, patterns);
		if (chunks.length > 0) {
			return applyLargeChunkSplit(content, chunks, maxSymbolLines);
		}
	}

	const trimmed = content.trim();
	if (trimmed.length === 0) {
		return [];
	}
	return applyLargeChunkSplit(content, [{
		text: trimmed,
		symbolType: 'file',
		startLine: 1,
		endLine: content.split('\n').length,
	}], maxSymbolLines);
}

export function getChunkDocId(filePath: string, chunkIndex: number): string {
	return `${path.normalize(filePath)}::chunk::${chunkIndex}`;
}

export const CHUNK_ENGINE = 'tree-sitter-hybrid-v1';

/**
 * Hybrid chunking for indexing: tree-sitter AST when supported, else regex chunker.
 * Strips leading copyright/license headers before slicing (line numbers preserved via offset).
 */
export async function chunkCodeForIndexing(
	content: string,
	filePath: string,
	maxSymbolLines = MAX_SYMBOL_LINES,
	treeSitterPass: TreeSitterIndexPass = 'off',
): Promise<SemanticCodeChunk[]> {
	try {
		const { body, headerLineCount } = stripLeadingFileHeader(content);
		const sliceContent = headerLineCount > 0 ? body : content;
		if (sliceContent.trim().length === 0) {
			return [];
		}

		let chunks: SemanticCodeChunk[] | undefined;

		const chunker = await loadTreeSitterChunkerModule();
		if (chunker && await isTreeSitterRuntimeReady() && canTreeSitterParse(filePath)) {
			try {
				const astChunks = await chunker.chunkWithTreeSitter(sliceContent, filePath);
				if (astChunks && astChunks.length > 0) {
					chunks = applyLargeChunkSplit(sliceContent, astChunks, maxSymbolLines);
				}
			} catch (err) {
				if (treeSitterPass === 'primary' && isTreeSitterWasmAbortError(err)) {
					recordTreeSitterDefer(filePath, err);
					return [];
				}
				if (treeSitterPass === 'retry') {
					console.warn(`[RAG] tree-sitter retry failed for ${filePath}, using regex fallback:`, err);
				} else {
					console.warn(`[RAG] tree-sitter chunk failed for ${filePath}, using regex fallback:`, err);
				}
			}
		}

		if (!chunks) {
			if (isTreeSitterDeferred(filePath)) {
				return [];
			}
			chunks = chunkCodeSemantically(sliceContent, filePath, maxSymbolLines);
		}

		if (headerLineCount > 0) {
			chunks = offsetChunkLineNumbers(chunks, headerLineCount);
		}
		return chunks;
	} catch (err) {
		if (treeSitterPass === 'primary' && isTreeSitterWasmAbortError(err)) {
			recordTreeSitterDefer(filePath, err);
			return [];
		}
		console.warn(`[RAG] chunkCodeForIndexing failed for ${filePath}, using whole-file fallback:`, err);
		return chunkCodeSemantically(content, filePath, maxSymbolLines);
	}
}
