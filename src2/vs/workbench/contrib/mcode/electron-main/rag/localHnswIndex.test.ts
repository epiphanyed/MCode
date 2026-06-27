/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { hnswDistanceToSimilarity, LocalHnswIndex } from './localHnswIndex.js';
import { normalizeToFloat32 } from './localVectorSearch.js';

async function skipUnlessHnswAvailable(this: Mocha.Context, dimensions: number): Promise<LocalHnswIndex> {
	const hnsw = await LocalHnswIndex.tryCreate(dimensions);
	if (!hnsw) {
		this.skip();
	}
	return hnsw;
}

suite('localHnswIndex', () => {
	test('HNSW returns nearest normalized vectors', async function () {
		const hnsw = await skipUnlessHnswAvailable.call(this, 4);

		const target = normalizeToFloat32([1, 0, 0, 0]);
		const near = normalizeToFloat32([0.99, 0.01, 0, 0]);
		const far = normalizeToFloat32([0, 1, 0, 0]);

		hnsw.add(1n, target);
		hnsw.add(2n, near);
		hnsw.add(3n, far);

		const hits = hnsw.search(target, 2);
		assert.strictEqual(hits.keys.length, 2);
		assert.strictEqual(hits.keys[0], 1n);
		assert.ok(hnswDistanceToSimilarity(hits.distances[0]) > 0.99);
	});

	test('remove drops vector from search results', async function () {
		const hnsw = await skipUnlessHnswAvailable.call(this, 3);

		const v = normalizeToFloat32([1, 2, 3]);
		hnsw.add(10n, v);
		hnsw.remove(10n);
		assert.strictEqual(hnsw.size(), 0);
	});
});
