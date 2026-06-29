/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoidModelService } from './mcodeModelService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export interface IRepositoryMapService {
	readonly _serviceBrand: undefined;
	getRepositoryMap(uris: URI[]): Promise<string>;
}

export const IRepositoryMapService = createDecorator<IRepositoryMapService>('repositoryMapService');

export class RepositoryMapService extends Disposable implements IRepositoryMapService {
	_serviceBrand: undefined;

	constructor(
		@IVoidModelService private readonly mcodeModelService: IVoidModelService,
	) {
		super();
	}

	async getRepositoryMap(uris: URI[]): Promise<string> {
		const startTime = Date.now();
		const blocks: string[] = [];
		for (const uri of uris) {
			try {
				await this.mcodeModelService.initializeModel(uri);
				const { model } = await this.mcodeModelService.getModelSafe(uri);
				if (model) {
					const lines = model.getValue().split('\n');
					const signatures: string[] = [];
					const ext = uri.path.substring(uri.path.lastIndexOf('.')).toLowerCase();

					if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i];
							const trimmed = line.trim();
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
							const line = lines[i];
							const trimmed = line.trim();
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
									continue; // filter out internal function statements in implementation files
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

					if (signatures.length > 0) {
						blocks.push(`${uri.fsPath}:\n${signatures.slice(0, 50).join('\n')}`);
					}
				}
			} catch (e) {
				console.error(`[RepositoryMapService] error for ${uri.fsPath}:`, e);
			}
		}
		console.log(`[RepositoryMapService] Generated map for ${uris.length} files in ${Date.now() - startTime}ms`);
		return blocks.join('\n\n');
	}
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

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
registerSingleton(IRepositoryMapService, RepositoryMapService, InstantiationType.Eager);
