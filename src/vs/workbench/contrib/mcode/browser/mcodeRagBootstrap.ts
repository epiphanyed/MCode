/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVoidRagService, DEFAULT_RAG_EMBEDDING } from '../common/mcodeRagTypes.js';
import { IVoidSettingsService } from '../common/mcodeSettingsService.js';

let bootstrapPromise: Promise<void> | undefined;

/**
 * Start RAG index load once per workbench session (idempotent).
 * Called from workbench contribution on restore and from chat as a fallback.
 */
export function startMcodeRagBootstrap(
	settingsService: IVoidSettingsService,
	workspaceContextService: IWorkspaceContextService,
	ragService: IVoidRagService,
): Promise<void> {
	if (!bootstrapPromise) {
		bootstrapPromise = runBootstrap(settingsService, workspaceContextService, ragService);
	}
	return bootstrapPromise;
}

async function runBootstrap(
	settingsService: IVoidSettingsService,
	workspaceContextService: IWorkspaceContextService,
	ragService: IVoidRagService,
): Promise<void> {
	await settingsService.waitForInitState;

	const workspace = workspaceContextService.getWorkspace();
	const folder = workspace.folders[0];
	if (!folder) {
		return;
	}

	const workspaceRoot = folder.uri.fsPath;
	const workspaceHash = workspace.id;
	const gs = settingsService.state.globalSettings;
	const indexType = gs.indexType || 'local';
	const useMilvus = indexType === 'milvus';
	const milvusConfig = {
		address: gs.milvusUrl || 'localhost:19530',
		username: gs.milvusUsername || '',
		password: gs.milvusPassword || '',
	};
	const embeddingConfig = {
		provider: gs.embeddingProvider ?? DEFAULT_RAG_EMBEDDING.provider,
		model: gs.embeddingModel ?? DEFAULT_RAG_EMBEDDING.model,
		ollamaEndpoint: gs.ollamaEndpoint ?? DEFAULT_RAG_EMBEDDING.ollamaEndpoint,
	};

	const indexStatus = await ragService.getIndexStatus();
	if (indexStatus.phase !== 'idle') {
		console.log(
			`[RAG] Index already ${indexStatus.phase} (${indexStatus.filesDone}/${indexStatus.filesTotal}); skipping duplicate bootstrap.`,
		);
		return;
	}

	try {
		const actualType = await ragService.initializeIndex(
			workspaceRoot,
			workspaceHash,
			useMilvus,
			milvusConfig,
			embeddingConfig,
			{ milvusDualWrite: gs.ragMilvusDualWrite ?? false },
		);
		console.log(`[RAG] Background bootstrap started (${actualType} mode, loading index…)`);
	} catch (e) {
		console.error('[RAG] Background bootstrap failed:', e);
	}
}
