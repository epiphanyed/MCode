/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { detectGitDynamicMode, isGitRelatedQuery } from './gitDynamicContext.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('gitDynamicContext', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('isGitRelatedQuery detects English diff intent', () => {
		assert.ok(isGitRelatedQuery('What did I change in the working tree?'));
		assert.ok(isGitRelatedQuery('show git diff for payment module'));
	});

	test('isGitRelatedQuery detects Chinese change intent', () => {
		assert.ok(isGitRelatedQuery('昨晚改了什么'));
		assert.ok(isGitRelatedQuery('工作区有哪些未提交的修改'));
	});

	test('isGitRelatedQuery ignores unrelated queries', () => {
		assert.ok(!isGitRelatedQuery('How does verifySignature work?'));
		assert.ok(!isGitRelatedQuery('explain this class design'));
	});

	test('detectGitDynamicMode routes commit history questions', () => {
		assert.strictEqual(detectGitDynamicMode('show last commit'), 'recent_commits');
		assert.strictEqual(detectGitDynamicMode('上次提交改了什么'), 'recent_commits');
		assert.strictEqual(detectGitDynamicMode('what files did I modify'), 'working_diff');
	});
});
