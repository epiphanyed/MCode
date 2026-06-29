/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import type { Database } from '@vscode/sqlite3';
import type { LocalVectorRecord } from './localVectorRecordMapper.js';
import { getLocalHnswPathForDb } from './localStorePaths.js';
import { chunkIdToHnswKey, hnswKeyToSqlValue, sqlValueToHnswKey } from './localHnswKeys.js';
import { hnswDistanceToSimilarity, LocalHnswIndex } from './localHnswIndex.js';
import {
	TopKScoreHeap,
	dotProduct,
	embeddingBufferToFloat32,
	float32ToBuffer,
	normalizeToFloat32,
} from './localVectorSearch.js';
import { ragLogBody, ragLogStage } from '../../common/helpers/ragDebugLog.js';

export const LOCAL_VECTOR_DB_FILENAME = 'rag_vectors.db';
export const LOCAL_VECTOR_STORAGE_ENGINE = 'sqlite-hnsw-v1';

const SCHEMA_VERSION = 2;
const SEARCH_BATCH_SIZE = 512;
const INSERT_CHUNK_SIZE = 128;
const HNSW_REBUILD_BATCH_SIZE = 256;
/** When post-filtering by doc_type, scale searchK by inverse doc-type ratio. */
const HNSW_DOC_FILTER_OVERSAMPLE = 32;
const HNSW_DOC_FILTER_RATIO_MARGIN = 1.5;

interface RagChunkRow {
	chunk_id: string;
	file_path: string;
	doc_type: string;
	text_content: string;
	metadata_json: string;
	embedding: Buffer;
	dim: number;
	hnsw_key: string | null;
}

export interface LocalSimilarityHit {
	record: LocalVectorRecord;
	score: number;
}

export interface LocalSimilaritySearchOptions {
	topK: number;
	docTypes?: string[];
	onBatchScanned?: () => void | Promise<void>;
}

export interface LocalVectorStoreOpenOptions {
	onHnswBatch?: () => void | Promise<void>;
	/** Skip loading/rebuilding HNSW on open; vectors are added incrementally during index build. */
	deferHnswLoad?: boolean;
}

function run(db: Database, sql: string, params: unknown[] = []): Promise<void> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, err => (err ? reject(err) : resolve()));
	});
}

function get<T>(db: Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
	});
}

function all<T>(db: Database, sql: string, params: unknown[] = []): Promise<T[]> {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
	});
}

function rowToRecord(row: RagChunkRow): LocalVectorRecord {
	let metadata: Record<string, unknown> = {};
	try {
		metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
	} catch {
		metadata = {};
	}
	const embedding = embeddingBufferToFloat32(row.embedding, row.dim);
	return {
		chunkId: row.chunk_id,
		filePath: row.file_path,
		docType: row.doc_type,
		textContent: row.text_content,
		metadata,
		embedding: [...embedding],
	};
}

export class LocalSqliteVectorStore {
	private hnsw: LocalHnswIndex | null = null;
	private hnswDisabled = false;
	private readonly hnswPath: string;

	private constructor(
		private readonly db: Database,
		private readonly dimensions: number,
		dbPath: string,
	) {
		this.hnswPath = getLocalHnswPathForDb(dbPath);
	}

	static async open(
		dbPath: string,
		dimensions: number,
		options?: LocalVectorStoreOpenOptions,
	): Promise<LocalSqliteVectorStore> {
		await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
		const { default: sqlite3 } = await import('@vscode/sqlite3');
		const db = await new Promise<Database>((resolve, reject) => {
			const instance = new sqlite3.Database(dbPath, err => (err ? reject(err) : resolve(instance)));
		});
		await run(db, 'PRAGMA journal_mode = WAL');
		await run(db, 'PRAGMA synchronous = NORMAL');
		await run(db, 'PRAGMA temp_store = MEMORY');
		const store = new LocalSqliteVectorStore(db, dimensions, dbPath);
		await store.ensureSchema();
		if (!options?.deferHnswLoad) {
			await store.ensureHnswReady(options?.onHnswBatch);
		}
		return store;
	}

	isHnswEnabled(): boolean {
		return !this.hnswDisabled && this.hnsw !== null;
	}

	getDimensions(): number {
		return this.dimensions;
	}

	private disableHnsw(reason: unknown): void {
		if (this.hnswDisabled) {
			return;
		}
		this.hnswDisabled = true;
		this.hnsw = null;
		console.warn('[RAG] HNSW index disabled; using brute-force vector scan:', reason);
	}

	private async ensureHnswForWrite(): Promise<void> {
		if (this.hnswDisabled) {
			return;
		}
		if (!this.hnsw) {
			this.hnsw = await LocalHnswIndex.tryCreate(this.dimensions);
			if (!this.hnsw) {
				this.hnswDisabled = true;
			}
		}
	}

	private safeHnswAdd(key: bigint, vector: Float32Array): void {
		if (this.hnswDisabled || !this.hnsw) {
			return;
		}
		try {
			this.hnsw.remove(key);
			this.hnsw.add(key, vector);
		} catch (err) {
			this.disableHnsw(err);
		}
	}

	private safeHnswRemove(key: bigint): void {
		if (this.hnswDisabled || !this.hnsw) {
			return;
		}
		try {
			this.hnsw.remove(key);
		} catch (err) {
			this.disableHnsw(err);
		}
	}

	/** Ensure HNSW matches SQLite after incremental index build. */
	async finalizeHnswIndex(onBatch?: () => void | Promise<void>): Promise<void> {
		if (this.hnswDisabled) {
			return;
		}
		const chunkCount = await this.getChunkCount();
		if (chunkCount === 0) {
			return;
		}
		if (this.hnsw && this.hnsw.size() === chunkCount) {
			await this.persistHnsw();
			return;
		}
		await this.rebuildHnswFromSqlite(onBatch);
	}

	async close(): Promise<void> {
		await this.persistHnsw();
		try {
			await run(this.db, 'PRAGMA wal_checkpoint(TRUNCATE)');
		} catch {
			// best-effort before closing handles (helps release .db-wal/.db-shm on Windows)
		}
		await new Promise<void>((resolve, reject) => {
			this.db.close(err => (err ? reject(err) : resolve()));
		});
	}

	async getChunkCount(): Promise<number> {
		const row = await get<{ count: number }>(this.db, 'SELECT COUNT(*) AS count FROM rag_chunks');
		return row?.count ?? 0;
	}

	async getDocTypeCounts(): Promise<Record<string, number>> {
		const rows = await all<{ doc_type: string; count: number }>(
			this.db,
			'SELECT doc_type, COUNT(*) AS count FROM rag_chunks GROUP BY doc_type',
		);
		const counts: Record<string, number> = {};
		for (const row of rows) {
			counts[row.doc_type] = row.count;
		}
		return counts;
	}

	getHnswVectorCount(): number {
		if (this.hnswDisabled || !this.hnsw) {
			return 0;
		}
		return this.hnsw.size();
	}

	async insertRecords(records: LocalVectorRecord[]): Promise<void> {
		if (records.length === 0) {
			return;
		}
		await this.ensureHnswForWrite();
		await run(this.db, 'BEGIN IMMEDIATE');
		try {
			for (let i = 0; i < records.length; i += INSERT_CHUNK_SIZE) {
				const batch = records.slice(i, i + INSERT_CHUNK_SIZE);
				for (const record of batch) {
					if (record.embedding.length !== this.dimensions) {
						throw new Error(
							`[RAG] Embedding dimension mismatch: expected ${this.dimensions}, got ${record.embedding.length}`,
						);
					}
					const normalized = normalizeToFloat32(record.embedding);
					const hnswKey = chunkIdToHnswKey(record.chunkId);
					await run(
						this.db,
						`INSERT OR REPLACE INTO rag_chunks
							(chunk_id, file_path, doc_type, text_content, metadata_json, embedding, dim, hnsw_key)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							record.chunkId,
							record.filePath,
							record.docType,
							record.textContent,
							JSON.stringify(record.metadata),
							float32ToBuffer(normalized),
							this.dimensions,
							hnswKeyToSqlValue(hnswKey),
						],
					);
					this.safeHnswAdd(hnswKey, normalized);
				}
			}
			await run(this.db, 'COMMIT');
		} catch (err) {
			await run(this.db, 'ROLLBACK');
			throw err;
		}
	}

	async deleteByChunkIds(chunkIds: string[]): Promise<void> {
		if (chunkIds.length === 0) {
			return;
		}
		for (const chunkId of chunkIds) {
			this.safeHnswRemove(chunkIdToHnswKey(chunkId));
		}
		await run(this.db, 'BEGIN IMMEDIATE');
		try {
			for (let i = 0; i < chunkIds.length; i += INSERT_CHUNK_SIZE) {
				const batch = chunkIds.slice(i, i + INSERT_CHUNK_SIZE);
				const placeholders = batch.map(() => '?').join(', ');
				await run(this.db, `DELETE FROM rag_chunks WHERE chunk_id IN (${placeholders})`, batch);
			}
			await run(this.db, 'COMMIT');
		} catch (err) {
			await run(this.db, 'ROLLBACK');
			throw err;
		}
	}

	async deleteByFilePath(filePath: string): Promise<number> {
		const rows = await all<{ chunk_id: string }>(
			this.db,
			'SELECT chunk_id FROM rag_chunks WHERE file_path = ?',
			[filePath],
		);
		if (rows.length === 0) {
			return 0;
		}
		await this.deleteByChunkIds(rows.map(row => row.chunk_id));
		return rows.length;
	}

	async walCheckpoint(): Promise<void> {
		await run(this.db, 'PRAGMA wal_checkpoint(PASSIVE)');
		await this.persistHnsw();
	}

	async similaritySearch(
		queryVector: number[],
		options: LocalSimilaritySearchOptions,
	): Promise<LocalSimilarityHit[]> {
		const query = normalizeToFloat32(queryVector);
		if (query.length !== this.dimensions) {
			throw new Error(
				`[RAG] Query embedding dimension mismatch: expected ${this.dimensions}, got ${query.length}`,
			);
		}

		const chunkCount = await this.getChunkCount();
		if (this.hnsw && this.hnsw.size() > 0) {
			let hits = await this.similaritySearchHnsw(query, options);
			const hasDocFilter = Boolean(options.docTypes && options.docTypes.filter(Boolean).length > 0);
			if (hits.length < options.topK && hasDocFilter && chunkCount > hits.length) {
				const hnswSize = this.hnsw.size();
				ragLogStage(
					'search',
					`HNSW docType filter ${hits.length}/${options.topK}; retrying searchK=${hnswSize}`,
				);
				hits = await this.similaritySearchHnsw(query, options, hnswSize);
			}
			if (hits.length < options.topK && hasDocFilter && chunkCount > hits.length) {
				ragLogStage(
					'search',
					`HNSW still ${hits.length}/${options.topK} filter=${JSON.stringify(options.docTypes)}; brute force on filtered rows`,
				);
				const bruteHits = await this.similaritySearchBruteForce(query, options);
				this.logSearchResult('brute-force-fallback', bruteHits, options, chunkCount);
				return bruteHits;
			}
			this.logSearchResult('hnsw', hits, options, chunkCount);
			return hits;
		}
		const bruteHits = await this.similaritySearchBruteForce(query, options);
		this.logSearchResult('brute-force', bruteHits, options, chunkCount);
		return bruteHits;
	}

	private logSearchResult(
		mode: string,
		hits: LocalSimilarityHit[],
		options: LocalSimilaritySearchOptions,
		chunkCount: number,
	): void {
		const topScores = hits.map(h => h.score.toFixed(3));
		const samplePaths = [...new Set(hits.map(h => h.record.filePath))];
		ragLogStage(
			'search',
			`${mode} topK=${options.topK} docTypes=${JSON.stringify(options.docTypes ?? null)} `
			+ `dbChunks=${chunkCount} hits=${hits.length} topScores=[${topScores.join(',')}] paths=${JSON.stringify(samplePaths)}`,
		);
		const hitText = hits.map((h, i) =>
			`#${i} score=${h.score.toFixed(3)} type=${h.record.docType} ${h.record.filePath}\n${h.record.textContent}`,
		).join('\n---\n');
		ragLogBody('search', `${mode} hits`, hitText);
	}

	private async computeHnswSearchKForDocFilter(
		topK: number,
		docTypes: string[],
		hnswSize: number,
		chunkCount: number,
	): Promise<number> {
		const placeholders = docTypes.map(() => '?').join(', ');
		const row = await get<{ count: number }>(
			this.db,
			`SELECT COUNT(*) AS count FROM rag_chunks WHERE doc_type IN (${placeholders})`,
			docTypes,
		);
		const filteredCount = Math.max(row?.count ?? 0, 1);
		const ratio = chunkCount / filteredCount;
		const ratioBased = Math.ceil(topK * ratio * HNSW_DOC_FILTER_RATIO_MARGIN);
		const fixedMin = Math.max(topK * HNSW_DOC_FILTER_OVERSAMPLE, topK + 64);
		return Math.min(Math.max(ratioBased, fixedMin), hnswSize);
	}

	private async similaritySearchHnsw(
		query: Float32Array,
		options: LocalSimilaritySearchOptions,
		searchKOverride?: number,
	): Promise<LocalSimilarityHit[]> {
		const docTypes = options.docTypes?.filter(Boolean);
		const hasDocFilter = Boolean(docTypes && docTypes.length > 0);
		const hnswSize = this.hnsw!.size();
		let searchK: number;
		if (searchKOverride !== undefined) {
			searchK = Math.min(searchKOverride, hnswSize);
		} else if (hasDocFilter) {
			const chunkCount = await this.getChunkCount();
			searchK = await this.computeHnswSearchKForDocFilter(
				options.topK,
				docTypes!,
				hnswSize,
				chunkCount,
			);
		} else {
			searchK = Math.min(options.topK, hnswSize);
		}
		const hits = this.hnsw!.search(query, searchK);
		if (hits.keys.length === 0) {
			ragLogStage('search', `hnsw searchK=${searchK} raw=0 (empty index)`);
			return [];
		}

		const recordsByKey = await this.fetchRecordsByHnswKeys(hits.keys);
		const results: LocalSimilarityHit[] = [];
		for (let i = 0; i < hits.keys.length; i++) {
			const key = hits.keys[i];
			const record = recordsByKey.get(hnswKeyToSqlValue(key));
			if (!record) {
				continue;
			}
			if (hasDocFilter && !docTypes!.includes(record.docType)) {
				continue;
			}
			results.push({
				record,
				score: hnswDistanceToSimilarity(hits.distances[i]),
			});
			if (results.length >= options.topK) {
				break;
			}
		}
		ragLogStage(
			'search',
			`hnsw searchK=${searchK} raw=${hits.keys.length} afterDocFilter=${results.length} docTypes=${JSON.stringify(docTypes ?? null)}`,
		);
		return results;
	}

	private async similaritySearchBruteForce(
		query: Float32Array,
		options: LocalSimilaritySearchOptions,
	): Promise<LocalSimilarityHit[]> {
		const heap = new TopKScoreHeap<string>(options.topK);
		let offset = 0;
		const docTypes = options.docTypes?.filter(Boolean);
		const hasDocFilter = Boolean(docTypes && docTypes.length > 0);
		const docTypeClause = hasDocFilter
			? `WHERE doc_type IN (${docTypes!.map(() => '?').join(', ')})`
			: '';
		const docTypeParams = hasDocFilter ? docTypes! : [];

		while (true) {
			const rows = await all<{ chunk_id: string; embedding: Buffer; dim: number }>(
				this.db,
				`SELECT chunk_id, embedding, dim
				 FROM rag_chunks
				 ${docTypeClause}
				 ORDER BY chunk_id
				 LIMIT ? OFFSET ?`,
				[...docTypeParams, SEARCH_BATCH_SIZE, offset],
			);
			if (rows.length === 0) {
				break;
			}

			for (const row of rows) {
				const embedding = embeddingBufferToFloat32(row.embedding, row.dim);
				const score = dotProduct(query, embedding);
				heap.push(row.chunk_id, score);
			}

			offset += rows.length;
			if (options.onBatchScanned) {
				await options.onBatchScanned();
			}
			if (rows.length < SEARCH_BATCH_SIZE) {
				break;
			}
		}

		const topEntries = heap.toSortedDesc();
		if (topEntries.length === 0) {
			return [];
		}

		const topChunkIds = topEntries.map(e => e.item);
		const placeholders = topChunkIds.map(() => '?').join(', ');
		const fullRows = await all<RagChunkRow>(
			this.db,
			`SELECT chunk_id, file_path, doc_type, text_content, metadata_json, embedding, dim, hnsw_key
			 FROM rag_chunks
			 WHERE chunk_id IN (${placeholders})`,
			topChunkIds,
		);

		const rowsMap = new Map<string, RagChunkRow>();
		for (const r of fullRows) {
			rowsMap.set(r.chunk_id, r);
		}

		const results: LocalSimilarityHit[] = [];
		for (const entry of topEntries) {
			const row = rowsMap.get(entry.item);
			if (row) {
				results.push({
					record: rowToRecord(row),
					score: entry.score,
				});
			}
		}
		return results;
	}

	private async fetchRecordsByHnswKeys(keys: bigint[]): Promise<Map<string, LocalVectorRecord>> {
		const out = new Map<string, LocalVectorRecord>();
		if (keys.length === 0) {
			return out;
		}
		for (let i = 0; i < keys.length; i += INSERT_CHUNK_SIZE) {
			const batch = keys.slice(i, i + INSERT_CHUNK_SIZE);
			const placeholders = batch.map(() => '?').join(', ');
			const keyStrings = batch.map(hnswKeyToSqlValue);
			const rows = await all<RagChunkRow>(
				this.db,
				`SELECT chunk_id, file_path, doc_type, text_content, metadata_json, embedding, dim, hnsw_key
				 FROM rag_chunks
				 WHERE hnsw_key IN (${placeholders})`,
				keyStrings,
			);
			for (const row of rows) {
				if (row.hnsw_key) {
					out.set(row.hnsw_key, rowToRecord(row));
				}
			}
		}
		return out;
	}

	private async ensureHnswReady(onBatch?: () => void | Promise<void>): Promise<void> {
		if (this.hnswDisabled) {
			return;
		}
		this.hnsw = await LocalHnswIndex.tryCreate(this.dimensions);
		if (!this.hnsw) {
			this.hnswDisabled = true;
			console.warn('[RAG] HNSW unavailable; using SQLite brute-force vector scan.');
			return;
		}

		const chunkCount = await this.getChunkCount();
		if (chunkCount === 0) {
			return;
		}

		let loaded = false;
		try {
			loaded = await this.hnsw.loadFromFile(this.hnswPath);
		} catch (err) {
			console.warn('[RAG] Failed to load HNSW index; rebuilding from SQLite:', err);
			this.hnsw.clear();
		}

		if (loaded && this.hnsw.size() === chunkCount) {
			console.log(`[RAG] Loaded HNSW index (${this.hnsw.size()} vectors)`);
			return;
		}

		if (loaded && this.hnsw.size() !== chunkCount) {
			console.warn(
				`[RAG] HNSW/SQLite count mismatch (${this.hnsw.size()} vs ${chunkCount}); rebuilding HNSW.`,
			);
		} else if (!loaded) {
			console.log(`[RAG] Building HNSW index from SQLite (${chunkCount} vectors)…`);
		}

		await this.rebuildHnswFromSqlite(onBatch);
	}

	private async rebuildHnswFromSqlite(onBatch?: () => void | Promise<void>): Promise<void> {
		if (!this.hnsw) {
			return;
		}
		this.hnsw.clear();
		let offset = 0;
		let indexed = 0;

		while (true) {
			const rows = await all<RagChunkRow>(
				this.db,
				`SELECT chunk_id, file_path, doc_type, text_content, metadata_json, embedding, dim, hnsw_key
				 FROM rag_chunks
				 ORDER BY chunk_id
				 LIMIT ? OFFSET ?`,
				[HNSW_REBUILD_BATCH_SIZE, offset],
			);
			if (rows.length === 0) {
				break;
			}

			await run(this.db, 'BEGIN IMMEDIATE');
			try {
				for (const row of rows) {
					const key = row.hnsw_key ? sqlValueToHnswKey(row.hnsw_key) : chunkIdToHnswKey(row.chunk_id);
					const embedding = embeddingBufferToFloat32(row.embedding, row.dim);
					this.safeHnswAdd(key, embedding);
					if (this.hnswDisabled) {
						break;
					}
					if (!row.hnsw_key) {
						await run(
							this.db,
							'UPDATE rag_chunks SET hnsw_key = ? WHERE chunk_id = ?',
							[hnswKeyToSqlValue(key), row.chunk_id],
						);
					}
					indexed++;
				}
				await run(this.db, 'COMMIT');
			} catch (err) {
				await run(this.db, 'ROLLBACK');
				throw err;
			}

			offset += rows.length;
			if (onBatch) {
				await onBatch();
			}
			if (this.hnswDisabled) {
				break;
			}
			if (rows.length < HNSW_REBUILD_BATCH_SIZE) {
				break;
			}
		}

		await this.persistHnsw();
		console.log(`[RAG] HNSW index ready (${indexed} vectors)`);
	}

	private async persistHnsw(): Promise<void> {
		if (!this.hnsw) {
			return;
		}
		try {
			await this.hnsw.saveToFile(this.hnswPath);
		} catch (err) {
			console.warn('[RAG] Failed to persist HNSW index:', err);
		}
	}

	private async ensureSchema(): Promise<void> {
		await run(
			this.db,
			`CREATE TABLE IF NOT EXISTS rag_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)`,
		);
		await run(
			this.db,
			`CREATE TABLE IF NOT EXISTS rag_chunks (
				chunk_id TEXT PRIMARY KEY,
				file_path TEXT NOT NULL,
				doc_type TEXT NOT NULL,
				text_content TEXT NOT NULL,
				metadata_json TEXT NOT NULL,
				embedding BLOB NOT NULL,
				dim INTEGER NOT NULL
			)`,
		);
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_rag_chunks_file_path ON rag_chunks(file_path)');
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc_type ON rag_chunks(doc_type)');

		const columns = await all<{ name: string }>(this.db, 'PRAGMA table_info(rag_chunks)');
		if (!columns.some(column => column.name === 'hnsw_key')) {
			await run(this.db, 'ALTER TABLE rag_chunks ADD COLUMN hnsw_key TEXT');
		}
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_rag_chunks_hnsw_key ON rag_chunks(hnsw_key)');

		const versionRow = await get<{ value: string }>(this.db, 'SELECT value FROM rag_meta WHERE key = ?', ['schema_version']);
		if (!versionRow) {
			await run(this.db, 'INSERT INTO rag_meta (key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
			await run(this.db, 'INSERT INTO rag_meta (key, value) VALUES (?, ?)', ['dimensions', String(this.dimensions)]);
		} else {
			await run(this.db, 'UPDATE rag_meta SET value = ? WHERE key = ?', [String(SCHEMA_VERSION), 'schema_version']);
		}
	}
}
