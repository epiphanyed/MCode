/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Lazy-load Milvus SDK so Electron startup does not pull parquet/thrift (uuid ESM) until needed. */

export type MilvusSdkModule = typeof import('@zilliz/milvus2-sdk-node');

let sdkModule: MilvusSdkModule | undefined;
let sdkLoadPromise: Promise<MilvusSdkModule> | undefined;

export async function loadMilvusSdk(): Promise<MilvusSdkModule> {
	if (sdkModule) {
		return sdkModule;
	}
	if (!sdkLoadPromise) {
		sdkLoadPromise = import('@zilliz/milvus2-sdk-node').then(mod => {
			sdkModule = mod;
			return mod;
		}).catch(err => {
			sdkLoadPromise = undefined;
			throw err;
		});
	}
	return sdkLoadPromise;
}
