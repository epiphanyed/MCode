/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util';
import { exec as _exec } from 'child_process';
import * as path from 'path';
import { isGitRepository } from './gitLogIndexer.js';

const exec = promisify(_exec);

const GIT_INTENT_PATTERNS: RegExp[] = [
	/\b(?:git\s+)?diff\b/i,
	/\b(?:git\s+)?log\b/i,
	/\buncommitted\b/i,
	/\bunstaged\b/i,
	/\bstaged\b/i,
	/\bworking\s+tree\b/i,
	/(?:改了什么|修改了什么|改了哪些|哪些改动|未提交|暂存|工作区|提交历史|最近提交|上次提交|昨晚|昨天)/,
	/\b(?:what|which).{0,20}(?:changed|modified|edited)\b/i,
	/\b(?:recent|latest|last)\s+commit\b/i,
	/\bcommit\s+history\b/i,
	/\bchanges?\s+(?:since|from|in)\b/i,
];

const SOURCE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp', '.c', '.cc', '.cxx',
	'.py', '.java', '.m', '.sci', '.sce', '.md', '.txt', '.json', '.yaml', '.yml',
	'.kt', '.kts'
]);

const DIFF_SKIP_PATTERNS = [
	/package-lock\.json$/,
	/yarn\.lock$/,
	/pnpm-lock\.yaml$/,
	/\.min\.js$/,
	/\.map$/,
	/^milvus\/volumes\//,
];

const MAX_DIFF_LINES_PER_FILE = 150;
const MAX_DIFF_FILES = 12;

export type GitDynamicMode = 'working_diff' | 'recent_commits';

export function isGitRelatedQuery(query: string): boolean {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return false;
	}
	return GIT_INTENT_PATTERNS.some(pattern => pattern.test(trimmed));
}

export function detectGitDynamicMode(query: string): GitDynamicMode {
	if (/(?:上次提交|最近提交|latest\s+commit|last\s+commit|commit\s+history|提交历史|昨晚|昨天)/i.test(query)) {
		return 'recent_commits';
	}
	return 'working_diff';
}

function shouldIncludeDiffFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	if (DIFF_SKIP_PATTERNS.some(p => p.test(normalized))) {
		return false;
	}
	const ext = path.extname(normalized).toLowerCase();
	if (ext && !SOURCE_EXTENSIONS.has(ext)) {
		return false;
	}
	return true;
}

function truncateDiff(diff: string, maxLines = MAX_DIFF_LINES_PER_FILE): string {
	const lines = diff.split('\n');
	if (lines.length <= maxLines) {
		return diff;
	}
	const head = lines.slice(0, maxLines).join('\n');
	return `${head}\n... (diff truncated, ${lines.length - maxLines} more lines)`;
}

async function runGit(cwd: string, command: string): Promise<string> {
	try {
		const { stdout } = await exec(command, { cwd, maxBuffer: 8 * 1024 * 1024 });
		return stdout.trim();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(message);
	}
}

async function buildWorkingDiffContext(workspaceRoot: string): Promise<string> {
	const sections: string[] = [];

	const unstagedStat = await runGit(workspaceRoot, 'git diff --stat');
	if (unstagedStat) {
		sections.push('## Unstaged changes (git diff --stat)\n' + unstagedStat);
	}

	const stagedStat = await runGit(workspaceRoot, 'git diff --cached --stat');
	if (stagedStat) {
		sections.push('## Staged changes (git diff --cached --stat)\n' + stagedStat);
	}

	const numstatRaw = await runGit(workspaceRoot, 'git diff --numstat');
	const stagedNumstatRaw = await runGit(workspaceRoot, 'git diff --cached --numstat');
	const fileScores = new Map<string, number>();

	const ingestNumstat = (raw: string) => {
		for (const line of raw.split('\n')) {
			const [added, deleted, file] = line.split('\t');
			if (!file || !shouldIncludeDiffFile(file)) {
				continue;
			}
			const score = (parseInt(added, 10) || 0) + (parseInt(deleted, 10) || 0);
			fileScores.set(file, (fileScores.get(file) ?? 0) + score);
		}
	};
	ingestNumstat(numstatRaw);
	ingestNumstat(stagedNumstatRaw);

	const topFiles = [...fileScores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_DIFF_FILES)
		.map(([file]) => file);

	for (const file of topFiles) {
		let diff = '';
		try {
			diff = await runGit(workspaceRoot, `git diff --no-color --unified=3 -- "${file}"`);
			if (!diff) {
				diff = await runGit(workspaceRoot, `git diff --cached --no-color --unified=3 -- "${file}"`);
			}
		} catch {
			continue;
		}
		if (diff) {
			sections.push(`## Diff: ${file}\n${truncateDiff(diff)}`);
		}
	}

	if (sections.length === 0) {
		const status = await runGit(workspaceRoot, 'git status --short');
		if (status) {
			return `## Git status\n${status}`;
		}
		return 'No uncommitted changes detected in the working tree.';
	}
	return sections.join('\n\n');
}

async function buildRecentCommitsContext(workspaceRoot: string): Promise<string> {
	const log = await runGit(
		workspaceRoot,
		'git log -n 5 --date=iso-strict --no-merges --pretty=format:"%H|%an|%ad|%s"',
	);
	const commits = log.split('\n').filter(Boolean);
	const sections: string[] = ['## Recent commits (git log -n 5)'];

	for (const line of commits) {
		const [hash, author, date, ...messageParts] = line.split('|');
		const message = messageParts.join('|');
		sections.push(`### ${hash?.slice(0, 12)} — ${message}\nAuthor: ${author}\nDate: ${date}`);
		try {
			const stat = await runGit(workspaceRoot, `git show --stat --format="" ${hash}`);
			if (stat) {
				sections.push(stat);
			}
		} catch {
			// ignore per-commit stat failures
		}
	}
	return sections.join('\n\n');
}

export interface GitDynamicContextOptions {
	workspaceRoot: string;
	query: string;
}

export async function buildGitDynamicContext(options: GitDynamicContextOptions): Promise<string | null> {
	const { workspaceRoot, query } = options;
	if (!isGitRepository(workspaceRoot)) {
		return null;
	}
	if (!isGitRelatedQuery(query)) {
		return null;
	}

	try {
		const mode = detectGitDynamicMode(query);
		const body = mode === 'recent_commits'
			? await buildRecentCommitsContext(workspaceRoot)
			: await buildWorkingDiffContext(workspaceRoot);
		return `--- GIT DYNAMIC CONTEXT (${mode}) ---\n${body}`;
	} catch (err) {
		console.warn('[RAG] Git dynamic context failed:', err);
		return null;
	}
}
