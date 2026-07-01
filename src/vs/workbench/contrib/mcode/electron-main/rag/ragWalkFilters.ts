/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';
import minimatch from 'minimatch';

/** Directory names skipped during workspace walks and path checks (any nesting depth). */
export const SKIPPED_DIR_NAMES = new Set([
	'node_modules', '.git', '.build', 'out', 'build', 'dist',
	'prebuilts', 'prebuilt', 'prebuild',
	'target', 'bin', 'obj', 'venv', 'env', '__pycache__', 'coverage',
	'temp', 'tmp', '.vscode', '.github', '.gitlab', '.gitea', '.svn', '.hg',
	'.idea', '.settings', '.circleci', '.husky',
	'third_party', 'third-party',
	'.venv', '.gradle', '.cargo', '.next', '.nuxt', '.yarn', '.pnpm',
	'test', 'tests',
]);

/** Directory names indexed after the main project tree (e.g. vendored deps). */
export const DEPRIORITIZED_DIR_NAMES = new Set([
	'external', 'third_party', 'third-party', 'vendor', 'vendors', 'deps', 'dependencies',
]);

/** Lower value = indexed earlier. Tier 0: workspace `src/`, tier 1: main tree, tier 2: external/vendor. */
export function getIndexFilePriority(filePath: string, workspaceRoot: string): number {
	const root = path.normalize(workspaceRoot);
	const rel = path.relative(root, path.normalize(filePath));
	if (!rel || rel.startsWith('..')) {
		return 1;
	}
	const segments = splitPathSegments(rel);
	if (segments.length > 0 && segments[0].toLowerCase() === 'src') {
		return 0;
	}
	if (segments.some(segment => DEPRIORITIZED_DIR_NAMES.has(segment.toLowerCase()))) {
		return 2;
	}
	return 1;
}

export function compareIndexFilePriority(a: string, b: string, workspaceRoot: string): number {
	const priorityDiff = getIndexFilePriority(a, workspaceRoot) - getIndexFilePriority(b, workspaceRoot);
	if (priorityDiff !== 0) {
		return priorityDiff;
	}
	return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

export function sortFilesForIndexing(files: string[], workspaceRoot: string): string[] {
	return files.slice().sort((a, b) => compareIndexFilePriority(a, b, workspaceRoot));
}

/** When walking the workspace root, descend into `src` first and external/vendor last. */
export function compareWalkDirectoryNames(a: string, b: string, parentDir: string, workspaceRoot: string): number {
	const atWorkspaceRoot = path.normalize(parentDir) === path.normalize(workspaceRoot);
	if (!atWorkspaceRoot) {
		return a.localeCompare(b, undefined, { sensitivity: 'base' });
	}
	const walkPriority = (name: string): number => {
		const lower = name.toLowerCase();
		if (lower === 'src') {
			return 0;
		}
		if (DEPRIORITIZED_DIR_NAMES.has(lower)) {
			return 2;
		}
		return 1;
	};
	const priorityDiff = walkPriority(a) - walkPriority(b);
	if (priorityDiff !== 0) {
		return priorityDiff;
	}
	return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Split a path into segments regardless of `/` or platform separator. */
export function splitPathSegments(filePath: string): string[] {
	return path.normalize(filePath).split(/[/\\]/).filter(Boolean);
}

/** True when a workspace-relative path matches any .mcodeignore-style pattern. */
export function isPathIgnoredByPatterns(relativePath: string, patterns: string[]): boolean {
	const normalized = relativePath.replace(/\\/g, '/');
	for (const pattern of patterns) {
		const cleanPattern = pattern.replace(/\\/g, '/').trim();
		if (!cleanPattern) {
			continue;
		}
		if (minimatch(normalized, cleanPattern, { dot: true })) {
			return true;
		}
		const prefix = cleanPattern.replace(/\/+$/, '');
		if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
			return true;
		}
	}
	return false;
}

/** True when a single directory entry should not be descended into. */
export function shouldSkipDirectoryName(dirName: string): boolean {
	if (dirName === '.' || dirName === '..') {
		return false;
	}
	const lower = dirName.toLowerCase();
	return SKIPPED_DIR_NAMES.has(lower) || dirName.startsWith('.');
}

/** True when any path segment of the directory path is a skipped or hidden directory (e.g. nested `.git`, `.github`). */
export function pathContainsSkippedDirectory(filePath: string): boolean {
	const dirname = path.dirname(filePath);
	if (dirname === '.' || dirname === '/' || dirname === '\\' || dirname === '') {
		return false;
	}
	return splitPathSegments(dirname).some(shouldSkipDirectoryName);
}
