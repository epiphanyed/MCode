/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IManimRenderResult {
	success: boolean;
	mediaPath?: string;
	error?: string;
}

export interface IDiagramValidationResult {
	success: boolean;
	error?: string;
}

export interface IVoidDiagramService {
	readonly _serviceBrand: undefined;
	renderManim(code: string, cwd: string): Promise<IManimRenderResult>;
}

export const IVoidDiagramService = createDecorator<IVoidDiagramService>('mcodeDiagramService');
