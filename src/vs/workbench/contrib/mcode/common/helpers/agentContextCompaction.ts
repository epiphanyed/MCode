/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ChatMessage, ToolMessage } from '../chatThreadServiceTypes.js';
import { BuiltinToolCallParams, ToolName } from '../toolsServiceTypes.js';
import { ragLogStage } from './ragDebugLog.js';

/** Tool results larger than this are candidates for folding in agent history. */
const LARGE_TOOL_CONTENT_THRESHOLD = 2_000;

/** Keep the most recent N large tool results at full size. */
const KEEP_FULL_LARGE_TOOL_RESULTS = 2;

const FOLDABLE_TOOLS = new Set<ToolName>([
	'read_file',
	'read_files',
	'get_dir_tree',
	'search_for_files',
	'search_pathnames_only',
	'ls_dir',
]);

type SuccessToolMessage = Extract<ToolMessage<ToolName>, { type: 'success' }>;

function summarizeToolMessage(m: SuccessToolMessage): string {
	const contentLen = m.content?.length ?? 0;
	switch (m.name) {
		case 'read_file': {
			const p = m.params as BuiltinToolCallParams['read_file'];
			return `[read_file summary] ${p.uri.fsPath} page=${p.pageNumber} (${contentLen} chars omitted from context)`;
		}
		case 'read_files': {
			const p = m.params as BuiltinToolCallParams['read_files'];
			const paths = p.uris.map(u => u.fsPath).join(', ');
			return `[read_files summary] ${p.uris.length} file(s) page=${p.pageNumber}: ${paths} (${contentLen} chars omitted from context)`;
		}
		case 'get_dir_tree': {
			const p = m.params as BuiltinToolCallParams['get_dir_tree'];
			return `[get_dir_tree summary] ${p.uri.fsPath} (${contentLen} chars omitted from context)`;
		}
		case 'search_for_files':
		case 'search_pathnames_only':
		case 'ls_dir': {
			return `[${m.name} summary] (${contentLen} chars omitted from context)`;
		}
		default:
			return `[tool summary] ${m.name} (${contentLen} chars omitted from context)`;
	}
}

/**
 * Fold older large tool results to path summaries so agent loops do not grow prompt without bound.
 * Only affects the copy sent to the LLM; thread storage is unchanged.
 */
export function compactAgentChatMessagesForLlm(messages: ChatMessage[]): ChatMessage[] {
	const largeIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== 'tool' || m.type !== 'success') {
			continue;
		}
		if (!FOLDABLE_TOOLS.has(m.name)) {
			continue;
		}
		if ((m.content?.length ?? 0) >= LARGE_TOOL_CONTENT_THRESHOLD) {
			largeIndices.push(i);
		}
	}
	if (largeIndices.length <= KEEP_FULL_LARGE_TOOL_RESULTS) {
		return messages;
	}
	const foldSet = new Set(largeIndices.slice(0, largeIndices.length - KEEP_FULL_LARGE_TOOL_RESULTS));
	if (foldSet.size === 0) {
		return messages;
	}
	let savedChars = 0;
	const compacted = messages.map((m, i) => {
		if (!foldSet.has(i) || m.role !== 'tool' || m.type !== 'success') {
			return m;
		}
		savedChars += m.content?.length ?? 0;
		return { ...m, content: summarizeToolMessage(m) };
	});
	ragLogStage('compact', `folded ${foldSet.size} tool result(s), saved ~${savedChars} chars`);
	return compacted;
}
