/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IVoidSCMService {
	readonly _serviceBrand: undefined;
	/**
	 * Get git diff --stat
	 *
	 * @param path Path to the git repository
	 */
	gitStat(path: string): Promise<string>
	/**
	 * Get git diff --stat for the top 10 most significantly changed files according to lines added/removed
	 *
	 * @param path Path to the git repository
	 */
	gitSampledDiffs(path: string): Promise<string>
	/**
	 * Get the current git branch
	 *
	 * @param path Path to the git repository
	 */
	gitBranch(path: string): Promise<string>
	/**
	 * Get the last 5 commits excluding merges
	 *
	 * @param path Path to the git repository
	 */
	gitLog(path: string): Promise<string>
	/**
	 * Check if the workspace has any unstaged, staged, or untracked changes
	 *
	 * @param path Path to the git repository
	 */
	isWorkspaceDirty(path: string): Promise<boolean>
	/**
	 * Automatically stage and commit all modifications with a standard commit message
	 *
	 * @param path Path to the git repository
	 * @param message The commit message
	 */
	createAutoCommit(path: string, message: string): Promise<void>
	/**
	 * Revert the latest commit if and only if it is an AI auto-commit
	 *
	 * @param path Path to the git repository
	 */
	performUndo(path: string): Promise<void>
}

export const IVoidSCMService = createDecorator<IVoidSCMService>('mcodeSCMService')
