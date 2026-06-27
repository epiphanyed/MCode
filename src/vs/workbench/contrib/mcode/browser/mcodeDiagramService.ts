/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IVoidDiagramService, IManimRenderResult } from '../common/mcodeDiagramTypes.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

class VoidDiagramBrowserService implements IVoidDiagramService {
	readonly _serviceBrand: undefined;
	private readonly voidDiagram: IVoidDiagramService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService
	) {
		this.voidDiagram = ProxyChannel.toService<IVoidDiagramService>(mainProcessService.getChannel('void-channel-diagram'));
	}

	async renderManim(code: string, cwd: string): Promise<IManimRenderResult> {
		return this.voidDiagram.renderManim(code, cwd);
	}
}

registerSingleton(IVoidDiagramService, VoidDiagramBrowserService, InstantiationType.Delayed);
