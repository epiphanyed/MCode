/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { findTextInCode, relaxMarkdownLine, sanitizeSearchReplaceOrig } from './findTextInCode.js';

suite('findTextInCode', () => {
	test('exact match', () => {
		const file = '# Title\n\nBody line\n';
		assert.deepStrictEqual(findTextInCode('Body line', file), [3, 3]);
	});

	test('markdown list ORIGINAL matches heading in file', () => {
		const file = '# Metafile 转 SVG\n\nSome content\n';
		const orig = '- Metafile 转 SVG\n\n';
		assert.deepStrictEqual(findTextInCode(orig, file), [1, 2]);
	});

	test('trailing empty lines on ORIGINAL', () => {
		const file = '## Section\n\nText\n';
		assert.deepStrictEqual(findTextInCode('## Section\n\n', file), [1, 2]);
	});

	test('strip code fence wrapper from ORIGINAL', () => {
		const file = 'hello\nworld\n';
		const orig = '```\nhello\n```';
		assert.deepStrictEqual(findTextInCode(orig, file), [1, 1]);
	});

	test('CRLF file contents', () => {
		const file = 'line one\r\nline two\r\n';
		assert.deepStrictEqual(findTextInCode('line two', file), [2, 2]);
	});

	test('relaxMarkdownLine', () => {
		assert.strictEqual(relaxMarkdownLine('- Metafile 转 SVG'), 'Metafile 转 SVG');
		assert.strictEqual(relaxMarkdownLine('## Metafile 转 SVG'), 'Metafile 转 SVG');
	});

	test('sanitizeSearchReplaceOrig', () => {
		assert.strictEqual(sanitizeSearchReplaceOrig('- Item\n\n'), '- Item');
	});
});
