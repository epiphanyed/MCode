/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { normalize } from '../../../../base/common/path.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVoidModelService } from './mcodeModelService.js';
import { IVoidRagService } from './mcodeRagTypes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

export interface IRepositoryMapService {
	readonly _serviceBrand: undefined;
	getRepositoryMap(uris: URI[]): Promise<string>;
}

export const IRepositoryMapService = createDecorator<IRepositoryMapService>('repositoryMapService');

export class RepositoryMapService extends Disposable implements IRepositoryMapService {
	_serviceBrand: undefined;

	constructor(
		@IVoidModelService private readonly mcodeModelService: IVoidModelService,
		@IVoidRagService private readonly ragService: IVoidRagService,
		@ITextFileService private readonly textFileService: ITextFileService,
	) {
		super();
	}

	async getRepositoryMap(uris: URI[]): Promise<string> {
		if (uris.length === 0) {
			return '';
		}

		const startTime = Date.now();
		const blocks: string[] = [];

		const pathsForIndex: string[] = [];
		const fallbackUris: URI[] = [];

		for (const uri of uris) {
			await this.mcodeModelService.initializeModel(uri);
			if (this.textFileService.isDirty(uri)) {
				fallbackUris.push(uri);
			} else {
				pathsForIndex.push(uri.fsPath);
			}
		}

		let indexed: { content: string; missingPaths: string[] } = { content: '', missingPaths: [] };
		if (pathsForIndex.length > 0) {
			try {
				indexed = await this.ragService.getRepositoryMapFromIndex(pathsForIndex, 4);
			} catch (e) {
				console.warn('[RepositoryMap] Index lookup failed, using live-model fallback only:', e);
				indexed = { content: '', missingPaths: pathsForIndex };
			}
		}

		if (indexed.content) {
			blocks.push(indexed.content);
		}

		const missingNormalized = new Set(
			indexed.missingPaths.map(p => normalize(p).toLowerCase()),
		);
		for (const uri of uris) {
			if (missingNormalized.has(normalize(uri.fsPath).toLowerCase())) {
				fallbackUris.push(uri);
			}
		}

		const fallbackSeen = new Set<string>();
		for (const uri of fallbackUris) {
			const key = normalize(uri.fsPath).toLowerCase();
			if (fallbackSeen.has(key)) {
				continue;
			}
			fallbackSeen.add(key);
			const fallback = await this._extractFallbackFromEditorModel(uri);
			if (fallback) {
				blocks.push(fallback);
			}
		}

		const indexedCount = pathsForIndex.length - indexed.missingPaths.length;
		console.log(
			`[RepositoryMap] Generated map for ${uris.length} files in ${Date.now() - startTime}ms`
			+ ` (indexed=${indexedCount}, fallback=${fallbackSeen.size})`,
		);
		return blocks.join('\n\n');
	}

	/** Regex-based skeleton when file is not in codeSymbolMap (unindexed / unsaved-only). */
	private async _extractFallbackFromEditorModel(uri: URI): Promise<string | null> {
		try {
			await this.mcodeModelService.initializeModel(uri);
			const { model } = await this.mcodeModelService.getModelSafe(uri);
			if (!model) {
				return null;
			}
			const signatures = extractSignaturesFromLines(model.getValue().split('\n'), uri);
			if (signatures.length === 0) {
				return null;
			}
			return `${uri.fsPath}:\n${signatures.slice(0, 50).join('\n')}`;
		} catch (e) {
			console.error(`[RepositoryMapService] fallback error for ${uri.fsPath}:`, e);
			return null;
		}
	}
}

/** Live-buffer fallback (same heuristics as legacy RepositoryMapService). */
export function extractSignaturesFromLines(lines: string[], uri: URI): string[] {
	const signatures: string[] = [];
	const ext = uri.path.substring(uri.path.lastIndexOf('.')).toLowerCase();

	if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('export class ') || trimmed.startsWith('class ') ||
				trimmed.startsWith('export interface ') || trimmed.startsWith('interface ') ||
				trimmed.startsWith('export function ') || trimmed.startsWith('function ') ||
				(trimmed.startsWith('export const ') && trimmed.includes('=>')) ||
				trimmed.startsWith('async function ') || trimmed.startsWith('export async function ')) {
				signatures.push('  ' + trimmed.replace(/\{.*/, '').trim() + ` (Line ${i + 1})`);
			}
		}
	} else if (ext === '.py') {
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('class ') || trimmed.startsWith('def ')) {
				signatures.push('  ' + trimmed.replace(/\:.*/, '').trim() + ` (Line ${i + 1})`);
			}
		}
	} else if (ext === '.h' || ext === '.cpp' || ext === '.hpp' || ext === '.cc') {
		const isCppImpl = ext === '.cpp' || ext === '.cc';
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith('class ') || trimmed.startsWith('struct ') || trimmed.startsWith('namespace ')) {
				signatures.push('  ' + trimmed.replace(/\{.*/, '').trim() + ` (Line ${i + 1})`);
				continue;
			}
			if (trimmed.includes('(') && trimmed.includes(')') && !trimmed.startsWith('//') && !trimmed.startsWith('#')) {
				if (isCppImpl && trimmed.endsWith(';')) {
					continue;
				}
				if (trimmed.startsWith('if ') || trimmed.startsWith('if(') ||
					trimmed.startsWith('for ') || trimmed.startsWith('for(') ||
					trimmed.startsWith('while ') || trimmed.startsWith('while(') ||
					trimmed.startsWith('switch ') || trimmed.startsWith('switch(') ||
					trimmed.startsWith('catch ') || trimmed.startsWith('catch(') ||
					trimmed.startsWith('return ') || trimmed.startsWith('return(') ||
					trimmed.startsWith('delete ') || trimmed.startsWith('using ') ||
					trimmed.startsWith('throw ') || trimmed.startsWith('else ') ||
					trimmed.includes(' = ') || (trimmed.includes('=') && trimmed.endsWith(';'))) {
					continue;
				}
				let lineRange = `(Line ${i + 1})`;
				if (isCppImpl) {
					const endIdx = findFunctionEndLine(lines, i);
					if (endIdx > i) {
						lineRange = `(Lines ${i + 1}-${endIdx + 1})`;
					}
				}
				signatures.push('  ' + trimmed.replace(/\{.*/, '').trim() + ' ' + lineRange);
			}
		}
	}

	return signatures;
}

function findFunctionEndLine(lines: string[], startIdx: number): number {
	let openBraces = 0;
	let foundBrace = false;
	for (let j = startIdx; j < lines.length; j++) {
		const line = lines[j];
		for (let k = 0; k < line.length; k++) {
			const char = line[k];
			if (char === '{') {
				openBraces++;
				foundBrace = true;
			} else if (char === '}') {
				openBraces--;
				foundBrace = true;
			}
		}
		if (foundBrace && openBraces <= 0) {
			return j;
		}
	}
	return startIdx;
}

registerSingleton(IRepositoryMapService, RepositoryMapService, InstantiationType.Eager);
