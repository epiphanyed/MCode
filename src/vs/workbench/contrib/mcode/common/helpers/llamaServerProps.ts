/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Build llama-server GET /props URL from an OpenAI-compatible base URL (e.g. http://host:8080/v1). */
export function llamaServerPropsUrl(openAiBaseUrl: string): string | null {
	const trimmed = openAiBaseUrl?.trim();
	if (!trimmed) {
		return null;
	}
	try {
		const u = new URL(trimmed);
		let path = u.pathname.replace(/\/+$/, '');
		if (path.endsWith('/v1')) {
			path = path.slice(0, -3);
		}
		u.pathname = `${path || ''}/props`.replace(/\/{2,}/g, '/');
		u.search = '';
		u.hash = '';
		return u.toString();
	} catch {
		return null;
	}
}

/** Parse n_ctx from llama-server GET /props JSON. */
export function parseContextWindowFromLlamaServerProps(json: unknown): number | null {
	if (!json || typeof json !== 'object') {
		return null;
	}
	const root = json as Record<string, unknown>;
	const settings = root.default_generation_settings;
	if (!settings || typeof settings !== 'object') {
		return null;
	}
	const gs = settings as Record<string, unknown>;
	const direct = gs.n_ctx;
	if (typeof direct === 'number' && direct > 0) {
		return direct;
	}
	const params = gs.params;
	if (params && typeof params === 'object') {
		const nCtx = (params as Record<string, unknown>).n_ctx;
		if (typeof nCtx === 'number' && nCtx > 0) {
			return nCtx;
		}
	}
	return null;
}

export function defaultReservedOutputTokens(contextWindow: number): number {
	return Math.min(8192, Math.max(2048, Math.floor(contextWindow * 0.125)));
}
