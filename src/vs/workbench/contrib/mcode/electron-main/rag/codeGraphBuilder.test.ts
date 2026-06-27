/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	createEmptyCodeGraph,
	expandGraphNeighbors,
	getRelatedFilesFromGraph,
	mergeFileIntoCodeGraph,
	purgeFileFromCodeGraph,
} from './codeGraphBuilder.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('codeGraphBuilder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('mergeFileIntoCodeGraph records import and call edges', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\src\\a.ts';
		const fileB = 'D:\\proj\\src\\b.ts';
		const symbolsA = [
			{ startLine: 1, endLine: 5, symbolType: 'function', symbolName: 'foo' },
		];
		const symbolsB = [
			{ startLine: 1, endLine: 8, symbolType: 'function', symbolName: 'bar' },
		];
		const contentA = `import { bar } from './b';\nexport function foo() { bar(); }\n`;
		const contentB = `export function bar() { return 1; }\n`;

		const index = new Map<string, string[]>();
		mergeFileIntoCodeGraph(graph, fileB, contentB, symbolsB, 'D:\\proj', index);
		mergeFileIntoCodeGraph(graph, fileA, contentA, symbolsA, 'D:\\proj', index);

		assert.ok(graph.edges.some(e => e.kind === 'imports'));
		assert.ok(graph.edges.some(e => e.kind === 'calls'));
		assert.ok(Object.keys(graph.nodes).length >= 3);
	});

	test('expandGraphNeighbors returns symbol neighbors', () => {
		const graph = createEmptyCodeGraph();
		const file = 'D:\\proj\\util.ts';
		const symbols = [
			{ startLine: 1, endLine: 3, symbolType: 'function', symbolName: 'helper' },
			{ startLine: 5, endLine: 10, symbolType: 'function', symbolName: 'main' },
		];
		const content = `function helper() {}\nfunction main() { helper(); }\n`;
		mergeFileIntoCodeGraph(graph, file, content, symbols, 'D:\\proj', new Map());

		const neighbors = expandGraphNeighbors(graph, [{ filePath: file, startLine: 5, symbolName: 'main' }], 4);
		assert.ok(neighbors.length >= 1);
		assert.ok(neighbors.some(n => n.symbolName === 'helper'));
	});

	test('purgeFileFromCodeGraph removes file nodes', () => {
		const graph = createEmptyCodeGraph();
		const file = 'D:\\proj\\x.ts';
		mergeFileIntoCodeGraph(graph, file, 'function f() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'f' },
		]);
		purgeFileFromCodeGraph(graph, file);
		assert.strictEqual(Object.keys(graph.nodes).length, 0);
		assert.strictEqual(graph.edges.length, 0);
	});

	test('getRelatedFilesFromGraph returns import neighbors', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\a.ts';
		const fileB = 'D:\\proj\\b.ts';
		mergeFileIntoCodeGraph(graph, fileB, 'export function bar() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'bar' },
		], 'D:\\proj', new Map());
		mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function foo() { bar(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'foo' },
		], 'D:\\proj', new Map());

		const deps = getRelatedFilesFromGraph(graph, fileA, 5);
		assert.ok(deps.some(d => d.filePath === fileB && d.kind === 'imports'));
	});

	test('expandGraphNeighbors supports 2-hop expansion', () => {
		const graph = createEmptyCodeGraph();
		const symbolNameIndex = new Map<string, string[]>();
		const fileA = 'D:\\proj\\a.ts';
		const fileB = 'D:\\proj\\b.ts';
		const fileC = 'D:\\proj\\c.ts';
		mergeFileIntoCodeGraph(graph, fileC, 'export function c() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'c' },
		], 'D:\\proj', symbolNameIndex);
		mergeFileIntoCodeGraph(graph, fileB, `import { c } from './c';\nexport function b() { c(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'b' },
		], 'D:\\proj', symbolNameIndex);
		mergeFileIntoCodeGraph(graph, fileA, `import { b } from './b';\nexport function a() { b(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'a' },
		], 'D:\\proj', symbolNameIndex);

		const oneHop = expandGraphNeighbors(graph, [{ filePath: fileA, startLine: 2, symbolName: 'a' }], 4, 1);
		assert.strictEqual(oneHop.some(n => n.filePath === fileB), true);
		assert.strictEqual(oneHop.some(n => n.filePath === fileC), false);

		const twoHop = expandGraphNeighbors(graph, [{ filePath: fileA, startLine: 2, symbolName: 'a' }], 6, 2);
		assert.strictEqual(twoHop.some(n => n.filePath === fileC), true);
	});
});
