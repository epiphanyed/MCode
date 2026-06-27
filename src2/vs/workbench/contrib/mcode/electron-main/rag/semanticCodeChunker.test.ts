/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { chunkCodeForIndexing, chunkCodeSemantically, MAX_SYMBOL_LINES } from './semanticCodeChunker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('semanticCodeChunker', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('C++ header function declaration', () => {
		const content = `#pragma once
void verify_signature(const uint8_t* data, size_t len);
int compute(int a, int b);
`;
		const chunks = chunkCodeSemantically(content, 'header.h');
		const names = chunks.filter(c => c.symbolType === 'function').map(c => c.symbolName);
		assert.ok(names.includes('verify_signature'));
		assert.ok(names.includes('compute'));
	});

	test('C++ function definition with body', () => {
		const content = `int add(int a, int b) {
	return a + b;
}
`;
		const chunks = chunkCodeSemantically(content, 'math.cpp');
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].symbolType, 'function');
		assert.strictEqual(chunks[0].symbolName, 'add');
	});

	test('TypeScript arrow function', () => {
		const content = `export const handler = async (req: Request) => {
	return req.json();
};
`;
		const chunks = chunkCodeSemantically(content, 'api.ts');
		assert.ok(chunks.some(c => c.symbolType === 'function' && c.symbolName === 'handler'));
	});

	test('export default function', () => {
		const content = `export default function App() {
	return null;
}
`;
		const chunks = chunkCodeSemantically(content, 'App.tsx');
		assert.ok(chunks.some(c => c.symbolType === 'function'));
	});

	test('Python def and class', () => {
		const content = `class Foo:
    def bar(self):
        return 1
`;
		const chunks = chunkCodeSemantically(content, 'mod.py');
		assert.ok(chunks.some(c => c.symbolType === 'class' && c.symbolName === 'Foo'));
	});

	test('Scilab function/endfunction', () => {
		const content = `function y = myfunc(x)
  y = x + 1
endfunction
`;
		const chunks = chunkCodeSemantically(content, 'algo.sci');
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].symbolType, 'function');
		assert.strictEqual(chunks[0].symbolName, 'myfunc');
	});

	test('MATLAB function/end', () => {
		const content = `function y = foo(x)
    y = x + 1;
end
`;
		const chunks = chunkCodeSemantically(content, 'algo.m');
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].symbolName, 'foo');
	});

	test('MATLAB classdef/end', () => {
		const content = `classdef MyHandler
    properties
        value
    end
    methods
        function obj = MyHandler(v)
            obj.value = v;
        end
    end
end
`;
		const chunks = chunkCodeSemantically(content, 'Handler.m');
		assert.ok(chunks.some(c => c.symbolType === 'class' && c.symbolName === 'MyHandler'));
	});

	test('Java class', () => {
		const content = `public class PaymentService {
    public int verify(String data) {
        return data.length();
    }
}
`;
		const chunks = chunkCodeSemantically(content, 'PaymentService.java');
		assert.ok(chunks.some(c => c.symbolType === 'method' && c.symbolName === 'verify'));
	});

	test('splits oversized symbols', () => {
		const body = Array.from({ length: 600 }, (_, i) => `  line${i}();`).join('\n');
		const content = `function big() {\n${body}\n}`;
		const chunks = chunkCodeSemantically(content, 'big.ts', 512);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every(c => c.endLine - c.startLine + 1 <= MAX_SYMBOL_LINES));
		assert.ok(chunks[0].partIndex !== undefined);
		assert.ok(chunks[0].partTotal !== undefined);
	});

	test('chunkCodeForIndexing strips copyright header from chunk text and preserves line numbers', async () => {
		const content = `/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Example Corp. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

function y = indexedFn()
  y = 42;
endfunction
`;
		const chunks = await chunkCodeForIndexing(content, 'sample.sci');
		assert.strictEqual(chunks.length >= 1, true);
		const fn = chunks.find(c => c.symbolName === 'indexedFn');
		assert.strictEqual(fn !== undefined, true);
		assert.strictEqual(fn!.text.includes('Copyright 2026 Example'), false);
		assert.strictEqual(fn!.startLine > 4, true);
	});
});
