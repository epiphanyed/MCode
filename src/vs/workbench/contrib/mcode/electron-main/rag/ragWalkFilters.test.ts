/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	compareIndexFilePriority,
	compareWalkDirectoryNames,
	getIndexFilePriority,
	isPathIgnoredByPatterns,
	pathContainsSkippedDirectory,
	shouldSkipDirectoryName,
	sortFilesForIndexing,
	splitPathSegments,
} from './ragWalkFilters.js';

suite('ragWalkFilters', () => {
	test('shouldSkipDirectoryName skips VCS and CI dot directories', () => {
		for (const name of ['.git', '.github', '.gitlab', '.gitea', '.svn', '.hg', '.circleci']) {
			assert.strictEqual(shouldSkipDirectoryName(name), true, name);
		}
		assert.strictEqual(shouldSkipDirectoryName('.'), false);
		assert.strictEqual(shouldSkipDirectoryName('..'), false);
		assert.strictEqual(shouldSkipDirectoryName('src'), false);
	});

	test('pathContainsSkippedDirectory detects nested skip dirs with forward slashes', () => {
		const nested = 'D:/work/project/vendor/lib/.github/workflows/ci.yml';
		assert.strictEqual(pathContainsSkippedDirectory(nested), true);
		assert.strictEqual(pathContainsSkippedDirectory('D:/work/project/external/v8/src/third_party/google_benchmark/foo.h'), true);
		assert.strictEqual(pathContainsSkippedDirectory('D:/work/project/vendor/lib/.gitlab-ci.yml'), false);
		assert.strictEqual(pathContainsSkippedDirectory('D:/work/project/vendor/lib/.gitlab/runner/config.yml'), true);
		assert.strictEqual(pathContainsSkippedDirectory('D:/work/project/submodule/.git/config'), true);
		assert.strictEqual(pathContainsSkippedDirectory('D:/work/project/src/main.ts'), false);
	});

	test('pathContainsSkippedDirectory detects nested skip dirs with backslashes', () => {
		assert.strictEqual(pathContainsSkippedDirectory('D:\\work\\project\\pkg\\.git\\hooks\\pre-commit'), true);
		assert.strictEqual(pathContainsSkippedDirectory('D:\\work\\project\\pkg\\src\\index.ts'), false);
	});

	test('splitPathSegments handles mixed separators', () => {
		assert.deepStrictEqual(
			splitPathSegments('D:/work/project/.github\\workflows/ci.yml'),
			['D:', 'work', 'project', '.github', 'workflows', 'ci.yml'],
		);
	});

	test('getIndexFilePriority prefers workspace src over external and nested src', () => {
		const root = 'D:\\work\\doc_morph';
		assert.strictEqual(getIndexFilePriority('D:\\work\\doc_morph\\src\\main.ts', root), 0);
		assert.strictEqual(getIndexFilePriority('D:\\work\\doc_morph\\include\\foo.h', root), 1);
		assert.strictEqual(getIndexFilePriority('D:\\work\\doc_morph\\external\\boost\\src\\vector.hpp', root), 2);
	});

	test('sortFilesForIndexing puts workspace src first and external last', () => {
		const root = 'D:/work/doc_morph';
		const files = [
			'D:/work/doc_morph/external/boost/foo.hpp',
			'D:/work/doc_morph/include/bar.h',
			'D:/work/doc_morph/src/app/main.cpp',
			'D:/work/doc_morph/src/util.ts',
		];
		const sorted = sortFilesForIndexing(files, root);
		assert.strictEqual(sorted[0], 'D:/work/doc_morph/src/app/main.cpp');
		assert.strictEqual(sorted[1], 'D:/work/doc_morph/src/util.ts');
		assert.strictEqual(sorted[sorted.length - 1], 'D:/work/doc_morph/external/boost/foo.hpp');
	});

	test('compareWalkDirectoryNames visits src before external at workspace root', () => {
		const root = 'D:/work/doc_morph';
		assert.ok(compareWalkDirectoryNames('src', 'external', root, root) < 0);
		assert.ok(compareWalkDirectoryNames('lib', 'external', root, root) < 0);
		assert.ok(compareWalkDirectoryNames('external', 'src', root, root) > 0);
		assert.strictEqual(compareIndexFilePriority('a.ts', 'b.ts', root), 'a.ts'.localeCompare('b.ts', undefined, { sensitivity: 'base' }));
	});

	test('isPathIgnoredByPatterns matches directory prefixes with trailing slash', () => {
		const patterns = ['external/', 'src/generated/**'];
		assert.strictEqual(isPathIgnoredByPatterns('external/boost/vector.hpp', patterns), true);
		assert.strictEqual(isPathIgnoredByPatterns('external', patterns), true);
		assert.strictEqual(isPathIgnoredByPatterns('src/main.ts', patterns), false);
		assert.strictEqual(isPathIgnoredByPatterns('src/generated/foo.ts', patterns), true);
	});
});
