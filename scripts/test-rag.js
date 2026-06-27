/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAG_GLOB = '**/workbench/contrib/mcode/**/*.test.js';
const CRASH_DIR = path.join(ROOT, '.build', 'crashes');

function run(command, args, options = {}) {
	const result = cp.spawnSync(command, args, {
		cwd: ROOT,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		...options,
	});
	if (result.error) {
		console.error(result.error);
		process.exit(1);
	}
	return result.status ?? 1;
}

function ensureElectron() {
	if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
		console.log('[test-rag] Installing dependencies...');
		const code = run('npm', ['i']);
		if (code !== 0) {
			process.exit(code);
		}
	}

	console.log('[test-rag] Ensuring Electron is downloaded...');
	const code = run('npm', ['run', 'electron']);
	if (code !== 0) {
		process.exit(code);
	}
}

function getElectronPath() {
	const product = require(path.join(ROOT, 'product.json'));
	if (process.platform === 'darwin') {
		return path.join(ROOT, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', 'Electron');
	}
	if (process.platform === 'win32') {
		return path.join(ROOT, '.build', 'electron', `${product.applicationName}.exe`);
	}
	return path.join(ROOT, '.build', 'electron', product.applicationName);
}

function normalizeExitCode(code) {
	// app.exit(0) can exit with code 255 in some Electron builds (see scripts/test.bat).
	return code === 255 ? 0 : code;
}

function main() {
	ensureElectron();

	const electronPath = getElectronPath();
	if (!fs.existsSync(electronPath)) {
		console.error(`[test-rag] Electron binary not found: ${electronPath}`);
		process.exit(1);
	}

	const testArgs = [
		path.join(ROOT, 'test', 'unit', 'electron', 'index.js'),
		'--runGlob', RAG_GLOB,
		'--crash-reporter-directory', CRASH_DIR,
		...process.argv.slice(2),
	];

	if (process.platform === 'linux') {
		testArgs.push('--disable-dev-shm-usage');
	}

	console.log(`[test-rag] Running RAG unit tests (${RAG_GLOB})...`);

	const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
	const code = cp.spawnSync(electronPath, testArgs, {
		cwd: ROOT,
		stdio: 'inherit',
		env,
	}).status ?? 1;

	process.exit(normalizeExitCode(code));
}

main();
