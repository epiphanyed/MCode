/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, ServiceSendLLMMessageParams, MainSendLLMMessageParams, MainLLMMessageAbortParams, ServiceModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, MainModelListParams, OllamaModelResponse, OpenaiCompatibleModelResponse, LLMChatMessage, } from './sendLLMMessageTypes.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVoidSettingsService } from './mcodeSettingsService.js';
import { IMCPService } from './mcpService.js';
import { logLongText, LOG_CHUNK_SIZE } from './helpers/ragDebugLog.js';

function stringifyLlmMessageContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (content === undefined || content === null) {
		return '';
	}
	try {
		return JSON.stringify(content, null, 2);
	} catch {
		return String(content);
	}
}

function formatChatMessageForLog(msg: LLMChatMessage): { role: string; text: string } {
	if ('parts' in msg) {
		return { role: msg.role, text: JSON.stringify(msg.parts, null, 2) };
	}
	let text = stringifyLlmMessageContent(msg.content);
	if ('tool_calls' in msg && msg.tool_calls?.length) {
		text += `\n[tool_calls]: ${JSON.stringify(msg.tool_calls, null, 2)}`;
	}
	if ('tool_call_id' in msg && msg.tool_call_id) {
		text = `[tool_call_id=${msg.tool_call_id}]\n${text}`;
	}
	return { role: msg.role, text };
}

function logOutboundLlmPayload(params: ServiceSendLLMMessageParams, requestId: string): void {
	const { logging, modelSelection, messagesType, separateSystemMessage, chatMode } = params;
	const provider = modelSelection?.providerName ?? 'none';
	const model = modelSelection?.modelName ?? 'none';
	const extras = logging.loggingExtras ? JSON.stringify(logging.loggingExtras) : '';

	console.log(
		`[LLM][send] requestId=${requestId} name=${logging.loggingName} type=${messagesType} `
		+ `model=${provider}/${model} chatMode=${chatMode ?? 'n/a'}${extras ? ` extras=${extras}` : ''}`,
	);

	if (separateSystemMessage?.trim()) {
		logLongText('[LLM][send] separateSystemMessage', separateSystemMessage, LOG_CHUNK_SIZE);
	}

	if (messagesType === 'chatMessages') {
		const messages = params.messages;
		let totalChars = separateSystemMessage?.length ?? 0;
		console.log(`[LLM][send] messages count=${messages.length}`);
		for (let i = 0; i < messages.length; i++) {
			const { role, text } = formatChatMessageForLog(messages[i]);
			totalChars += text.length;
			logLongText(`[LLM][send] message[${i}] role=${role}`, text, LOG_CHUNK_SIZE);
		}
		console.log(`[LLM][send] payload totalChars≈${totalChars}`);
	} else {
		const { prefix, suffix, stopTokens } = params.messages;
		console.log(
			`[LLM][send] FIM prefixChars=${prefix.length} suffixChars=${suffix.length} `
			+ `stopTokens=${JSON.stringify(stopTokens)}`,
		);
		logLongText('[LLM][send] FIM prefix', prefix, LOG_CHUNK_SIZE);
		logLongText('[LLM][send] FIM suffix', suffix, LOG_CHUNK_SIZE);
	}
}

// calls channel to implement features
export const ILLMMessageService = createDecorator<ILLMMessageService>('llmMessageService');

export interface ILLMMessageService {
	readonly _serviceBrand: undefined;
	sendLLMMessage: (params: ServiceSendLLMMessageParams) => string | null;
	abort: (requestId: string) => void;
	ollamaList: (params: ServiceModelListParams<OllamaModelResponse>) => void;
	openAICompatibleList: (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => void;
	/** llama-server GET /props → n_ctx; null if not a llama-server or unreachable. */
	fetchLlamaServerContextWindow: (endpoint: string) => Promise<number | null>;
}


// open this file side by side with llmMessageChannel
export class LLMMessageService extends Disposable implements ILLMMessageService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel // LLMMessageChannel

	// sendLLMMessage
	private readonly llmMessageHooks = {
		onText: {} as { [eventId: string]: ((params: EventLLMMessageOnTextParams) => void) },
		onFinalMessage: {} as { [eventId: string]: ((params: EventLLMMessageOnFinalMessageParams) => void) },
		onError: {} as { [eventId: string]: ((params: EventLLMMessageOnErrorParams) => void) },
		onAbort: {} as { [eventId: string]: (() => void) }, // NOT sent over the channel, result is instant when we call .abort()
	}

	// list hooks
	private readonly listHooks = {
		ollama: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OllamaModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OllamaModelResponse>) => void) },
		},
		openAICompat: {
			success: {} as { [eventId: string]: ((params: EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>) => void) },
			error: {} as { [eventId: string]: ((params: EventModelListOnErrorParams<OpenaiCompatibleModelResponse>) => void) },
		}
	} satisfies {
		[providerName in 'ollama' | 'openAICompat']: {
			success: { [eventId: string]: ((params: EventModelListOnSuccessParams<any>) => void) },
			error: { [eventId: string]: ((params: EventModelListOnErrorParams<any>) => void) },
		}
	}

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService, // used as a renderer (only usable on client side)
		@IVoidSettingsService private readonly mcodeSettingsService: IVoidSettingsService,
		// @INotificationService private readonly notificationService: INotificationService,
		@IMCPService private readonly mcpService: IMCPService,
	) {
		super()

		// const service = ProxyChannel.toService<LLMMessageChannel>(mainProcessService.getChannel('void-channel-sendLLMMessage')); // lets you call it like a service
		// see llmMessageChannel.ts
		this.channel = this.mainProcessService.getChannel('void-channel-llmMessage')

		// .listen sets up an IPC channel and takes a few ms, so we set up listeners immediately and add hooks to them instead
		// llm
		this._register((this.channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this.llmMessageHooks.onText[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this.llmMessageHooks.onFinalMessage[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId)
		}))
		this._register((this.channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			this.llmMessageHooks.onError[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId);
			console.error('Error in LLMMessageService:', JSON.stringify(e))
		}))
		// .list()
		this._register((this.channel.listen('onSuccess_list_ollama') satisfies Event<EventModelListOnSuccessParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.success[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onError_list_ollama') satisfies Event<EventModelListOnErrorParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.error[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onSuccess_list_openAICompatible') satisfies Event<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.success[e.requestId]?.(e)
		}))
		this._register((this.channel.listen('onError_list_openAICompatible') satisfies Event<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.error[e.requestId]?.(e)
		}))

	}

	sendLLMMessage(params: ServiceSendLLMMessageParams) {
		const { onText, onFinalMessage, onError, onAbort, modelSelection, ...proxyParams } = params;

		// throw an error if no model/provider selected (this should usually never be reached, the UI should check this first, but might happen in cases like Apply where we haven't built much UI/checks yet, good practice to have check logic on backend)
		if (modelSelection === null) {
			const message = `Please add a provider in MCode's Settings.`
			onError({ message, fullError: null })
			return null
		}

		if (params.messagesType === 'chatMessages' && (params.messages?.length ?? 0) === 0) {
			const message = `No messages detected.`
			onError({ message, fullError: null })
			return null
		}

		const { settingsOfProvider, } = this.mcodeSettingsService.state

		const mcpTools = this.mcpService.getMCPTools()

		// add state for request id
		const requestId = generateUuid();
		this.llmMessageHooks.onText[requestId] = onText
		this.llmMessageHooks.onFinalMessage[requestId] = onFinalMessage
		this.llmMessageHooks.onError[requestId] = onError
		this.llmMessageHooks.onAbort[requestId] = onAbort // used internally only

		logOutboundLlmPayload(params, requestId);

		// params will be stripped of all its functions over the IPC channel
		this.channel.call('sendLLMMessage', {
			...proxyParams,
			requestId,
			settingsOfProvider,
			modelSelection,
			mcpTools,
		} satisfies MainSendLLMMessageParams);

		return requestId
	}

	abort(requestId: string) {
		this.llmMessageHooks.onAbort[requestId]?.() // calling the abort hook here is instant (doesn't go over a channel)
		this.channel.call('abort', { requestId } satisfies MainLLMMessageAbortParams);
		this._clearChannelHooks(requestId)
	}


	ollamaList = (params: ServiceModelListParams<OllamaModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.mcodeSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.ollama.success[requestId_] = onSuccess
		this.listHooks.ollama.error[requestId_] = onError

		this.channel.call('ollamaList', {
			...proxyParams,
			settingsOfProvider,
			providerName: 'ollama',
			requestId: requestId_,
		} satisfies MainModelListParams<OllamaModelResponse>)
	}


	openAICompatibleList = (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params

		const { settingsOfProvider } = this.mcodeSettingsService.state

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.openAICompat.success[requestId_] = onSuccess
		this.listHooks.openAICompat.error[requestId_] = onError

		this.channel.call('openAICompatibleList', {
			...proxyParams,
			settingsOfProvider,
			requestId: requestId_,
		} satisfies MainModelListParams<OpenaiCompatibleModelResponse>)
	}

	fetchLlamaServerContextWindow = async (endpoint: string): Promise<number | null> => {
		try {
			const nCtx = await this.channel.call('fetchLlamaServerContextWindow', { endpoint });
			return typeof nCtx === 'number' && nCtx > 0 ? nCtx : null;
		} catch {
			return null;
		}
	}

	private _clearChannelHooks(requestId: string) {
		delete this.llmMessageHooks.onText[requestId]
		delete this.llmMessageHooks.onFinalMessage[requestId]
		delete this.llmMessageHooks.onError[requestId]

		delete this.listHooks.ollama.success[requestId]
		delete this.listHooks.ollama.error[requestId]

		delete this.listHooks.openAICompat.success[requestId]
		delete this.listHooks.openAICompat.error[requestId]
	}
}

registerSingleton(ILLMMessageService, LLMMessageService, InstantiationType.Eager);

