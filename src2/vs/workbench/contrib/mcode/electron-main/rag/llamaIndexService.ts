/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
    Document,
    Settings,
    BaseEmbedding,
    MarkdownNodeParser,
    MetadataMode,
    type BaseNode,
} from "llamaindex";
import { OpenAIEmbedding } from "@llamaindex/openai";
import { Ollama } from "ollama";
import * as path from 'path';
import * as fs from 'fs';
import type {
    RagEmbeddingConfig,
    RagFileChange,
    RagIncrementalSyncEvent,
    RagIndexCompleteEvent,
    RagIndexErrorEvent,
    RagIndexPhase,
    RagIndexProgressEvent,
    RagIndexStatus,
    RagInitOptions,
    RagMilvusConfig,
    RagMilvusConnectionResult,
    RagQueryOptions,
    RagRelatedDependency,
} from '../../common/mcodeRagTypes.js';
import { defaultRagQueryOptions, DEFAULT_RAG_EMBEDDING, OLLAMA_EMBEDDING_DEFAULT_DIMENSIONS, OPENAI_EMBEDDING_DEFAULT_DIMENSIONS } from '../../common/mcodeRagTypes.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { chunkCodeForIndexing, CHUNK_ENGINE, getChunkDocId } from './semanticCodeChunker.js';
import { rerankRetrievedNodes, applyMMRDiversity, type RetrievedNode } from './ragReranker.js';
import {
    assignDocParentChunks,
    expandCodeChunkText,
    resolveDocDisplayText,
    type CodeSymbolEntry,
} from './ragQueryHelpers.js';
import { fetchGitCommits, gitCommitsToNodes } from './gitLogIndexer.js';
import { buildGitDynamicContext } from './gitDynamicContext.js';
import { extractMarkdownLinkedFiles } from './markdownLinkParser.js';
import type { MilvusRagStore } from './milvusStore.js';
import { createMilvusRagStore, milvusHitToMetadataLazy, nodeToMilvusRecordLazy, testMilvusConnectionLazy } from './milvusLazyModule.js';
import {
    buildSymbolNameIndex,
    createEmptyCodeGraph,
    getRelatedFilesFromGraph,
    mergeFileIntoCodeGraphAsync,
    purgeFileFromCodeGraph,
    CODE_GRAPH_ENGINE,
    type CodeGraph,
} from './codeGraphBuilder.js';
import { compactCodeContent } from './ragCompactFormat.js';
import {
    appendSectionWithinBudget,
    applyIntentOrchestration,
    buildLinkedCodeSnippets,
    collectLinkedFilesFromDocNodes,
    dedupeRetrievedNodes,
    expandRetrievalWithGraph,
    formatGraphExpandedSnippet,
    formatLinkedCodeSnippet,
    mergeOrchestratorOptions,
    computeLocalRouterRetrieveTopK,
    filterRetrievedByRoute,
    routeQueryTargets,
    splitSubQuestions,
    splitSubQuestionsWithLlm,
    targetsToMilvusPartitions,
    targetsToLocalDocTypes,
    type RagRouteTarget,
} from './ragQueryOrchestrator.js';
import { LocalSqliteVectorStore, LOCAL_VECTOR_STORAGE_ENGINE } from './localSqliteVectorStore.js';
import {
    getLocalVectorDbFileName,
    getLocalVectorDbPathForLayout,
    getNamedLocalStorePath,
    LEGACY_LOCAL_VECTOR_DB_FILENAME,
    localStoreHasVectorDb,
    resolveLocalStoreLayout,
    type LocalStoreLayout,
} from './localStorePaths.js';
import { localVectorRecordToNode, nodeToLocalVectorRecord } from './localVectorRecordMapper.js';

const MANIFEST_VERSION = 6;
const EMBED_BATCH_SIZE = 32;
const MANIFEST_FILENAME = 'index_manifest.json';
const FILE_CHUNK_MAP_FILENAME = 'file_chunk_map.json';
const DOC_PARENT_MAP_FILENAME = 'doc_parent_map.json';
const CODE_SYMBOL_MAP_FILENAME = 'code_symbol_map.json';
const CODE_GRAPH_MAP_FILENAME = 'code_graph_map.json';
const GIT_COMMIT_INDEX_FILENAME = 'git_commit_index.json';
const BUILD_CHECKPOINT_FILENAME = 'index_build_checkpoint.json';
const BUILD_CHECKPOINT_VERSION = 1;
const CHECKPOINT_METADATA_EVERY = 5;
const SIDECAR_FLUSH_EVERY = 60;
const ORCHESTRATOR_ENGINE = 'rag-orchestrator-v1';
const INDEX_YIELD_EVERY = 20;
const BUILD_FILE_YIELD_EVERY = 1;
const WALK_YIELD_EVERY = 64;
/** Skip files with any line longer than this (minified/generated blobs). */
const MAX_INDEXABLE_LINE_CHARS = 4096;
/** Skip doc (.md/.txt) files larger than this. */
const MAX_INDEXABLE_DOC_FILE_BYTES = 512 * 1024;
/** Skip code files larger than this. */
const MAX_INDEXABLE_CODE_FILE_BYTES = 2 * 1024 * 1024;
const DOC_EXTENSIONS = new Set(['.md', '.txt']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp', '.c', '.py', '.sci', '.sce', '.m', '.java']);
const SKIPPED_DIRS = new Set([
    'node_modules', '.git', '.build', 'out', 'build', 'dist',
    'prebuilts', 'prebuilt', 'prebuild',
]);

interface IndexManifest {
    version: number;
    chunkEngine?: string;
    indexBackend?: 'local' | 'milvus' | 'dual';
    embeddingProvider: string;
    embeddingModel: string;
    dimensions: number;
    fileCount: number;
    chunkCount: number;
    gitCommitCount?: number;
    graphEngine?: string;
    orchestratorEngine?: string;
    vectorStorage?: string;
    builtAt: string;
}

interface IndexBuildCheckpoint {
    version: number;
    status: 'in_progress';
    indexBackend: IndexManifest['indexBackend'];
    embeddingProvider: string;
    embeddingModel: string;
    dimensions: number;
    indexedFiles: string[];
    gitCommitsIndexed: boolean;
    gitCommitCount: number;
    totalFiles: number;
    chunkCount: number;
    startedAt: string;
    updatedAt: string;
}

interface LocalIndexBuildOptions {
    resume?: boolean;
    forceFresh?: boolean;
}

interface ScanIndexResult {
    targetFiles: string[];
    allNodes: BaseNode[];
    fileChunkMap: Record<string, number>;
    gitCommitCount: number;
    gitDocIds: string[];
}

class CustomOllamaEmbedding extends BaseEmbedding {
    private ollamaClient: Ollama;
    private modelName: string;

    constructor(options: { model: string; baseUrl?: string }) {
        super();
        this.modelName = options.model;
        this.ollamaClient = new Ollama({ host: options.baseUrl || "http://127.0.0.1:11434" });
    }

    async getTextEmbedding(text: string): Promise<number[]> {
        const response = await this.ollamaClient.embed({
            model: this.modelName,
            input: text,
        });
        return response.embeddings[0];
    }

    override getTextEmbeddings = async (texts: string[]): Promise<number[][]> => {
        const response = await this.ollamaClient.embed({
            model: this.modelName,
            input: texts,
        });
        return response.embeddings;
    };
}

export class LlamaIndexService {
    private localVectorStore: LocalSqliteVectorStore | null = null;
    private localVectorDimensions = 0;
    private localStorePath: string | null = null;
    private localVectorDbFileName: string = LEGACY_LOCAL_VECTOR_DB_FILENAME;
    private workspaceRoot: string = "";
    private workspaceHash: string = "";
    private ignorePatterns: string[] = [];
    private activeIndexType: 'local' | 'milvus' | null = null;
    private currentEmbeddingConfig: RagEmbeddingConfig = {};
    private fileChunkMap: Record<string, number> = {};
    private cachedManifestParams: { provider: string; model: string; dimensions: number } | null = null;
    private compileCommandPathsCache: Set<string> | null | undefined = undefined;
    private docParentMap: Record<string, string> = {};
    private codeSymbolMap: Record<string, CodeSymbolEntry[]> = {};
    private codeGraph: CodeGraph = createEmptyCodeGraph();
    private symbolNameIndex: Map<string, string[]> = new Map();
    private milvusStore: MilvusRagStore | null = null;
    private milvusConfig: RagMilvusConfig | null = null;
    private milvusDualWrite = false;
    /** Set per queryContext call when ragCompactMode is enabled (CTX-C3). */
    private queryCompactMode = false;

    private currentPhase: RagIndexPhase = 'idle';
    private filesDone = 0;
    private filesTotal = 0;
    private progressChunks = 0;
    private currentFile: string | null = null;
    private lastError: string | null = null;
    private lastIncrementalSync: RagIncrementalSyncEvent | null = null;
    private indexBuildInProgress = false;
    private localIndexBuildDeferHnsw = false;

    /** Yield the Electron main thread so IPC/UI can process events. */
    private yieldToEventLoop(): Promise<void> {
        return new Promise<void>(resolve => setImmediate(resolve));
    }

    private setLocalStoreLayout(layout: LocalStoreLayout): void {
        this.localStorePath = layout.storePath;
        this.localVectorDbFileName = layout.dbFileName;
    }

    private getLocalVectorDbPath(localStorePath: string): string {
        const dbFileName = localStorePath === this.localStorePath
            ? this.localVectorDbFileName
            : LEGACY_LOCAL_VECTOR_DB_FILENAME;
        return getLocalVectorDbPathForLayout(localStorePath, dbFileName);
    }

    private async closeLocalVectorStore(): Promise<void> {
        if (this.localVectorStore) {
            await this.localVectorStore.walCheckpoint();
            await this.localVectorStore.close();
            this.localVectorStore = null;
        }
    }

    private async ensureLocalVectorStore(dimensions: number): Promise<LocalSqliteVectorStore> {
        if (!this.localStorePath) {
            throw new Error('[RAG] Local store path is not set.');
        }
        if (this.localVectorStore && this.localVectorDimensions === dimensions) {
            return this.localVectorStore;
        }
        await this.closeLocalVectorStore();
        this.localVectorStore = await LocalSqliteVectorStore.open(this.getLocalVectorDbPath(this.localStorePath), dimensions, {
            onHnswBatch: () => this.yieldToEventLoop(),
            deferHnswLoad: this.indexBuildInProgress && this.localIndexBuildDeferHnsw,
        });
        this.localVectorDimensions = dimensions;
        return this.localVectorStore;
    }

    private async insertNodesToLocalStore(nodes: BaseNode[], dimensions: number): Promise<void> {
        if (nodes.length === 0) {
            return;
        }
        for (let i = 0; i < nodes.length; i += EMBED_BATCH_SIZE) {
            await this.yieldToEventLoop();
            const batch = nodes.slice(i, i + EMBED_BATCH_SIZE);
            await this.embedNodesInBatches(batch);
            const records = batch.map(node => {
                const embedding = node.embedding;
                if (!embedding || embedding.length === 0) {
                    throw new Error(`[RAG] Missing embedding for node ${node.id_ ?? 'unknown'}`);
                }
                return nodeToLocalVectorRecord(node, embedding);
            });
            const store = await this.ensureLocalVectorStore(dimensions);
            await store.insertRecords(records);
        }
    }

    /** Schedule long-running index work without blocking the IPC caller. */
    private runBackgroundIndexOperation(task: () => Promise<void>): void {
        if (this.indexBuildInProgress) {
            console.warn('[RAG] Index operation already in progress; ignoring duplicate request.');
            return;
        }
        this.indexBuildInProgress = true;
        this.lastError = null;
        this.fireProgress({
            phase: 'loading',
            filesDone: 0,
            filesTotal: 0,
            chunks: 0,
            currentFile: 'Preparing index…',
        });

        void (async () => {
            try {
                // Let initializeIndex return to the renderer before heavy work starts.
                await this.yieldToEventLoop();
                await this.yieldToEventLoop();
                await task();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.fireError(message);
            } finally {
                this.indexBuildInProgress = false;
                this.localIndexBuildDeferHnsw = false;
            }
        })();
    }

    private readonly _onIndexProgress = new Emitter<RagIndexProgressEvent>();
    readonly onIndexProgress: Event<RagIndexProgressEvent> = this._onIndexProgress.event;

    private readonly _onIndexComplete = new Emitter<RagIndexCompleteEvent>();
    readonly onIndexComplete: Event<RagIndexCompleteEvent> = this._onIndexComplete.event;

    private readonly _onIndexError = new Emitter<RagIndexErrorEvent>();
    readonly onIndexError: Event<RagIndexErrorEvent> = this._onIndexError.event;

    private readonly _onIncrementalSync = new Emitter<RagIncrementalSyncEvent>();
    readonly onIncrementalSync: Event<RagIncrementalSyncEvent> = this._onIncrementalSync.event;

    constructor() {
        Settings.embedModel = new CustomOllamaEmbedding({
            model: DEFAULT_RAG_EMBEDDING.model,
            baseUrl: DEFAULT_RAG_EMBEDDING.ollamaEndpoint,
        });
    }

    private fireProgress(event: RagIndexProgressEvent): void {
        this.currentPhase = event.phase;
        this.filesDone = event.filesDone;
        this.filesTotal = event.filesTotal;
        this.progressChunks = event.chunks;
        this.currentFile = event.currentFile ?? null;
        this._onIndexProgress.fire(event);
    }

    private fireComplete(event: RagIndexCompleteEvent): void {
        this.currentPhase = 'idle';
        this.filesDone = 0;
        this.filesTotal = 0;
        this.currentFile = null;
        this.lastError = null;
        this._onIndexComplete.fire(event);
    }

    private fireError(message: string, phase?: RagIndexProgressEvent['phase']): void {
        this.currentPhase = 'idle';
        this.lastError = message;
        this._onIndexError.fire({ message, phase });
    }


    public getIndexStatus(): RagIndexStatus {
        const manifest = this.localStorePath ? this.readManifest(this.localStorePath) : null;
        return {
            phase: this.currentPhase,
            fileCount: manifest?.fileCount ?? 0,
            chunkCount: manifest?.chunkCount ?? this.progressChunks,
            builtAt: manifest?.builtAt ?? null,
            indexType: this.activeIndexType,
            filesDone: this.filesDone,
            filesTotal: this.filesTotal,
            currentFile: this.currentFile,
            lastIncrementalSync: this.lastIncrementalSync,
            error: this.lastError,
            graphEngineReady: manifest?.graphEngine === CODE_GRAPH_ENGINE,
            gitCommitCount: manifest?.gitCommitCount ?? 0,
        };
    }

    private getLocalStorePath(workspaceRoot: string, workspaceHash: string): LocalStoreLayout {
        return resolveLocalStoreLayout(workspaceRoot, workspaceHash);
    }

    private getManifestPath(localStorePath: string): string {
        return path.join(localStorePath, MANIFEST_FILENAME);
    }

    private getFileChunkMapPath(localStorePath: string): string {
        return path.join(localStorePath, FILE_CHUNK_MAP_FILENAME);
    }

    private readManifest(localStorePath: string): IndexManifest | null {
        const manifestPath = this.getManifestPath(localStorePath);
        if (!fs.existsSync(manifestPath)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as IndexManifest;
        } catch (err) {
            console.warn('[RAG] Failed to read index manifest, will rebuild:', err);
            return null;
        }
    }

    private writeManifest(localStorePath: string, manifest: IndexManifest): void {
        fs.writeFileSync(this.getManifestPath(localStorePath), JSON.stringify(manifest, null, 2), 'utf8');
    }

    private getBuildCheckpointPath(localStorePath: string): string {
        return path.join(localStorePath, BUILD_CHECKPOINT_FILENAME);
    }

    private readBuildCheckpoint(localStorePath: string): IndexBuildCheckpoint | null {
        const checkpointPath = this.getBuildCheckpointPath(localStorePath);
        if (!fs.existsSync(checkpointPath)) {
            return null;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as IndexBuildCheckpoint;
            if (parsed.version !== BUILD_CHECKPOINT_VERSION || parsed.status !== 'in_progress') {
                return null;
            }
            return parsed;
        } catch (err) {
            console.warn('[RAG] Failed to read index build checkpoint:', err);
            return null;
        }
    }

    private writeBuildCheckpoint(localStorePath: string, checkpoint: IndexBuildCheckpoint): void {
        fs.writeFileSync(this.getBuildCheckpointPath(localStorePath), JSON.stringify(checkpoint, null, 2), 'utf8');
    }

    private async writeBuildCheckpointAsync(localStorePath: string, checkpoint: IndexBuildCheckpoint): Promise<void> {
        await fs.promises.writeFile(this.getBuildCheckpointPath(localStorePath), JSON.stringify(checkpoint, null, 2), 'utf8');
    }

    private deleteBuildCheckpoint(localStorePath: string): void {
        const checkpointPath = this.getBuildCheckpointPath(localStorePath);
        if (fs.existsSync(checkpointPath)) {
            fs.rmSync(checkpointPath, { force: true });
        }
    }

    private checkpointMatches(
        checkpoint: IndexBuildCheckpoint,
        provider: string,
        model: string,
        dimensions: number,
        expectedBackend: IndexManifest['indexBackend'] = 'local',
    ): boolean {
        return checkpoint.embeddingProvider === provider
            && checkpoint.embeddingModel === model
            && checkpoint.dimensions === dimensions
            && (checkpoint.indexBackend ?? 'local') === expectedBackend;
    }

    private async flushLocalVectorWal(): Promise<void> {
        if (this.localVectorStore) {
            await this.yieldToEventLoop();
            await this.localVectorStore.walCheckpoint();
            await this.yieldToEventLoop();
        }
    }

    private readFileChunkMap(localStorePath: string): Record<string, number> {
        const mapPath = this.getFileChunkMapPath(localStorePath);
        if (!fs.existsSync(mapPath)) {
            return {};
        }
        try {
            return JSON.parse(fs.readFileSync(mapPath, 'utf8')) as Record<string, number>;
        } catch {
            return {};
        }
    }

    private writeFileChunkMap(localStorePath: string): void {
        fs.writeFileSync(this.getFileChunkMapPath(localStorePath), JSON.stringify(this.fileChunkMap, null, 2), 'utf8');
    }

    private async writeFileChunkMapAsync(localStorePath: string): Promise<void> {
        await fs.promises.writeFile(this.getFileChunkMapPath(localStorePath), JSON.stringify(this.fileChunkMap, null, 2), 'utf8');
    }

    private getDocParentMapPath(localStorePath: string): string {
        return path.join(localStorePath, DOC_PARENT_MAP_FILENAME);
    }

    private getCodeSymbolMapPath(localStorePath: string): string {
        return path.join(localStorePath, CODE_SYMBOL_MAP_FILENAME);
    }

    private getCodeGraphMapPath(localStorePath: string): string {
        return path.join(localStorePath, CODE_GRAPH_MAP_FILENAME);
    }

    private loadSidecarMaps(localStorePath: string): void {
        const parentPath = this.getDocParentMapPath(localStorePath);
        const symbolPath = this.getCodeSymbolMapPath(localStorePath);
        const graphPath = this.getCodeGraphMapPath(localStorePath);
        this.docParentMap = {};
        this.codeSymbolMap = {};
        this.codeGraph = createEmptyCodeGraph();
        this.symbolNameIndex = new Map();
        if (fs.existsSync(parentPath)) {
            try {
                this.docParentMap = JSON.parse(fs.readFileSync(parentPath, 'utf8')) as Record<string, string>;
            } catch (err) {
                console.warn('[RAG] Failed to load doc_parent_map.json:', err);
            }
        }
        if (fs.existsSync(symbolPath)) {
            try {
                this.codeSymbolMap = JSON.parse(fs.readFileSync(symbolPath, 'utf8')) as Record<string, CodeSymbolEntry[]>;
            } catch (err) {
                console.warn('[RAG] Failed to load code_symbol_map.json:', err);
            }
        }
        if (fs.existsSync(graphPath)) {
            try {
                this.codeGraph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as CodeGraph;
                this.symbolNameIndex = buildSymbolNameIndex(this.codeGraph);
            } catch (err) {
                console.warn('[RAG] Failed to load code_graph_map.json:', err);
            }
        }
    }

    private writeSidecarMaps(localStorePath: string): void {
        fs.writeFileSync(this.getDocParentMapPath(localStorePath), JSON.stringify(this.docParentMap, null, 2), 'utf8');
        fs.writeFileSync(this.getCodeSymbolMapPath(localStorePath), JSON.stringify(this.codeSymbolMap, null, 2), 'utf8');
        fs.writeFileSync(this.getCodeGraphMapPath(localStorePath), JSON.stringify(this.codeGraph, null, 2), 'utf8');
    }

    private async writeSidecarMapsAsync(localStorePath: string): Promise<void> {
        await Promise.all([
            fs.promises.writeFile(this.getDocParentMapPath(localStorePath), JSON.stringify(this.docParentMap, null, 2), 'utf8'),
            fs.promises.writeFile(this.getCodeSymbolMapPath(localStorePath), JSON.stringify(this.codeSymbolMap, null, 2), 'utf8'),
            fs.promises.writeFile(this.getCodeGraphMapPath(localStorePath), JSON.stringify(this.codeGraph, null, 2), 'utf8'),
        ]);
    }

    private purgeSidecarMapsForFile(normalizedPath: string): void {
        delete this.codeSymbolMap[normalizedPath];
        purgeFileFromCodeGraph(this.codeGraph, normalizedPath);
        this.symbolNameIndex = buildSymbolNameIndex(this.codeGraph);
        for (const key of Object.keys(this.docParentMap)) {
            if (key.startsWith(`${normalizedPath}::parent::`)) {
                delete this.docParentMap[key];
            }
        }
    }

    private async readFileLineRange(filePath: string, startLine: number, endLine: number): Promise<string> {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        return lines.slice(Math.max(startLine - 1, 0), endLine).join('\n');
    }

    private manifestMatches(
        manifest: IndexManifest,
        provider: string,
        model: string,
        dimensions: number,
        expectedBackend: IndexManifest['indexBackend'] = 'local',
    ): boolean {
        return manifest.version === MANIFEST_VERSION
            && manifest.chunkEngine === CHUNK_ENGINE
            && (manifest.indexBackend ?? 'local') === expectedBackend
            && (manifest.vectorStorage ?? LOCAL_VECTOR_STORAGE_ENGINE) === LOCAL_VECTOR_STORAGE_ENGINE
            && manifest.embeddingProvider === provider
            && manifest.embeddingModel === model
            && manifest.dimensions === dimensions;
    }

    private localStoreHasIndex(layout: LocalStoreLayout): boolean {
        return localStoreHasVectorDb(layout);
    }

    private clearLocalStore(localStorePath: string): void {
        if (fs.existsSync(localStorePath)) {
            fs.rmSync(localStorePath, { recursive: true, force: true });
        }
        fs.mkdirSync(localStorePath, { recursive: true });
        this.resetLocalStoreState();
    }

    private resetLocalStoreState(): void {
        void this.closeLocalVectorStore();
        this.localVectorDimensions = 0;
        this.fileChunkMap = {};
        this.docParentMap = {};
        this.codeSymbolMap = {};
        this.codeGraph = createEmptyCodeGraph();
        this.symbolNameIndex = new Map();
    }

    private async clearLocalStoreAsync(localStorePath: string): Promise<void> {
        if (fs.existsSync(localStorePath)) {
            await fs.promises.rm(localStorePath, { recursive: true, force: true });
            await this.yieldToEventLoop();
        }
        await fs.promises.mkdir(localStorePath, { recursive: true });
        this.resetLocalStoreState();
    }

    private clearLocalStoreForFreshBuild(localStorePath: string): void {
        this.clearLocalStore(localStorePath);
        this.deleteBuildCheckpoint(localStorePath);
    }

    private async clearLocalStoreForFreshBuildAsync(localStorePath: string): Promise<void> {
        await this.clearLocalStoreAsync(localStorePath);
        this.deleteBuildCheckpoint(localStorePath);
    }

    private createMdParser(): MarkdownNodeParser {
        return new MarkdownNodeParser();
    }

    private normalizeFilePath(filePath: string): string {
        return path.normalize(filePath);
    }

    private loadMcodeIgnore(workspaceRoot: string): void {
        let ignoreFile = path.join(workspaceRoot, '.mcodeignore');
        if (!fs.existsSync(ignoreFile)) {
            ignoreFile = path.join(workspaceRoot, '.voidignore');
        }
        this.ignorePatterns = [];
        if (fs.existsSync(ignoreFile)) {
            try {
                const content = fs.readFileSync(ignoreFile, 'utf8');
                this.ignorePatterns = content
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'));
                console.log(`[RAG] Loaded ${this.ignorePatterns.length} ignore patterns from ${path.basename(ignoreFile)}`);
            } catch (err) {
                console.error(`[RAG] Failed to read ignore file:`, err);
            }
        }
    }

    private isPathIgnored(filePath: string): boolean {
        const relativePath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
        for (const pattern of this.ignorePatterns) {
            const cleanPattern = pattern.replace(/\\/g, '/');
            if (relativePath === cleanPattern ||
                relativePath.startsWith(cleanPattern + '/') ||
                (cleanPattern.endsWith('*') && relativePath.startsWith(cleanPattern.slice(0, -1)))
            ) {
                return true;
            }
        }
        return false;
    }

    private pathInSkippedDir(filePath: string): boolean {
        const segments = this.normalizeFilePath(filePath).split(path.sep);
        return segments.some(s => SKIPPED_DIRS.has(s.toLowerCase()));
    }

    private shouldSkipDirName(dirName: string): boolean {
        return SKIPPED_DIRS.has(dirName.toLowerCase());
    }

    private hasOverlongLine(content: string, maxChars = MAX_INDEXABLE_LINE_CHARS): boolean {
        let lineStart = 0;
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '\n') {
                if (i - lineStart > maxChars) {
                    return true;
                }
                lineStart = i + 1;
            }
        }
        return content.length - lineStart > maxChars;
    }

    private maxIndexableFileBytes(filePath: string): number {
        return this.isDocFile(filePath) ? MAX_INDEXABLE_DOC_FILE_BYTES : MAX_INDEXABLE_CODE_FILE_BYTES;
    }

    private async readFileIfIndexable(filePath: string): Promise<string | null> {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            return null;
        }
        if (stat.size > this.maxIndexableFileBytes(filePath)) {
            console.warn(`[RAG] Skipping oversized file (${stat.size} bytes): ${filePath}`);
            return null;
        }
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            return null;
        }
        if (this.hasOverlongLine(content)) {
            console.warn(`[RAG] Skipping file with lines > ${MAX_INDEXABLE_LINE_CHARS} chars: ${filePath}`);
            return null;
        }
        return content;
    }

    private loadCompileCommandPaths(workspaceRoot: string, forceReload = false): Set<string> | null {
        if (!forceReload && this.compileCommandPathsCache !== undefined) {
            return this.compileCommandPathsCache;
        }
        const compileCommandsPath = path.join(workspaceRoot, 'compile_commands.json');
        if (!fs.existsSync(compileCommandsPath)) {
            this.compileCommandPathsCache = null;
            return null;
        }
        try {
            const entries = JSON.parse(fs.readFileSync(compileCommandsPath, 'utf8')) as Array<{ file?: string }>;
            const paths = new Set<string>();
            for (const entry of entries) {
                if (entry.file) {
                    paths.add(path.normalize(entry.file));
                }
            }
            if (paths.size === 0) {
                this.compileCommandPathsCache = null;
                return null;
            }
            console.log(`[RAG] Found compile_commands.json with ${paths.size} entries`);
            this.compileCommandPathsCache = paths;
            return paths;
        } catch (err) {
            console.warn('[RAG] Failed to parse compile_commands.json, falling back to directory walk:', err);
            this.compileCommandPathsCache = null;
            return null;
        }
    }

    private async purgeIgnoredFilesFromIndex(): Promise<{ removedFiles: number; removedChunks: number }> {
        if (!this.localVectorStore && !this.milvusStore) {
            return { removedFiles: 0, removedChunks: 0 };
        }

        let removedFiles = 0;
        let removedChunks = 0;
        for (const filePath of Object.keys(this.fileChunkMap)) {
            if (!this.isPathIgnored(filePath)) {
                continue;
            }
            const removed = await this.removeFileFromAllIndexes(filePath);
            removedChunks += removed;
            removedFiles += 1;
        }

        if (removedFiles > 0) {
            console.log(`[RAG] Purged ${removedFiles} ignored file(s), ${removedChunks} chunk(s) removed`);
        }
        return { removedFiles, removedChunks };
    }

    private async removeFileFromAllIndexes(filePath: string): Promise<number> {
        const normalized = this.normalizeFilePath(filePath);
        const chunkCount = this.fileChunkMap[normalized] ?? 0;
        if (chunkCount === 0) {
            return 0;
        }

        if (this.milvusStore && this.activeIndexType === 'milvus') {
            const chunkIds: string[] = [];
            for (let i = 0; i < chunkCount; i++) {
                chunkIds.push(getChunkDocId(normalized, i));
            }
            await this.milvusStore.deleteByChunkIds(chunkIds);
        }

        if (this.localVectorStore) {
            const chunkIds: string[] = [];
            for (let i = 0; i < chunkCount; i++) {
                chunkIds.push(getChunkDocId(normalized, i));
            }
            await this.localVectorStore.deleteByChunkIds(chunkIds);
            try {
                await this.localVectorStore.deleteByChunkIds([normalized]);
            } catch {
                // ignore legacy id
            }
        }

        delete this.fileChunkMap[normalized];
        this.purgeSidecarMapsForFile(normalized);
        return chunkCount;
    }

    private updateCodeGraphForFile(normalizedPath: string, content: string): Promise<void> {
        if (this.isDocFile(normalizedPath)) {
            return Promise.resolve();
        }
        const symbols = this.codeSymbolMap[normalizedPath];
        if (!symbols?.length) {
            return Promise.resolve();
        }
        return mergeFileIntoCodeGraphAsync(
            this.codeGraph,
            normalizedPath,
            content,
            symbols,
            this.workspaceRoot,
            this.symbolNameIndex,
        );
    }

    private async completeRagLlmPrompt(prompt: string): Promise<string> {
        if (!Settings.llm) {
            throw new Error('[RAG] LLM not configured for sub-question split');
        }
        const llm = Settings.llm as { complete?: (opts: { prompt: string }) => Promise<{ text?: string }> };
        if (typeof llm.complete !== 'function') {
            throw new Error('[RAG] LLM complete API unavailable');
        }
        const response = await llm.complete({ prompt });
        return String(response.text ?? '').trim();
    }

    private async resolveSubQuestions(
        queryText: string,
        orch: ReturnType<typeof mergeOrchestratorOptions>,
    ): Promise<string[]> {
        if (!orch.useSubQuestions) {
            return [queryText];
        }
        if (orch.useLlmSubQuestions && Settings.llm) {
            return splitSubQuestionsWithLlm(queryText, prompt => this.completeRagLlmPrompt(prompt));
        }
        return splitSubQuestions(queryText);
    }

    private getGitCommitIndexPath(localStorePath: string): string {
        return path.join(localStorePath, GIT_COMMIT_INDEX_FILENAME);
    }

    private readGitCommitDocIds(localStorePath: string): string[] {
        const filePath = this.getGitCommitIndexPath(localStorePath);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { docIds?: string[] };
            return Array.isArray(parsed.docIds) ? parsed.docIds : [];
        } catch {
            return [];
        }
    }

    private writeGitCommitDocIds(localStorePath: string, docIds: string[]): void {
        fs.writeFileSync(
            this.getGitCommitIndexPath(localStorePath),
            JSON.stringify({ docIds }, null, 2),
            'utf8',
        );
    }

    /** Refresh git_commit nodes after incremental code updates (P10-5). */
    private async refreshGitCommitIndex(): Promise<number> {
        if (!this.localStorePath || !this.workspaceRoot) {
            return 0;
        }

        const prevIds = this.readGitCommitDocIds(this.localStorePath);
        for (const id of prevIds) {
            if (this.localVectorStore) {
                try {
                    await this.localVectorStore.deleteByChunkIds([id]);
                } catch (err) {
                    console.warn(`[RAG] SQLite delete failed for git commit ${id}:`, err);
                }
            }
            if (this.milvusStore && this.activeIndexType === 'milvus') {
                try {
                    await this.milvusStore.deleteByChunkIds([id]);
                } catch (err) {
                    console.warn(`[RAG] Milvus delete failed for git commit ${id}:`, err);
                }
            }
        }

        let gitCommitCount = 0;
        try {
            const commits = await fetchGitCommits(this.workspaceRoot);
            const gitNodes = gitCommitsToNodes(commits);
            gitCommitCount = gitNodes.length;

            if (gitNodes.length > 0) {
                if (this.milvusStore && this.activeIndexType === 'milvus') {
                    await this.embedNodesInBatches(gitNodes);
                    const records = await Promise.all(
                        gitNodes.map(node => nodeToMilvusRecordLazy(node, node.embedding!)),
                    );
                    await this.milvusStore.insertRecords(records);
                }
                if (this.localVectorStore && this.cachedManifestParams) {
                    await this.insertNodesToLocalStore(gitNodes, this.cachedManifestParams.dimensions);
                }
            }

            const docIds = gitNodes.map(node => String(node.id_ ?? '')).filter(Boolean);
            this.writeGitCommitDocIds(this.localStorePath, docIds);

            const manifest = this.readManifest(this.localStorePath);
            if (manifest) {
                const prevGitCount = manifest.gitCommitCount ?? prevIds.length;
                this.writeManifest(this.localStorePath, {
                    ...manifest,
                    gitCommitCount,
                    chunkCount: Math.max(0, manifest.chunkCount - prevGitCount + gitCommitCount),
                    builtAt: new Date().toISOString(),
                });
            }

            if (gitCommitCount > 0) {
                console.log(`[RAG] Refreshed ${gitCommitCount} git commit chunk(s) after incremental sync`);
            }
        } catch (err) {
            console.warn('[RAG] Git commit refresh failed:', err);
        }

        return gitCommitCount;
    }

    private async upsertFileInAllIndexes(filePath: string): Promise<number> {
        const normalized = this.normalizeFilePath(filePath);
        if (!this.shouldIndexFile(normalized) || !fs.existsSync(normalized)) {
            return 0;
        }

        await this.removeFileFromAllIndexes(normalized);

        const content = await this.readFileIfIndexable(normalized);
        if (content === null) {
            return 0;
        }
        const mdParser = this.createMdParser();
        const nodes = await this.chunkFile(normalized, content, mdParser);
        if (nodes.length === 0) {
            return 0;
        }

        if (this.milvusStore && this.activeIndexType === 'milvus') {
            await this.embedNodesInBatches(nodes);
            const records = await Promise.all(
                nodes.map(node => nodeToMilvusRecordLazy(node, node.embedding!)),
            );
            await this.milvusStore.insertRecords(records);
        }

        if (this.localVectorStore && this.cachedManifestParams) {
            await this.insertNodesToLocalStore(nodes, this.cachedManifestParams.dimensions);
        }

        this.fileChunkMap[normalized] = nodes.length;
        await this.updateCodeGraphForFile(normalized, content);
        if (this.localStorePath) {
            this.writeSidecarMaps(this.localStorePath);
        }
        return nodes.length;
    }

    private async nodeFromMilvusHit(hit: Record<string, unknown>): Promise<BaseNode> {
        const metadata = await milvusHitToMetadataLazy(hit);
        return new Document({
            id_: String(hit.chunk_id ?? metadata.filePath ?? 'unknown'),
            text: String(hit.text_content ?? ''),
            metadata,
        });
    }

    private async retrieveVectorNodes(
        queryText: string,
        opts: Required<RagQueryOptions>,
        routeTargets: RagRouteTarget[],
        useRouter: boolean,
    ): Promise<RetrievedNode[]> {
        const retrieveTopK = opts.similarityTopK;
        const partitions = useRouter ? targetsToMilvusPartitions(routeTargets) : undefined;

        if (this.activeIndexType === 'milvus' && this.milvusStore) {
            const denseVector = await Settings.embedModel.getTextEmbedding(queryText);
            const hits = await this.milvusStore.hybridSearch(
                queryText,
                denseVector,
                retrieveTopK,
                partitions,
            );
            return Promise.all(hits.map(async (hit, index) => ({
                node: await this.nodeFromMilvusHit(hit),
                score: typeof hit.score === 'number' ? hit.score : (hits.length - index),
            })));
        }

        if (!this.localVectorStore) {
            return [];
        }

        const localRetrieveTopK = computeLocalRouterRetrieveTopK(retrieveTopK, routeTargets, useRouter);
        const denseVector = await Settings.embedModel.getTextEmbedding(queryText);
        const docTypes = useRouter ? targetsToLocalDocTypes(routeTargets) : undefined;
        const hits = await this.localVectorStore.similaritySearch(denseVector, {
            topK: localRetrieveTopK,
            docTypes,
            onBatchScanned: () => this.yieldToEventLoop(),
        });
        const scored: RetrievedNode[] = hits.map((hit, index) => ({
            node: localVectorRecordToNode(hit.record),
            score: hit.score,
        }));

        if (useRouter) {
            return filterRetrievedByRoute(scored, routeTargets, retrieveTopK);
        }
        return scored.slice(0, retrieveTopK);
    }

    private async assembleOrchestratedContext(
        queryText: string,
        opts: Required<RagQueryOptions>,
        orch: ReturnType<typeof mergeOrchestratorOptions>,
    ): Promise<string | null> {
        const hasIndex = (this.activeIndexType === 'milvus' && this.milvusStore) || this.localVectorStore;
        if (!hasIndex) {
            return null;
        }

        const routeTargets = orch.useRouter ? routeQueryTargets(queryText) : ['all' as RagRouteTarget];
        const subQueries = await this.resolveSubQuestions(queryText, orch);

        let scored: RetrievedNode[] = [];
        for (const subQ of subQueries) {
            const nodes = await this.retrieveVectorNodes(subQ, opts, routeTargets, orch.useRouter);
            scored.push(...nodes);
        }
        scored = dedupeRetrievedNodes(scored);

        if (scored.length === 0) {
            return null;
        }

        if (opts.useReranker && scored.length > 1) {
            const rerankPool = Math.max(opts.finalTopK * 2, opts.finalTopK);
            scored = rerankRetrievedNodes(queryText, scored, rerankPool);
        }
        scored = applyMMRDiversity(scored, opts.finalTopK);

        const sections: string[] = [];
        let budgetRemaining = opts.assemblyMaxChars ?? Number.POSITIVE_INFINITY;
        const ORCHESTRATION_EXPAND_MIN_CHARS = 400;

        const formatted = await Promise.all(
            scored.map(async result => {
                const displayContent = await this.resolveDisplayContent(result.node);
                return this.formatNodeContext(result.node, displayContent);
            }),
        );
        const topKBlock = formatted.join('\n\n');
        budgetRemaining = appendSectionWithinBudget(sections, topKBlock, budgetRemaining);

        if (orch.useGraphExpand && budgetRemaining >= ORCHESTRATION_EXPAND_MIN_CHARS) {
            const graphSnippets = await expandRetrievalWithGraph(
                this.codeGraph,
                scored,
                (filePath, startLine, endLine) => this.readFileLineRange(filePath, startLine, endLine),
                orch.graphExpandMax,
                orch.graphExpandHops,
            );
            if (graphSnippets.length > 0) {
                const graphBlock = graphSnippets.map(formatGraphExpandedSnippet).join('\n\n');
                budgetRemaining = appendSectionWithinBudget(sections, graphBlock, budgetRemaining);
            }
        }

        if (orch.useDocLinkedCode && budgetRemaining >= ORCHESTRATION_EXPAND_MIN_CHARS) {
            const linkedPaths = collectLinkedFilesFromDocNodes(scored, this.workspaceRoot);
            if (linkedPaths.length > 0) {
                const linkedSnippets = await buildLinkedCodeSnippets(
                    linkedPaths,
                    this.codeSymbolMap,
                    (filePath, startLine, endLine) => this.readFileLineRange(filePath, startLine, endLine),
                    orch.docLinkedMax,
                );
                if (linkedSnippets.length > 0) {
                    const linkedBlock = linkedSnippets.map(formatLinkedCodeSnippet).join('\n\n');
                    appendSectionWithinBudget(sections, linkedBlock, budgetRemaining);
                }
            }
        }

        return sections.filter(Boolean).join('\n\n');
    }

    public async queryContext(queryText: string, options?: RagQueryOptions): Promise<string> {
        const gitContext = this.workspaceRoot
            ? await buildGitDynamicContext({ workspaceRoot: this.workspaceRoot, query: queryText })
            : null;

        const opts = { ...defaultRagQueryOptions, ...options };
        this.queryCompactMode = opts.ragCompactMode ?? false;
        let orch = mergeOrchestratorOptions(opts);
        orch = applyIntentOrchestration(queryText, orch, opts.ragIntentOrchestration !== false);
        const useOrchestrator = options?.useOrchestrator !== false;

        try {
            const vectorContext = useOrchestrator
                ? await this.assembleOrchestratedContext(queryText, opts, orch)
                : await this.assembleLegacyContext(queryText, opts);

            if (vectorContext) {
                return gitContext ? `${gitContext}\n\n${vectorContext}` : vectorContext;
            }
            return gitContext ?? "No context found. RAG index has not been initialized yet.";
        } catch (err) {
            console.error('[RAG] Retrieval failed:', err);
            return gitContext ?? "No context found. RAG index has not been initialized yet.";
        }
    }

    /** Pre-orchestrator retrieval path (no router / graph / sub-questions). */
    private async assembleLegacyContext(queryText: string, opts: Required<RagQueryOptions>): Promise<string | null> {
        if (this.activeIndexType === 'milvus' && this.milvusStore) {
            const denseVector = await Settings.embedModel.getTextEmbedding(queryText);
            const hits = await this.milvusStore.hybridSearch(
                queryText,
                denseVector,
                opts.useReranker ? opts.similarityTopK : opts.finalTopK,
            );
            if (hits.length === 0) {
                return null;
            }
            let scored: RetrievedNode[] = await Promise.all(hits.map(async (hit, index) => ({
                node: await this.nodeFromMilvusHit(hit),
                score: typeof hit.score === 'number' ? hit.score : (hits.length - index),
            })));
            if (opts.useReranker && scored.length > 1) {
                const rerankPool = Math.max(opts.finalTopK * 2, opts.finalTopK);
                scored = rerankRetrievedNodes(queryText, scored, rerankPool);
            }
            scored = applyMMRDiversity(scored, opts.finalTopK);
            const formatted = await Promise.all(
                scored.map(async result => {
                    const displayContent = await this.resolveDisplayContent(result.node);
                    return this.formatNodeContext(result.node, displayContent);
                }),
            );
            return formatted.join('\n\n');
        }

        if (!this.localVectorStore) {
            return null;
        }

        const denseVector = await Settings.embedModel.getTextEmbedding(queryText);
        const hits = await this.localVectorStore.similaritySearch(denseVector, {
            topK: opts.useReranker ? opts.similarityTopK : opts.finalTopK,
            onBatchScanned: () => this.yieldToEventLoop(),
        });
        if (hits.length === 0) {
            return null;
        }

        let scored: RetrievedNode[] = hits.map((hit, index) => ({
            node: localVectorRecordToNode(hit.record),
            score: hit.score,
        }));

        if (opts.useReranker && scored.length > 1) {
            const rerankPool = Math.max(opts.finalTopK * 2, opts.finalTopK);
            scored = rerankRetrievedNodes(queryText, scored, rerankPool);
        }
        scored = applyMMRDiversity(scored, opts.finalTopK);

        const formatted = await Promise.all(
            scored.map(async result => {
                const displayContent = await this.resolveDisplayContent(result.node);
                return this.formatNodeContext(result.node, displayContent);
            }),
        );
        return formatted.join('\n\n');
    }

    private shouldIndexFile(filePath: string): boolean {
        const normalized = this.normalizeFilePath(filePath);
        if (!path.isAbsolute(normalized)) {
            return false;
        }
        if (this.pathInSkippedDir(normalized)) {
            return false;
        }
        if (this.isPathIgnored(normalized)) {
            return false;
        }
        const ext = path.extname(normalized).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) {
            return false;
        }
        const compilePaths = this.loadCompileCommandPaths(this.workspaceRoot);
        if (compilePaths && !compilePaths.has(normalized)) {
            return false;
        }
        return true;
    }

    private walkDir(dir: string, fileList: string[] = []): string[] {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            if (this.isPathIgnored(filePath)) {
                continue;
            }
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                if (this.shouldSkipDirName(file)) {
                    continue;
                }
                this.walkDir(filePath, fileList);
            } else if (this.shouldIndexFile(filePath)) {
                fileList.push(filePath);
            }
        }
        return fileList;
    }

    private async walkDirAsync(dir: string, fileList: string[] = [], visited = { count: 0 }): Promise<string[]> {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(dir);
        } catch {
            return fileList;
        }

        for (const file of entries) {
            visited.count += 1;
            if (visited.count % WALK_YIELD_EVERY === 0) {
                await this.yieldToEventLoop();
            }

            const filePath = path.join(dir, file);
            if (this.isPathIgnored(filePath)) {
                continue;
            }

            let stat: fs.Stats;
            try {
                stat = await fs.promises.stat(filePath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                if (this.shouldSkipDirName(file)) {
                    continue;
                }
                await this.walkDirAsync(filePath, fileList, visited);
            } else if (this.shouldIndexFile(filePath)) {
                fileList.push(filePath);
            }
        }
        return fileList;
    }

    private collectTargetFiles(): string[] {
        const compilePaths = this.loadCompileCommandPaths(this.workspaceRoot);
        if (compilePaths) {
            const files: string[] = [];
            for (const filePath of compilePaths) {
                if (fs.existsSync(filePath) && this.shouldIndexFile(filePath)) {
                    files.push(filePath);
                }
            }
            console.log(`[RAG] Indexing ${files.length} files from compile_commands.json whitelist`);
            return files;
        }
        return this.walkDir(this.workspaceRoot);
    }

    private async collectTargetFilesAsync(): Promise<string[]> {
        this.fireProgress({
            phase: 'scanning',
            filesDone: 0,
            filesTotal: 0,
            chunks: 0,
            currentFile: 'Discovering workspace files…',
        });
        await this.yieldToEventLoop();

        const compilePaths = this.loadCompileCommandPaths(this.workspaceRoot);
        if (compilePaths) {
            const files: string[] = [];
            let checked = 0;
            for (const filePath of compilePaths) {
                checked += 1;
                if (checked % WALK_YIELD_EVERY === 0) {
                    await this.yieldToEventLoop();
                }
                try {
                    await fs.promises.access(filePath);
                    if (this.shouldIndexFile(filePath)) {
                        files.push(filePath);
                    }
                } catch {
                    // file missing
                }
            }
            console.log(`[RAG] Indexing ${files.length} files from compile_commands.json whitelist`);
            return files;
        }

        const files = await this.walkDirAsync(this.workspaceRoot);
        console.log(`[RAG] Discovered ${files.length} indexable files in workspace`);
        return files;
    }

    private isDocFile(filePath: string): boolean {
        return DOC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    }

    private getHeaderBreadcrumb(metadata: Record<string, unknown>): string | undefined {
        const headers = Object.entries(metadata)
            .filter(([key, value]) => key.startsWith('Header_') && typeof value === 'string')
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([, value]) => value as string);
        return headers.length > 0 ? headers.join(' > ') : undefined;
    }

    private enrichDocNode(node: BaseNode, filePath: string, fileName: string, chunkIndex: number, linkedFiles?: string[]): BaseNode {
        const metadata = { ...node.metadata } as Record<string, unknown>;
        metadata.filePath = filePath;
        metadata.fileName = fileName;
        metadata.docType = 'doc_chunk';
        const breadcrumb = this.getHeaderBreadcrumb(metadata);
        if (breadcrumb) {
            metadata.headers = breadcrumb;
        }
        if (linkedFiles && linkedFiles.length > 0) {
            metadata.linkedFiles = linkedFiles;
        }
        node.id_ = getChunkDocId(filePath, chunkIndex);
        node.metadata = metadata;
        return node;
    }
    private async semanticChunksToNodes(normalizedPath: string, fileName: string, content: string): Promise<BaseNode[]> {
        const semanticChunks = await chunkCodeForIndexing(content, normalizedPath);
        this.codeSymbolMap[normalizedPath] = semanticChunks.map(chunk => ({
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            symbolType: chunk.symbolType,
            symbolName: chunk.symbolName,
        }));
        return semanticChunks.map((chunk, index) => new Document({
            id_: getChunkDocId(normalizedPath, index),
            text: chunk.text,
            metadata: {
                filePath: normalizedPath,
                fileName,
                docType: 'code_chunk',
                symbolType: chunk.symbolType,
                symbolName: chunk.symbolName,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                ...(chunk.partIndex !== undefined ? { partIndex: chunk.partIndex } : {}),
                ...(chunk.partTotal !== undefined ? { partTotal: chunk.partTotal } : {}),
            },
        }));
    }

    private async chunkFile(filePath: string, content: string, mdParser: MarkdownNodeParser): Promise<BaseNode[]> {
        const normalizedPath = this.normalizeFilePath(filePath);
        const fileName = path.basename(normalizedPath);
        if (this.isDocFile(normalizedPath)) {
            const linkedFiles = path.extname(normalizedPath).toLowerCase() === '.md'
                ? extractMarkdownLinkedFiles(content, normalizedPath, this.workspaceRoot)
                : [];
            const doc = new Document({
                id_: getChunkDocId(normalizedPath, 0),
                text: content,
                metadata: { filePath: normalizedPath, fileName, docType: 'doc_chunk' },
            });
            const nodes = await mdParser.getNodesFromDocuments([doc]);
            const enriched = nodes.map((node, index) => this.enrichDocNode(node, normalizedPath, fileName, index, linkedFiles));
            this.purgeSidecarMapsForFile(normalizedPath);
            const fileParents = assignDocParentChunks(enriched);
            Object.assign(this.docParentMap, fileParents);
            return enriched;
        }

        return await this.semanticChunksToNodes(normalizedPath, fileName, content);
    }

    private configureEmbeddingModel(embeddingConfig?: RagEmbeddingConfig): RagEmbeddingConfig {
        const provider = embeddingConfig?.provider ?? DEFAULT_RAG_EMBEDDING.provider;
        const model = embeddingConfig?.model ?? DEFAULT_RAG_EMBEDDING.model;
        const ollamaEndpoint = embeddingConfig?.ollamaEndpoint ?? DEFAULT_RAG_EMBEDDING.ollamaEndpoint;
        this.currentEmbeddingConfig = { provider, model, ollamaEndpoint };

        if (provider === 'ollama') {
            if (!/embed|bge-|mxbai|nomic/i.test(model)) {
                console.warn(
                    `[RAG] "${model}" may not be an embedding model. Use e.g. nomic-embed-text (ollama pull nomic-embed-text).`,
                );
            }
            console.log(`[RAG] Initializing local Ollama embedding model: ${model} at ${ollamaEndpoint}`);
            Settings.embedModel = new CustomOllamaEmbedding({ model, baseUrl: ollamaEndpoint });
        } else {
            const openAIKey = process.env.OPENAI_API_KEY || "";
            if (!openAIKey) {
                console.warn('[RAG] OpenAI embedding selected but OPENAI_API_KEY is not set.');
            }
            console.log(`[RAG] Initializing OpenAI embedding model: ${model}`);
            Settings.embedModel = new OpenAIEmbedding({ model, apiKey: openAIKey });
        }

        return this.currentEmbeddingConfig;
    }

    private async detectEmbeddingDimensions(): Promise<{ dimensions: number; isOnline: boolean }> {
        const provider = this.currentEmbeddingConfig.provider ?? DEFAULT_RAG_EMBEDDING.provider;
        let dimensions = provider === 'ollama'
            ? OLLAMA_EMBEDDING_DEFAULT_DIMENSIONS
            : OPENAI_EMBEDDING_DEFAULT_DIMENSIONS;
        let isOnline = true;
        try {
            const dummyVector = await Settings.embedModel.getTextEmbedding("test");
            if (dummyVector && dummyVector.length > 0) {
                dimensions = dummyVector.length;
                console.log(`[RAG] Dynamically detected embedding vector dimensions: ${dimensions}`);
            }
        } catch (err) {
            isOnline = false;
            console.warn(`[RAG] Failed to dynamically detect embedding dimensions, using default: ${dimensions}`, err);
        }
        return { dimensions, isOnline };
    }

    private async embedNodesInBatches(nodes: BaseNode[]): Promise<void> {
        for (let i = 0; i < nodes.length; i += EMBED_BATCH_SIZE) {
            await this.yieldToEventLoop();
            const batch = nodes.slice(i, i + EMBED_BATCH_SIZE);
            const texts = batch.map(node => node.getContent(MetadataMode.NONE));
            const embeddings = await Settings.embedModel.getTextEmbeddings(texts);
            batch.forEach((node, index) => {
                node.embedding = embeddings[index];
            });
        }
    }

    private async scanWorkspaceNodes(): Promise<ScanIndexResult> {
        const mdParser = this.createMdParser();
        const targetFiles = this.collectTargetFiles();
        const allNodes: BaseNode[] = [];
        const fileChunkMap: Record<string, number> = {};
        this.codeGraph = createEmptyCodeGraph();
        this.symbolNameIndex = new Map();

        this.fireProgress({
            phase: 'scanning',
            filesDone: 0,
            filesTotal: targetFiles.length,
            chunks: 0,
        });

        for (let i = 0; i < targetFiles.length; i++) {
            if (i % INDEX_YIELD_EVERY === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            const filePath = targetFiles[i];
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                const nodes = await this.chunkFile(filePath, content, mdParser);
                const normalized = this.normalizeFilePath(filePath);
                fileChunkMap[normalized] = nodes.length;
                allNodes.push(...nodes);
                await this.updateCodeGraphForFile(normalized, content);
            } catch (e) {
                console.warn(`[RAG] Failed to read or chunk file ${filePath}:`, e);
            }

            if (i % INDEX_YIELD_EVERY === 0 || i === targetFiles.length - 1) {
                this.fireProgress({
                    phase: 'scanning',
                    filesDone: i + 1,
                    filesTotal: targetFiles.length,
                    chunks: allNodes.length,
                    currentFile: path.basename(filePath),
                });
            }
        }

        let gitCommitCount = 0;
        let gitDocIds: string[] = [];
        try {
            const commits = await fetchGitCommits(this.workspaceRoot);
            const gitNodes = gitCommitsToNodes(commits);
            gitCommitCount = gitNodes.length;
            gitDocIds = gitNodes.map(node => String(node.id_ ?? '')).filter(Boolean);
            allNodes.push(...gitNodes);
            if (gitCommitCount > 0) {
                console.log(`[RAG] Indexed ${gitCommitCount} git commits`);
            }
        } catch (err) {
            console.warn('[RAG] Git commit indexing failed:', err);
        }

        return { targetFiles, allNodes, fileChunkMap, gitCommitCount, gitDocIds };
    }

    private writeIndexManifest(
        localStorePath: string,
        params: {
            provider: string;
            model: string;
            dimensions: number;
            fileCount: number;
            chunkCount: number;
            gitCommitCount: number;
            indexBackend: IndexManifest['indexBackend'];
        },
    ): string {
        const builtAt = new Date().toISOString();
        this.writeManifest(localStorePath, {
            version: MANIFEST_VERSION,
            chunkEngine: CHUNK_ENGINE,
            indexBackend: params.indexBackend,
            embeddingProvider: params.provider,
            embeddingModel: params.model,
            dimensions: params.dimensions,
            fileCount: params.fileCount,
            chunkCount: params.chunkCount,
            gitCommitCount: params.gitCommitCount,
            graphEngine: CODE_GRAPH_ENGINE,
            orchestratorEngine: ORCHESTRATOR_ENGINE,
            vectorStorage: LOCAL_VECTOR_STORAGE_ENGINE,
            builtAt,
        });
        return builtAt;
    }

    private async persistLocalVectorIndex(
        localStorePath: string,
        allNodes: BaseNode[],
        fileChunkMap: Record<string, number>,
        dimensions: number,
    ): Promise<void> {
        this.localStorePath = localStorePath;
        await this.insertNodesToLocalStore(allNodes, dimensions);
        this.fileChunkMap = fileChunkMap;
        this.writeFileChunkMap(localStorePath);
        this.writeSidecarMaps(localStorePath);
    }

    private async persistMilvusIndex(
        allNodes: BaseNode[],
        dimensions: number,
        recreateCollection: boolean,
    ): Promise<void> {
        if (!this.milvusStore) {
            throw new Error('[RAG] Milvus store is not initialized.');
        }
        await this.milvusStore.ensureCollection(dimensions, recreateCollection);
        await this.embedNodesInBatches(allNodes);
        const records = await Promise.all(allNodes.map(async (node, index) => {
            const embedding = node.embedding;
            if (!embedding || embedding.length === 0) {
                throw new Error(`[RAG] Missing embedding for node ${node.id_ ?? index}`);
            }
            return nodeToMilvusRecordLazy(node, embedding);
        }));
        await this.milvusStore.insertRecords(records);
    }

    public async testMilvusConnection(config: RagMilvusConfig): Promise<RagMilvusConnectionResult> {
        return testMilvusConnectionLazy(config);
    }

    private async insertNodesForLocalBuild(nodes: BaseNode[], dimensions: number): Promise<void> {
        await this.insertNodesToLocalStore(nodes, dimensions);
    }

    private async indexSingleFileForLocalBuild(filePath: string, mdParser: MarkdownNodeParser, dimensions: number): Promise<number> {
        await this.yieldToEventLoop();
        const normalized = this.normalizeFilePath(filePath);
        const content = await this.readFileIfIndexable(filePath);
        if (content === null) {
            return 0;
        }
        const nodes = await this.chunkFile(filePath, content, mdParser);
        if (nodes.length === 0) {
            await this.updateCodeGraphForFile(normalized, content);
            return 0;
        }

        await this.insertNodesForLocalBuild(nodes, dimensions);
        await this.yieldToEventLoop();

        this.fileChunkMap[normalized] = nodes.length;
        await this.updateCodeGraphForFile(normalized, content);
        return nodes.length;
    }

    private async indexGitCommitsForLocalBuild(dimensions: number): Promise<{ gitCommitCount: number; gitDocIds: string[] }> {
        try {
            const commits = await fetchGitCommits(this.workspaceRoot);
            const gitNodes = gitCommitsToNodes(commits);
            if (gitNodes.length === 0) {
                return { gitCommitCount: 0, gitDocIds: [] };
            }
            await this.insertNodesForLocalBuild(gitNodes, dimensions);
            const gitDocIds = gitNodes.map(node => String(node.id_ ?? '')).filter(Boolean);
            console.log(`[RAG] Indexed ${gitNodes.length} git commits`);
            return { gitCommitCount: gitNodes.length, gitDocIds };
        } catch (err) {
            console.warn('[RAG] Git commit indexing failed:', err);
            return { gitCommitCount: 0, gitDocIds: [] };
        }
    }

    private saveBuildCheckpointProgress(
        localStorePath: string,
        params: {
            provider: string;
            model: string;
            dimensions: number;
            indexedFiles: Set<string>;
            gitCommitsIndexed: boolean;
            totalFiles: number;
            chunkCount: number;
            gitCommitCount: number;
            startedAt: string;
        },
    ): void {
        this.writeBuildCheckpoint(localStorePath, {
            version: BUILD_CHECKPOINT_VERSION,
            status: 'in_progress',
            indexBackend: 'local',
            embeddingProvider: params.provider,
            embeddingModel: params.model,
            dimensions: params.dimensions,
            indexedFiles: [...params.indexedFiles],
            gitCommitsIndexed: params.gitCommitsIndexed,
            gitCommitCount: params.gitCommitCount,
            totalFiles: params.totalFiles,
            chunkCount: params.chunkCount,
            startedAt: params.startedAt,
            updatedAt: new Date().toISOString(),
        });
    }

    private async saveBuildCheckpointProgressAsync(
        localStorePath: string,
        params: {
            provider: string;
            model: string;
            dimensions: number;
            indexedFiles: Set<string>;
            gitCommitsIndexed: boolean;
            totalFiles: number;
            chunkCount: number;
            gitCommitCount: number;
            startedAt: string;
        },
    ): Promise<void> {
        await this.writeBuildCheckpointAsync(localStorePath, {
            version: BUILD_CHECKPOINT_VERSION,
            status: 'in_progress',
            indexBackend: 'local',
            embeddingProvider: params.provider,
            embeddingModel: params.model,
            dimensions: params.dimensions,
            indexedFiles: [...params.indexedFiles],
            gitCommitsIndexed: params.gitCommitsIndexed,
            gitCommitCount: params.gitCommitCount,
            totalFiles: params.totalFiles,
            chunkCount: params.chunkCount,
            startedAt: params.startedAt,
            updatedAt: new Date().toISOString(),
        });
    }

    private async flushBuildMetadataToDisk(localStorePath: string): Promise<void> {
        await this.yieldToEventLoop();
        await this.writeFileChunkMapAsync(localStorePath);
        await this.yieldToEventLoop();
    }

    private async flushBuildFullToDisk(localStorePath: string): Promise<void> {
        await this.yieldToEventLoop();
        await this.writeFileChunkMapAsync(localStorePath);
        await this.writeSidecarMapsAsync(localStorePath);
        await this.flushLocalVectorWal();
        await this.yieldToEventLoop();
    }

    private async buildLocalIndex(
        localStorePath: string,
        provider: string,
        model: string,
        dimensions: number,
        buildOptions?: LocalIndexBuildOptions,
    ): Promise<{ fileCount: number; chunkCount: number }> {
        const forceFresh = buildOptions?.forceFresh === true;
        let resume = buildOptions?.resume === true && !forceFresh;

        this.localStorePath = localStorePath;
        this.compileCommandPathsCache = undefined;

        const indexedFiles = new Set<string>();
        let gitCommitsIndexed = false;
        let gitCommitCount = 0;
        let totalChunks = 0;
        let startedAt = new Date().toISOString();

        if (forceFresh) {
            await this.clearLocalStoreForFreshBuildAsync(localStorePath);
            resume = false;
        } else if (resume) {
            const checkpoint = this.readBuildCheckpoint(localStorePath);
            const canLoadPartial = checkpoint
                && this.checkpointMatches(checkpoint, provider, model, dimensions, 'local')
                && this.localStoreHasIndex({
                    storePath: localStorePath,
                    dbFileName: this.localVectorDbFileName,
                    isLegacy: this.localVectorDbFileName === LEGACY_LOCAL_VECTOR_DB_FILENAME,
                });

            if (canLoadPartial && checkpoint) {
                await this.loadLocalVectorStore(localStorePath, dimensions);
                for (const filePath of checkpoint.indexedFiles) {
                    indexedFiles.add(filePath);
                }
                gitCommitsIndexed = checkpoint.gitCommitsIndexed;
                gitCommitCount = checkpoint.gitCommitCount;
                totalChunks = checkpoint.chunkCount;
                startedAt = checkpoint.startedAt;
            } else {
                resume = false;
                await this.clearLocalStoreForFreshBuildAsync(localStorePath);
            }
        } else {
            await this.clearLocalStoreForFreshBuildAsync(localStorePath);
        }

        const targetFiles = await this.collectTargetFilesAsync();
        const pendingFiles = targetFiles.filter(filePath => !indexedFiles.has(this.normalizeFilePath(filePath)));

        this.localIndexBuildDeferHnsw = !resume || indexedFiles.size === 0;

        if (resume) {
            console.log(`[RAG] Resuming local index build (${indexedFiles.size}/${targetFiles.length} files already indexed)...`);
        } else {
            console.log('[RAG] Building local vector index from workspace scan...');
        }

        this.saveBuildCheckpointProgress(localStorePath, {
            provider,
            model,
            dimensions,
            indexedFiles,
            gitCommitsIndexed,
            gitCommitCount,
            totalFiles: targetFiles.length,
            chunkCount: totalChunks,
            startedAt,
        });

        this.fireProgress({
            phase: 'scanning',
            filesDone: indexedFiles.size,
            filesTotal: targetFiles.length,
            chunks: totalChunks,
            currentFile: pendingFiles[0] ? path.basename(pendingFiles[0]) : undefined,
        });
        await this.yieldToEventLoop();

        const mdParser = this.createMdParser();
        let filesDone = indexedFiles.size;
        let filesSinceMetadataFlush = 0;
        let filesSinceVectorFlush = 0;

        for (let i = 0; i < pendingFiles.length; i++) {
            if (i % BUILD_FILE_YIELD_EVERY === 0) {
                await this.yieldToEventLoop();
            }

            const filePath = pendingFiles[i];

            try {
                totalChunks += await this.indexSingleFileForLocalBuild(filePath, mdParser, dimensions);
            } catch (e) {
                console.warn(`[RAG] Failed to read or chunk file ${filePath}:`, e);
            }

            indexedFiles.add(this.normalizeFilePath(filePath));
            filesDone += 1;
            filesSinceMetadataFlush += 1;
            filesSinceVectorFlush += 1;

            this.fireProgress({
                phase: 'scanning',
                filesDone,
                filesTotal: targetFiles.length,
                chunks: totalChunks,
                currentFile: path.basename(filePath),
            });
            await this.yieldToEventLoop();

            if (filesSinceMetadataFlush >= CHECKPOINT_METADATA_EVERY || i === pendingFiles.length - 1) {
                await this.saveBuildCheckpointProgressAsync(localStorePath, {
                    provider,
                    model,
                    dimensions,
                    indexedFiles,
                    gitCommitsIndexed,
                    gitCommitCount,
                    totalFiles: targetFiles.length,
                    chunkCount: totalChunks,
                    startedAt,
                });
                await this.flushBuildMetadataToDisk(localStorePath);
                filesSinceMetadataFlush = 0;
            }

            if (filesSinceVectorFlush >= SIDECAR_FLUSH_EVERY || i === pendingFiles.length - 1) {
                await this.saveBuildCheckpointProgressAsync(localStorePath, {
                    provider,
                    model,
                    dimensions,
                    indexedFiles,
                    gitCommitsIndexed,
                    gitCommitCount,
                    totalFiles: targetFiles.length,
                    chunkCount: totalChunks,
                    startedAt,
                });
                await this.flushBuildFullToDisk(localStorePath);
                filesSinceVectorFlush = 0;
            }
        }

        let gitDocIds: string[] = [];
        if (!gitCommitsIndexed) {
            this.fireProgress({
                phase: 'persisting',
                filesDone: targetFiles.length,
                filesTotal: targetFiles.length,
                chunks: totalChunks,
            });
            const gitResult = await this.indexGitCommitsForLocalBuild(dimensions);
            gitCommitCount = gitResult.gitCommitCount;
            gitDocIds = gitResult.gitDocIds;
            totalChunks += gitCommitCount;
            gitCommitsIndexed = true;
            this.writeGitCommitDocIds(localStorePath, gitDocIds);
            await this.saveBuildCheckpointProgressAsync(localStorePath, {
                provider,
                model,
                dimensions,
                indexedFiles,
                gitCommitsIndexed: true,
                gitCommitCount,
                totalFiles: targetFiles.length,
                chunkCount: totalChunks,
                startedAt,
            });
            await this.flushBuildFullToDisk(localStorePath);
        } else {
            gitDocIds = this.readGitCommitDocIds(localStorePath);
        }

        if (totalChunks === 0) {
            console.warn('[RAG] No valid chunks found to index.');
            this.localVectorStore = null;
            this.localVectorDimensions = 0;
            this.fileChunkMap = {};
            this.deleteBuildCheckpoint(localStorePath);
            const builtAt = new Date().toISOString();
            this.fireComplete({
                fileCount: targetFiles.length,
                chunkCount: 0,
                builtAt,
                indexType: 'local',
            });
            return { fileCount: targetFiles.length, chunkCount: 0 };
        }

        this.deleteBuildCheckpoint(localStorePath);
        if (this.localVectorStore) {
            await this.yieldToEventLoop();
            await this.localVectorStore.finalizeHnswIndex(() => this.yieldToEventLoop());
        }
        this.localIndexBuildDeferHnsw = false;
        this.writeGitCommitDocIds(localStorePath, gitDocIds);
        const builtAt = this.writeIndexManifest(localStorePath, {
            provider,
            model,
            dimensions,
            fileCount: targetFiles.length,
            chunkCount: totalChunks,
            gitCommitCount,
            indexBackend: 'local',
        });
        this.cachedManifestParams = { provider, model, dimensions };
        console.log(`[RAG] Built local index: ${targetFiles.length} files, ${totalChunks} chunks (${gitCommitCount} git commits)`);
        this.fireComplete({
            fileCount: targetFiles.length,
            chunkCount: totalChunks,
            builtAt,
            indexType: 'local',
        });
        return { fileCount: targetFiles.length, chunkCount: totalChunks };
    }

    private async buildMilvusIndex(
        localStorePath: string,
        workspaceHash: string,
        provider: string,
        model: string,
        dimensions: number,
        dualWrite: boolean,
    ): Promise<{ fileCount: number; chunkCount: number }> {
        console.log(`[RAG] Building Milvus hybrid index${dualWrite ? ' (dual-write to local)' : ''}...`);
        this.localStorePath = localStorePath;
        this.compileCommandPathsCache = undefined;

        if (dualWrite) {
            this.clearLocalStoreForFreshBuild(localStorePath);
        } else {
            fs.mkdirSync(localStorePath, { recursive: true });
            this.localVectorStore = null;
            this.localVectorDimensions = 0;
            this.fileChunkMap = {};
            this.docParentMap = {};
            this.codeSymbolMap = {};
            this.codeGraph = createEmptyCodeGraph();
            this.symbolNameIndex = new Map();
        }

        if (!this.milvusConfig) {
            throw new Error('[RAG] Milvus configuration is missing.');
        }
        if (this.milvusStore) {
            await this.milvusStore.close();
        }
        this.milvusStore = await createMilvusRagStore(this.milvusConfig, workspaceHash);

        const scanned = await this.scanWorkspaceNodes();
        if (scanned.allNodes.length === 0) {
            console.warn('[RAG] No valid chunks found to index in Milvus.');
            this.activeIndexType = null;
            const builtAt = new Date().toISOString();
            this.fireComplete({
                fileCount: scanned.targetFiles.length,
                chunkCount: 0,
                builtAt,
                indexType: 'milvus',
            });
            return { fileCount: scanned.targetFiles.length, chunkCount: 0 };
        }

        this.fireProgress({
            phase: 'persisting',
            filesDone: scanned.targetFiles.length,
            filesTotal: scanned.targetFiles.length,
            chunks: scanned.allNodes.length,
        });

        await this.persistMilvusIndex(scanned.allNodes, dimensions, true);

        if (dualWrite) {
            await this.persistLocalVectorIndex(localStorePath, scanned.allNodes, scanned.fileChunkMap, dimensions);
        } else {
            this.fileChunkMap = scanned.fileChunkMap;
            this.writeFileChunkMap(localStorePath);
            this.writeSidecarMaps(localStorePath);
        }
        this.writeGitCommitDocIds(localStorePath, scanned.gitDocIds);

        const indexBackend = dualWrite ? 'dual' : 'milvus';
        const builtAt = this.writeIndexManifest(localStorePath, {
            provider,
            model,
            dimensions,
            fileCount: scanned.targetFiles.length,
            chunkCount: scanned.allNodes.length,
            gitCommitCount: scanned.gitCommitCount,
            indexBackend,
        });
        this.cachedManifestParams = { provider, model, dimensions };
        console.log(`[RAG] Built Milvus index: ${scanned.targetFiles.length} files, ${scanned.allNodes.length} chunks (${scanned.gitCommitCount} git commits)`);
        this.fireComplete({
            fileCount: scanned.targetFiles.length,
            chunkCount: scanned.allNodes.length,
            builtAt,
            indexType: 'milvus',
        });
        return { fileCount: scanned.targetFiles.length, chunkCount: scanned.allNodes.length };
    }

    private async loadMilvusIndex(localStorePath: string, workspaceHash: string, dimensions: number): Promise<boolean> {
        if (!this.milvusConfig) {
            return false;
        }
        try {
            if (this.milvusStore) {
                await this.milvusStore.close();
            }
            this.milvusStore = await createMilvusRagStore(this.milvusConfig, workspaceHash);
            await this.milvusStore.ensureCollection(dimensions, false);
            this.localStorePath = localStorePath;
            this.fileChunkMap = this.readFileChunkMap(localStorePath);
            this.loadSidecarMaps(localStorePath);
            const manifest = this.readManifest(localStorePath);
            if (manifest) {
                this.cachedManifestParams = {
                    provider: manifest.embeddingProvider,
                    model: manifest.embeddingModel,
                    dimensions: manifest.dimensions,
                };
                console.log(`[RAG] Loaded Milvus index (${manifest.chunkCount} chunks, built ${manifest.builtAt})`);
            }
            if (manifest?.indexBackend === 'dual') {
                await this.loadLocalVectorStore(localStorePath, dimensions);
            } else {
                this.localVectorStore = null;
                this.localVectorDimensions = 0;
            }
            return true;
        } catch (err) {
            console.warn('[RAG] Failed to load Milvus index:', err);
            this.milvusStore = null;
            return false;
        }
    }

    private async loadLocalVectorStore(localStorePath: string, dimensions: number): Promise<boolean> {
        try {
            const dbPath = this.getLocalVectorDbPath(localStorePath);
            if (!fs.existsSync(dbPath)) {
                return false;
            }
            await this.yieldToEventLoop();
            await this.closeLocalVectorStore();
            this.localVectorStore = await LocalSqliteVectorStore.open(dbPath, dimensions, {
                onHnswBatch: () => this.yieldToEventLoop(),
            });
            this.localVectorDimensions = dimensions;
            this.localStorePath = localStorePath;
            this.fileChunkMap = this.readFileChunkMap(localStorePath);
            this.loadSidecarMaps(localStorePath);
            const manifest = this.readManifest(localStorePath);
            if (manifest) {
                this.cachedManifestParams = {
                    provider: manifest.embeddingProvider,
                    model: manifest.embeddingModel,
                    dimensions: manifest.dimensions,
                };
                console.log(`[RAG] Loaded local SQLite index (${manifest.chunkCount} chunks, built ${manifest.builtAt})`);
            } else {
                const chunkCount = await this.localVectorStore.getChunkCount();
                console.log(`[RAG] Loaded local SQLite index (${chunkCount} chunks)`);
            }
            return true;
        } catch (err) {
            console.warn('[RAG] Failed to load existing local SQLite index:', err);
            this.localVectorStore = null;
            this.localVectorDimensions = 0;
            return false;
        }
    }

    /**
     * Initialize RAG index (local SQLite vector store and/or Milvus hybrid store).
     * Returns immediately; all heavy work runs on a later main-process turn.
     */
    public async initializeIndex(
        workspaceRoot: string,
        workspaceHash: string,
        useMilvus: boolean,
        milvusConfig?: RagMilvusConfig,
        embeddingConfig?: RagEmbeddingConfig,
        initOptions?: RagInitOptions,
    ): Promise<'local' | 'milvus'> {
        const targetType: 'local' | 'milvus' = useMilvus ? 'milvus' : 'local';
        this.runBackgroundIndexOperation(() => this.executeInitializeIndex(
            workspaceRoot,
            workspaceHash,
            useMilvus,
            milvusConfig,
            embeddingConfig,
            initOptions,
        ));
        return targetType;
    }

    private async executeInitializeIndex(
        workspaceRoot: string,
        workspaceHash: string,
        useMilvus: boolean,
        milvusConfig?: RagMilvusConfig,
        embeddingConfig?: RagEmbeddingConfig,
        initOptions?: RagInitOptions,
    ): Promise<void> {
        try {
            await this.yieldToEventLoop();
            this.workspaceRoot = workspaceRoot;
            this.workspaceHash = workspaceHash;
            this.compileCommandPathsCache = undefined;
            this.loadMcodeIgnore(workspaceRoot);
            this.milvusDualWrite = initOptions?.milvusDualWrite === true;

            const forceRebuild = initOptions?.forceRebuild === true;
            let storeLayout = this.getLocalStorePath(workspaceRoot, workspaceHash);
            if (forceRebuild && storeLayout.isLegacy) {
                storeLayout = {
                    storePath: getNamedLocalStorePath(workspaceRoot),
                    dbFileName: getLocalVectorDbFileName(workspaceRoot),
                    isLegacy: false,
                };
            }
            this.setLocalStoreLayout(storeLayout);
            const localStorePath = storeLayout.storePath;
            if (storeLayout.isLegacy) {
                console.log('[RAG] Using legacy hash-based index store. Rebuild to migrate to project-named storage.');
            }
            const checkpoint = this.readBuildCheckpoint(localStorePath);

            if (useMilvus) {
                if (!milvusConfig?.address?.trim()) {
                    throw new Error('[RAG] Milvus address is required when index type is milvus.');
                }
                const connection = await testMilvusConnectionLazy(milvusConfig);
                if (!connection.ok) {
                    throw new Error(connection.message);
                }
                this.milvusConfig = milvusConfig;
            } else {
                this.milvusConfig = null;
                if (this.milvusStore) {
                    await this.milvusStore.close();
                    this.milvusStore = null;
                }
            }

            const { provider, model } = this.configureEmbeddingModel(embeddingConfig);
            const expectedBackendEarly: IndexManifest['indexBackend'] = useMilvus
                ? (this.milvusDualWrite ? 'dual' : 'milvus')
                : 'local';
            const canSkipDimensionProbe = !forceRebuild
                && !useMilvus
                && checkpoint
                && this.checkpointMatches(checkpoint, provider!, model!, checkpoint.dimensions, expectedBackendEarly);

            this.fireProgress({
                phase: 'loading',
                filesDone: 0,
                filesTotal: 0,
                chunks: 0,
                currentFile: canSkipDimensionProbe ? 'Resuming index build…' : 'Probing embedding model…',
            });
            await this.yieldToEventLoop();

            let dimensions: number;
            let isOnline: boolean;
            if (canSkipDimensionProbe && checkpoint) {
                dimensions = checkpoint.dimensions;
                isOnline = true;
            } else {
                const detected = await this.detectEmbeddingDimensions();
                dimensions = detected.dimensions;
                isOnline = detected.isOnline;
            }

            const manifest = this.readManifest(localStorePath);
            const expectedBackend: IndexManifest['indexBackend'] = expectedBackendEarly;
            const manifestCompatible = manifest
                ? this.manifestMatches(manifest, provider!, model!, dimensions, expectedBackend)
                : false;
            const checkpointCompatible = checkpoint
                ? this.checkpointMatches(checkpoint, provider!, model!, dimensions, expectedBackend)
                : false;
            const hasCompleteIndex = useMilvus
                ? Boolean(manifest && manifestCompatible && (manifest.indexBackend === 'milvus' || manifest.indexBackend === 'dual'))
                : this.localStoreHasIndex(storeLayout) && Boolean(manifest) && manifestCompatible;
            const canResumeBuild = !forceRebuild
                && !useMilvus
                && checkpointCompatible
                && this.localStoreHasIndex(storeLayout);

            const shouldRebuild = forceRebuild
                || canResumeBuild
                || !hasCompleteIndex;

            if (shouldRebuild) {
                if (!isOnline) {
                    console.warn('[RAG] Embedding model is offline or unreachable. Skipping index rebuild to prevent main thread freeze.');
                    if (hasCompleteIndex) {
                        this.fireProgress({ phase: 'loading', filesDone: 0, filesTotal: 0, chunks: 0 });
                        if (useMilvus) {
                            await this.loadMilvusIndex(localStorePath, workspaceHash, dimensions);
                            this.activeIndexType = this.milvusStore ? 'milvus' : null;
                        } else {
                            await this.loadLocalVectorStore(localStorePath, dimensions);
                            this.activeIndexType = this.localVectorStore ? 'local' : null;
                        }
                        if (manifest) {
                            this.fireComplete({
                                fileCount: manifest.fileCount,
                                chunkCount: manifest.chunkCount,
                                builtAt: manifest.builtAt,
                                indexType: useMilvus ? 'milvus' : 'local',
                            });
                        }
                    } else {
                        this.activeIndexType = null;
                        this.fireError(
                            'Cannot build index: embedding model is offline. Start Ollama and use an embedding model (e.g. nomic-embed-text, bge-m3).',
                        );
                    }
                    return;
                }

                if (forceRebuild) {
                    console.log('[RAG] Force rebuild requested.');
                } else if (canResumeBuild) {
                    console.log('[RAG] Resuming interrupted index build from checkpoint.');
                } else if (!hasCompleteIndex) {
                    console.log('[RAG] No existing compatible index found.');
                } else if (!manifestCompatible) {
                    console.log('[RAG] Embedding model or index backend changed; rebuilding index.');
                }

                this.fireProgress({ phase: 'scanning', filesDone: 0, filesTotal: 0, chunks: 0 });
                if (useMilvus) {
                    await this.buildMilvusIndex(localStorePath, workspaceHash, provider!, model!, dimensions, this.milvusDualWrite);
                    this.activeIndexType = this.milvusStore ? 'milvus' : null;
                } else {
                    await this.buildLocalIndex(localStorePath, provider!, model!, dimensions, {
                        resume: canResumeBuild,
                        forceFresh: forceRebuild,
                    });
                    this.activeIndexType = this.localVectorStore ? 'local' : null;
                }
                return;
            }

            this.fireProgress({ phase: 'loading', filesDone: 0, filesTotal: 0, chunks: 0 });
            if (useMilvus) {
                await this.loadMilvusIndex(localStorePath, workspaceHash, dimensions);
                const loadedManifest = this.readManifest(localStorePath);
                if (loadedManifest) {
                    this.fireComplete({
                        fileCount: loadedManifest.fileCount,
                        chunkCount: loadedManifest.chunkCount,
                        builtAt: loadedManifest.builtAt,
                        indexType: 'milvus',
                    });
                } else {
                    this.currentPhase = 'idle';
                }
                this.activeIndexType = this.milvusStore ? 'milvus' : null;
                return;
            }

            const loadedManifest = this.readManifest(localStorePath);
            await this.loadLocalVectorStore(localStorePath, loadedManifest?.dimensions ?? dimensions);
            if (loadedManifest) {
                this.fireComplete({
                    fileCount: loadedManifest.fileCount,
                    chunkCount: loadedManifest.chunkCount,
                    builtAt: loadedManifest.builtAt,
                    indexType: 'local',
                });
            } else {
                this.currentPhase = 'idle';
            }
            this.activeIndexType = this.localVectorStore ? 'local' : null;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.fireError(message);
        }
    }

    /**
     * Apply incremental index updates for changed/deleted workspace files.
     */
    public async applyIncrementalChanges(changes: RagFileChange[]): Promise<void> {
        if (!this.localStorePath) {
            return;
        }
        const milvusPrimary = this.activeIndexType === 'milvus';
        if (milvusPrimary && !this.milvusStore) {
            return;
        }
        if (!milvusPrimary && !this.localVectorStore) {
            return;
        }

        let manifest = this.readManifest(this.localStorePath);
        if (!manifest || !this.cachedManifestParams) {
            return;
        }

        const merged = new Map<string, RagFileChange['type']>();
        for (const change of changes) {
            const normalized = this.normalizeFilePath(change.filePath);
            if (change.type === 'deleted') {
                merged.set(normalized, 'deleted');
            } else if (merged.get(normalized) !== 'deleted') {
                merged.set(normalized, 'updated');
            }
        }

        if (merged.size === 0) {
            return;
        }

        this.fireProgress({
            phase: 'incremental',
            filesDone: 0,
            filesTotal: merged.size,
            chunks: manifest.chunkCount,
        });

        // compile_commands.json changed → whitelist changed, full rebuild (includes git commit re-index)
        for (const filePath of merged.keys()) {
            if (path.basename(filePath) === 'compile_commands.json') {
                console.log('[RAG] compile_commands.json changed, triggering full index rebuild (code whitelist + git commits).');
                if (milvusPrimary) {
                    await this.buildMilvusIndex(
                        this.localStorePath,
                        this.workspaceHash,
                        this.cachedManifestParams.provider,
                        this.cachedManifestParams.model,
                        this.cachedManifestParams.dimensions,
                        manifest.indexBackend === 'dual',
                    );
                } else {
                    await this.buildLocalIndex(
                        this.localStorePath,
                        this.cachedManifestParams.provider,
                        this.cachedManifestParams.model,
                        this.cachedManifestParams.dimensions,
                        { forceFresh: true },
                    );
                }
                return;
            }
        }

        let netChunkDelta = 0;
        let netFileDelta = 0;
        let appliedCount = 0;

        const ignoreRulesChanged = [...merged.keys()].some(filePath => {
            const baseName = path.basename(filePath);
            return baseName === '.mcodeignore' || baseName === '.voidignore';
        });
        if (ignoreRulesChanged) {
            this.loadMcodeIgnore(this.workspaceRoot);
            const purge = await this.purgeIgnoredFilesFromIndex();
            netChunkDelta -= purge.removedChunks;
            netFileDelta -= purge.removedFiles;
            appliedCount += purge.removedFiles;
        }

        for (const [filePath, changeType] of merged) {
            const baseName = path.basename(filePath);
            if (baseName === '.mcodeignore' || baseName === '.voidignore') {
                continue;
            }

            const wasIndexed = filePath in this.fileChunkMap;

            if (changeType === 'deleted') {
                if (wasIndexed) {
                    const removed = await this.removeFileFromAllIndexes(filePath);
                    netChunkDelta -= removed;
                    netFileDelta -= 1;
                    appliedCount += 1;
                }
                continue;
            }

            if (!this.shouldIndexFile(filePath)) {
                if (wasIndexed) {
                    const removed = await this.removeFileFromAllIndexes(filePath);
                    netChunkDelta -= removed;
                    netFileDelta -= 1;
                    appliedCount += 1;
                }
                continue;
            }

            try {
                const prevChunks = this.fileChunkMap[filePath] ?? 0;
                const newChunks = await this.upsertFileInAllIndexes(filePath);
                netChunkDelta += newChunks - prevChunks;
                if (!wasIndexed && newChunks > 0) {
                    netFileDelta += 1;
                } else if (wasIndexed && newChunks === 0) {
                    netFileDelta -= 1;
                }
                appliedCount += 1;
            } catch (err) {
                console.warn(`[RAG] Incremental upsert failed for ${filePath}:`, err);
            }
        }

        if (appliedCount === 0) {
            this.currentPhase = 'idle';
            this.filesDone = 0;
            this.filesTotal = 0;
            this.currentFile = null;
            return;
        }

        manifest = {
            ...manifest,
            fileCount: Math.max(0, manifest.fileCount + netFileDelta),
            chunkCount: Math.max(0, manifest.chunkCount + netChunkDelta),
            builtAt: new Date().toISOString(),
        };

        await this.refreshGitCommitIndex();
        manifest = this.readManifest(this.localStorePath) ?? manifest;

        this.writeManifest(this.localStorePath, manifest);
        this.writeFileChunkMap(this.localStorePath);
        this.writeSidecarMaps(this.localStorePath);
        console.log(`[RAG] Incremental update: ${appliedCount} file(s), Δchunks=${netChunkDelta}, Δfiles=${netFileDelta}`);

        this.lastIncrementalSync = {
            fileCount: appliedCount,
            deltaChunks: netChunkDelta,
            timestamp: new Date().toISOString(),
        };
        this._onIncrementalSync.fire(this.lastIncrementalSync);
        this.fireComplete({
            fileCount: manifest.fileCount,
            chunkCount: manifest.chunkCount,
            builtAt: manifest.builtAt,
            indexType: 'local',
        });
    }

    public async getActiveIndexType(): Promise<'local' | 'milvus' | null> {
        return this.activeIndexType;
    }

    private formatNodeContext(node: BaseNode, displayContent: string): string {
        const metadata = node.metadata as Record<string, unknown>;
        const filePath = String(metadata.filePath ?? 'unknown');
        const docType = String(metadata.docType ?? 'code_chunk');
        const symbolType = metadata.symbolType ? String(metadata.symbolType) : undefined;
        const symbolName = metadata.symbolName ? String(metadata.symbolName) : undefined;
        const headers = metadata.headers ? String(metadata.headers) : undefined;
        const startLine = metadata.startLine;
        const endLine = metadata.endLine;
        const locationParts: string[] = [];
        if (symbolType && symbolName) {
            locationParts.push(`${symbolType}: ${symbolName}`);
        } else if (symbolType) {
            locationParts.push(`Kind: ${symbolType}`);
        }
        if (headers) {
            locationParts.push(`Section: ${headers}`);
        }
        if (docType === 'git_commit') {
            const hash = metadata.commitHash ? String(metadata.commitHash).slice(0, 12) : undefined;
            const author = metadata.author ? String(metadata.author) : undefined;
            const date = metadata.date ? String(metadata.date) : undefined;
            if (hash) {
                locationParts.push(`Commit: ${hash}`);
            }
            if (author) {
                locationParts.push(`Author: ${author}`);
            }
            if (date) {
                locationParts.push(`Date: ${date}`);
            }
        }
        const linkedFiles = metadata.linkedFiles;
        if (Array.isArray(linkedFiles) && linkedFiles.length > 0) {
            locationParts.push(`Links: ${linkedFiles.slice(0, 5).join(', ')}`);
        }
        if (typeof startLine === 'number' && typeof endLine === 'number') {
            locationParts.push(`Lines: ${startLine}-${endLine}`);
        }
        const partIndex = metadata.partIndex;
        const partTotal = metadata.partTotal;
        if (typeof partIndex === 'number' && typeof partTotal === 'number' && partTotal > 1) {
            locationParts.push(`Part: ${partIndex}/${partTotal}`);
        }
        if (docType === 'doc_chunk' && metadata.parentKey) {
            locationParts.push('Parent context');
        }
        const locationSuffix = locationParts.length > 0 ? ` (${locationParts.join(', ')})` : '';
        return `--- FILE: ${filePath} (Type: ${docType})${locationSuffix} ---\n${displayContent}`;
    }

    private async resolveDisplayContent(node: BaseNode): Promise<string> {
        const metadata = node.metadata as Record<string, unknown>;
        const docType = String(metadata.docType ?? 'code_chunk');
        let text: string;
        if (docType === 'doc_chunk') {
            text = resolveDocDisplayText(node, this.docParentMap);
        } else {
            text = await expandCodeChunkText(
                node,
                this.codeSymbolMap,
                (filePath, startLine, endLine) => this.readFileLineRange(filePath, startLine, endLine),
            );
        }
        if (this.queryCompactMode && docType === 'code_chunk') {
            return compactCodeContent(text);
        }
        return text;
    }

    public getRelatedDependencies(filePath: string, maxResults = 8): RagRelatedDependency[] {
        const normalized = path.normalize(filePath);
        if (Object.keys(this.codeGraph.nodes).length === 0) {
            return [];
        }
        return getRelatedFilesFromGraph(this.codeGraph, normalized, maxResults).map(dep => ({
            filePath: dep.filePath,
            kind: dep.kind,
            reason: dep.reason,
        }));
    }
}
