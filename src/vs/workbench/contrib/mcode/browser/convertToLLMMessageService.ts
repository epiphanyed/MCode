import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities } from '../common/modelCapabilities.js';
import { reParsedToolXMLString, chat_systemMessage } from '../common/prompt/prompts.js';
import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/mcodeSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, ProviderName } from '../common/mcodeSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/mcodeModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { estimateTokenCount, MIN_RETAINED_CHARS } from '../common/helpers/tokenEstimate.js';
import { stripDiagramBlocksForLlm } from '../common/helpers/diagramBlockStripper.js';
import { stripFileHeaderForToolOutput } from '../common/helpers/fileHeaderStripper.js';
import { agentReadRegistryKey } from '../common/helpers/agentReadRegistry.js';
import { BuiltinToolCallParams } from '../common/toolsServiceTypes.js';
import { IRepositoryMapService } from '../common/repositoryMapService.js';


export const EMPTY_MESSAGE = '(empty message)'

export function maskSensitiveSecrets(text: string): string {
	let cleanText = text;
	cleanText = cleanText.replace(/sk-[a-zA-Z0-9]{48}/g, "<MASKED_OPENAI_KEY>");
	cleanText = cleanText.replace(/(password|passwd|db_password)\s*[:=]\s*["'][^"']+["']/gi, '$1: "<MASKED_SECRET>"');
	cleanText = cleanText.replace(/(aws_secret_access_key|client_secret|api_key|client_id|auth_token)\s*[:=]\s*["'][^"']+["']/gi, '$1: "<MASKED_SECRET>"');
	return cleanText;
}



type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const CHARS_PER_TOKEN = 4 // fallback when estimateTokenCount not used
const TRIM_TO_LEN = 120




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			newMessages.push(currMsg)
			continue
		}

		// edit previous assistant message to have called the tool
		const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined
		if (prevMsg?.role === 'assistant') {
			prevMsg.tool_calls = [{
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			}]
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
->
assistant: ...content, call(name, id, params)
user: ...content, result(id, content)
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: (AnthropicLLMChatMessage | (SimpleLLMMessage & { role: 'tool' }))[] = messages;

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				newMessages[i] = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : currMsg.anthropicReasoning
				}
			}
			else {
				newMessages[i] = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			continue
		}

		if (currMsg.role === 'user') {
			newMessages[i] = {
				role: 'user',
				content: currMsg.content,
			}
			continue
		}

		if (currMsg.role === 'tool') {
			// add anthropic tools
			const prevMsg = 0 <= i - 1 && i - 1 <= newMessages.length ? newMessages[i - 1] : undefined

			// make it so the assistant called the tool
			if (prevMsg?.role === 'assistant') {
				if (typeof prevMsg.content === 'string') prevMsg.content = [{ type: 'text', text: prevMsg.content }]
				prevMsg.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			}

			// turn each tool into a user message with tool results at the end
			newMessages[i] = {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }]
			}
			continue
		}

	}

	// we just removed the tools
	return newMessages as AnthropicLLMChatMessage[]
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]
		const next = 0 <= i + 1 && i + 1 <= messages.length - 1 ? messages[i + 1] : null

		if (c.role === 'assistant') {
			// if called a tool (message after it), re-add its XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			if (next?.role === 'tool') {
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			if (c.role === 'tool')
				c.content = `<${c.name}_result>\n${c.content}\n</${c.name}_result>`

			if (llmChatMessages.length === 0 || llmChatMessages[llmChatMessages.length - 1].role !== 'user')
				llmChatMessages.push({
					role: 'user',
					content: c.content
				})
			else
				llmChatMessages[llmChatMessages.length - 1].content += '\n\n' + c.content
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined } => {

	reservedOutputTokenSpace = Math.max(
		reservedOutputTokenSpace ?? 4_096,
		Math.floor(contextWindow * 0.15),
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES (from the user's .mcoderules file):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = estimateTokenCount(message.content)

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalLen = 0
	for (const m of messages) { totalLen += estimateTokenCount(m.content) }
	const inputTokenBudget = Math.max(
		(contextWindow - reservedOutputTokenSpace),
		Math.ceil(MIN_RETAINED_CHARS / CHARS_PER_TOKEN),
	)
	const tokensNeedToTrim = totalLen - inputTokenBudget


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                          totalLen
	let remainingTokensToTrim = tokensNeedToTrim
	let i = 0

	while (remainingTokensToTrim > 0) {
		i += 1
		if (i > messages.length * 2) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]

		const msgTokens = estimateTokenCount(m.content)
		const trimToTokens = Math.ceil(TRIM_TO_LEN / CHARS_PER_TOKEN)
		const numTokensWillTrim = msgTokens - trimToTokens
		if (numTokensWillTrim > remainingTokensToTrim) {
			const ratio = (msgTokens - remainingTokensToTrim) / Math.max(msgTokens, 1)
			const keepChars = Math.max(TRIM_TO_LEN, Math.floor(m.content.length * ratio))
			m.content = m.content.slice(0, keepChars - '...'.length).trim() + '...'
			break
		}

		remainingTokensToTrim -= numTokensWillTrim
		m.content = m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const newFirstMessage = {
			role: 'user',
			content: `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n${llmMessages[0].content}`
		} as const
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = c.text || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	let latestToolName: ToolName | undefined = undefined
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						latestToolName = c.name
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						if (!latestToolName) return null
						return { functionResponse: { id: c.tool_use_id, name: latestToolName, response: { output: c.content } } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage }
	}

	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined }>
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
	estimateTokenUsage: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null }) => Promise<{ usedTokens: number, maxTokens: number, percentage: number }>
}


export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly mcodeSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly mcodeModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IRepositoryMapService private readonly repositoryMapService: IRepositoryMapService,
	) {
		super()
	}

	// Read .mcoderules files from workspace folders
	private _getMcodeRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let mcodeRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.mcoderules')
				const { model } = this.mcodeModelService.getModel(uri)
				if (!model) continue
				mcodeRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return mcodeRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Get combined AI instructions from settings and .mcoderules files
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.mcodeSettingsService.state.globalSettings.aiInstructions;
		const mcodeRulesFileContent = this._getMcodeRulesFileContents();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (mcodeRulesFileContent) ans.push(mcodeRulesFileContent)
		return ans.join('\n\n')
	}


	// system message
	private _generateChatMessagesSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined) => {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath) || [];
		const activeURI = this.editorService.activeEditor?.resource?.fsPath;

		const directoryStr = await this.directoryStrService.getSystemDirectoriesStr({
			cutOffMessage: chatMode === 'agent' || chatMode === 'gather' ?
				`...Use get_dir_tree tool for full directory tree...`
				: `...Use get_dir_tree or ask user for more if necessary...`
		})

		const includeXMLToolDefinitions = !specialToolFormat

		const mcpTools = this.mcpService.getMCPTools()

		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		const systemMessage = chat_systemMessage({ workspaceFolders, openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode, mcpTools, includeXMLToolDefinitions })
		return systemMessage
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[], activeReadKeysSet?: Set<string>): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		for (const m of chatMessages) {
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'assistant') {
				simpleLLMMessages.push({
					role: m.role,
					content: stripDiagramBlocksForLlm(m.displayContent),
					anthropicReasoning: m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				let content = stripDiagramBlocksForLlm(m.content);
				if (activeReadKeysSet && m.type === 'success') {
					if (m.name === 'read_file') {
						const p = (m as any).params as BuiltinToolCallParams['read_file'];
						const key = agentReadRegistryKey('read_file', p);
						const hasKey = activeReadKeysSet ? activeReadKeysSet.has(key) : false;
						console.log('[RAG][debug] checking read_file key:', key, 'hasKey:', hasKey);
						if (hasKey) {
							content = `[read_file success] File ${p.uri.fsPath} page ${p.pageNumber} loaded in [ACTIVE FILES CONTEXT]. Do NOT read again — use edit_file to append this file's analysis to the deliverable .md.`;
						} else {
							content = `[read_file success] File ${p.uri.fsPath} page ${p.pageNumber} was pruned from active context. Re-read only if you need NEW content for the next .md section; otherwise edit_file the deliverable .md with what you already know.`;
						}
					} else if (m.name === 'read_files') {
						const p = (m as any).params as BuiltinToolCallParams['read_files'];
						const key = agentReadRegistryKey('read_files', p);
						const hasKey = activeReadKeysSet ? activeReadKeysSet.has(key) : false;
						console.log('[RAG][debug] checking read_files key:', key, 'hasKey:', hasKey);
						if (hasKey) {
							const paths = p.uris.map(u => u.fsPath).join(', ');
							content = `[read_files success] Files [${paths}] page ${p.pageNumber} loaded in [ACTIVE FILES CONTEXT]. Do NOT read again — use edit_file to append analysis to the deliverable .md.`;
						} else {
							const paths = p.uris.map(u => u.fsPath).join(', ');
							content = `[read_files success] Files [${paths}] page ${p.pageNumber} were pruned from active context. Re-read only for NEW .md sections; prefer edit_file on the deliverable .md.`;
						}
					}
				}
				simpleLLMMessages.push({
					role: m.role,
					content: content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				simpleLLMMessages.push({
					role: m.role,
					content: stripDiagramBlocksForLlm(m.content),
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.mcodeSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.mcodeSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.mcodeSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.mcodeSettingsService.state.globalSettings;
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat)
		let systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		// 1. Find active read files
		const activeReadKeys: string[] = [];
		const activeReadKeysSet = new Set<string>();
		const filesToLoad: { uri: URI; pageNumber: number; startLine: number | null; endLine: number | null }[] = [];

		for (let i = chatMessages.length - 1; i >= 0; i--) {
			const m = chatMessages[i];
			if (m.role === 'tool' && m.type === 'success') {
				if (m.name === 'read_file') {
					const p = m.params as BuiltinToolCallParams['read_file'];
					const key = agentReadRegistryKey('read_file', p);
					if (!activeReadKeysSet.has(key)) {
						activeReadKeysSet.add(key);
						activeReadKeys.push(key);
						filesToLoad.push({ uri: p.uri, pageNumber: p.pageNumber, startLine: p.startLine, endLine: p.endLine });
					}
				} else if (m.name === 'read_files') {
					const p = m.params as BuiltinToolCallParams['read_files'];
					const key = agentReadRegistryKey('read_files', p);
					if (!activeReadKeysSet.has(key)) {
						activeReadKeysSet.add(key);
						activeReadKeys.push(key);
						for (const uri of p.uris) {
							filesToLoad.push({ uri: uri, pageNumber: p.pageNumber, startLine: null, endLine: null });
						}
					}
				}
			}
		}

		// Keep only the most recent N active read calls
		const MAX_ACTIVE_READS = 5;
		const slicedActiveKeys = activeReadKeys.slice(0, MAX_ACTIVE_READS);
		const slicedActiveKeysSet = new Set(slicedActiveKeys);
		console.log('[RAG][debug] slicedActiveKeysSet:', Array.from(slicedActiveKeysSet));

		// Now collect unique file pages to load (since read_files has multiple files, we map uri+page to content)
		type ActiveReadItem = 
			| { type: 'read_file'; uri: URI; pageNumber: number; startLine: number | null; endLine: number | null }
			| { type: 'read_files'; uris: URI[]; pageNumber: number };

		const filePagesToLoad: ActiveReadItem[] = [];
		const filePagesSet = new Set<string>();

		for (let i = chatMessages.length - 1; i >= 0; i--) {
			const m = chatMessages[i];
			if (m.role === 'tool' && m.type === 'success') {
				if (m.name === 'read_file') {
					const p = m.params as BuiltinToolCallParams['read_file'];
					const key = agentReadRegistryKey('read_file', p);
					if (slicedActiveKeysSet.has(key)) {
						const fileKey = `${p.uri.fsPath.toLowerCase()}::p${p.pageNumber}${p.startLine !== null || p.endLine !== null ? `::lines${p.startLine}-${p.endLine}` : ''}`;
						if (!filePagesSet.has(fileKey)) {
							filePagesSet.add(fileKey);
							filePagesToLoad.push({ type: 'read_file', uri: p.uri, pageNumber: p.pageNumber, startLine: p.startLine, endLine: p.endLine });
						}
					}
				} else if (m.name === 'read_files') {
					const p = m.params as BuiltinToolCallParams['read_files'];
					const key = agentReadRegistryKey('read_files', p);
					if (slicedActiveKeysSet.has(key)) {
						const combinedPaths = p.uris.map(u => u.fsPath.toLowerCase()).sort().join(',');
						const fileKey = `read_files::${combinedPaths}::p${p.pageNumber}`;
						if (!filePagesSet.has(fileKey)) {
							filePagesSet.add(fileKey);
							filePagesToLoad.push({ type: 'read_files', uris: p.uris, pageNumber: p.pageNumber });
						}
					}
				}
			}
		}

		// Fetch the content of each active file page
		const activeFilesBlocks: string[] = [];
		for (const f of filePagesToLoad) {
			try {
				if (f.type === 'read_file') {
					await this.mcodeModelService.initializeModel(f.uri);
					const { model } = await this.mcodeModelService.getModelSafe(f.uri);
					if (model !== null) {
						const startLineNumber = f.startLine === null ? 1 : f.startLine;
						const fromStartOfFile = f.startLine === null || f.startLine <= 1;
						let contents: string;
						if (f.startLine === null && f.endLine === null) {
							contents = model.getValue(EndOfLinePreference.LF);
						} else {
							const endLineNumber = f.endLine === null ? model.getLineCount() : f.endLine;
							contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF);
						}
						// Strip header and diagram blocks
						contents = stripFileHeaderForToolOutput(contents, fromStartOfFile);
						contents = stripDiagramBlocksForLlm(contents);

						// Slice to page size (16,000 chars)
						const pageSize = 16000;
						const fromIdx = pageSize * (f.pageNumber - 1);
						const toIdx = pageSize * f.pageNumber - 1;
						const pageContents = contents.slice(fromIdx, toIdx + 1);

						const rangeStr = f.startLine !== null || f.endLine !== null ? `, lines ${startLineNumber}-${f.endLine === null ? 'end' : f.endLine}` : '';
						activeFilesBlocks.push(`--- FILE: ${f.uri.fsPath} (page ${f.pageNumber}${rangeStr}) ---\n${pageContents}`);
					}
				} else if (f.type === 'read_files') {
					const fileBlocks: string[] = [];
					for (const uri of f.uris) {
						try {
							await this.mcodeModelService.initializeModel(uri);
							const { model } = await this.mcodeModelService.getModelSafe(uri);
							if (model !== null) {
								let contents = model.getValue(EndOfLinePreference.LF);
								contents = stripFileHeaderForToolOutput(contents, true);
								contents = stripDiagramBlocksForLlm(contents);
								fileBlocks.push(`${uri.fsPath}\n\`\`\`\n${contents}\n\`\`\``);
							}
						} catch (e) {
							fileBlocks.push(`${uri.fsPath}\n\`\`\`\nError: ${e instanceof Error ? e.message : String(e)}\n\`\`\``);
						}
					}
					const combined = fileBlocks.join('\n\n');
					const pageSize = 16000; // MAX_READ_FILES_COMBINED_PAGE
					const fromIdx = pageSize * (f.pageNumber - 1);
					const toIdx = pageSize * f.pageNumber - 1;
					const pageContents = combined.slice(fromIdx, toIdx + 1);

					activeFilesBlocks.push(`--- FILES: [${f.uris.map(u => u.fsPath).join(', ')}] (page ${f.pageNumber}) ---\n${pageContents}`);
				}
			} catch (e) {
				console.error(`Error loading active context file block:`, e);
			}
		}

		let activeFilesSection = '';
		if (activeFilesBlocks.length > 0) {
			activeFilesSection = `\n\n[ACTIVE FILES CONTEXT]\nThe following files are currently loaded in your active workspace context:\n${activeFilesBlocks.join('\n\n')}\n\nUse this content to write or append to the user's deliverable .md (edit_file / rewrite_file). Do NOT re-read the same path/page if it is listed here. If a file was pruned from this list, you may read_file again only when you need new content for the next .md section — not to repeat exploration. After at most 2 read/search tools, your next tool MUST update the deliverable .md.`;
		}

		// Find relevant URIs for repository map (Opened files, Active file, and Recent reads)
		const relevantURIs: URI[] = [];
		const relevantPathsSet = new Set<string>();

		const addURI = (uri: URI) => {
			const key = uri.fsPath.toLowerCase();
			if (!relevantPathsSet.has(key)) {
				relevantPathsSet.add(key);
				relevantURIs.push(uri);
			}
		};

		// 1. Active file
		const activeURI = this.editorService.activeEditor?.resource;
		if (activeURI) {
			addURI(activeURI);
		}

		// 2. Opened files
		const openedModels = this.modelService.getModels().filter(m => m.isAttachedToEditor());
		for (const m of openedModels) {
			addURI(m.uri);
		}

		// 3. Recently read files
		for (const f of filePagesToLoad) {
			if (f.type === 'read_file') {
				addURI(f.uri);
			} else if (f.type === 'read_files') {
				for (const uri of f.uris) {
					addURI(uri);
				}
			}
		}

		// Generate the Repository Map
		let repositoryMapSection = '';
		try {
			console.log('[RepositoryMap] Gathering codebase map signatures for relevant files:', relevantURIs.map(u => u.fsPath));
			const repositoryMapContent = await this.repositoryMapService.getRepositoryMap(relevantURIs);
			if (repositoryMapContent) {
				console.log(`[RepositoryMap] Generated map size: ${repositoryMapContent.length} characters.`);
				repositoryMapSection = `\n\n[REPOSITORY MAP]\nHere are the class/function signatures of files relevant to your current focus:\n${repositoryMapContent}`;
			}
		} catch (e) {
			console.error('[RepositoryMap] Error generating repository map:', e);
		}

		if (systemMessage && repositoryMapSection) {
			systemMessage += repositoryMapSection;
		}

		if (systemMessage && activeFilesSection) {
			systemMessage += activeFilesSection;
		}

		const modelSelectionOptions = this.mcodeSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();
		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages, slicedActiveKeysSet)
		const maskedLLMMessages = llmMessages.map(m => ({
			...m,
			content: maskSensitiveSecrets(m.content)
		}));

		const { messages, separateSystemMessage } = prepareMessages({
			messages: maskedLLMMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}

	estimateTokenUsage: IConvertToLLMMessageService['estimateTokenUsage'] = async ({ chatMessages, chatMode, modelSelection }) => {
		if (modelSelection === null) return { usedTokens: 0, maxTokens: 4096, percentage: 0 }

		const { overridesOfModel } = this.mcodeSettingsService.state
		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.mcodeSettingsService.state.globalSettings;
		const fullSystemMessage = await this._generateChatMessagesSystemMessage(chatMode, specialToolFormat)
		const systemMessage = disableSystemMessage ? '' : fullSystemMessage;

		const aiInstructions = this._getCombinedAIInstructions();
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages)

		let totalLen = systemMessage.length + aiInstructions.length;
		for (const m of llmMessages) {
			totalLen += m.content.length;
		}

		const usedTokens = Math.round(totalLen / CHARS_PER_TOKEN);
		const maxTokens = contextWindow;
		const percentage = Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 100)));

		return { usedTokens, maxTokens, percentage };
	}

}

registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/



