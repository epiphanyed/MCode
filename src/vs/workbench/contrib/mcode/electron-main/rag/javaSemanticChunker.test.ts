/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { chunkJava } from './javaSemanticChunker.js';
import { chunkCodeForIndexing, chunkCodeSemantically } from './semanticCodeChunker.js';

suite('javaSemanticChunker', () => {
	test('splits class into method-level chunks', () => {
		const content = `public class PaymentService {
    public int verify(String data) {
        return data.length();
    }

    private void helper() {
        // noop
    }
}
`;
		const chunks = chunkJava(content);
		assert.ok(chunks.some(c => c.symbolType === 'method' && c.symbolName === 'verify'));
		assert.ok(chunks.some(c => c.symbolType === 'method' && c.symbolName === 'helper'));
		assert.ok(!chunks.some(c => c.symbolType === 'class'));
	});

	test('extracts constructor as separate chunk', () => {
		const content = `public class User {
    public User(String name) {
        this.name = name;
    }
}
`;
		const chunks = chunkJava(content);
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].symbolType, 'constructor');
		assert.strictEqual(chunks[0].symbolName, 'User');
	});

	test('interface abstract methods become chunks', () => {
		const content = `public interface Repo {
    void save();

    default void flush() {
        // default impl
    }
}
`;
		const chunks = chunkJava(content);
		assert.ok(chunks.some(c => c.symbolName === 'save' && c.symbolType === 'method'));
		assert.ok(chunks.some(c => c.symbolName === 'flush' && c.symbolType === 'method'));
	});

	test('nested type yields member chunks from each type', () => {
		const content = `public class Outer {
    public void outerMethod() {
        run();
    }

    static class Inner {
        void innerMethod() {
            run();
        }
    }
}
`;
		const chunks = chunkJava(content);
		assert.ok(chunks.some(c => c.symbolName === 'outerMethod'));
		assert.ok(chunks.some(c => c.symbolName === 'innerMethod'));
	});

	test('chunkCodeForIndexing uses Java semantic chunker', async () => {
		const content = `public class PaymentService {
    /** Verifies payment payload length. */
    public int verify(String data) {
        return data.length();
    }
}
`;
		const chunks = await chunkCodeForIndexing(content, 'PaymentService.java');
		const verify = chunks.find(c => c.symbolName === 'verify');
		assert.ok(verify);
		assert.ok(verify!.text.includes('verify'));
		assert.ok(verify!.text.includes('Verifies payment payload length'));
	});

	test('falls back to type chunk when type has no members', () => {
		const content = `public enum Status {
    ACTIVE, INACTIVE
}
`;
		const chunks = chunkCodeSemantically(content, 'Status.java');
		assert.ok(chunks.some(c => c.symbolType === 'enum' && c.symbolName === 'Status'));
	});
});
