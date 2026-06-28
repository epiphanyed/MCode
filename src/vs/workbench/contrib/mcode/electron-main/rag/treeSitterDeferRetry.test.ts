/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	getTreeSitterDeferredFiles,
	isTreeSitterDeferred,
	recordTreeSitterDefer,
	resetTreeSitterDeferState,
	takeTreeSitterDeferredFiles,
} from './treeSitterDeferRetry.js';

suite('treeSitterDeferRetry', () => {
	setup(() => {
		resetTreeSitterDeferState();
	});

	test('recordTreeSitterDefer tracks normalized paths', () => {
		recordTreeSitterDefer('D:/work/project/src/foo.h', new Error('Aborted()'));
		assert.strictEqual(isTreeSitterDeferred('D:\\work\\project\\src\\foo.h'), true);
		assert.deepStrictEqual(getTreeSitterDeferredFiles(), ['D:\\work\\project\\src\\foo.h']);
	});

	test('takeTreeSitterDeferredFiles drains the queue', () => {
		recordTreeSitterDefer('a.ts', new Error('Aborted()'));
		recordTreeSitterDefer('b.ts', new Error('Aborted()'));
		const files = takeTreeSitterDeferredFiles();
		assert.strictEqual(files.length, 2);
		assert.strictEqual(getTreeSitterDeferredFiles().length, 0);
	});
});
