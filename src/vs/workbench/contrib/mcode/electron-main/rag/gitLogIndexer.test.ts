/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseGitLogOutput, formatCommitDocument, getGitCommitDocId } from './gitLogIndexer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('gitLogIndexer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseGitLogOutput extracts commit and file stats', () => {
		const sample = `COMMIT|abc123def456|Alice|2026-06-01T10:00:00+08:00|Fix payment module
10\t5\tsrc/pay.cpp
0\t2\tREADME.md

COMMIT|def789|Bob|2026-06-02T11:00:00+08:00|Update docs
3\t1\tdocs/setup.md
`;
		const commits = parseGitLogOutput(sample);
		assert.strictEqual(commits.length, 2);
		assert.strictEqual(commits[0].hash, 'abc123def456');
		assert.strictEqual(commits[0].author, 'Alice');
		assert.strictEqual(commits[0].message, 'Fix payment module');
		assert.strictEqual(commits[0].files.length, 2);
		assert.strictEqual(commits[0].files[0].path, 'src/pay.cpp');
		assert.strictEqual(commits[0].files[0].added, 10);
	});

	test('formatCommitDocument includes metadata fields', () => {
		const text = formatCommitDocument({
			hash: 'abc',
			author: 'Alice',
			date: '2026-06-01',
			message: 'Fix bug',
			files: [{ path: 'a.ts', added: 1, deleted: 0 }],
		});
		assert.ok(text.includes('Commit Hash: abc'));
		assert.ok(text.includes('Author: Alice'));
		assert.ok(text.includes('a.ts (+1, -0)'));
	});

	test('getGitCommitDocId is stable', () => {
		assert.strictEqual(getGitCommitDocId('abc123'), 'git::commit::abc123');
	});
});
