/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { compactCodeContent } from './ragCompactFormat.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ragCompactFormat', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('compactCodeContent truncates long files', () => {
		const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
		const out = compactCodeContent(long);
		assert.ok(out.includes('lines omitted'));
		assert.ok(out.length < long.length);
	});
});
