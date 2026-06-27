/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/** Legacy SQLite filename (pre project-name layout). */
export const LEGACY_LOCAL_VECTOR_DB_FILENAME = 'rag_vectors.db';
export const LEGACY_LOCAL_HNSW_FILENAME = 'rag_vectors.usearch';

export interface LocalStoreLayout {
	storePath: string;
	dbFileName: string;
	isLegacy: boolean;
}

/** Sanitize workspace folder name for use as a store directory / db basename. */
export function sanitizeWorkspaceStoreName(workspaceRoot: string): string {
	const base = path.basename(path.normalize(workspaceRoot)) || 'workspace';
	const sanitized = base
		.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_')
		.replace(/^_+|_+$/g, '');
	return (sanitized.slice(0, 64) || 'workspace');
}

export function getLocalStoreBaseDir(): string {
	return path.join(process.env.APPDATA || process.env.HOME || '', 'MCode', 'LlamaStore');
}

export function getNamedLocalStorePath(workspaceRoot: string): string {
	return path.join(getLocalStoreBaseDir(), sanitizeWorkspaceStoreName(workspaceRoot));
}

export function getLegacyLocalStorePath(workspaceHash: string): string {
	return path.join(getLocalStoreBaseDir(), workspaceHash);
}

export function getLocalVectorDbFileName(workspaceRoot: string): string {
	return `${sanitizeWorkspaceStoreName(workspaceRoot)}.db`;
}

export function getLocalHnswFileName(workspaceRoot: string): string {
	return `${sanitizeWorkspaceStoreName(workspaceRoot)}.usearch`;
}

export function getLocalVectorDbPathForLayout(storePath: string, dbFileName: string): string {
	return path.join(storePath, dbFileName);
}

export function getLocalHnswPathForDb(dbPath: string): string {
	const base = path.basename(dbPath, path.extname(dbPath));
	return path.join(path.dirname(dbPath), `${base}.usearch`);
}

/**
 * Resolve store directory and db filename.
 * Prefers project-name layout; falls back to legacy workspace-hash folder if present.
 */
export function resolveLocalStoreLayout(workspaceRoot: string, workspaceHash: string): LocalStoreLayout {
	const storeName = sanitizeWorkspaceStoreName(workspaceRoot);
	const namedStorePath = getNamedLocalStorePath(workspaceRoot);
	const namedDbFileName = `${storeName}.db`;
	const namedDbPath = getLocalVectorDbPathForLayout(namedStorePath, namedDbFileName);

	if (fs.existsSync(namedDbPath)) {
		return { storePath: namedStorePath, dbFileName: namedDbFileName, isLegacy: false };
	}

	const legacyStorePath = getLegacyLocalStorePath(workspaceHash);
	const legacyDbPath = getLocalVectorDbPathForLayout(legacyStorePath, LEGACY_LOCAL_VECTOR_DB_FILENAME);
	if (fs.existsSync(legacyDbPath)) {
		return {
			storePath: legacyStorePath,
			dbFileName: LEGACY_LOCAL_VECTOR_DB_FILENAME,
			isLegacy: true,
		};
	}

	return { storePath: namedStorePath, dbFileName: namedDbFileName, isLegacy: false };
}

export function localStoreHasVectorDb(layout: LocalStoreLayout): boolean {
	return fs.existsSync(getLocalVectorDbPathForLayout(layout.storePath, layout.dbFileName));
}
