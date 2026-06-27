/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { encodeSparseVector, tokenizeForSparse } from './milvusSparseEncoder.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('milvusSparseEncoder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('tokenizeForSparse captures identifiers and hashes', () => {
		const tokens = tokenizeForSparse('verify_signature USE_SSL commit a1b2c3d4');
		assert.ok(tokens.includes('verify_signature'));
		assert.ok(tokens.includes('use_ssl'));
		assert.ok(tokens.includes('a1b2c3d4'));
	});

	test('encodeSparseVector returns weighted sparse dict', () => {
		const sparse = encodeSparseVector('PaymentService verify_signature');
		const keys = Object.keys(sparse);
		assert.ok(keys.length >= 2);
		const values = keys.map(k => sparse[k as unknown as number]!);
		assert.ok(values.every(v => v > 0 && v <= 1));
	});
});
