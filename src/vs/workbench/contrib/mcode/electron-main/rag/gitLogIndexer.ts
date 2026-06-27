/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util';
import { exec as _exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Document, type BaseNode } from 'llamaindex';

const exec = promisify(_exec);

export const DEFAULT_GIT_LOG_MAX_COMMITS = 100;
const COMMIT_HEADER_PREFIX = 'COMMIT|';

export interface GitCommitFileStat {
	path: string;
	added: number;
	deleted: number;
}

export interface GitCommitRecord {
	hash: string;
	author: string;
	date: string;
	message: string;
	files: GitCommitFileStat[];
}

export interface GitLogIndexOptions {
	maxCommits?: number;
}

export function getGitCommitDocId(hash: string): string {
	return `git::commit::${hash}`;
}

export function isGitRepository(workspaceRoot: string): boolean {
	return fs.existsSync(path.join(workspaceRoot, '.git'));
}

async function runGit(cwd: string, command: string): Promise<string> {
	const { stdout } = await exec(command, { cwd, maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

/** Parse `git log --numstat --pretty=format:"COMMIT|..."` output. Exported for tests. */
export function parseGitLogOutput(output: string): GitCommitRecord[] {
	const commits: GitCommitRecord[] = [];
	let current: GitCommitRecord | null = null;

	for (const rawLine of output.split('\n')) {
		const line = rawLine.trimEnd();
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith(COMMIT_HEADER_PREFIX)) {
			if (current) {
				commits.push(current);
			}
			const parts = line.slice(COMMIT_HEADER_PREFIX.length).split('|');
			current = {
				hash: parts[0] ?? '',
				author: parts[1] ?? '',
				date: parts[2] ?? '',
				message: parts.slice(3).join('|'),
				files: [],
			};
			continue;
		}
		if (!current) {
			continue;
		}
		const tabParts = line.split('\t');
		if (tabParts.length < 3) {
			continue;
		}
		const added = tabParts[0] === '-' ? 0 : parseInt(tabParts[0], 10) || 0;
		const deleted = tabParts[1] === '-' ? 0 : parseInt(tabParts[1], 10) || 0;
		const filePath = tabParts.slice(2).join('\t');
		if (filePath) {
			current.files.push({ path: filePath, added, deleted });
		}
	}
	if (current) {
		commits.push(current);
	}
	return commits.filter(c => c.hash.length > 0);
}

export function formatCommitDocument(commit: GitCommitRecord): string {
	const lines = [
		`Commit Hash: ${commit.hash}`,
		`Author: ${commit.author}`,
		`Date: ${commit.date}`,
		`Message: ${commit.message}`,
		'Modified Files:',
	];
	if (commit.files.length === 0) {
		lines.push('- (no file stats)');
	} else {
		for (const file of commit.files) {
			lines.push(`- ${file.path} (+${file.added}, -${file.deleted})`);
		}
	}
	return lines.join('\n');
}

export async function fetchGitCommits(workspaceRoot: string, options?: GitLogIndexOptions): Promise<GitCommitRecord[]> {
	if (!isGitRepository(workspaceRoot)) {
		return [];
	}
	const maxCommits = options?.maxCommits ?? DEFAULT_GIT_LOG_MAX_COMMITS;
	const format = `${COMMIT_HEADER_PREFIX}%H|%an|%ad|%s`;
	try {
		const output = await runGit(
			workspaceRoot,
			`git log -n ${maxCommits} --date=iso-strict --no-merges --numstat --pretty=format:"${format}"`,
		);
		return parseGitLogOutput(output);
	} catch (err) {
		console.warn('[RAG] Git log indexing skipped:', err);
		return [];
	}
}

export function gitCommitsToNodes(commits: GitCommitRecord[]): BaseNode[] {
	return commits.map(commit => {
		const linesAdded = commit.files.reduce((sum, f) => sum + f.added, 0);
		const linesDeleted = commit.files.reduce((sum, f) => sum + f.deleted, 0);
		return new Document({
			id_: getGitCommitDocId(commit.hash),
			text: formatCommitDocument(commit),
			metadata: {
				docType: 'git_commit',
				commitHash: commit.hash,
				author: commit.author,
				date: commit.date,
				message: commit.message,
				filesChanged: commit.files.length,
				linesAdded,
				linesDeleted,
				filePath: `git://${commit.hash.slice(0, 12)}`,
				fileName: commit.message.slice(0, 80),
			},
		});
	});
}
