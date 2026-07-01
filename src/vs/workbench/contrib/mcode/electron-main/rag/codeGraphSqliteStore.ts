/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import type { Database } from '@vscode/sqlite3';
import {
	createEmptyCodeGraph,
	type CodeGraph,
	type CodeGraphEdgeKind,
	type CodeGraphNode,
} from './codeGraphBuilder.js';

export const CODE_GRAPH_DB = 'code_graph.db';

/** Use SQL-backed relation queries above this in-memory node count. */
export const CODE_GRAPH_SQL_QUERY_NODE_THRESHOLD = 8000;

const SCHEMA_VERSION = 1;

export interface CodeGraphRelationHit {
	from: {
		filePath: string;
		symbolName?: string;
		startLine?: number;
		endLine?: number;
		symbolType?: string;
	};
	to: {
		filePath: string;
		symbolName?: string;
		startLine?: number;
		endLine?: number;
		symbolType?: string;
	};
	kind: CodeGraphEdgeKind;
}

interface EntityRow {
	id: string;
	fs_path: string;
	name: string;
	type: string;
	start_line: number | null;
	end_line: number | null;
}

interface RelationRow {
	from_id: string;
	to_id: string;
	kind: string;
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

function nodeToEntityRow(node: CodeGraphNode): EntityRow {
	const isFile = node.id.endsWith('::file');
	return {
		id: node.id,
		fs_path: node.filePath,
		name: node.symbolName ?? path.basename(node.filePath),
		type: node.symbolType ?? (isFile ? 'file' : 'symbol'),
		start_line: node.startLine ?? null,
		end_line: node.endLine ?? null,
	};
}

function entityRowToNode(row: EntityRow): CodeGraphNode {
	return {
		id: row.id,
		filePath: row.fs_path,
		symbolName: row.type === 'file' ? undefined : row.name,
		symbolType: row.type === 'file' ? undefined : row.type,
		startLine: row.start_line ?? undefined,
		endLine: row.end_line ?? undefined,
	};
}

function applyEdge(graph: CodeGraph, from: string, to: string, kind: CodeGraphEdgeKind): void {
	if (from === to) {
		return;
	}
	graph.edges.push({ from, to, kind });
	const fromList = graph.adjacency[from] ?? [];
	if (!fromList.includes(to)) {
		fromList.push(to);
		graph.adjacency[from] = fromList;
	}
	const toList = graph.adjacency[to] ?? [];
	if (!toList.includes(from)) {
		toList.push(from);
		graph.adjacency[to] = toList;
	}
}

/**
 * Independent graph database (same index directory as rag_vectors.db, separate file).
 * Entities + relations per original Graphify design; not merged into vector store.
 */
export class CodeGraphSqliteStore {
	private constructor(private readonly db: Database) { }

	static async open(dbPath: string): Promise<CodeGraphSqliteStore> {
		await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
		const { default: sqlite3 } = await import('@vscode/sqlite3');
		const db = await new Promise<Database>((resolve, reject) => {
			const instance = new sqlite3.Database(dbPath, err => (err ? reject(err) : resolve(instance)));
		});
		await run(db, 'PRAGMA journal_mode = WAL');
		await run(db, 'PRAGMA synchronous = NORMAL');
		const store = new CodeGraphSqliteStore(db);
		await store.ensureSchema();
		return store;
	}

	private async ensureSchema(): Promise<void> {
		await run(this.db, `
			CREATE TABLE IF NOT EXISTS code_graph_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		await run(this.db, `
			CREATE TABLE IF NOT EXISTS code_entities (
				id TEXT PRIMARY KEY,
				fs_path TEXT NOT NULL,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				start_line INTEGER,
				end_line INTEGER
			)
		`);
		await run(this.db, `
			CREATE TABLE IF NOT EXISTS code_relations (
				from_id TEXT NOT NULL,
				to_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				PRIMARY KEY (from_id, to_id, kind),
				FOREIGN KEY(from_id) REFERENCES code_entities(id) ON DELETE CASCADE,
				FOREIGN KEY(to_id) REFERENCES code_entities(id) ON DELETE CASCADE
			)
		`);
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_entities_path ON code_entities(fs_path)');
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_entities_name ON code_entities(name)');
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_relations_from ON code_relations(from_id)');
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_relations_to ON code_relations(to_id)');
		await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_relations_kind ON code_relations(kind)');
		await run(
			this.db,
			'INSERT OR IGNORE INTO code_graph_meta (key, value) VALUES (?, ?)',
			['schema_version', String(SCHEMA_VERSION)],
		);
	}

	async getEntityCount(): Promise<number> {
		const row = await get<{ count: number }>(this.db, 'SELECT COUNT(*) AS count FROM code_entities');
		return row?.count ?? 0;
	}

	async loadGraph(): Promise<CodeGraph> {
		const graph = createEmptyCodeGraph();
		const entities = await all<EntityRow>(this.db, 'SELECT id, fs_path, name, type, start_line, end_line FROM code_entities');
		for (const row of entities) {
			graph.nodes[row.id] = entityRowToNode(row);
		}
		const relations = await all<RelationRow>(this.db, 'SELECT from_id, to_id, kind FROM code_relations');
		for (const row of relations) {
			if (!graph.nodes[row.from_id] || !graph.nodes[row.to_id]) {
				continue;
			}
			applyEdge(graph, row.from_id, row.to_id, row.kind as CodeGraphEdgeKind);
		}
		return graph;
	}

	/** Full replace from in-memory graph (after full index build). */
	async syncFromGraph(graph: CodeGraph): Promise<void> {
		await run(this.db, 'BEGIN IMMEDIATE');
		try {
			await run(this.db, 'DELETE FROM code_relations');
			await run(this.db, 'DELETE FROM code_entities');
			await this.insertGraphEntitiesAndRelations(graph, Object.keys(graph.nodes), graph.edges);
			await run(this.db, 'COMMIT');
		} catch (err) {
			await run(this.db, 'ROLLBACK');
			throw err;
		}
	}

	/** Incremental: replace one file's entities and any edges touching them. */
	async syncFileFromGraph(graph: CodeGraph, filePath: string): Promise<void> {
		const normalized = path.normalize(filePath);
		const fileNodeIds = new Set<string>();
		for (const [id, node] of Object.entries(graph.nodes)) {
			if (path.normalize(node.filePath) === normalized) {
				fileNodeIds.add(id);
			}
		}
		await this.purgeFile(normalized);
		if (fileNodeIds.size === 0) {
			return;
		}
		const edges = graph.edges.filter(
			e => (fileNodeIds.has(e.from) || fileNodeIds.has(e.to))
				&& graph.nodes[e.from]
				&& graph.nodes[e.to],
		);
		await run(this.db, 'BEGIN IMMEDIATE');
		try {
			await this.insertGraphEntitiesAndRelations(graph, [...fileNodeIds], edges);
			await run(this.db, 'COMMIT');
		} catch (err) {
			await run(this.db, 'ROLLBACK');
			throw err;
		}
	}

	private async insertGraphEntitiesAndRelations(
		graph: CodeGraph,
		entityIds: string[],
		edges: CodeGraph['edges'],
	): Promise<void> {
		for (const id of entityIds) {
			const node = graph.nodes[id];
			if (!node) {
				continue;
			}
			const row = nodeToEntityRow(node);
			await run(
				this.db,
				`INSERT INTO code_entities (id, fs_path, name, type, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)`,
				[row.id, row.fs_path, row.name, row.type, row.start_line, row.end_line],
			);
		}
		for (const edge of edges) {
			await run(
				this.db,
				'INSERT OR IGNORE INTO code_relations (from_id, to_id, kind) VALUES (?, ?, ?)',
				[edge.from, edge.to, edge.kind],
			);
		}
	}

	async purgeFile(filePath: string): Promise<void> {
		const normalized = path.normalize(filePath);
		const prefix = `${normalized}::`;
		const ids = await all<{ id: string }>(
			this.db,
			'SELECT id FROM code_entities WHERE fs_path = ? OR id LIKE ?',
			[normalized, `${prefix}%`],
		);
		if (ids.length === 0) {
			return;
		}
		await run(this.db, 'BEGIN IMMEDIATE');
		try {
			for (const { id } of ids) {
				await run(this.db, 'DELETE FROM code_relations WHERE from_id = ? OR to_id = ?', [id, id]);
				await run(this.db, 'DELETE FROM code_entities WHERE id = ?', [id]);
			}
			await run(this.db, 'COMMIT');
		} catch (err) {
			await run(this.db, 'ROLLBACK');
			throw err;
		}
	}

	async queryRelations(
		entityName?: string,
		filePath?: string,
		relationType?: string,
		limit = 500,
	): Promise<CodeGraphRelationHit[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];

		if (relationType) {
			clauses.push('r.kind = ?');
			params.push(relationType);
		}
		if (filePath) {
			const normalized = path.normalize(filePath);
			clauses.push('(ef.fs_path = ? OR et.fs_path = ?)');
			params.push(normalized, normalized);
		}
		if (entityName) {
			clauses.push('(ef.name LIKE ? OR et.name LIKE ?)');
			const pattern = `%${entityName}%`;
			params.push(pattern, pattern);
		}

		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const rows = await all<{
			from_path: string;
			from_name: string;
			from_type: string;
			from_start: number | null;
			from_end: number | null;
			to_path: string;
			to_name: string;
			to_type: string;
			to_start: number | null;
			to_end: number | null;
			kind: string;
		}>(
			this.db,
			`
			SELECT
				ef.fs_path AS from_path, ef.name AS from_name, ef.type AS from_type,
				ef.start_line AS from_start, ef.end_line AS from_end,
				et.fs_path AS to_path, et.name AS to_name, et.type AS to_type,
				et.start_line AS to_start, et.end_line AS to_end,
				r.kind AS kind
			FROM code_relations r
			JOIN code_entities ef ON ef.id = r.from_id
			JOIN code_entities et ON et.id = r.to_id
			${where}
			LIMIT ?
			`,
			[...params, limit],
		);

		return rows.map(row => ({
			from: {
				filePath: row.from_path,
				symbolName: row.from_type === 'file' ? undefined : row.from_name,
				startLine: row.from_start ?? undefined,
				endLine: row.from_end ?? undefined,
				symbolType: row.from_type === 'file' ? 'file' : row.from_type,
			},
			to: {
				filePath: row.to_path,
				symbolName: row.to_type === 'file' ? undefined : row.to_name,
				startLine: row.to_start ?? undefined,
				endLine: row.to_end ?? undefined,
				symbolType: row.to_type === 'file' ? 'file' : row.to_type,
			},
			kind: row.kind as CodeGraphEdgeKind,
		}));
	}

	async walCheckpoint(): Promise<void> {
		await run(this.db, 'PRAGMA wal_checkpoint(TRUNCATE)');
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.db.close(err => (err ? reject(err) : resolve()));
		});
	}
}
