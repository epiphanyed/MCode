/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Document } from 'llamaindex';
import {
	applyIntentOrchestration,
	classifyRagQueryComplexity,
	collectLinkedFilesFromDocNodes,
	computeLocalRouterRetrieveTopK,
	dedupeRetrievedNodes,
	docTypeMatchesRoute,
	filterRetrievedByRoute,
	routeQueryTargets,
	splitSubQuestions,
	splitSubQuestionsWithLlm,
	mergeOrchestratorOptions,
	targetsToMilvusPartitions,
} from './ragQueryOrchestrator.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ragQueryOrchestrator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('routeQueryTargets detects doc-only intent', () => {
		const targets = routeQueryTargets('Where is the README documentation?');
		assert.ok(targets.includes('doc'));
	});

	test('routeQueryTargets detects git intent', () => {
		const targets = routeQueryTargets('show git diff for auth module');
		assert.ok(targets.includes('git'));
	});

	test('targetsToMilvusPartitions maps code route', () => {
		const partitions = targetsToMilvusPartitions(['code']);
		assert.deepStrictEqual(partitions, ['code_partition']);
	});

	test('splitSubQuestions splits long multi-clause queries', () => {
		const parts = splitSubQuestions(
			'How does the payment module validate signatures; and what does the README say about deployment configuration?',
		);
		assert.ok(parts.length >= 2);
	});

	test('splitSubQuestions keeps short queries intact', () => {
		const q = 'How does verifyToken work?';
		assert.deepStrictEqual(splitSubQuestions(q), [q]);
	});

	test('docTypeMatchesRoute filters by target', () => {
		assert.ok(docTypeMatchesRoute('doc_chunk', ['doc']));
		assert.ok(!docTypeMatchesRoute('code_chunk', ['doc']));
		assert.ok(docTypeMatchesRoute('code_chunk', ['all']));
	});

	test('computeLocalRouterRetrieveTopK oversamples for routed local queries', () => {
		assert.strictEqual(computeLocalRouterRetrieveTopK(12, ['all'], true), 12);
		assert.strictEqual(computeLocalRouterRetrieveTopK(12, ['doc'], true), 48);
		assert.strictEqual(computeLocalRouterRetrieveTopK(12, ['doc'], false), 12);
		assert.strictEqual(computeLocalRouterRetrieveTopK(20, ['git'], true), 64);
	});

	test('filterRetrievedByRoute keeps doc hits from mixed candidates', () => {
		const code = new Document({ id_: 'c', text: 'code', metadata: { docType: 'code_chunk' } });
		const doc = new Document({ id_: 'd', text: 'doc', metadata: { docType: 'doc_chunk' } });
		const filtered = filterRetrievedByRoute([
			{ node: code, score: 1 },
			{ node: code, score: 0.9 },
			{ node: doc, score: 0.8 },
		], ['doc'], 5);
		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(String(filtered[0].node.id_), 'd');
	});

	test('dedupeRetrievedNodes removes duplicate ids', () => {
		const node = new Document({ id_: 'a::chunk::0', text: 'hello', metadata: { filePath: 'a.ts' } });
		const deduped = dedupeRetrievedNodes([
			{ node, score: 1 },
			{ node, score: 0.5 },
		]);
		assert.strictEqual(deduped.length, 1);
	});

	test('collectLinkedFilesFromDocNodes resolves workspace paths', () => {
		const node = new Document({
			id_: 'doc::0',
			text: 'see impl',
			metadata: {
				docType: 'doc_chunk',
				linkedFiles: ['src/auth.ts'],
			},
		});
		const paths = collectLinkedFilesFromDocNodes([{ node, score: 1 }], 'D:\\proj');
		assert.ok(paths.some(p => p.endsWith('auth.ts')));
	});

	test('mergeOrchestratorOptions includes graphExpandHops default', () => {
		const orch = mergeOrchestratorOptions({});
		assert.strictEqual(orch.graphExpandHops, 1);
		assert.strictEqual(orch.useLlmSubQuestions, false);
	});

	test('classifyRagQueryComplexity and applyIntentOrchestration', () => {
		assert.strictEqual(classifyRagQueryComplexity('解释这段代码'), 'simple');
		assert.strictEqual(classifyRagQueryComplexity('整个项目的架构和跨模块依赖'), 'complex');
		const full = mergeOrchestratorOptions({});
		const lite = applyIntentOrchestration('explain this function', full, true);
		assert.strictEqual(lite.useSubQuestions, false);
		assert.strictEqual(lite.useGraphExpand, false);
	});

	test('splitSubQuestionsWithLlm falls back on LLM failure', async () => {
		const parts = await splitSubQuestionsWithLlm(
			'How does auth work; and what changed in git last night?',
			async () => { throw new Error('fail'); },
		);
		assert.ok(parts.length >= 1);
	});
});
