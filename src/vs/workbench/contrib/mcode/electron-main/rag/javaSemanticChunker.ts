/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { SemanticCodeChunk } from './semanticCodeChunker.js';

const MIN_JAVA_CHUNK_CHARS = 8;

const JAVA_TYPE_HEADER_RE = /\b(?:public|private|protected|abstract|static|final|sealed|non-sealed|strictfp|\s)*?(?:@\s*interface|class|interface|enum|record)\s+([\w$]+)/g;

const JAVA_MEMBER_MODIFIERS = '(?:(?:public|private|protected|static|final|synchronized|native|abstract|default|strictfp)\\s+)*';

const JAVA_METHOD_HEADER_RE = new RegExp(
	'^' + JAVA_MEMBER_MODIFIERS + '(?:<[^>]+>\\s+)?[\\w<>\\[\\],\\s.?@]+\\s+([\\w$]+)\\s*\\([^)]*\\)\\s*(?:throws\\s+[\\w.\\s,]+)?\\s*(\\{|;)',
);

const JAVA_NESTED_TYPE_RE = /^(?:(?:public|private|protected|static|final|strictfp)\s+)*(?:@\s*interface|class|interface|enum|record)\s+([\w$]+)/;

const JAVA_CONSTRUCTOR_HEADER_RE = new RegExp(
	'^((?:public|private|protected|\\s)+)([\\w$]+)\\s*\\([^)]*\\)\\s*(?:throws\\s+[\\w.\\s,]+)?\\s*(\\{)',
);

function lineNumberAt(content: string, index: number): number {
	return content.slice(0, index).split('\n').length;
}

function skipJavaTrivia(content: string, start: number): number {
	let i = start;
	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
			i++;
			continue;
		}
		if (ch === '/' && next === '/') {
			const nl = content.indexOf('\n', i);
			i = nl === -1 ? content.length : nl + 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = content.indexOf('*/', i + 2);
			i = end === -1 ? content.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

function findBlockEnd(content: string, openBraceIndex: number): number {
	let depth = 0;
	let i = openBraceIndex;
	let inString: '"' | "'" | null = null;
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
		if (ch === '"' || ch === "'") {
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
	let inString: '"' | "'" | null = null;
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
		if (ch === '"' || ch === "'") {
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

function javaTypeKind(header: string): string {
	if (/\b@\s*interface\b/.test(header)) {
		return 'annotation';
	}
	if (/\binterface\b/.test(header)) {
		return 'interface';
	}
	if (/\benum\b/.test(header)) {
		return 'enum';
	}
	if (/\brecord\b/.test(header)) {
		return 'record';
	}
	return 'class';
}

function skipLeadingMemberAnnotations(body: string, start: number): number {
	let i = start;
	while (i < body.length) {
		i = skipJavaTrivia(body, i);
		const rest = body.slice(i);
		const ann = rest.match(/^@[\w.]+\s*(?:\([^)]*\))?\s*/);
		if (ann) {
			i += ann[0].length;
			continue;
		}
		break;
	}
	return i;
}

function extractJavaMembers(
	body: string,
	bodyStartLine: number,
	typeName: string,
): SemanticCodeChunk[] {
	const chunks: SemanticCodeChunk[] = [];
	let i = 0;

	while (i < body.length) {
		i = skipLeadingMemberAnnotations(body, i);
		if (i >= body.length) {
			break;
		}

		const rest = body.slice(i);

		if (/^static\s*\{/.test(rest)) {
			const braceIdx = rest.indexOf('{');
			const end = findBlockEnd(body, i + braceIdx);
			const text = body.slice(i, end).trim();
			if (text.length >= MIN_JAVA_CHUNK_CHARS) {
				chunks.push({
					text,
					symbolType: 'static_initializer',
					symbolName: `${typeName}.static`,
					startLine: bodyStartLine + lineNumberAt(body, i) - 1,
					endLine: bodyStartLine + lineNumberAt(body, end - 1) - 1,
				});
			}
			i = end;
			continue;
		}

		const nestedMatch = rest.match(JAVA_NESTED_TYPE_RE);
		if (nestedMatch) {
			const headerEnd = nestedMatch[0].length;
			const braceIdx = rest.indexOf('{', headerEnd);
			if (braceIdx !== -1) {
				const absBrace = i + braceIdx;
				const nestedEnd = findBlockEnd(body, absBrace);
				const nestedBody = body.slice(absBrace + 1, nestedEnd - 1);
				const nestedStartLine = bodyStartLine + lineNumberAt(body, absBrace + 1) - 1;
				chunks.push(...extractJavaMembers(nestedBody, nestedStartLine, nestedMatch[1]));
				i = nestedEnd;
				continue;
			}
		}

		const ctorMatch = rest.match(JAVA_CONSTRUCTOR_HEADER_RE);
		if (ctorMatch && ctorMatch[2] === typeName) {
			const braceIdx = i + ctorMatch[0].length - 1;
			const end = findBlockEnd(body, braceIdx);
			const text = body.slice(i, end).trim();
			if (text.length >= MIN_JAVA_CHUNK_CHARS) {
				chunks.push({
					text,
					symbolType: 'constructor',
					symbolName: typeName,
					startLine: bodyStartLine + lineNumberAt(body, i) - 1,
					endLine: bodyStartLine + lineNumberAt(body, end - 1) - 1,
				});
			}
			i = end;
			continue;
		}

		const methodMatch = rest.match(JAVA_METHOD_HEADER_RE);
		if (methodMatch) {
			const symbolName = methodMatch[1];
			const terminator = methodMatch[2];
			let end: number;
			if (terminator === '{') {
				const braceIdx = i + methodMatch[0].length - 1;
				end = findBlockEnd(body, braceIdx);
			} else {
				end = findSemicolonEnd(body, i + methodMatch[0].length - 1);
			}
			const text = body.slice(i, end).trim();
			if (text.length >= MIN_JAVA_CHUNK_CHARS) {
				chunks.push({
					text,
					symbolType: 'method',
					symbolName,
					startLine: bodyStartLine + lineNumberAt(body, i) - 1,
					endLine: bodyStartLine + lineNumberAt(body, end - 1) - 1,
				});
			}
			i = end;
			continue;
		}

		const nextSpecial = rest.search(/[{};]/);
		i = nextSpecial === -1 ? body.length : i + nextSpecial + 1;
	}

	return chunks;
}

/**
 * Java semantic chunking: type-aware scan with method/constructor-level chunks.
 */
export function chunkJava(content: string): SemanticCodeChunk[] {
	const chunks: SemanticCodeChunk[] = [];
	let searchFrom = 0;

	while (searchFrom < content.length) {
		JAVA_TYPE_HEADER_RE.lastIndex = searchFrom;
		const match = JAVA_TYPE_HEADER_RE.exec(content);
		if (!match) {
			break;
		}

		const typeName = match[1];
		const header = match[0];
		const symbolType = javaTypeKind(header);
		const headerEnd = match.index + header.length;
		const braceIdx = content.indexOf('{', headerEnd);
		if (braceIdx === -1) {
			searchFrom = match.index + 1;
			continue;
		}

		const typeEnd = findBlockEnd(content, braceIdx);
		const typeStart = match.index;
		const bodyStart = braceIdx + 1;
		const bodyEnd = typeEnd - 1;
		const body = content.slice(bodyStart, bodyEnd);
		const bodyStartLine = lineNumberAt(content, bodyStart);

		const memberChunks = extractJavaMembers(body, bodyStartLine, typeName);
		if (memberChunks.length > 0) {
			chunks.push(...memberChunks);
		} else {
			const text = content.slice(typeStart, typeEnd).trim();
			if (text.length >= MIN_JAVA_CHUNK_CHARS) {
				chunks.push({
					text,
					symbolType,
					symbolName: typeName,
					startLine: lineNumberAt(content, typeStart),
					endLine: lineNumberAt(content, typeEnd - 1),
				});
			}
		}

		searchFrom = typeEnd;
	}

	chunks.sort((a, b) => a.startLine - b.startLine);
	return chunks;
}
