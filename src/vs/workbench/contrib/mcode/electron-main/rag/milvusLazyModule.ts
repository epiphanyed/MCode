/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Lazy entry for Milvus runtime modules. Nothing here loads @zilliz/milvus2-sdk-node
 * until the user selects Milvus index or runs an explicit connection test.
 */

import type { BaseNode } from 'llamaindex';
import type { RagMilvusConfig, RagMilvusConnectionResult } from '../../common/mcodeRagTypes.js';
import type { MilvusRagStore } from './milvusStore.js';
import type { MilvusRagRecord } from './milvusRecordMapper.js';

type MilvusStoreModule = typeof import('./milvusStore.js');
type MilvusRecordMapperModule = typeof import('./milvusRecordMapper.js');

let storeModule: MilvusStoreModule | undefined;
let mapperModule: MilvusRecordMapperModule | undefined;

export async function getMilvusStoreModule(): Promise<MilvusStoreModule> {
	if (!storeModule) {
		storeModule = await import('./milvusStore.js');
	}
	return storeModule;
}

async function getMilvusRecordMapperModule(): Promise<MilvusRecordMapperModule> {
	if (!mapperModule) {
		mapperModule = await import('./milvusRecordMapper.js');
	}
	return mapperModule;
}

export async function testMilvusConnectionLazy(config: RagMilvusConfig): Promise<RagMilvusConnectionResult> {
	const mod = await getMilvusStoreModule();
	return mod.testMilvusConnection(config);
}

export async function createMilvusRagStore(config: RagMilvusConfig, workspaceHash: string): Promise<MilvusRagStore> {
	const mod = await getMilvusStoreModule();
	return new mod.MilvusRagStore(config, workspaceHash);
}

export async function nodeToMilvusRecordLazy(node: BaseNode, denseVector: number[]): Promise<MilvusRagRecord> {
	const mod = await getMilvusRecordMapperModule();
	return mod.nodeToMilvusRecord(node, denseVector);
}

export async function milvusHitToMetadataLazy(hit: Record<string, unknown>): Promise<Record<string, unknown>> {
	const mod = await getMilvusRecordMapperModule();
	return mod.milvusHitToMetadata(hit);
}
