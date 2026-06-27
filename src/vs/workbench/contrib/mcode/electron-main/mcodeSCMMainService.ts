/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util'
import { exec as _exec } from 'child_process'
import { promises as fs } from 'fs'
import * as pathLib from 'path'
import { IVoidSCMService } from '../common/mcodeSCMTypes.js'

interface NumStat {
	file: string
	added: number
	removed: number
}

const exec = promisify(_exec)

//8000 and 10 were chosen after some experimentation on small-to-moderately sized changes
const MAX_DIFF_LENGTH = 8000
const MAX_DIFF_FILES = 10

const git = async (command: string, path: string): Promise<string> => {
	const { stdout, stderr } = await exec(`${command}`, { cwd: path })
	if (stderr) {
		throw new Error(stderr)
	}
	return stdout.trim()
}

const getNumStat = async (path: string, useStagedChanges: boolean): Promise<NumStat[]> => {
	const staged = useStagedChanges ? '--staged' : ''
	const output = await git(`git diff --numstat ${staged}`, path)
	return output
		.split('\n')
		.map((line) => {
			const [added, removed, file] = line.split('\t')
			return {
				file,
				added: parseInt(added, 10) || 0,
				removed: parseInt(removed, 10) || 0,
			}
		})
}

const getSampledDiff = async (file: string, path: string, useStagedChanges: boolean): Promise<string> => {
	const staged = useStagedChanges ? '--staged' : ''
	const diff = await git(`git diff --unified=0 --no-color ${staged} -- "${file}"`, path)
	return diff.slice(0, MAX_DIFF_LENGTH)
}

const hasStagedChanges = async (path: string): Promise<boolean> => {
	const output = await git('git diff --staged --name-only', path)
	return output.length > 0
}

export class VoidSCMService implements IVoidSCMService {
	readonly _serviceBrand: undefined

	async gitStat(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const staged = useStagedChanges ? '--staged' : ''
		return git(`git diff --stat ${staged}`, path)
	}

	async gitSampledDiffs(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const numStatList = await getNumStat(path, useStagedChanges)
		const topFiles = numStatList
			.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
			.slice(0, MAX_DIFF_FILES)
		const diffs = await Promise.all(topFiles.map(async ({ file }) => ({ file, diff: await getSampledDiff(file, path, useStagedChanges) })))
		return diffs.map(({ file, diff }) => `==== ${file} ====\n${diff}`).join('\n\n')
	}

	gitBranch(path: string): Promise<string> {
		return git('git branch --show-current', path)
	}

	gitLog(path: string): Promise<string> {
		return git('git log --pretty=format:"%h|%s|%ad" --date=short --no-merges -n 5', path)
	}

	async isWorkspaceDirty(path: string): Promise<boolean> {
		try {
			const stdout = await git('git status --porcelain', path);
			return stdout.trim().length > 0;
		} catch (e) {
			return false;
		}
	}

	async createAutoCommit(path: string, message: string): Promise<void> {
		await git('git add -A', path);
		const formattedMsg = `🤖 [Void Auto] ${message}`;
		const msgFilePath = pathLib.join(path, '.git', 'VOID_COMMIT_EDITMSG');
		try {
			await fs.writeFile(msgFilePath, formattedMsg, 'utf8');
			await git(`git commit -F "${msgFilePath}"`, path);
		} finally {
			try {
				await fs.unlink(msgFilePath);
			} catch (e) {
				// Ignore
			}
		}
	}

	async performUndo(path: string): Promise<void> {
		const lastCommitSubject = await git('git log -1 --pretty=%s', path);
		if (lastCommitSubject.startsWith('🤖 [Void Auto]')) {
			// 1. Get files modified in the last commit
			const filesOutput = await git('git diff-tree --no-commit-id --name-only -r HEAD', path);
			const files = filesOutput.split('\n').map(f => f.trim()).filter(Boolean);

			// 2. Mixed reset to remove the commit, keeping changes in working directory
			await git('git reset HEAD~1', path);

			// 3. Selective revert / checkout files modified in that commit
			for (const file of files) {
				const fullFilePath = pathLib.join(path, file);
				try {
					await git(`git checkout -- "${file}"`, path);
				} catch (checkoutErr) {
					// If checkout fails, it means the file was newly added (does not exist in HEAD~1)
					// We safely delete the untracked file from disk.
					try {
						const stat = await fs.stat(fullFilePath);
						if (stat.isFile()) {
							await fs.unlink(fullFilePath);
						}
					} catch {
						// File doesn't exist, nothing to clean up
					}
				}
			}
		} else {
			throw new Error('The last commit was not an AI auto-commit. Undo aborted to protect your code.');
		}
	}
}
