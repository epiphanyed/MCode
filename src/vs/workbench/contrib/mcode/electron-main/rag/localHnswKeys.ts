/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

/** Stable 64-bit key for USearch from a chunk id string. */
export function chunkIdToHnswKey(chunkId: string): bigint {
	const digest = createHash('sha256').update(chunkId, 'utf8').digest();
	return digest.readBigUInt64LE(0);
}

export function hnswKeyToSqlValue(key: bigint): string {
	return key.toString(10);
}

export function sqlValueToHnswKey(value: string): bigint {
	return BigInt(value);
}
