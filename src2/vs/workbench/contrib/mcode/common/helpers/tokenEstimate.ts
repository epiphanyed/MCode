/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Lightweight token estimate (Phase 12 CTX-C1) — no external tokenizer. */
export function estimateTokenCount(text: string): number {
	if (!text) {
		return 0;
	}
	let cjk = 0;
	let other = 0;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code >= 0x4e00 && code <= 0x9fff) {
			cjk += 1;
		} else {
			other += 1;
		}
	}
	return Math.ceil(cjk / 1.5 + other / 4);
}

/** Minimum chars to retain after context trim (~500 tokens). */
export const MIN_RETAINED_CHARS = 500 * 4;
