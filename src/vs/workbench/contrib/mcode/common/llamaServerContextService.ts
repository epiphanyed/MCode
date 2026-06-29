/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IVoidSettingsService } from './mcodeSettingsService.js';
import { ProviderName } from './mcodeSettingsTypes.js';
import { defaultReservedOutputTokens } from './helpers/llamaServerProps.js';

const LLAMA_PROPS_PROVIDERS: ProviderName[] = ['openAICompatible', 'lmStudio', 'vLLM'];

export const ILlamaServerContextService = createDecorator<ILlamaServerContextService>('llamaServerContextService');

export interface ILlamaServerContextService {
	readonly _serviceBrand: undefined;
	/** Query llama-server GET /props and apply n_ctx to models without manual contextWindow override. */
	syncForProvider(providerName: ProviderName): Promise<number | null>;
}

export class LlamaServerContextService extends Disposable implements ILlamaServerContextService {
	readonly _serviceBrand: undefined;

	private readonly _syncedNCtx = new Map<string, number>();

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
	) {
		super();
	}

	async syncForProvider(providerName: ProviderName): Promise<number | null> {
		if (!LLAMA_PROPS_PROVIDERS.includes(providerName)) {
			return null;
		}
		const endpoint = this.settingsService.state.settingsOfProvider[providerName].endpoint?.trim();
		if (!endpoint) {
			return null;
		}

		const cacheKey = `${providerName}::${endpoint}`;
		const nCtx = await this.llmMessageService.fetchLlamaServerContextWindow(endpoint);
		if (nCtx === null || nCtx <= 0) {
			return null;
		}
		if (this._syncedNCtx.get(cacheKey) === nCtx) {
			return nCtx;
		}
		this._syncedNCtx.set(cacheKey, nCtx);

		const reserved = defaultReservedOutputTokens(nCtx);
		const { models } = this.settingsService.state.settingsOfProvider[providerName];
		const modelNames = new Set(models.map(m => m.modelName));

		const chatSel = this.settingsService.state.modelSelectionOfFeature.Chat;
		if (chatSel?.providerName === providerName && chatSel.modelName) {
			modelNames.add(chatSel.modelName);
		}

		for (const modelName of modelNames) {
			const prev = this.settingsService.state.overridesOfModel[providerName]?.[modelName];
			if (prev?.contextWindow !== undefined) {
				continue;
			}
			await this.settingsService.setOverridesOfModel(providerName, modelName, {
				...prev,
				contextWindow: nCtx,
				reservedOutputTokenSpace: prev?.reservedOutputTokenSpace ?? reserved,
			});
		}

		console.log(`[LLM] Synced contextWindow=${nCtx} from llama-server /props (${providerName}, ${endpoint})`);
		return nCtx;
	}
}

registerSingleton(ILlamaServerContextService, LlamaServerContextService, InstantiationType.Delayed);
