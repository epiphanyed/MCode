/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

export const LOCAL_HNSW_FILENAME = 'rag_vectors.usearch';

const HNSW_CONNECTIVITY = 16;
const HNSW_EXPANSION_ADD = 128;
const HNSW_EXPANSION_SEARCH = 64;

export interface HnswSearchHit {
	keys: bigint[];
	distances: Float32Array;
}

type UsearchModule = typeof import('usearch');
type UsearchIndex = InstanceType<UsearchModule['Index']>;

let cachedUsearchModule: UsearchModule | null | undefined;

function resolveUsearchPackageJson(): string | null {
	const candidates = [
		path.join(process.cwd(), 'node_modules', 'usearch', 'package.json'),
	];
	if (typeof import.meta.url === 'string') {
		const here = path.dirname(fileURLToPath(import.meta.url));
		candidates.push(path.join(here, '../../../../../../../node_modules/usearch/package.json'));
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

function loadUsearchModule(): UsearchModule | null {
	if (cachedUsearchModule !== undefined) {
		return cachedUsearchModule;
	}
	try {
		const pkgPath = resolveUsearchPackageJson();
		if (!pkgPath) {
			cachedUsearchModule = null;
			return null;
		}
		const req = createRequire(pkgPath);
		cachedUsearchModule = req('usearch') as UsearchModule;
		return cachedUsearchModule;
	} catch {
		cachedUsearchModule = null;
		return null;
	}
}

export class LocalHnswIndex {
	private index: UsearchIndex | null = null;
	private readonly usearch: UsearchModule;

	private constructor(usearch: UsearchModule, private readonly dimensions: number) {
		this.usearch = usearch;
	}

	static async tryCreate(dimensions: number): Promise<LocalHnswIndex | null> {
		const usearch = loadUsearchModule();
		if (!usearch) {
			return null;
		}
		return new LocalHnswIndex(usearch, dimensions);
	}

	private createEmptyIndex(): UsearchIndex {
		return new this.usearch.Index({
			dimensions: this.dimensions,
			metric: this.usearch.MetricKind.Cos,
			quantization: this.usearch.ScalarKind.F32,
			connectivity: HNSW_CONNECTIVITY,
			expansion_add: HNSW_EXPANSION_ADD,
			expansion_search: HNSW_EXPANSION_SEARCH,
			multi: false,
		});
	}

	private ensureIndex(): UsearchIndex {
		if (!this.index) {
			this.index = this.createEmptyIndex();
		}
		return this.index;
	}

	size(): number {
		return this.index ? this.index.size() : 0;
	}

	clear(): void {
		this.index = this.createEmptyIndex();
	}

	add(key: bigint, vector: Float32Array): void {
		if (vector.length !== this.dimensions) {
			throw new Error(
				`[RAG] HNSW vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
			);
		}
		try {
			this.ensureIndex().add(key, vector);
		} catch (err) {
			throw new Error(`[RAG] HNSW add failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	remove(key: bigint): void {
		if (!this.index || this.index.size() === 0) {
			return;
		}
		try {
			this.index.remove(key);
		} catch {
			// Key may already be absent after partial rebuild.
		}
	}

	search(query: Float32Array, topK: number): HnswSearchHit {
		const index = this.ensureIndex();
		const k = Math.min(Math.max(1, topK), index.size());
		if (k === 0) {
			return { keys: [], distances: new Float32Array(0) };
		}
		try {
			const matches = index.search(query, k, 0);
			const keys: bigint[] = [];
			for (let i = 0; i < matches.keys.length; i++) {
				keys.push(matches.keys[i] as bigint);
			}
			return { keys, distances: matches.distances };
		} catch (err) {
			throw new Error(`[RAG] HNSW search failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async loadFromFile(filePath: string): Promise<boolean> {
		if (!fs.existsSync(filePath)) {
			return false;
		}
		try {
			const index = this.createEmptyIndex();
			await index.load(filePath);
			this.index = index;
			return true;
		} catch (err) {
			throw new Error(`[RAG] HNSW load failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async saveToFile(filePath: string): Promise<void> {
		if (!this.index || this.index.size() === 0) {
			if (fs.existsSync(filePath)) {
				await fs.promises.unlink(filePath);
			}
			return;
		}
		try {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			await this.index.save(filePath);
		} catch (err) {
			throw new Error(`[RAG] HNSW save failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** Cosine distance from USearch → dot-product similarity score. */
export function hnswDistanceToSimilarity(distance: number): number {
	return 1 - distance;
}
