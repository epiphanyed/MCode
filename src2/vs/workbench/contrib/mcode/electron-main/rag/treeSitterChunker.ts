/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import type * as Parser from '@vscode/tree-sitter-wasm';
import type { SemanticCodeChunk } from './semanticCodeChunker.js';
import { createTreeSitterParser } from './treeSitterRuntime.js';

/** Maps file extension to @vscode/tree-sitter-wasm grammar file (without .wasm). */
const EXT_TO_GRAMMAR: Record<string, string> = {
	'.c': 'tree-sitter-cpp',
	'.h': 'tree-sitter-cpp',
	'.cpp': 'tree-sitter-cpp',
	'.hpp': 'tree-sitter-cpp',
	'.cc': 'tree-sitter-cpp',
	'.cxx': 'tree-sitter-cpp',
	'.ts': 'tree-sitter-typescript',
	'.tsx': 'tree-sitter-tsx',
	'.js': 'tree-sitter-javascript',
	'.jsx': 'tree-sitter-javascript',
	'.py': 'tree-sitter-python',
};

/** tree-sitter node type → chunk symbolType (aligned with semanticCodeChunker). */
const NODE_TYPE_TO_SYMBOL: Record<string, string> = {
	function_definition: 'function',
	function_declaration: 'function',
	method_definition: 'function',
	constructor: 'function',
	arrow_function: 'function',
	class_specifier: 'class',
	class_definition: 'class',
	class_declaration: 'class',
	struct_specifier: 'struct',
	union_specifier: 'union',
	enum_specifier: 'enum',
	template_declaration: 'template',
	namespace_definition: 'namespace',
	interface_declaration: 'interface',
	type_alias_declaration: 'typedef',
	enum_declaration: 'enum',
	lexical_declaration: 'function',
};

const SEMANTIC_NODE_TYPES = new Set(Object.keys(NODE_TYPE_TO_SYMBOL));

const MIN_CHUNK_CHARS = 8;

export function canTreeSitterParse(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return ext in EXT_TO_GRAMMAR;
}

function getGrammarForFile(filePath: string): string | undefined {
	return EXT_TO_GRAMMAR[path.extname(filePath).toLowerCase()];
}

function nodeNameFromField(node: Parser.Node, fieldName: string): string | undefined {
	const field = node.childForFieldName(fieldName);
	if (field && (field.type === 'identifier' || field.type === 'type_identifier' || field.type === 'property_identifier')) {
		return field.text;
	}
	return undefined;
}

function extractSymbolName(node: Parser.Node, symbolType: string, text: string): string | undefined {
	const fromField =
		nodeNameFromField(node, 'name')
		?? nodeNameFromField(node, 'declarator')
		?? findDescendantIdentifier(node);
	if (fromField) {
		return fromField;
	}
	return extractNameFromText(text, symbolType);
}

function findDescendantIdentifier(node: Parser.Node): string | undefined {
	if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
		return node.text;
	}
	for (let i = 0; i < node.childCount; i++) {
		const found = findDescendantIdentifier(node.child(i)!);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function extractNameFromText(text: string, symbolType: string): string | undefined {
	const firstLine = text.split('\n')[0] ?? text;
	const patterns: Record<string, RegExp> = {
		function: /\b(?:function|def)\s+([\w$]+)|\b([\w$]+)\s*[=:]\s*(?:async\s*)?\(/,
		class: /\b(?:class|classdef)\s+([\w$:]+)/,
		struct: /\bstruct\s+([\w:]+)/,
		union: /\bunion\s+([\w:]+)/,
		enum: /\benum\s+(?:class\s+)?([\w:]+)/,
		interface: /\binterface\s+([\w$]+)/,
		typedef: /\btype\s+([\w$]+)/,
		template: /\btemplate\s*(?:<[^>]*>)?\s*(?:class|struct|typename)\s+([\w:]+)/,
		namespace: /\bnamespace\s+([\w:]+)/,
	};
	const pattern = patterns[symbolType];
	if (!pattern) {
		return undefined;
	}
	const m = firstLine.match(pattern);
	return m?.[1] ?? m?.[2];
}

function isStrictlyInside(inner: { start: number; end: number }, outer: { start: number; end: number }): boolean {
	return inner.start >= outer.start && inner.end <= outer.end
		&& (inner.start > outer.start || inner.end < outer.end);
}

function dedupeNestedSpans(spans: Array<{ start: number; end: number; text: string; symbolType: string; symbolName?: string; startLine: number; endLine: number }>): SemanticCodeChunk[] {
	spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
	const kept: typeof spans = [];
	for (const span of spans) {
		if (kept.some(k => isStrictlyInside(span, k))) {
			continue;
		}
		kept.push(span);
	}
	return kept.map(span => ({
		text: span.text,
		symbolType: span.symbolType,
		symbolName: span.symbolName,
		startLine: span.startLine,
		endLine: span.endLine,
	}));
}

function shouldIncludeLexicalDeclaration(node: Parser.Node): boolean {
	if (node.type !== 'lexical_declaration') {
		return true;
	}
	return node.text.includes('=>');
}

function collectSemanticNodes(node: Parser.Node, content: string, out: Array<{ start: number; end: number; text: string; symbolType: string; symbolName?: string; startLine: number; endLine: number }>): void {
	if (SEMANTIC_NODE_TYPES.has(node.type) && shouldIncludeLexicalDeclaration(node)) {
		const text = node.text.trim();
		if (text.length >= MIN_CHUNK_CHARS) {
			const symbolType = NODE_TYPE_TO_SYMBOL[node.type] ?? node.type;
			const start = node.startIndex;
			const end = node.endIndex;
			out.push({
				start,
				end,
				text,
				symbolType,
				symbolName: extractSymbolName(node, symbolType, text),
				startLine: node.startPosition.row + 1,
				endLine: node.endPosition.row + 1,
			});
		}
	}
	for (let i = 0; i < node.childCount; i++) {
		collectSemanticNodes(node.child(i)!, content, out);
	}
}

/**
 * Parse source with tree-sitter and return semantic chunks, or null when parse yields nothing.
 */
export async function chunkWithTreeSitter(content: string, filePath: string): Promise<SemanticCodeChunk[] | null> {
	const grammar = getGrammarForFile(filePath);
	if (!grammar) {
		return null;
	}

	const parser = await createTreeSitterParser(grammar);
	const tree = parser.parse(content);
	if (!tree) {
		return null;
	}

	const raw: Array<{ start: number; end: number; text: string; symbolType: string; symbolName?: string; startLine: number; endLine: number }> = [];
	collectSemanticNodes(tree.rootNode, content, raw);

	if (raw.length === 0) {
		return null;
	}

	const deduped = dedupeNestedSpans(raw);
	deduped.sort((a, b) => a.startLine - b.startLine);
	return deduped;
}
