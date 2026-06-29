/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface RagInitOptions {
	/** When true, delete the existing local store and rebuild from scratch. */
	forceRebuild?: boolean;
	/** When true with Milvus mode, also persist a local VectorStoreIndex copy. */
	milvusDualWrite?: boolean;
}

export interface RagMilvusConfig {
	address: string;
	username?: string;
	password?: string;
}

export interface RagMilvusConnectionResult {
	ok: boolean;
	message: string;
}

export interface RagEmbeddingConfig {
	provider?: 'openai' | 'ollama';
	model?: string;
	ollamaEndpoint?: string;
}

/** Default RAG embedding: local Ollama (no OpenAI key required). */
export const DEFAULT_RAG_EMBEDDING: Required<RagEmbeddingConfig> = {
	provider: 'ollama',
	model: 'nomic-embed-text',
	ollamaEndpoint: 'http://127.0.0.1:11434',
};

export const OLLAMA_EMBEDDING_DEFAULT_DIMENSIONS = 768;
export const OPENAI_EMBEDDING_DEFAULT_DIMENSIONS = 1536;

export interface RagFileChange {
	/** Absolute filesystem path */
	filePath: string;
	type: 'updated' | 'deleted';
}

/** Inputs for LSP + vector context merge (Phase 1 dual-channel RAG). */
export interface RagContextBundle {
	lspSnippets: string[];
	vectorContext: string;
	/** Absolute paths from @file / folder staging — excluded from vector chunks. */
	excludeFilePaths?: string[];
}

export interface RagContextMergeOptions {
	/** Total character budget for merged context. Default 12000. */
	maxTotalChars?: number;
	/** Fraction of budget reserved for LSP snippets. Default 0.3. */
	lspBudgetRatio?: number;
	/** Max chars for Git dynamic context section. Default 2000. */
	gitMaxChars?: number;
	excludeFilePaths?: string[];
}

export interface RagContextMergeResult {
	merged: string;
	hasLsp: boolean;
	hasVector: boolean;
}

export type RagIndexPhase = 'idle' | 'scanning' | 'persisting' | 'loading' | 'incremental';

export interface RagIndexProgressEvent {
	phase: Exclude<RagIndexPhase, 'idle'>;
	filesDone: number;
	filesTotal: number;
	chunks: number;
	currentFile?: string;
}

export interface RagIndexCompleteEvent {
	fileCount: number;
	chunkCount: number;
	builtAt: string;
	indexType: 'local' | 'milvus';
}

export interface RagIndexErrorEvent {
	message: string;
	phase?: RagIndexProgressEvent['phase'];
}

export interface RagIncrementalSyncEvent {
	fileCount: number;
	deltaChunks: number;
	timestamp: string;
}

export interface RagIndexStatus {
	phase: RagIndexPhase;
	fileCount: number;
	chunkCount: number;
	builtAt: string | null;
	indexType: 'local' | 'milvus' | null;
	filesDone: number;
	filesTotal: number;
	currentFile: string | null;
	lastIncrementalSync: RagIncrementalSyncEvent | null;
	error: string | null;
	/** True when manifest includes current code graph engine. */
	graphEngineReady: boolean;
	gitCommitCount: number;
}

export interface RagQueryOptions {
	/** Candidates retrieved before rerank. Default 12. */
	similarityTopK?: number;
	/** Final chunks injected into LLM context. Default 5. */
	finalTopK?: number;
	/** Hybrid vector + keyword rerank. Default true. */
	useReranker?: boolean;
	/** Phase 8 orchestration (router, sub-questions, graph). Default true. */
	useOrchestrator?: boolean;
	useSubQuestions?: boolean;
	/** LLM-based sub-question split (heuristic fallback). Default false. */
	useLlmSubQuestions?: boolean;
	useRouter?: boolean;
	useGraphExpand?: boolean;
	/** Graph neighbor hops (1–2). Default 1. */
	graphExpandHops?: number;
	graphExpandMax?: number;
	useDocLinkedCode?: boolean;
	docLinkedMax?: number;
	/** Max chars for orchestrated vector assembly before merge (CTX-B2). */
	assemblyMaxChars?: number;
	/** Compact long code chunks in retrieval output (CTX-C3). */
	ragCompactMode?: boolean;
	/** Auto-disable SubQuestion/Graph on simple queries (CTX-B1). */
	ragIntentOrchestration?: boolean;
}

export const defaultRagQueryOptions: Required<RagQueryOptions> = {
	similarityTopK: 8,
	finalTopK: 3,
	useReranker: true,
	useOrchestrator: true,
	useSubQuestions: true,
	useLlmSubQuestions: false,
	useRouter: true,
	useGraphExpand: true,
	graphExpandHops: 1,
	graphExpandMax: 4,
	useDocLinkedCode: true,
	docLinkedMax: 3,
	assemblyMaxChars: 8_400,
	ragCompactMode: false,
	ragIntentOrchestration: true,
};

export interface RagRelatedDependency {
	filePath: string;
	kind: 'imports' | 'imported_by' | 'calls' | 'references';
	reason: string;
}

export interface IVoidRagService {
	readonly _serviceBrand: undefined;

	readonly onIndexProgress: Event<RagIndexProgressEvent>;
	readonly onIndexComplete: Event<RagIndexCompleteEvent>;
	readonly onIndexError: Event<RagIndexErrorEvent>;
	readonly onIncrementalSync: Event<RagIncrementalSyncEvent>;

	initializeIndex(workspaceRoot: string, workspaceHash: string, useMilvus: boolean, milvusConfig?: RagMilvusConfig, embeddingConfig?: RagEmbeddingConfig, initOptions?: RagInitOptions): Promise<'local' | 'milvus'>;
	getActiveIndexType(): Promise<'local' | 'milvus' | null>;
	getIndexStatus(): Promise<RagIndexStatus>;
	testMilvusConnection(config: RagMilvusConfig): Promise<RagMilvusConnectionResult>;
	queryContext(queryText: string, options?: RagQueryOptions): Promise<string>;
	/** Wait until the vector index is loaded or index init finishes (whichever comes first). */
	waitForIndexReady(timeoutMs?: number): Promise<boolean>;
	getRelatedDependencies(filePath: string, maxResults?: number): Promise<RagRelatedDependency[]>;
	applyIncrementalChanges(changes: RagFileChange[]): Promise<void>;
}

export const IVoidRagService = createDecorator<IVoidRagService>('mcodeRagService');

export const defaultRagIndexStatus = (): RagIndexStatus => ({
	phase: 'idle',
	fileCount: 0,
	chunkCount: 0,
	builtAt: null,
	indexType: null,
	filesDone: 0,
	filesTotal: 0,
	currentFile: null,
	lastIncrementalSync: null,
	error: null,
	graphEngineReady: false,
	gitCommitCount: 0,
});