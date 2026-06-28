/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Electron Main tree-sitter loader (Phase 5).
 *
 * `@vscode/tree-sitter-wasm/wasm/tree-sitter.js` is AMD-only (UMD `factory(exports)` does not
 * populate CJS exports). Load via global `define.amd` + `createRequire(scriptPath)` in real Node
 * context so `Parser.init()` can use dynamic `import()`. See TREE_SITTER_LOADER.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type * as Parser from '@vscode/tree-sitter-wasm';

type TreeSitterWasm = typeof import('@vscode/tree-sitter-wasm');

let wasmModule: TreeSitterWasm | undefined;
let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Parser.Language>();

function resolveWasmDir(): string {
	const candidates = [
		path.join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
	];
	if (typeof import.meta.url === 'string') {
		const here = path.dirname(fileURLToPath(import.meta.url));
		candidates.push(path.join(here, '../../../../../../../node_modules/@vscode/tree-sitter-wasm/wasm'));
	}
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, 'tree-sitter.wasm'))) {
			return dir;
		}
	}
	throw new Error('[RAG] @vscode/tree-sitter-wasm not found under node_modules');
}

type DefineCallback = (exports: object) => TreeSitterWasm;

function loadTreeSitterViaAmd(scriptPath: string): TreeSitterWasm {
	const defineCalls: Array<{ callback: DefineCallback }> = [];
	const priorDefine = (globalThis as { define?: unknown }).define;
	const priorAmd = (globalThis as { define?: { amd?: boolean } }).define?.amd;

	(globalThis as { define?: unknown }).define = ((id: unknown, deps: unknown, cb: unknown) => {
		let callback = cb;
		if (typeof id !== 'string') {
			callback = deps;
		}
		defineCalls.push({ callback: callback as DefineCallback });
	}) as unknown;
	(globalThis as { define?: { amd?: boolean } }).define!.amd = true;

	try {
		const req = createRequire(scriptPath);
		req(scriptPath);
		const defineCall = defineCalls.pop();
		if (!defineCall) {
			throw new Error('[RAG] tree-sitter.js did not register an AMD module');
		}
		const amdExports = {};
		return defineCall.callback(amdExports) ?? amdExports as TreeSitterWasm;
	} finally {
		if (priorDefine === undefined) {
			delete (globalThis as { define?: unknown }).define;
		} else {
			(globalThis as { define?: unknown }).define = priorDefine;
			if (priorAmd !== undefined) {
				(globalThis as { define?: { amd?: boolean } }).define!.amd = priorAmd;
			}
		}
	}
}

async function getWasmModule(): Promise<TreeSitterWasm> {
	if (!wasmModule) {
		const wasmDir = resolveWasmDir();
		const scriptPath = path.join(wasmDir, 'tree-sitter.js');
		wasmModule = loadTreeSitterViaAmd(scriptPath);
	}
	return wasmModule;
}

export async function ensureTreeSitterInitialized(): Promise<void> {
	if (!initPromise) {
		initPromise = (async () => {
			const { Parser } = await getWasmModule();
			const wasmDir = resolveWasmDir();
			await Parser.init({
				locateFile: () => path.join(wasmDir, 'tree-sitter.wasm'),
			});
		})();
	}
	await initPromise;
}

export async function loadTreeSitterLanguage(grammarWasmName: string): Promise<Parser.Language> {
	const cached = languageCache.get(grammarWasmName);
	if (cached) {
		return cached;
	}
	await ensureTreeSitterInitialized();
	const { Language } = await getWasmModule();
	const wasmPath = path.join(resolveWasmDir(), `${grammarWasmName}.wasm`);
	const fileBuffer = fs.readFileSync(wasmPath);
	const language = await Language.load(new Uint8Array(fileBuffer));
	languageCache.set(grammarWasmName, language);
	return language;
}

export async function createTreeSitterParser(grammarWasmName: string): Promise<Parser.Parser> {
	const { Parser } = await getWasmModule();
	await ensureTreeSitterInitialized();
	const language = await loadTreeSitterLanguage(grammarWasmName);
	const parser = new Parser();
	parser.setLanguage(language);
	return parser;
}

const parserPool = new Map<string, Parser.Parser>();

/** Skip AST parse for very large sources to limit WASM peak memory (regex fallback still runs). */
export const MAX_TREE_SITTER_PARSE_BYTES = 1024 * 1024;

export function isTreeSitterWasmAbortError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /Aborted|RuntimeError|out of memory|allocation failed/i.test(message);
}

/** Release pooled parsers at index build boundaries. */
export function resetTreeSitterRuntimeForIndexBuild(): void {
	disposeAllTreeSitterParsers();
}

export async function getSharedTreeSitterParser(grammarWasmName: string): Promise<Parser.Parser> {
	let parser = parserPool.get(grammarWasmName);
	if (!parser) {
		parser = await createTreeSitterParser(grammarWasmName);
		parserPool.set(grammarWasmName, parser);
	}
	return parser;
}

export function deleteTreeSitterTree(tree: Parser.Tree | null | undefined): void {
	if (!tree) {
		return;
	}
	try {
		tree.delete();
	} catch {
		// best-effort WASM cleanup
	}
}

export function disposeAllTreeSitterParsers(): void {
	for (const parser of parserPool.values()) {
		try {
			parser.delete();
		} catch {
			// best-effort
		}
	}
	parserPool.clear();
}

/** Parse with a pooled parser; caller must delete the returned tree. */
export async function parseWithSharedTreeSitterParser(
	grammarWasmName: string,
	content: string,
): Promise<Parser.Tree | null> {
	if (Buffer.byteLength(content, 'utf8') > MAX_TREE_SITTER_PARSE_BYTES) {
		return null;
	}
	const parser = await getSharedTreeSitterParser(grammarWasmName);
	return parser.parse(content);
}

let loadProbe: boolean | undefined;

/** True when wasm files exist on disk (cheap sync check). */
export function isTreeSitterAvailable(): boolean {
	try {
		resolveWasmDir();
		return true;
	} catch {
		return false;
	}
}

/** True when tree-sitter.js can load in the current runtime (Electron tests may fail AMD load). */
export async function probeTreeSitterLoad(): Promise<boolean> {
	if (loadProbe !== undefined) {
		return loadProbe;
	}
	if (!isTreeSitterAvailable()) {
		loadProbe = false;
		return false;
	}
	try {
		await getWasmModule();
		await ensureTreeSitterInitialized();
		loadProbe = true;
	} catch {
		loadProbe = false;
	}
	return loadProbe;
}
