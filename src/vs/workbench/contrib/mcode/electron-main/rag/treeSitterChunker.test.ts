/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { chunkCodeForIndexing } from './semanticCodeChunker.js';
import { canTreeSitterParse, chunkWithTreeSitter } from './treeSitterChunker.js';
import { isTreeSitterAvailable, probeTreeSitterLoad } from './treeSitterRuntime.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

async function skipUnlessTreeSitterRuntime(this: Mocha.Context): Promise<void> {
	if (!isTreeSitterAvailable() || !(await probeTreeSitterLoad())) {
		this.skip();
	}
}

suite('treeSitterChunker', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('canTreeSitterParse covers Phase 5 languages', () => {
		assert.ok(canTreeSitterParse('a.cpp'));
		assert.ok(canTreeSitterParse('a.ts'));
		assert.ok(canTreeSitterParse('a.js'));
		assert.ok(canTreeSitterParse('a.py'));
		assert.ok(canTreeSitterParse('a.kt'));
		assert.ok(canTreeSitterParse('build.gradle.kts'));
		assert.ok(!canTreeSitterParse('a.sci'));
		assert.ok(!canTreeSitterParse('a.m'));
	});

	test('tree-sitter C++ extracts function and class', async function () {
		await skipUnlessTreeSitterRuntime.call(this);
		const content = `struct PaymentConfig { int timeout; };
int verify_signature(const char* data) { return 1; }
class Handler { void run() {} };
`;
		const chunks = await chunkWithTreeSitter(content, 'pay.cpp');
		assert.ok(chunks && chunks.length >= 2);
		const names = chunks!.map(c => c.symbolName).filter(Boolean);
		assert.ok(names.includes('verify_signature'));
	});

	test('chunkCodeForIndexing prefers AST for TypeScript', async function () {
		await skipUnlessTreeSitterRuntime.call(this);
		const content = `export interface Config { timeout: number; }
export function verify(data: string): number { return 1; }
export class Handler { run() {} }
`;
		const chunks = await chunkCodeForIndexing(content, 'api.ts');
		assert.ok(chunks.some(c => c.symbolType === 'interface' && c.symbolName === 'Config'));
		assert.ok(chunks.some(c => c.symbolType === 'function' && c.symbolName === 'verify'));
		assert.ok(chunks.some(c => c.symbolType === 'class' && c.symbolName === 'Handler'));
	});

	test('chunkCodeForIndexing falls back for Scilab', async () => {
		const content = `function y = myfunc(x)
  y = x + 1
endfunction
`;
		const chunks = await chunkCodeForIndexing(content, 'algo.sci');
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].symbolName, 'myfunc');
	});

	test('chunkCodeForIndexing keeps doc comments above functions', async function () {
		await skipUnlessTreeSitterRuntime.call(this);
		const content = `/**
 * Verifies payment signature.
 * @param data payload bytes
 */
export function verify(data: string): number {
  return 1;
}
`;
		const chunks = await chunkCodeForIndexing(content, 'pay.ts');
		const verifyChunk = chunks.find(c => c.symbolName === 'verify');
		assert.ok(verifyChunk);
		assert.ok(verifyChunk!.text.includes('Verifies payment signature'));
		assert.ok(verifyChunk!.text.includes('@param data'));
	});

	test('chunkCodeForIndexing strips file header but keeps function doc', async function () {
		await skipUnlessTreeSitterRuntime.call(this);
		const content = `// Copyright 2026 Example Corp. All rights reserved.
// Licensed under the MIT License.

/** Process incoming request. */
export function handleRequest(): void {}
`;
		const chunks = await chunkCodeForIndexing(content, 'api.ts');
		const handleChunk = chunks.find(c => c.symbolName === 'handleRequest');
		assert.ok(handleChunk);
		assert.ok(!handleChunk!.text.includes('Copyright 2026'));
		assert.ok(handleChunk!.text.includes('Process incoming request'));
	});

	test('tree-sitter Kotlin extracts class, interface, property, and expression-body fun', async function () {
		await skipUnlessTreeSitterRuntime.call(this);
		const content = `class MyKotlinClass {
    fun processData(input: String): Int {
        return input.length
    }
}

interface MyInterface { fun foo(): Unit }

enum class Color { RED, GREEN }

val topLevel = 1

fun topLevelFun() = 42
`;
		const chunks = await chunkWithTreeSitter(content, 'Sample.kt');
		assert.ok(chunks && chunks.length >= 5);
		assert.ok(chunks!.some(c => c.symbolType === 'class' && c.symbolName === 'MyKotlinClass'));
		assert.ok(chunks!.some(c => c.symbolType === 'interface' && c.symbolName === 'MyInterface'));
		assert.ok(chunks!.some(c => c.symbolType === 'enum' && c.symbolName === 'Color'));
		assert.ok(chunks!.some(c => c.symbolType === 'property' && c.symbolName === 'topLevel'));
		assert.ok(chunks!.some(c => c.symbolType === 'function' && c.symbolName === 'topLevelFun'));
	});

	test('chunkCodeForIndexing prefers AST for Kotlin', async function () {
		await skipUnlessTreeSitterRuntime.call(this);
		const content = `object CompanionObject {
    fun logMessage(msg: String) { println(msg) }
}

fun greet() = "hello"
`;
		const chunks = await chunkCodeForIndexing(content, 'Main.kt');
		assert.ok(chunks.some(c => c.symbolType === 'class' && c.symbolName === 'CompanionObject'));
		assert.ok(chunks.some(c => c.symbolType === 'function' && c.symbolName === 'greet'));
	});
});
