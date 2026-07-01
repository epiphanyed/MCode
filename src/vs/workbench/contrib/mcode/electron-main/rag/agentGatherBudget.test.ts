/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import type { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import {
	buildConsecutiveGatherWarning,
	capSearchPathListResult,
	countConsecutiveGathers,
	detectAgentDeliverablePath,
	GATHER_BUDGET_BEFORE_EDIT_WARNING,
} from '../../common/helpers/agentGatherBudget.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('agentGatherBudget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('countConsecutiveGathers stops at user or edit', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'write 代码分析/svg.md', displayContent: 'write 代码分析/svg.md', selections: [], state: { stagingSelections: [], isBeingEdited: false } },
			{ role: 'tool', type: 'success', name: 'search_for_files', params: {} as any, result: {}, content: '', id: '1', rawParams: {}, mcpServerName: undefined },
			{ role: 'tool', type: 'success', name: 'read_file', params: { uri: URI.file('/a.ts'), pageNumber: 1, startLine: null, endLine: null }, result: {}, content: '', id: '2', rawParams: {}, mcpServerName: undefined },
		];
		assert.strictEqual(countConsecutiveGathers(messages), 2);
	});

	test('detectAgentDeliverablePath from user message', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: '输出 `代码分析\\svg.md`', displayContent: '输出 `代码分析\\svg.md`', selections: [], state: { stagingSelections: [], isBeingEdited: false } },
		];
		const path = detectAgentDeliverablePath(messages);
		assert.ok(path?.toLowerCase().endsWith('svg.md'));
	});

	test('buildConsecutiveGatherWarning when over budget', () => {
		const warn = buildConsecutiveGatherWarning(GATHER_BUDGET_BEFORE_EDIT_WARNING, 'D:\\proj\\代码分析\\svg.md');
		assert.ok(warn?.includes('CONSECUTIVE GATHERS'));
		assert.ok(warn?.includes('svg.md'));
	});

	test('capSearchPathListResult limits chars', () => {
		const lines = Array.from({ length: 200 }, (_, i) => `D:\\very\\long\\path\\file${i}.ts`);
		const out = capSearchPathListResult(lines, 1, true, '\n(has next page)');
		assert.ok(out.length <= 8200);
		assert.ok(out.includes('search_in_folder'));
	});
});
