/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidSettingsService } from '../common/mcodeSettingsService.js';
import { ILlamaServerContextService } from '../common/llamaServerContextService.js';
import { ProviderName } from '../common/mcodeSettingsTypes.js';

const LLAMA_PROPS_PROVIDERS = new Set<ProviderName>(['openAICompatible', 'lmStudio', 'vLLM']);

class LlamaServerContextContrib extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.llamaServerContext';

	constructor(
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@ILlamaServerContextService private readonly llamaServerContextService: ILlamaServerContextService,
	) {
		super();

		this._register(this.settingsService.onDidChangeState(() => {
			for (const providerName of LLAMA_PROPS_PROVIDERS) {
				const endpoint = this.settingsService.state.settingsOfProvider[providerName].endpoint?.trim();
				if (endpoint && this.settingsService.state.settingsOfProvider[providerName]._didFillInProviderSettings) {
					void this.llamaServerContextService.syncForProvider(providerName);
				}
			}
		}));

		void this.settingsService.waitForInitState.then(() => {
			for (const providerName of LLAMA_PROPS_PROVIDERS) {
				const endpoint = this.settingsService.state.settingsOfProvider[providerName].endpoint?.trim();
				if (endpoint) {
					void this.llamaServerContextService.syncForProvider(providerName);
				}
			}
		});
	}
}

registerWorkbenchContribution2(LlamaServerContextContrib.ID, LlamaServerContextContrib, WorkbenchPhase.Eventually);
