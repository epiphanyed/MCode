/*--------------------------------------------------------------------------------------

 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.

 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.

 *--------------------------------------------------------------------------------------*/



import { Event } from '../../../../base/common/event.js';

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

import { LlamaIndexService } from './rag/llamaIndexService.js';



export class VoidRagService implements IVoidRagService {

	readonly _serviceBrand: undefined;

	private readonly llamaIndexService: LlamaIndexService;



	readonly onIndexProgress: Event<RagIndexProgressEvent>;

	readonly onIndexComplete: Event<RagIndexCompleteEvent>;

	readonly onIndexError: Event<RagIndexErrorEvent>;

	readonly onIncrementalSync: Event<RagIncrementalSyncEvent>;



	constructor() {

		this.llamaIndexService = new LlamaIndexService();

		this.onIndexProgress = this.llamaIndexService.onIndexProgress;

		this.onIndexComplete = this.llamaIndexService.onIndexComplete;

		this.onIndexError = this.llamaIndexService.onIndexError;

		this.onIncrementalSync = this.llamaIndexService.onIncrementalSync;

	}



	async initializeIndex(workspaceRoot: string, workspaceHash: string, useMilvus: boolean, milvusConfig?: any, embeddingConfig?: RagEmbeddingConfig, initOptions?: RagInitOptions): Promise<'local' | 'milvus'> {

		return this.llamaIndexService.initializeIndex(workspaceRoot, workspaceHash, useMilvus, milvusConfig, embeddingConfig, initOptions);

	}



	async getActiveIndexType(): Promise<'local' | 'milvus' | null> {

		return this.llamaIndexService.getActiveIndexType();

	}



	async getIndexStatus(): Promise<RagIndexStatus> {

		return this.llamaIndexService.getIndexStatus();

	}



	async queryContext(queryText: string, options?: RagQueryOptions): Promise<string> {

		return this.llamaIndexService.queryContext(queryText, options);

	}

	getRelatedDependencies(filePath: string, maxResults?: number): Promise<RagRelatedDependency[]> {

		return Promise.resolve(this.llamaIndexService.getRelatedDependencies(filePath, maxResults));

	}



	async applyIncrementalChanges(changes: RagFileChange[]): Promise<void> {

		return this.llamaIndexService.applyIncrementalChanges(changes);

	}

	async testMilvusConnection(config: RagMilvusConfig): Promise<RagMilvusConnectionResult> {

		return this.llamaIndexService.testMilvusConnection(config);

	}

}

