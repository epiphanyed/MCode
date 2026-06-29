/*--------------------------------------------------------------------------------------

 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.

 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.

 *--------------------------------------------------------------------------------------*/



import { Event } from '../../../../base/common/event.js';

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';

import {

	IVoidRagService,

	RagEmbeddingConfig,

	RagFileChange,

	RagIncrementalSyncEvent,

	RagIndexCompleteEvent,

	RagIndexErrorEvent,

	RagIndexProgressEvent,

	RagIndexStatus,

	RagInitOptions,

	RagMilvusConfig,

	RagMilvusConnectionResult,

	RagQueryOptions,

	RagRelatedDependency,

} from '../common/mcodeRagTypes.js';

import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';



class VoidRagBrowserService implements IVoidRagService {

	readonly _serviceBrand: undefined;

	private readonly voidRag: IVoidRagService;



	readonly onIndexProgress: Event<RagIndexProgressEvent>;

	readonly onIndexComplete: Event<RagIndexCompleteEvent>;

	readonly onIndexError: Event<RagIndexErrorEvent>;

	readonly onIncrementalSync: Event<RagIncrementalSyncEvent>;



	constructor(

		@IMainProcessService mainProcessService: IMainProcessService

	) {

		this.voidRag = ProxyChannel.toService<IVoidRagService>(mainProcessService.getChannel('void-channel-rag'));

		this.onIndexProgress = this.voidRag.onIndexProgress;

		this.onIndexComplete = this.voidRag.onIndexComplete;

		this.onIndexError = this.voidRag.onIndexError;

		this.onIncrementalSync = this.voidRag.onIncrementalSync;

	}



	async initializeIndex(workspaceRoot: string, workspaceHash: string, useMilvus: boolean, milvusConfig?: any, embeddingConfig?: RagEmbeddingConfig, initOptions?: RagInitOptions): Promise<'local' | 'milvus'> {

		return this.voidRag.initializeIndex(workspaceRoot, workspaceHash, useMilvus, milvusConfig, embeddingConfig, initOptions);

	}



	async getActiveIndexType(): Promise<'local' | 'milvus' | null> {

		return this.voidRag.getActiveIndexType();

	}



	async getIndexStatus(): Promise<RagIndexStatus> {

		return this.voidRag.getIndexStatus();

	}



	async queryContext(queryText: string, options?: RagQueryOptions): Promise<string> {

		return this.voidRag.queryContext(queryText, options);

	}

	async waitForIndexReady(timeoutMs?: number): Promise<boolean> {

		return this.voidRag.waitForIndexReady(timeoutMs);

	}

	async getRelatedDependencies(filePath: string, maxResults?: number): Promise<RagRelatedDependency[]> {

		return this.voidRag.getRelatedDependencies(filePath, maxResults);

	}



	async applyIncrementalChanges(changes: RagFileChange[]): Promise<void> {

		return this.voidRag.applyIncrementalChanges(changes);

	}

	async testMilvusConnection(config: RagMilvusConfig): Promise<RagMilvusConnectionResult> {

		return this.voidRag.testMilvusConnection(config);

	}

}



registerSingleton(IVoidRagService, VoidRagBrowserService, InstantiationType.Delayed);

