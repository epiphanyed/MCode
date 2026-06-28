/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isTreeSitterWasmAbortError } from './treeSitterRuntime.js';

suite('treeSitterRuntime', () => {
	test('isTreeSitterWasmAbortError detects Emscripten abort', () => {
		assert.strictEqual(isTreeSitterWasmAbortError(new Error('Aborted(). Build with -sASSERTIONS for more info.')), true);
		assert.strictEqual(isTreeSitterWasmAbortError(new Error('RuntimeError: unreachable')), true);
		assert.strictEqual(isTreeSitterWasmAbortError(new Error('file not found')), false);
	});
});
