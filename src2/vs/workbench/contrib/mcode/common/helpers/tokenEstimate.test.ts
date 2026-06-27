/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { estimateTokenCount } from './tokenEstimate.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('tokenEstimate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimateTokenCount weights CJK higher than ASCII', () => {
		const ascii = 'a'.repeat(400);
		const cjk = '中'.repeat(100);
		assert.ok(estimateTokenCount(cjk) > estimateTokenCount(ascii) / 2);
	});
});
