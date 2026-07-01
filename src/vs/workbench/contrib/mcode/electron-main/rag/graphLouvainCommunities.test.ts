/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	buildCliqueBridgeWeightedGraph,
	groupNodesByCommunity,
	runLouvain,
} from './graphLouvainCommunities.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('graphLouvainCommunities', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('runLouvain splits two cliques with a weak bridge', () => {
		const graph = buildCliqueBridgeWeightedGraph(4, 0.1);
		const { assignment, modularity } = runLouvain(graph);
		const groups = groupNodesByCommunity(assignment);
		assert.strictEqual(groups.size, 2, 'expected two Louvain communities');
		const sizes = [...groups.values()].map(m => m.length).sort((a, b) => a - b);
		assert.deepStrictEqual(sizes, [4, 4]);
		assert.ok(modularity > 0);
	});

	test('runLouvain returns empty for edgeless graph', () => {
		const graph = {
			nodeIds: ['a', 'b'],
			neighbors: new Map([
				['a', new Map()],
				['b', new Map()],
			]),
			strength: new Map([['a', 0], ['b', 0]]),
			totalEdgeWeight: 0,
		};
		const { assignment, modularity } = runLouvain(graph);
		assert.strictEqual(assignment.size, 0);
		assert.strictEqual(modularity, 0);
	});
});
