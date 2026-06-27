/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { canTreeSitterParse } from './treeSitterGrammarMap.js';

suite('treeSitterLazy', () => {
	test('canTreeSitterParse does not require chunker module', () => {
		assert.strictEqual(canTreeSitterParse('api.ts'), true);
		assert.strictEqual(canTreeSitterParse('macros.h'), true);
		assert.strictEqual(canTreeSitterParse('readme.md'), false);
	});
});
