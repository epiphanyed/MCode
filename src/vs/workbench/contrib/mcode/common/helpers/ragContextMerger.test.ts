/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	extractFilePathFromChunk,
	isExcludedFilePath,
	isGitContextChunk,
	mergeRagContexts,
	splitVectorContext,
} from './ragContextMerger.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ragContextMerger', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('splitVectorContext splits FILE, GRAPH, and LINKED sections', () => {
		const vector = [
			'## Unstaged changes\n+line',
			'--- FILE: src/a.ts (Type: code) ---\nfunction a() {}',
			'--- GRAPH IMPORT: src/b.ts (symbol: foo, L1-3) ---\ncall()',
			'--- LINKED CODE: src/c.ts (bar, L10-20) ---\nlinked',
		].join('\n\n');
		const chunks = splitVectorContext(vector);
		assert.strictEqual(chunks.length, 4);
		assert.ok(isGitContextChunk(chunks[0]));
		assert.ok(chunks[1].startsWith('--- FILE:'));
		assert.ok(chunks[2].startsWith('--- GRAPH'));
		assert.ok(chunks[3].startsWith('--- LINKED CODE:'));
	});

	test('mergeRagContexts gives git its own section and budget', () => {
		const gitBlock = '## Diff: big.ts\n' + 'x'.repeat(5000);
		const codeBlock = '--- FILE: src/other.ts (Type: code) ---\n' + 'y'.repeat(500);
		const merged = mergeRagContexts({
			lspSnippets: [],
			vectorContext: `${gitBlock}\n\n${codeBlock}`,
		}, {
			maxTotalChars: 3000,
			gitMaxChars: 800,
			lspBudgetRatio: 0.3,
		});
		assert.strictEqual(merged.merged.includes('[Git Context]:'), true);
		assert.strictEqual(merged.merged.includes('[RAG Context]:'), true);
		const gitSection = merged.merged.split('[RAG Context]:')[0];
		assert.ok(gitSection.length < 1200, 'git section should respect gitMaxChars');
	});

	test('mergeRagContexts excludes staging selection file paths', () => {
		const vector = [
			'--- FILE: src/selected.ts (Type: code) ---\nselected body',
			'--- FILE: src/other.ts (Type: code) ---\nother body',
		].join('\n\n');
		const merged = mergeRagContexts({
			lspSnippets: [],
			vectorContext: vector,
			excludeFilePaths: ['D:/work/src/selected.ts'],
		}, { maxTotalChars: 12_000 });
		assert.strictEqual(merged.merged.includes('selected body'), false);
		assert.strictEqual(merged.merged.includes('other body'), true);
	});

	test('extractFilePathFromChunk and isExcludedFilePath', () => {
		const chunk = '--- FILE: src/foo.ts (Type: code) ---\ncode';
		assert.strictEqual(extractFilePathFromChunk(chunk), 'src/foo.ts');
		assert.strictEqual(
			isExcludedFilePath('src/foo.ts', ['D:\\work\\src\\foo.ts']),
			true,
		);
	});
});
