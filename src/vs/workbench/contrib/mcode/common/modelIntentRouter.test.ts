/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	classifyQueryIntent,
	routeModelByIntent,
} from './modelIntentRouter.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('modelIntentRouter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifyQueryIntent detects fast queries', () => {
		assert.strictEqual(classifyQueryIntent('解释这段代码'), 'fast');
		assert.strictEqual(classifyQueryIntent('what is this function'), 'fast');
	});

	test('classifyQueryIntent detects reasoning queries', () => {
		assert.strictEqual(classifyQueryIntent('why does this crash with null pointer'), 'reasoning');
		assert.strictEqual(classifyQueryIntent('这段代码报错怎么办'), 'reasoning');
	});

	test('classifyQueryIntent defaults to code', () => {
		assert.strictEqual(classifyQueryIntent('refactor the payment module'), 'code');
	});

	test('routeModelByIntent uses configured fast model', () => {
		const defaultModel = { providerName: 'openAI' as const, modelName: 'gpt-4o' };
		const fastModel = { providerName: 'openAI' as const, modelName: 'gpt-4o-mini' };
		const result = routeModelByIntent('explain this', defaultModel, {
			enabled: true,
			fastModel,
			reasoningModel: null,
		});
		assert.strictEqual(result.routed, true);
		assert.strictEqual(result.model.modelName, 'gpt-4o-mini');
	});

	test('routeModelByIntent skips when disabled', () => {
		const defaultModel = { providerName: 'openAI' as const, modelName: 'gpt-4o' };
		const result = routeModelByIntent('explain this', defaultModel, {
			enabled: false,
			fastModel: { providerName: 'openAI', modelName: 'gpt-4o-mini' },
			reasoningModel: null,
		});
		assert.strictEqual(result.routed, false);
		assert.strictEqual(result.model.modelName, 'gpt-4o');
	});
});
