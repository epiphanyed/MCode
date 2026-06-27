/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';

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

/** Split a path into segments regardless of `/` or platform separator. */
export function splitPathSegments(filePath: string): string[] {
	return path.normalize(filePath).split(/[/\\]/).filter(Boolean);
}

/** True when a single directory entry should not be descended into. */
export function shouldSkipDirectoryName(dirName: string): boolean {
	if (dirName === '.' || dirName === '..') {
		return false;
	}
	const lower = dirName.toLowerCase();
	return SKIPPED_DIR_NAMES.has(lower) || dirName.startsWith('.');
}

/** True when any path segment is a skipped or hidden directory (e.g. nested `.git`, `.github`). */
export function pathContainsSkippedDirectory(filePath: string): boolean {
	return splitPathSegments(filePath).some(shouldSkipDirectoryName);
}
