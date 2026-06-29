/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { ChatMessage } from '../chatThreadServiceTypes.js';
import { BuiltinToolCallParams, BuiltinToolResultType } from '../toolsServiceTypes.js';

export type AgentReadToolName = 'read_file' | 'read_files';

function normalizePaths(uris: URI[]): string {
	return [...uris].map(u => u.fsPath.toLowerCase()).sort().join('\0');
}

/** Stable key for a read_file / read_files call (path + page + optional line range). */
export function agentReadRegistryKey(
	toolName: AgentReadToolName,
	params: BuiltinToolCallParams[AgentReadToolName],
): string {
	if (toolName === 'read_file') {
		const p = params as BuiltinToolCallParams['read_file'];
		const linePart = p.startLine !== null || p.endLine !== null ? `:lines${p.startLine}-${p.endLine}` : '';
		return `read_file:${p.uri.fsPath.toLowerCase()}:p${p.pageNumber}${linePart}`;
	}
	const p = params as BuiltinToolCallParams['read_files'];
	return `read_files:${normalizePaths(p.uris)}:p${p.pageNumber}`;
}

export function isAgentReadRegistered(registry: string[] | undefined, key: string): boolean {
	return registry?.includes(key) ?? false;
}

export function appendAgentReadRegistry(registry: string[] | undefined, key: string): string[] {
	const list = registry ?? [];
	if (list.includes(key)) {
		return list;
	}
	return [...list, key];
}

/** Rebuild registry from successful read tool messages (after checkpoint / edit truncate). */
export function rebuildAgentReadRegistryFromMessages(messages: ChatMessage[]): string[] {
	const keys: string[] = [];
	for (const m of messages) {
		if (m.role !== 'tool' || m.type !== 'success') {
			continue;
		}
		if (m.name === 'read_file') {
			const key = agentReadRegistryKey('read_file', m.params as BuiltinToolCallParams['read_file']);
			if (!keys.includes(key)) {
				keys.push(key);
			}
		} else if (m.name === 'read_files') {
			const key = agentReadRegistryKey('read_files', m.params as BuiltinToolCallParams['read_files']);
			if (!keys.includes(key)) {
				keys.push(key);
			}
		}
	}
	return keys;
}

export function alreadyReadToolResult(
	toolName: AgentReadToolName,
	params: BuiltinToolCallParams[AgentReadToolName],
): string {
	if (toolName === 'read_file') {
		const p = params as BuiltinToolCallParams['read_file'];
		return `[already read] ${p.uri.fsPath} page=${p.pageNumber}. Already in this thread — do NOT read again. Append findings to the deliverable .md with edit_file (use [ACTIVE FILES CONTEXT] or earlier messages).`;
	}
	const p = params as BuiltinToolCallParams['read_files'];
	const paths = p.uris.map(u => u.fsPath).join(', ');
	return `[already read] read_files page=${p.pageNumber}: ${paths}. Already in this thread — do NOT read again. Append findings to the deliverable .md with edit_file.`;
}

export function stubAlreadyReadToolResult(toolName: AgentReadToolName): BuiltinToolResultType[AgentReadToolName] {
	if (toolName === 'read_file') {
		return { fileContents: '', totalFileLen: 0, totalNumLines: 0, hasNextPage: false };
	}
	return { combinedContents: '', totalCombinedLen: 0, hasNextPage: false, files: [] };
}
