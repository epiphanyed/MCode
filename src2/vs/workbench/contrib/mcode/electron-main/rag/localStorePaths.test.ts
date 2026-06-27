/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import {
	getLocalVectorDbFileName,
	getNamedLocalStorePath,
	resolveLocalStoreLayout,
	sanitizeWorkspaceStoreName,
} from './localStorePaths.js';

suite('localStorePaths', () => {
	test('sanitizeWorkspaceStoreName uses folder basename', () => {
		assert.strictEqual(sanitizeWorkspaceStoreName('D:\\work\\void'), 'void');
		assert.strictEqual(sanitizeWorkspaceStoreName('/home/user/my-app'), 'my-app');
	});

	test('getLocalVectorDbFileName matches project name', () => {
		assert.strictEqual(getLocalVectorDbFileName('D:\\work\\void'), 'void.db');
	});

	test('getNamedLocalStorePath ends with project folder name', () => {
		const storePath = getNamedLocalStorePath('D:\\work\\void');
		assert.ok(storePath.endsWith(`${path.sep}void`) || storePath.endsWith('/void'));
	});

	test('resolveLocalStoreLayout defaults to named layout for new projects', () => {
		const layout = resolveLocalStoreLayout('D:\\work\\my-project', 'abc123hash');
		assert.strictEqual(layout.dbFileName, 'my-project.db');
		assert.ok(layout.storePath.includes(`${path.sep}my-project`) || layout.storePath.endsWith('/my-project'));
		assert.strictEqual(layout.isLegacy, false);
	});
});
