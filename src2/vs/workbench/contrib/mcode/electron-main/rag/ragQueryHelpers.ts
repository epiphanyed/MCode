/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { MetadataMode, type BaseNode } from 'llamaindex';

export interface CodeSymbolEntry {
	startLine: number;
	endLine: number;
	symbolType: string;
	symbolName?: string;
}

export const DOC_PARENT_MAX_CHARS = 1500;
export const CODE_EXPAND_MAX_CHARS = 500;

const CONTAINER_SYMBOL_TYPES = new Set(['class', 'struct', 'namespace', 'interface', 'enum', 'union']);

export function getHeaderBreadcrumbFromMetadata(metadata: Record<string, unknown>): string | undefined {
	const headers = Object.entries(metadata)
		.filter(([key, value]) => key.startsWith('Header_') && typeof value === 'string')
		.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
		.map(([, value]) => value as string);
	return headers.length > 0 ? headers.join(' > ') : undefined;
}

/**
 * Assign parent keys to markdown child nodes and return parentKey → parentText map.
 */
export function assignDocParentChunks(nodes: BaseNode[], maxParentChars = DOC_PARENT_MAX_CHARS): Record<string, string> {
	const parentMap: Record<string, string> = {};
	if (nodes.length === 0) {
		return parentMap;
	}

	const filePath = String((nodes[0].metadata as Record<string, unknown>).filePath ?? 'unknown');
	let groupIndex = 0;
	let currentHeader = '';
	let currentTexts: string[] = [];
	let currentNodeIds: string[] = [];

	const flushGroup = () => {
		if (currentNodeIds.length === 0) {
			return;
		}
		const parentKey = `${filePath}::parent::${groupIndex}`;
		const parentText = currentTexts.join('\n\n').slice(0, maxParentChars);
		parentMap[parentKey] = parentText;
		for (const nodeId of currentNodeIds) {
			const node = nodes.find(n => String(n.id_) === nodeId);
			if (node) {
				(node.metadata as Record<string, unknown>).parentKey = parentKey;
			}
		}
		groupIndex++;
		currentTexts = [];
		currentNodeIds = [];
	};

	for (const node of nodes) {
		const metadata = node.metadata as Record<string, unknown>;
		const header = getHeaderBreadcrumbFromMetadata(metadata) ?? '';
		const text = node.getContent(MetadataMode.NONE);
		const nodeId = String(node.id_);

		const wouldExceed =
			currentTexts.join('\n\n').length + text.length > maxParentChars
			&& currentTexts.length > 0;

		if ((header !== currentHeader && currentTexts.length > 0) || wouldExceed) {
			flushGroup();
		}

		currentHeader = header;
		currentTexts.push(text);
		currentNodeIds.push(nodeId);
	}

	flushGroup();
	return parentMap;
}

export function resolveDocDisplayText(node: BaseNode, docParentMap: Record<string, string>): string {
	const metadata = node.metadata as Record<string, unknown>;
	const parentKey = metadata.parentKey ? String(metadata.parentKey) : undefined;
	if (parentKey && docParentMap[parentKey]) {
		return docParentMap[parentKey];
	}
	return node.getContent(MetadataMode.NONE);
}

export function findEnclosingSymbol(
	symbols: CodeSymbolEntry[],
	startLine: number,
): CodeSymbolEntry | undefined {
	let best: CodeSymbolEntry | undefined;
	for (const symbol of symbols) {
		if (!CONTAINER_SYMBOL_TYPES.has(symbol.symbolType)) {
			continue;
		}
		if (symbol.startLine <= startLine && symbol.endLine >= startLine) {
			if (!best || symbol.startLine > best.startLine) {
				best = symbol;
			}
		}
	}
	return best;
}

export async function expandCodeChunkText(
	node: BaseNode,
	codeSymbolMap: Record<string, CodeSymbolEntry[]>,
	readFileLines: (filePath: string, startLine: number, endLine: number) => Promise<string>,
): Promise<string> {
	const metadata = node.metadata as Record<string, unknown>;
	const content = node.getContent(MetadataMode.NONE);
	if (String(metadata.docType ?? '') !== 'code_chunk' || content.length >= CODE_EXPAND_MAX_CHARS) {
		return content;
	}

	const filePath = String(metadata.filePath ?? '');
	const startLine = typeof metadata.startLine === 'number' ? metadata.startLine : undefined;
	if (!filePath || startLine === undefined) {
		return content;
	}

	const symbols = codeSymbolMap[filePath];
	if (!symbols?.length) {
		return content;
	}

	const enclosing = findEnclosingSymbol(symbols, startLine);
	if (!enclosing) {
		return content;
	}

	const symbolType = String(metadata.symbolType ?? '');
	if (CONTAINER_SYMBOL_TYPES.has(symbolType)) {
		return content;
	}

	try {
		const parentText = await readFileLines(filePath, enclosing.startLine, enclosing.endLine);
		if (!parentText.trim() || parentText.includes(content.trim())) {
			return content;
		}
		return `${parentText.trim()}\n\n// --- matched symbol (${symbolType}: ${metadata.symbolName ?? 'unknown'}) ---\n\n${content.trim()}`;
	} catch {
		return content;
	}
}
