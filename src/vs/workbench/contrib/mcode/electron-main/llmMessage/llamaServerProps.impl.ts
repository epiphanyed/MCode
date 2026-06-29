/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { llamaServerPropsUrl, parseContextWindowFromLlamaServerProps } from '../../common/helpers/llamaServerProps.js';

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchLlamaServerContextWindow(openAiBaseUrl: string): Promise<number | null> {
	const propsUrl = llamaServerPropsUrl(openAiBaseUrl);
	if (!propsUrl) {
		return null;
	}
	try {
		const res = await fetch(propsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) {
			return null;
		}
		const json: unknown = await res.json();
		return parseContextWindowFromLlamaServerProps(json);
	} catch {
		return null;
	}
}
