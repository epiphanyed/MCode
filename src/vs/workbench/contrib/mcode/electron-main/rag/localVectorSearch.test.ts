/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { dotProduct, normalizeToFloat32, TopKScoreHeap } from './localVectorSearch.js';

suite('localVectorSearch', () => {
	test('normalizeToFloat32 produces unit vector', () => {
		const normalized = normalizeToFloat32([3, 4]);
		assert.strictEqual(normalized.length, 2);
		assert.ok(Math.abs(dotProduct(normalized, normalized) - 1) < 1e-5);
	});

	test('TopKScoreHeap keeps highest scores', () => {
		const heap = new TopKScoreHeap<number>(2);
		heap.push(1, 0.1);
		heap.push(2, 0.9);
		heap.push(3, 0.5);
		heap.push(4, 0.2);
		const top = heap.toSortedDesc().map(entry => entry.item);
		assert.deepStrictEqual(top, [2, 3]);
	});
});
