/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { RagMilvusConfig, RagMilvusConnectionResult } from '../../common/mcodeRagTypes.js';
import type { MilvusRagRecord } from './milvusRecordMapper.js';
import type { MilvusDocType } from './milvusConstants.js';
import { MILVUS_PARTITIONS } from './milvusConstants.js';
import { encodeSparseVector } from './milvusSparseEncoder.js';
import { loadMilvusSdk, type MilvusSdkModule } from './milvusSdkLoader.js';

const INSERT_BATCH_SIZE = 64;
const COLLECTION_PREFIX = 'mcode_hybrid_';

export function sanitizeCollectionSuffix(workspaceHash: string): string {
	return workspaceHash.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function getMilvusCollectionName(workspaceHash: string): string {
	return `${COLLECTION_PREFIX}${sanitizeCollectionSuffix(workspaceHash)}`;
}

export async function createMilvusClient(config: RagMilvusConfig): Promise<MilvusClient> {
	const { MilvusClient: Client } = await loadMilvusSdk();
	return new Client({
		address: config.address,
		username: config.username || undefined,
		password: config.password || undefined,
	});
}

export async function testMilvusConnection(config: RagMilvusConfig): Promise<RagMilvusConnectionResult> {
	if (!config.address?.trim()) {
		return { ok: false, message: 'Milvus address is required.' };
	}
	let client: MilvusClient | undefined;
	try {
		client = await createMilvusClient(config);
		const health = await client.checkHealth();
		if (health.isHealthy) {
			return { ok: true, message: `Connected to Milvus at ${config.address}` };
		}
		return { ok: false, message: health.reasons?.join('; ') || 'Milvus is not healthy.' };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `Milvus connection failed: ${message}` };
	} finally {
		try {
			await client?.closeConnection();
		} catch {
			// ignore
		}
	}
}

export class MilvusRagStore {
	private sdk!: MilvusSdkModule;
	private client!: MilvusClient;
	private readonly collectionName: string;
	private ready = false;
	private readonly initPromise: Promise<void>;

	constructor(
		config: RagMilvusConfig,
		workspaceHash: string,
	) {
		this.collectionName = getMilvusCollectionName(workspaceHash);
		this.initPromise = this.initClient(config);
	}

	private async initClient(config: RagMilvusConfig): Promise<void> {
		this.sdk = await loadMilvusSdk();
		this.client = new this.sdk.MilvusClient({
			address: config.address,
			username: config.username || undefined,
			password: config.password || undefined,
		});
	}

	private async ensureInitialized(): Promise<void> {
		await this.initPromise;
	}

	getCollectionName(): string {
		return this.collectionName;
	}

	async ensureCollection(dimensions: number, recreate = false): Promise<void> {
		await this.ensureInitialized();
		const { DataType, IndexType, MetricType } = this.sdk;

		const exists = await this.client.hasCollection({ collection_name: this.collectionName });
		if (exists.value && recreate) {
			await this.client.dropCollection({ collection_name: this.collectionName });
		}
		const existsAfterDrop = await this.client.hasCollection({ collection_name: this.collectionName });
		if (!existsAfterDrop.value) {
			await this.client.createCollection({
				collection_name: this.collectionName,
				fields: [
					{ name: 'chunk_id', data_type: DataType.VarChar, is_primary_key: true, max_length: 1024 },
					{ name: 'dense_vector', data_type: DataType.FloatVector, dim: dimensions },
					{ name: 'sparse_vector', data_type: DataType.SparseFloatVector },
					{ name: 'doc_type', data_type: DataType.VarChar, max_length: 32 },
					{ name: 'text_content', data_type: DataType.VarChar, max_length: 65535 },
					{ name: 'file_path', data_type: DataType.VarChar, max_length: 2048 },
					{ name: 'metadata', data_type: DataType.JSON },
				],
			});

			await this.client.createIndex({
				collection_name: this.collectionName,
				field_name: 'dense_vector',
				index_name: 'dense_hnsw',
				index_type: IndexType.HNSW,
				metric_type: MetricType.COSINE,
				params: { M: 16, efConstruction: 200 },
			});
			await this.client.createIndex({
				collection_name: this.collectionName,
				field_name: 'sparse_vector',
				index_name: 'sparse_inverted',
				index_type: IndexType.SPARSE_INVERTED_INDEX,
				metric_type: MetricType.IP,
			});
			await this.client.createIndex({
				collection_name: this.collectionName,
				field_name: 'doc_type',
				index_name: 'doc_type_inverted',
				index_type: IndexType.INVERTED,
			});

			for (const partition of Object.values(MILVUS_PARTITIONS)) {
				await this.client.createPartition({
					collection_name: this.collectionName,
					partition_name: partition,
				});
			}
		}

		await this.client.loadCollectionSync({ collection_name: this.collectionName });
		this.ready = true;
	}

	async insertRecords(records: MilvusRagRecord[]): Promise<void> {
		await this.ensureInitialized();
		if (!this.ready) {
			throw new Error('[RAG] Milvus collection is not loaded.');
		}
		for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
			const batch = records.slice(i, i + INSERT_BATCH_SIZE);
			const byPartition = new Map<string, MilvusRagRecord[]>();
			for (const record of batch) {
				const partition = MILVUS_PARTITIONS[record.doc_type];
				const list = byPartition.get(partition) ?? [];
				list.push(record);
				byPartition.set(partition, list);
			}
			for (const [partition_name, rows] of byPartition) {
				await this.client.insert({
					collection_name: this.collectionName,
					partition_name,
					data: rows as never,
				});
			}
		}
		await this.client.flushSync({ collection_names: [this.collectionName] });
	}

	async deleteByChunkIds(chunkIds: string[]): Promise<void> {
		await this.ensureInitialized();
		if (chunkIds.length === 0 || !this.ready) {
			return;
		}
		const quoted = chunkIds.map(id => `"${id.replace(/"/g, '\\"')}"`).join(', ');
		await this.client.delete({
			collection_name: this.collectionName,
			filter: `chunk_id in [${quoted}]`,
		});
	}

	async hybridSearch(
		queryText: string,
		denseVector: number[],
		limit: number,
		partitionNames?: string[],
	): Promise<Array<Record<string, unknown>>> {
		await this.ensureInitialized();
		if (!this.ready) {
			throw new Error('[RAG] Milvus collection is not loaded.');
		}
		const { RRFRanker } = this.sdk;
		const sparseVector = encodeSparseVector(queryText);
		const searchPartitions = partitionNames ?? Object.values(MILVUS_PARTITIONS);
		const topK = Math.max(limit, 12);

		const results = await this.client.search({
			collection_name: this.collectionName,
			partition_names: searchPartitions,
			data: [
				{
					anns_field: 'dense_vector',
					data: denseVector,
					params: { ef: 64 },
					limit: topK,
				},
				{
					anns_field: 'sparse_vector',
					data: sparseVector,
					params: { drop_ratio_search: 0.2 },
					limit: topK,
				},
			],
			rerank: RRFRanker(60),
			limit,
			output_fields: ['chunk_id', 'doc_type', 'text_content', 'file_path', 'metadata'],
		});

		const rows: Array<Record<string, unknown>> = [];
		const resultRows = results.results ?? [];
		for (const row of resultRows) {
			if (row && typeof row === 'object') {
				rows.push(row as Record<string, unknown>);
			}
		}
		return rows;
	}

	async close(): Promise<void> {
		await this.ensureInitialized();
		try {
			await this.client.closeConnection();
		} catch {
			// ignore
		}
		this.ready = false;
	}
}

export function partitionForDocType(docType: MilvusDocType): string {
	return MILVUS_PARTITIONS[docType];
}
