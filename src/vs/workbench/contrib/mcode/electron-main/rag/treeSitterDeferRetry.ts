/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';

export type TreeSitterIndexPass = 'primary' | 'retry' | 'off';

interface DeferredEntry {
	err: unknown;
}

const deferredByPath = new Map<string, DeferredEntry>();

export function resetTreeSitterDeferState(): void {
	deferredByPath.clear();
}

export function recordTreeSitterDefer(filePath: string, err: unknown): void {
	deferredByPath.set(path.normalize(filePath), { err });
}

export function isTreeSitterDeferred(filePath: string): boolean {
	return deferredByPath.has(path.normalize(filePath));
}

export function getTreeSitterDeferredFiles(): string[] {
	return [...deferredByPath.keys()];
}

export function clearTreeSitterDeferred(filePath: string): void {
	deferredByPath.delete(path.normalize(filePath));
}

export function takeTreeSitterDeferredFiles(): string[] {
	const files = getTreeSitterDeferredFiles();
	deferredByPath.clear();
	return files;
}
