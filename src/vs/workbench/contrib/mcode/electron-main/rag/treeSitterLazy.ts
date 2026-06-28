/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

type TreeSitterChunkerModule = typeof import('./treeSitterChunker.js');

let chunkerLoadState: 'pending' | 'ok' | 'unavailable' = 'pending';
let chunkerModule: TreeSitterChunkerModule | null = null;
let warnedChunkerUnavailable = false;

/** Load tree-sitter chunker once; cache success/failure so missing build output does not spam per file. */
export async function loadTreeSitterChunkerModule(): Promise<TreeSitterChunkerModule | null> {
	if (chunkerLoadState === 'unavailable') {
		return null;
	}
	if (chunkerLoadState === 'ok' && chunkerModule) {
		return chunkerModule;
	}
	try {
		chunkerModule = await import('./treeSitterChunker.js');
		chunkerLoadState = 'ok';
		return chunkerModule;
	} catch (err) {
		chunkerLoadState = 'unavailable';
		chunkerModule = null;
		if (!warnedChunkerUnavailable) {
			warnedChunkerUnavailable = true;
			console.warn('[RAG] tree-sitter chunker unavailable; using regex fallback for code files.', err);
		}
		return null;
	}
}

let runtimeReady: boolean | undefined;
let warnedRuntimeUnavailable = false;

/** Probe tree-sitter WASM runtime once; failures disable AST path for the session. */
export async function isTreeSitterRuntimeReady(): Promise<boolean> {
	if (runtimeReady !== undefined) {
		return runtimeReady;
	}
	try {
		const { probeTreeSitterLoad } = await import('./treeSitterRuntime.js');
		runtimeReady = await probeTreeSitterLoad();
		return runtimeReady;
	} catch (err) {
		runtimeReady = false;
		if (!warnedRuntimeUnavailable) {
			warnedRuntimeUnavailable = true;
			console.warn('[RAG] tree-sitter runtime unavailable; using regex fallback for code files.', err);
		}
		return false;
	}
}

/** Clear cached readiness after index build so the next build re-probes. */
export function resetTreeSitterLazyProbeCache(): void {
	runtimeReady = undefined;
}
