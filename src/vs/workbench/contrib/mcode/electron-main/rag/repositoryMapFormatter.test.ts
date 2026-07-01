/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { dedupeCodeSymbols, formatFileRepositoryBlock, formatSymbolSignatureLine } from './repositoryMapFormatter.js';
import type { CodeSymbolEntry } from './ragQueryHelpers.js';

suite('repositoryMapFormatter', () => {
	test('dedupeCodeSymbols merges split chunks for same symbol', () => {
		const symbols: CodeSymbolEntry[] = [
			{ startLine: 10, endLine: 20, symbolType: 'class', symbolName: 'Foo' },
			{ startLine: 10, endLine: 45, symbolType: 'class', symbolName: 'Foo' },
			{ startLine: 50, endLine: 60, symbolType: 'function', symbolName: 'bar' },
		];
		const deduped = dedupeCodeSymbols(symbols);
		assert.strictEqual(deduped.length, 2);
		assert.strictEqual(deduped[0].endLine, 45);
	});

	test('formatSymbolSignatureLine includes line range', () => {
		const line = formatSymbolSignatureLine({
			startLine: 3,
			endLine: 18,
			symbolType: 'class',
			symbolName: 'CSvgParser',
		});
		assert.ok(line.includes('CSvgParser'));
		assert.ok(line.includes('Lines 3-18'));
	});

	test('formatFileRepositoryBlock includes graph hints', () => {
		const block = formatFileRepositoryBlock(
			'D:\\proj\\a.ts',
			[{ startLine: 1, endLine: 10, symbolType: 'class', symbolName: 'A' }],
			[{ filePath: 'D:\\proj\\b.ts', kind: 'imports', reason: 'import dependency' }],
		);
		assert.ok(block.includes('a.ts'));
		assert.ok(block.includes('[graph] imports'));
		assert.ok(block.includes('b.ts'));
	});
});
