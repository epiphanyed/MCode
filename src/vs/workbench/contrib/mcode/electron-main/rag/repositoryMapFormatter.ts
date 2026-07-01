/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { CodeSymbolEntry } from './ragQueryHelpers.js';
import type { RelatedFileDependency } from './codeGraphBuilder.js';

const MAX_SYMBOLS_PER_FILE = 50;

function formatLineRange(startLine: number, endLine: number): string {
	return startLine === endLine ? `(Line ${startLine})` : `(Lines ${startLine}-${endLine})`;
}

/** Merge duplicate symbol chunks (large symbols split across index parts). */
export function dedupeCodeSymbols(symbols: CodeSymbolEntry[]): CodeSymbolEntry[] {
	const byKey = new Map<string, CodeSymbolEntry>();
	for (const symbol of symbols) {
		const key = symbol.symbolName
			? `${symbol.symbolType}::${symbol.symbolName}`
			: `${symbol.symbolType}::${symbol.startLine}`;
		const prev = byKey.get(key);
		if (!prev) {
			byKey.set(key, { ...symbol });
			continue;
		}
		byKey.set(key, {
			...prev,
			startLine: Math.min(prev.startLine, symbol.startLine),
			endLine: Math.max(prev.endLine, symbol.endLine),
		});
	}
	return [...byKey.values()].sort((a, b) => a.startLine - b.startLine);
}

export function formatSymbolSignatureLine(symbol: CodeSymbolEntry): string {
	const name = symbol.symbolName ?? symbol.symbolType;
	const range = formatLineRange(symbol.startLine, symbol.endLine);
	return `  ${symbol.symbolType} ${name} ${range}`;
}

function formatGraphHintLine(dep: RelatedFileDependency): string {
	const kindLabel = dep.kind === 'imported_by' ? 'imported_by' : dep.kind;
	const detail = dep.reason ? ` — ${dep.reason}` : '';
	return `  [graph] ${kindLabel} → ${dep.filePath}${detail}`;
}

/** Format one file block for [REPOSITORY MAP] from indexed symbols + optional graph neighbors. */
export function formatFileRepositoryBlock(
	filePath: string,
	symbols: CodeSymbolEntry[],
	graphNeighbors: RelatedFileDependency[] = [],
): string {
	const deduped = dedupeCodeSymbols(symbols).slice(0, MAX_SYMBOLS_PER_FILE);
	const lines = deduped.map(formatSymbolSignatureLine);
	for (const dep of graphNeighbors) {
		lines.push(formatGraphHintLine(dep));
	}
	return `${filePath}:\n${lines.join('\n')}`;
}

export function formatRepositoryMapBlocks(blocks: string[]): string {
	return blocks.filter(Boolean).join('\n\n');
}
