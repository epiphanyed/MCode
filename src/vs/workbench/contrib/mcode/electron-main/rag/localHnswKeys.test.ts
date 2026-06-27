/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { chunkIdToHnswKey, hnswKeyToSqlValue, sqlValueToHnswKey } from './localHnswKeys.js';

suite('localHnswKeys', () => {
	test('chunkIdToHnswKey is stable and round-trips through SQL value', () => {
		const key = chunkIdToHnswKey('file.cpp:0:128');
		const sql = hnswKeyToSqlValue(key);
		assert.strictEqual(sqlValueToHnswKey(sql), key);
		assert.strictEqual(chunkIdToHnswKey('file.cpp:0:128'), key);
	});

	test('different chunk ids produce different keys', () => {
		const a = chunkIdToHnswKey('a');
		const b = chunkIdToHnswKey('b');
		assert.notStrictEqual(a, b);
	});
});
