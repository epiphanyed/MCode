/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { findLeadingCommentStartLine, extendChunkWithLeadingComments } from './symbolLeadingComments.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('symbolLeadingComments', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('findLeadingCommentStartLine includes block doc comment', () => {
		const lines = [
			'/**',
			' * Computes payment total.',
			' * @param amount base amount',
			' */',
			'int compute(int amount) {',
			'  return amount;',
			'}',
		];
		assert.strictEqual(findLeadingCommentStartLine(lines, 5), 1);
	});

	test('findLeadingCommentStartLine includes consecutive line comments', () => {
		const lines = [
			'// Validates input',
			'// Returns true when ok',
			'function validate(x) {',
			'  return true;',
			'}',
		];
		assert.strictEqual(findLeadingCommentStartLine(lines, 3), 1);
	});

	test('findLeadingCommentStartLine stops at previous symbol', () => {
		const lines = [
			'/** doc for foo */',
			'void foo() {}',
			'/** doc for bar */',
			'void bar() {}',
		];
		assert.strictEqual(findLeadingCommentStartLine(lines, 4), 3);
	});

	test('extendChunkWithLeadingComments prepends comment text', () => {
		const content = `/**
 * Verify signature.
 */
export function verify(data: string): number {
  return 1;
}
`;
		const extended = extendChunkWithLeadingComments(content, {
			text: 'export function verify(data: string): number {\n  return 1;\n}',
			symbolType: 'function',
			symbolName: 'verify',
			startLine: 4,
			endLine: 6,
		});
		assert.ok(extended.text.includes('Verify signature'));
		assert.ok(extended.text.includes('export function verify'));
		assert.strictEqual(extended.startLine, 1);
	});

	test('extendChunkWithLeadingComments skips file chunks', () => {
		const chunk = {
			text: 'whole file',
			symbolType: 'file',
			startLine: 1,
			endLine: 10,
		};
		const extended = extendChunkWithLeadingComments('// comment\nfoo();', chunk);
		assert.strictEqual(extended.text, chunk.text);
		assert.strictEqual(extended.startLine, 1);
	});
});
