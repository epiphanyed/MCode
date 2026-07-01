import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IVoidSettingsService } from './mcodeSettingsService.js';
import { ProviderName } from './mcodeSettingsTypes.js';

export const ILlamaServerContextService = createDecorator<ILlamaServerContextService>('llamaServerContextService');

export interface ILlamaServerContextService {
	readonly _serviceBrand: undefined;
	/** Query llama-server GET /props and apply n_ctx to models without manual contextWindow override. */
	syncForProvider(providerName: ProviderName): Promise<number | null>;
}

export class LlamaServerContextService extends Disposable implements ILlamaServerContextService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService _llmMessageService: ILLMMessageService,
		@IVoidSettingsService _settingsService: IVoidSettingsService,
	) {
		super();
	}

	async syncForProvider(_providerName: ProviderName): Promise<number | null> {
		return null;
	}
}

registerSingleton(ILlamaServerContextService, LlamaServerContextService, InstantiationType.Delayed);
