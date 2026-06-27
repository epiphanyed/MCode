/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import type * as Parser from '@vscode/tree-sitter-wasm';
import type { CodeSymbolEntry } from './ragQueryHelpers.js';
import { canTreeSitterParse } from './treeSitterChunker.js';
import { createTreeSitterParser } from './treeSitterRuntime.js';
import { resolveImportTarget, isCallKeyword } from './codeGraphBuilder.js';

export interface TreeSitterGraphExtraction {
	imports: string[];
	callsBySymbolLine: Map<number, Set<string>>;
}

const IMPORT_NODE_TYPES = new Set([
	'import_statement',
	'import_declaration',
	'import_from_statement',
	'preproc_include',
]);

const CALL_NODE_TYPES = new Set([
	'call_expression',
	'call',
]);

const CONTAINER_OR_FUNCTION = new Set([
	'function', 'class', 'struct', 'method', 'namespace', 'interface', 'template',
]);

function importSpecFromNode(node: Parser.Node): string | undefined {
	if (node.type === 'preproc_include') {
		const pathNode = node.childForFieldName('path') ?? node.namedChildren.find(c => c !== null && (c.type === 'string_literal' || c.type === 'system_lib_string'));
		if (pathNode) {
			return pathNode.text.replace(/^["<]|["">]$/g, '');
		}
		return node.text.replace(/^#\s*include\s+[<"]|[">]$/g, '').trim();
	}

	const source = node.childForFieldName('source');
	if (source) {
		return source.text.replace(/^['"]|['"]$/g, '');
	}

	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i)!;
		if (child.type === 'string' || child.type === 'string_literal') {
			return child.text.replace(/^['"]|['"]$/g, '');
		}
	}
	return undefined;
}

function pythonImportSpec(node: Parser.Node): string | undefined {
	if (node.type === 'import_from_statement') {
		const moduleName = node.childForFieldName('module_name');
		return moduleName?.text;
	}
	if (node.type === 'import_statement') {
		const name = node.childForFieldName('name');
		return name?.text.split(',')[0]?.trim();
	}
	return importSpecFromNode(node);
}

function calleeNameFromCallNode(node: Parser.Node): string | undefined {
	const fn = node.childForFieldName('function') ?? node.childForFieldName('name');
	if (!fn) {
		return undefined;
	}
	if (fn.type === 'identifier' || fn.type === 'property_identifier' || fn.type === 'type_identifier') {
		return fn.text;
	}
	if (fn.type === 'member_expression' || fn.type === 'field_expression' || fn.type === 'attribute') {
		const prop = fn.childForFieldName('property') ?? fn.childForFieldName('field');
		return prop?.text;
	}
	if (fn.type === 'scoped_identifier') {
		const name = fn.childForFieldName('name');
		return name?.text;
	}
	return undefined;
}

function collectImports(root: Parser.Node, filePath: string, workspaceRoot?: string): string[] {
	const ext = path.extname(filePath).toLowerCase();
	const targets: string[] = [];
	const seen = new Set<string>();

	const visit = (node: Parser.Node): void => {
		if (IMPORT_NODE_TYPES.has(node.type)) {
			const spec = ext === '.py' ? pythonImportSpec(node) : importSpecFromNode(node);
			if (spec) {
				const resolved = resolveImportTarget(spec, filePath, workspaceRoot);
				if (resolved && !seen.has(resolved)) {
					seen.add(resolved);
					targets.push(resolved);
				}
			}
		}
		for (let i = 0; i < node.childCount; i++) {
			visit(node.child(i)!);
		}
	};

	visit(root);
	return targets;
}

function symbolContainsLine(symbol: CodeSymbolEntry, line: number): boolean {
	return line >= symbol.startLine && line <= symbol.endLine;
}

function collectCallsBySymbol(
	root: Parser.Node,
	symbols: CodeSymbolEntry[],
): Map<number, Set<string>> {
	const callsByLine = new Map<number, Set<string>>();
	const containerSymbols = symbols.filter(s => CONTAINER_OR_FUNCTION.has(s.symbolType));

	const visit = (node: Parser.Node): void => {
		if (CALL_NODE_TYPES.has(node.type)) {
			const line = node.startPosition.row + 1;
			const callee = calleeNameFromCallNode(node);
			if (callee && !isCallKeyword(callee)) {
				for (const symbol of containerSymbols) {
					if (symbolContainsLine(symbol, line)) {
						const set = callsByLine.get(symbol.startLine) ?? new Set<string>();
						set.add(callee);
						callsByLine.set(symbol.startLine, set);
						break;
					}
				}
			}
		}
		for (let i = 0; i < node.childCount; i++) {
			visit(node.child(i)!);
		}
	};

	visit(root);
	return callsByLine;
}

/** AST-based import/call extraction (Phase 10 / P10-2). */
export async function extractGraphEdgesWithTreeSitter(
	content: string,
	filePath: string,
	symbols: CodeSymbolEntry[],
	workspaceRoot?: string,
): Promise<TreeSitterGraphExtraction | null> {
	if (!canTreeSitterParse(filePath)) {
		return null;
	}

	const ext = path.extname(filePath).toLowerCase();
	const grammarMap: Record<string, string> = {
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
	const grammar = grammarMap[ext];
	if (!grammar) {
		return null;
	}

	const parser = await createTreeSitterParser(grammar);
	const tree = parser.parse(content);
	if (!tree) {
		return null;
	}

	return {
		imports: collectImports(tree.rootNode, filePath, workspaceRoot),
		callsBySymbolLine: collectCallsBySymbol(tree.rootNode, symbols),
	};
}
