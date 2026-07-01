/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Extract human-readable text from Ollama ResponseError and generic errors. */
export function getEmbeddingErrorText(err: unknown): string {
	if (err instanceof Error) {
		const nested = (err as Error & { error?: unknown }).error;
		if (typeof nested === 'string' && nested.trim()) {
			return `${err.message}\n${nested}`.trim();
		}
		return err.message;
	}
	if (typeof err === 'string') {
		return err;
	}
	return String(err);
}

/** Embedding failures that will repeat for every file — abort the build immediately. */
export function isFatalEmbeddingError(err: unknown): boolean {
	const text = getEmbeddingErrorText(err).toLowerCase();
	return (
		text.includes('llama-server process has terminated')
		|| text.includes('llama-server binary not found')
		|| text.includes('error starting llama-server')
		|| text.includes('cuda error')
		|| text.includes('ptx was compiled')
		|| text.includes('econnrefused')
		|| text.includes('connectex')
		|| text.includes('enotfound')
		|| text.includes('fetch failed')
		|| text.includes('socket hang up')
	);
}

/** User-facing guidance for Settings UI and index error events. */
export function formatUserFacingEmbeddingError(err: unknown, endpoint?: string): string {
	const text = getEmbeddingErrorText(err);
	const host = endpoint?.trim() || 'Ollama';
	const lower = text.toLowerCase();

	if (lower.includes('llama-server binary not found') || lower.includes('error starting llama-server')) {
		return `Ollama at ${host} is incomplete or misconfigured (llama-server missing). Reinstall Ollama on that host or switch back to a working endpoint (e.g. http://127.0.0.1:11434).`;
	}
	if (lower.includes('cuda') || lower.includes('ptx')) {
		return `Ollama GPU/CUDA crashed while embedding (${host}). Update GPU drivers and Ollama, run "ollama pull bge-m3" again, or force CPU mode (set OLLAMA_LLM_LIBRARY=cpu before starting Ollama).`;
	}
	if (lower.includes('llama-server process has terminated')) {
		return `Ollama embedding server crashed (${host}). Restart Ollama and verify the model with: ollama run bge-m3 "test".`;
	}
	if (lower.includes('econnrefused') || lower.includes('connectex') || lower.includes('enotfound') || lower.includes('fetch failed')) {
		return `Cannot reach Ollama at ${host}. Start Ollama locally or fix the endpoint in Settings → Embedding.`;
	}

	return `Embedding failed (${host}): ${text.split('\n')[0]}`;
}
