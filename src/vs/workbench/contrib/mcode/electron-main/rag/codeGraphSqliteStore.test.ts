/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createEmptyCodeGraph,
	mergeFileIntoCodeGraph,
	purgeFileFromCodeGraph,
} from './codeGraphBuilder.js';
import { CodeGraphSqliteStore } from './codeGraphSqliteStore.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('codeGraphSqliteStore', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('syncFromGraph, loadGraph, queryRelations, purgeFile roundtrip', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-sqlite-'));
		const dbPath = path.join(tmpDir, 'code_graph.db');
		const graph = createEmptyCodeGraph();
		const fileA = path.join(tmpDir, 'a.ts');
		const fileB = path.join(tmpDir, 'b.ts');
		const index = new Map<string, string[]>();

		mergeFileIntoCodeGraph(graph, fileB, 'export function bar() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'bar' },
		], tmpDir, index);
		mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function foo() { bar(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'foo' },
		], tmpDir, index);

		const store = await CodeGraphSqliteStore.open(dbPath);
		try {
			await store.syncFromGraph(graph);
			assert.ok((await store.getEntityCount()) > 0);

			const loaded = await store.loadGraph();
			assert.strictEqual(Object.keys(loaded.nodes).length, Object.keys(graph.nodes).length);
			assert.strictEqual(loaded.edges.length, graph.edges.length);

			const hits = await store.queryRelations('foo', undefined, 'calls');
			assert.ok(hits.length >= 1);
			assert.ok(hits.some(h => h.from.symbolName === 'foo' || h.to.symbolName === 'foo'));

			await store.purgeFile(fileA);
			const afterPurge = await store.loadGraph();
			assert.ok(!Object.values(afterPurge.nodes).some(n => n.filePath === fileA));
		} finally {
			await store.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('purgeFileFromCodeGraph aligns with SQLite purgeFile', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-purge-'));
		const dbPath = path.join(tmpDir, 'code_graph.db');
		const graph = createEmptyCodeGraph();
		const file = path.join(tmpDir, 'only.ts');

		mergeFileIntoCodeGraph(graph, file, 'function f() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'f' },
		]);

		const store = await CodeGraphSqliteStore.open(dbPath);
		try {
			await store.syncFromGraph(graph);
			purgeFileFromCodeGraph(graph, file);
			await store.purgeFile(file);

			const loaded = await store.loadGraph();
			assert.strictEqual(Object.keys(loaded.nodes).length, 0);
			assert.strictEqual(loaded.edges.length, 0);
		} finally {
			await store.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('syncFileFromGraph updates only one file', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-sync-file-'));
		const dbPath = path.join(tmpDir, 'code_graph.db');
		const graph = createEmptyCodeGraph();
		const fileA = path.join(tmpDir, 'a.ts');
		const fileB = path.join(tmpDir, 'b.ts');
		const index = new Map<string, string[]>();

		mergeFileIntoCodeGraph(graph, fileB, 'export function bar() {}\n', [
			{ startLine: 1, endLine: 1, symbolType: 'function', symbolName: 'bar' },
		], tmpDir, index);
		mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function foo() { bar(); }\n`, [
			{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'foo' },
		], tmpDir, index);

		const store = await CodeGraphSqliteStore.open(dbPath);
		try {
			await store.syncFromGraph(graph);
			purgeFileFromCodeGraph(graph, fileA);
			mergeFileIntoCodeGraph(graph, fileA, `import { bar } from './b';\nexport function fooRenamed() { bar(); }\n`, [
				{ startLine: 2, endLine: 2, symbolType: 'function', symbolName: 'fooRenamed' },
			], tmpDir, index);
			await store.syncFileFromGraph(graph, fileA);

			const hits = await store.queryRelations('fooRenamed', fileA, 'calls');
			assert.ok(hits.some(h => h.from.symbolName === 'fooRenamed' || h.to.symbolName === 'fooRenamed'));
			const loaded = await store.loadGraph();
			assert.ok(Object.values(loaded.nodes).some(n => n.filePath === fileB));
		} finally {
			await store.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
