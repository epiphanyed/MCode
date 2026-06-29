/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { stripLeadingFileHeader, offsetChunkLineNumbers } from '../../common/helpers/fileHeaderStripper.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('fileHeaderStripper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips VS Code style block copyright header', () => {
		const content = `/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Example Corp. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

export function hello() {
	return 1;
}
`;
		const { body, headerLineCount } = stripLeadingFileHeader(content);
		assert.ok(headerLineCount >= 4);
		assert.ok(body.startsWith('export function hello'));
		assert.ok(!body.includes('Copyright 2026 Example'));
	});

	test('strips hash comment copyright header (Python)', () => {
		const content = `# Copyright 2024 Acme
# Licensed under the MIT License

def main():
    pass
`;
		const { body, headerLineCount } = stripLeadingFileHeader(content);
		assert.strictEqual(headerLineCount, 3);
		assert.ok(body.startsWith('def main'));
	});

	test('does not strip pragma once without copyright', () => {
		const content = `#pragma once
void foo();
`;
		const { body, headerLineCount } = stripLeadingFileHeader(content);
		assert.strictEqual(headerLineCount, 0);
		assert.strictEqual(body, content);
	});

	test('offsetChunkLineNumbers maps body lines to file lines', () => {
		const offset = offsetChunkLineNumbers([{ startLine: 1, endLine: 3 }], 5);
		assert.strictEqual(offset[0].startLine, 6);
		assert.strictEqual(offset[0].endLine, 8);
	});
});
