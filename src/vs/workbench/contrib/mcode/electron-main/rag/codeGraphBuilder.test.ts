/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	buildCodeGraphViewPayload,
	buildFileSymbolIndex,
	buildFileLevelDisplayGraph,
	buildFocusFileDisplayGraph,
	buildSymbolSearchIndex,
	filterGraphEdgeKinds,
	computeGraphCommunities,
	computeNodeDegrees,
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

	test('buildFileSymbolIndex maps class names to file paths for file-level search', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\service.ts';
		mergeFileIntoCodeGraph(graph, fileA, 'export class MyService {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'class', symbolName: 'MyService' },
		], 'D:\\proj', new Map());

		const index = buildFileSymbolIndex(graph);
		const key = Object.keys(index).find(k => k.endsWith('service.ts'));
		assert.ok(key);
		assert.ok(index[key!]!.includes('MyService'));

		const payload = buildCodeGraphViewPayload(graph);
		assert.ok(payload.fileSymbolIndex[key!]?.includes('MyService'));
		assert.ok(payload.symbolSearchIndex['myservice']?.some(l => l.startLine === 1));
	});

	test('buildSymbolSearchIndex handles prototype property names like constructor', () => {
		const graph = createEmptyCodeGraph();
		mergeFileIntoCodeGraph(graph, 'D:\\proj\\a.ts', 'class constructor {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'class', symbolName: 'constructor' },
		], 'D:\\proj', new Map());
		const index = buildSymbolSearchIndex(graph);
		assert.ok(Array.isArray(index['constructor']));
		assert.strictEqual(index['constructor']!.length, 1);
	});

	test('buildCodeGraphViewPayload ranks hub nodes by degree', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\a.ts';
		const fileB = 'D:\\proj\\b.ts';
		mergeFileIntoCodeGraph(graph, fileB, 'export function bar() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'bar' },
		], 'D:\\proj', new Map());
		mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function foo() { bar(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'foo' },
		], 'D:\\proj', new Map());

		const degrees = computeNodeDegrees(graph);
		assert.ok(Object.keys(degrees).length >= 2);

		const payload = buildCodeGraphViewPayload(graph, 3);
		assert.ok(payload.hubNodes.length <= 3);
		assert.ok(payload.hubNodes[0].degree >= (payload.hubNodes[1]?.degree ?? 0));
		assert.strictEqual(payload.graph, graph);
		assert.strictEqual(payload.viewMode, 'full');
		assert.strictEqual(payload.totalNodeCount, Object.keys(graph.nodes).length);
		assert.ok(payload.architectureReport.includes('GRAPH_REPORT'));
	});

	test('mergeFileIntoCodeGraph records contains and inherits edges', () => {
		const graph = createEmptyCodeGraph();
		const file = 'D:\\proj\\animal.ts';
		const content = `class Animal {}\nclass Dog extends Animal {\n  bark() {}\n}\n`;
		const symbols = [
			{ startLine: 1, endLine: 1, symbolType: 'class', symbolName: 'Animal' },
			{ startLine: 2, endLine: 4, symbolType: 'class', symbolName: 'Dog' },
			{ startLine: 3, endLine: 3, symbolType: 'method', symbolName: 'bark' },
		];
		mergeFileIntoCodeGraph(graph, file, content, symbols, 'D:\\proj', new Map());
		assert.ok(graph.edges.some(e => e.kind === 'contains'));
		assert.ok(graph.edges.some(e => e.kind === 'inherits'));
	});

	test('computeGraphCommunities uses Louvain on linked graph', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\a.ts';
		const fileB = 'D:\\proj\\b.ts';
		mergeFileIntoCodeGraph(graph, fileB, 'export function bar() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'bar' },
		], 'D:\\proj', new Map());
		mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function foo() { bar(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'foo' },
		], 'D:\\proj', new Map());
		const result = computeGraphCommunities(graph);
		assert.ok(result.communities.length >= 1);
		assert.strictEqual(result.method, 'louvain');
		assert.ok(result.graphModularity !== undefined);
		const payload = buildCodeGraphViewPayload(graph);
		assert.strictEqual(payload.communityMethod, 'louvain');
		assert.ok(Object.keys(payload.nodeCommunity).length >= 1);
		assert.ok(payload.architectureReport.includes('Louvain'));
	});

	test('computeGraphCommunities uses file-level Louvain when symbol count exceeds limit', () => {
		const graph = createEmptyCodeGraph();
		const root = 'D:\\proj';
		const index = new Map<string, string[]>();
		for (let f = 0; f < 150; f++) {
			const file = `${root}\\m${f}.ts`;
			let content = f > 0 ? `import './m${f - 1}';\n` : '';
			const symbols: { startLine: number; endLine: number; symbolType: string; symbolName: string }[] = [];
			let line = f > 0 ? 2 : 1;
			for (let s = 0; s < 45; s++) {
				content += `export function f${f}_${s}() {}\n`;
				symbols.push({ startLine: line, endLine: line, symbolType: 'function', symbolName: `f${f}_${s}` });
				line++;
			}
			mergeFileIntoCodeGraph(graph, file, content, symbols, root, index);
		}

		assert.ok(Object.keys(graph.nodes).length > 6000);
		const result = computeGraphCommunities(graph);
		assert.strictEqual(result.method, 'louvain-file');
		assert.ok(result.graphModularity !== undefined);
		assert.ok(Object.keys(result.nodeCommunity).length > 0);
	});

	test('filterGraphEdgeKinds keeps nodes when no matching edges', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\a.ts';
		mergeFileIntoCodeGraph(graph, fileA, 'export function foo() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'foo' },
		], 'D:\\proj', new Map());
		const fileDisplay = buildFileLevelDisplayGraph(graph);
		const filtered = filterGraphEdgeKinds(fileDisplay, ['calls', 'inherits']);
		assert.ok(Object.keys(filtered.nodes).length > 0);
		assert.strictEqual(filtered.edges.length, 0);
	});

	test('buildFocusFileDisplayGraph includes focus file symbols and neighbors', () => {
		const graph = createEmptyCodeGraph();
		const fileA = 'D:\\proj\\a.ts';
		const fileB = 'D:\\proj\\b.ts';
		mergeFileIntoCodeGraph(graph, fileB, 'export function bar() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'bar' },
		], 'D:\\proj', new Map());
		mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function foo() { bar(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'foo' },
		], 'D:\\proj', new Map());

		const focused = buildFocusFileDisplayGraph(graph, fileA);
		assert.ok(Object.keys(focused.nodes).some(id => focused.nodes[id]!.filePath === fileA));
		assert.ok(focused.edges.length >= 1);
	});
});
