/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as path from 'path';
import { extractMarkdownLinkedFiles } from './markdownLinkParser.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('markdownLinkParser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts relative markdown links', () => {
		const docPath = path.join('D:', 'proj', 'docs', 'setup.md');
		const workspaceRoot = path.join('D:', 'proj');
		const content = `
See [Payment API](../src/services/payment.ts) and [readme](./README.md).
External [site](https://example.com) ignored.
`;
		const linked = extractMarkdownLinkedFiles(content, docPath, workspaceRoot);
		assert.ok(linked.includes('src/services/payment.ts'));
		assert.ok(linked.includes('docs/README.md'));
		assert.ok(!linked.some(f => f.includes('example.com')));
	});

	test('ignores anchor-only and mailto links', () => {
		const docPath = '/proj/docs/a.md';
		const content = '[section](#intro) [mail](mailto:a@b.com)';
		const linked = extractMarkdownLinkedFiles(content, docPath, '/proj');
		assert.strictEqual(linked.length, 0);
	});
});
