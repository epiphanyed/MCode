/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import type * as Parser from '@vscode/tree-sitter-wasm';
import type { CodeSymbolEntry } from './ragQueryHelpers.js';
import { canTreeSitterParse, getTreeSitterGrammarForFile } from './treeSitterGrammarMap.js';
import {
	deleteTreeSitterTree,
	parseWithSharedTreeSitterParser,
} from './treeSitterRuntime.js';
import { resolveImportTarget, isCallKeyword } from './codeGraphBuilder.js';

export interface TreeSitterGraphExtraction {
	imports: string[];
	callsBySymbolLine: Map<number, Set<string>>;
	inheritsBySymbolLine: Map<number, Set<string>>;
}

const IMPORT_NODE_TYPES = new Set([
	'import_statement',
	'import_declaration',
	'import_from_statement',
	'import_header',
	'preproc_include',
]);

const CALL_NODE_TYPES = new Set([
	'call_expression',
	'call',
]);

const CLASS_NODE_TYPES = new Set([
	'class_declaration',
	'class_definition',
	'class_specifier',
	'interface_declaration',
]);

const HERITAGE_NODE_TYPES = new Set([
	'extends_clause',
	'implements_clause',
	'class_heritage',
	'base_class_clause',
	'superclasses',
]);

const CONTAINER_OR_FUNCTION = new Set([
	'function', 'class', 'struct', 'method', 'namespace', 'interface', 'template', 'enum', 'property',
]);

const TYPE_NAME_NODE_TYPES = new Set([
	'identifier',
	'type_identifier',
	'simple_identifier',
	'scoped_identifier',
	'property_identifier',
	'user_type',
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

function kotlinImportSpec(node: Parser.Node): string | undefined {
	if (node.type !== 'import_header') {
		return undefined;
	}
	let text = node.text.replace(/^import\s+/, '').trim();
	const aliasIdx = text.lastIndexOf(' as ');
	if (aliasIdx >= 0) {
		text = text.slice(0, aliasIdx).trim();
	}
	return text.length > 0 ? text : undefined;
}

function kotlinCallTarget(node: Parser.Node): string | undefined {
	if (node.type === 'simple_identifier') {
		return node.text;
	}
	if (node.type === 'navigation_expression') {
		let last: string | undefined;
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i)!;
			if (child.type === 'simple_identifier') {
				last = child.text;
			}
		}
		return last;
	}
	return undefined;
}

function importSpecForNode(node: Parser.Node, ext: string): string | undefined {
	if (ext === '.py') {
		return pythonImportSpec(node);
	}
	if (ext === '.kt' || ext === '.kts') {
		return kotlinImportSpec(node) ?? importSpecFromNode(node);
	}
	return importSpecFromNode(node);
}

function calleeNameFromCallNode(node: Parser.Node): string | undefined {
	if (node.type === 'call_expression') {
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i)!;
			if (child.type === 'call_suffix') {
				break;
			}
			const kotlinCallee = kotlinCallTarget(child);
			if (kotlinCallee) {
				return kotlinCallee;
			}
		}
	}

	const fn = node.childForFieldName('function') ?? node.childForFieldName('name');
	if (!fn) {
		return undefined;
	}
	if (fn.type === 'identifier' || fn.type === 'property_identifier' || fn.type === 'type_identifier' || fn.type === 'simple_identifier') {
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

function collectKotlinDelegationTypes(node: Parser.Node, names: Set<string>): void {
	if (node.type === 'type_identifier') {
		names.add(node.text);
		return;
	}
	for (let i = 0; i < node.childCount; i++) {
		collectKotlinDelegationTypes(node.child(i)!, names);
	}
}

function collectImports(root: Parser.Node, filePath: string, workspaceRoot?: string): string[] {
	const ext = path.extname(filePath).toLowerCase();
	const targets: string[] = [];
	const seen = new Set<string>();

	const visit = (node: Parser.Node): void => {
		if (IMPORT_NODE_TYPES.has(node.type)) {
			const spec = importSpecForNode(node, ext);
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

function collectTypeNames(node: Parser.Node, names: Set<string>): void {
	if (TYPE_NAME_NODE_TYPES.has(node.type)) {
		const text = node.text.trim();
		if (text && text !== 'extends' && text !== 'implements' && text !== 'public' && text !== 'private' && text !== 'protected') {
			names.add(text.split('.').pop() ?? text);
		}
	}
	if (node.type === 'generic_type' || node.type === 'type_arguments') {
		for (let i = 0; i < node.childCount; i++) {
			collectTypeNames(node.child(i)!, names);
		}
		return;
	}
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i)!;
		if (HERITAGE_NODE_TYPES.has(node.type) || HERITAGE_NODE_TYPES.has(child.type)) {
			collectTypeNames(child, names);
		}
	}
}

function classSymbolForNode(node: Parser.Node, symbols: CodeSymbolEntry[]): CodeSymbolEntry | undefined {
	const line = node.startPosition.row + 1;
	const nameNode = node.childForFieldName('name') ?? node.namedChildren.find(c =>
		c?.type === 'identifier' || c?.type === 'type_identifier' || c?.type === 'simple_identifier');
	const className = nameNode?.text;
	return symbols.find(s =>
		(s.symbolType === 'class' || s.symbolType === 'interface' || s.symbolType === 'enum') &&
		symbolContainsLine(s, line) &&
		(!className || s.symbolName === className),
	);
}

function collectInheritsBySymbol(
	root: Parser.Node,
	symbols: CodeSymbolEntry[],
): Map<number, Set<string>> {
	const inheritsByLine = new Map<number, Set<string>>();

	const visit = (node: Parser.Node): void => {
		if (CLASS_NODE_TYPES.has(node.type)) {
			const symbol = classSymbolForNode(node, symbols);
			if (symbol) {
				const bases = new Set<string>();
				for (let i = 0; i < node.childCount; i++) {
					const child = node.child(i)!;
					if (child.type === 'delegation_specifier') {
						collectKotlinDelegationTypes(child, bases);
					}
					if (HERITAGE_NODE_TYPES.has(child.type) || child.type === 'superclasses') {
						collectTypeNames(child, bases);
					}
				}
				if (node.type === 'class_definition') {
					const superclasses = node.childForFieldName('superclasses');
					if (superclasses) {
						collectTypeNames(superclasses, bases);
					}
				}
				if (bases.size > 0) {
					inheritsByLine.set(symbol.startLine, bases);
				}
			}
		}
		for (let i = 0; i < node.childCount; i++) {
			visit(node.child(i)!);
		}
	};

	visit(root);
	return inheritsByLine;
}

/** AST-based import/call/inherit extraction (Phase 10 / P10-2). */
export async function extractGraphEdgesWithTreeSitter(
	content: string,
	filePath: string,
	symbols: CodeSymbolEntry[],
	workspaceRoot?: string,
): Promise<TreeSitterGraphExtraction | null> {
	if (!canTreeSitterParse(filePath)) {
		return null;
	}

	const grammar = getTreeSitterGrammarForFile(filePath);
	if (!grammar) {
		return null;
	}

	const tree = await parseWithSharedTreeSitterParser(grammar, content);
	if (!tree) {
		return null;
	}

	try {
		return {
			imports: collectImports(tree.rootNode, filePath, workspaceRoot),
			callsBySymbolLine: collectCallsBySymbol(tree.rootNode, symbols),
			inheritsBySymbolLine: collectInheritsBySymbol(tree.rootNode, symbols),
		};
	} finally {
		deleteTreeSitterTree(tree);
	}
}
