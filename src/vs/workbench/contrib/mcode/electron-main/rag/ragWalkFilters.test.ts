/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	pathContainsSkippedDirectory,
	shouldSkipDirectoryName,
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
});
