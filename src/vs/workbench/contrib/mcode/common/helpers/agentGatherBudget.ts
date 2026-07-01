/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import type { ChatMessage } from '../chatThreadServiceTypes.js';
import type { BuiltinToolCallParams, BuiltinToolName } from '../toolsServiceTypes.js';

export const MAX_ACTIVE_READS = 8;

export function getActiveReadsLimit(contextWindow: number): number {
	if (contextWindow <= 8192) {
		return 2;
	} else if (contextWindow <= 16384) {
		return 4;
	} else if (contextWindow <= 32768) {
		return 6;
	} else if (contextWindow <= 65536) {
		return 8;
	} else if (contextWindow <= 131072) {
		return 12;
	} else {
		return 16;
	}
}

/** Consecutive gather tools before mandatory edit warning (K3). */
export const GATHER_BUDGET_BEFORE_EDIT_WARNING = 2;

export const MAX_SEARCH_RESULT_CHARS = 8000;
export const MAX_SEARCH_RESULT_LINES = 50;

const GATHER_TOOL_NAMES = new Set<BuiltinToolName>([
	'read_file',
	'read_files',
	'search_for_files',
	'search_pathnames_only',
	'search_in_file',
	'ls_dir',
	'get_dir_tree',
]);

const EDIT_TOOL_NAMES = new Set<BuiltinToolName>([
	'edit_file',
	'rewrite_file',
	'create_file_or_folder',
]);

/** Count successful gather tools since last user message or edit/create. */
export function countConsecutiveGathers(chatMessages: ChatMessage[]): number {
	let count = 0;
	for (let i = chatMessages.length - 1; i >= 0; i--) {
		const m = chatMessages[i];
		if (m.role === 'user') {
			break;
		}
		if (m.role === 'tool' && m.type === 'success') {
			const toolName = m.name as BuiltinToolName;
			if (EDIT_TOOL_NAMES.has(toolName)) {
				break;
			}
			if (GATHER_TOOL_NAMES.has(toolName)) {
				count += 1;
			}
		}
	}
	return count;
}

const DELIVERABLE_MD_PATTERN = /[`'"]?([^\s`'"]*(?:[\\/][^\s`'"]*)+\.md)[`'"]?|(?:输出|写入|write|create)[^\n]*?([^\s`'"]+\.md)/gi;

/** Target .md from recent edits or first user message mentioning a .md path. */
export function detectAgentDeliverablePath(chatMessages: ChatMessage[]): string | undefined {
	for (let i = chatMessages.length - 1; i >= 0; i--) {
		const m = chatMessages[i];
		if (m.role === 'tool' && m.type === 'success') {
			if (m.name === 'edit_file' || m.name === 'rewrite_file') {
				const fsPath = (m.params as BuiltinToolCallParams['edit_file']).uri.fsPath;
				if (fsPath.toLowerCase().endsWith('.md')) {
					return fsPath;
				}
			}
			if (m.name === 'create_file_or_folder') {
				const p = m.params as BuiltinToolCallParams['create_file_or_folder'];
				if (!p.isFolder && p.uri.fsPath.toLowerCase().endsWith('.md')) {
					return p.uri.fsPath;
				}
			}
		}
	}

	for (const m of chatMessages) {
		if (m.role !== 'user') {
			continue;
		}
		const text = m.displayContent || m.content;
		let match: RegExpExecArray | null;
		DELIVERABLE_MD_PATTERN.lastIndex = 0;
		while ((match = DELIVERABLE_MD_PATTERN.exec(text)) !== null) {
			const candidate = (match[1] ?? match[2])?.trim();
			if (candidate && candidate.toLowerCase().endsWith('.md')) {
				return path.normalize(candidate.replace(/\//g, path.sep));
			}
		}
	}
	return undefined;
}

export function buildConsecutiveGatherWarning(gatherCount: number, deliverablePath?: string): string | undefined {
	if (gatherCount < GATHER_BUDGET_BEFORE_EDIT_WARNING) {
		return undefined;
	}
	if (deliverablePath) {
		return `\n\n[WARNING: CONSECUTIVE GATHERS] You have performed ${gatherCount} consecutive read/search operations. To avoid infinite loops and context thrashing, you MUST now write your findings or changes to the target file to record your progress. Next tool MUST be edit_file or rewrite_file on: ${deliverablePath}. Do NOT call read_file, read_files, search_for_files, or search_in_folder again until you have written/modified this file.`;
	}
	return `\n\n[WARNING: CONSECUTIVE GATHERS] You have performed ${gatherCount} consecutive read/search operations without editing/writing to any files. To avoid infinite loops and context thrashing, you MUST now write your findings or initialize the target file (using edit_file, rewrite_file, or create_file_or_folder) to record your progress. Do NOT call read_file, read_files, search_for_files, or search_in_folder again until you have written/modified a file.`;
}

/** Cap search path list for tool result string (S1). */
export function capSearchPathListResult(
	pathLines: string[],
	pageNumber: number,
	hasNextPage: boolean,
	nextPageSuffix: string,
): string {
	let lines = pathLines;
	let truncatedByLines = false;
	if (lines.length > MAX_SEARCH_RESULT_LINES) {
		lines = lines.slice(0, MAX_SEARCH_RESULT_LINES);
		truncatedByLines = true;
	}
	let out = lines.join('\n') + nextPageSuffix;
	if (out.length > MAX_SEARCH_RESULT_CHARS) {
		out = out.slice(0, MAX_SEARCH_RESULT_CHARS)
			+ `\n...(truncated to ${MAX_SEARCH_RESULT_CHARS} chars; use search_in_folder or page_number=${pageNumber + 1} for more)`;
	} else if (truncatedByLines) {
		out += `\n...(showing ${MAX_SEARCH_RESULT_LINES} paths; use page_number=${pageNumber + 1} for more)`;
	}
	if (truncatedByLines || out.length >= MAX_SEARCH_RESULT_CHARS) {
		out += '\nTIP: Narrow scope with search_in_folder instead of searching the whole workspace.';
	}
	return out;
}
