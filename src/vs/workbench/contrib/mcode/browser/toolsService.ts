import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/mcodeModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IMcodeCommandBarService } from './mcodeCommandBarService.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_READ_FILES_BATCH, MAX_READ_FILES_COMBINED_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { capSearchPathListResult } from '../common/helpers/agentGatherBudget.js'
import { IVoidSettingsService } from '../common/mcodeSettingsService.js'
import { IVoidRagService } from '../common/mcodeRagTypes.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { stripFileHeaderForToolOutput } from '../common/helpers/fileHeaderStripper.js'
import { stripDiagramBlocksForToolOutput } from '../common/helpers/diagramBlockStripper.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const parseURIList = (urisUnknown: unknown, maxCount = MAX_READ_FILES_BATCH): string[] => {
	if (urisUnknown === null || urisUnknown === undefined) {
		throw new Error('Invalid LLM output: uris was null.')
	}
	let paths: string[]
	if (Array.isArray(urisUnknown)) {
		paths = urisUnknown.map((u, i) => validateStr(`uris[${i}]`, u))
	} else if (typeof urisUnknown === 'string') {
		const trimmed = urisUnknown.trim()
		if (!trimmed) {
			throw new Error('Invalid LLM output: uris was empty.')
		}
		if (trimmed.startsWith('[')) {
			let parsed: unknown
			try {
				parsed = JSON.parse(trimmed)
			} catch (e) {
				throw new Error(`Invalid LLM output: uris JSON parse failed: ${e}`)
			}
			if (!Array.isArray(parsed) || parsed.length === 0) {
				throw new Error('Invalid LLM output: uris must be a non-empty JSON array.')
			}
			paths = parsed.map((u, i) => validateStr(`uris[${i}]`, u))
		} else if (trimmed.includes('\n')) {
			paths = trimmed.split('\n').map(s => s.trim()).filter(Boolean)
		} else {
			paths = trimmed.split(',').map(s => s.trim()).filter(Boolean)
		}
	} else {
		throw new Error(`Invalid LLM output format: uris must be a string or array, got ${typeof urisUnknown}.`)
	}
	if (paths.length === 0) {
		throw new Error('Invalid LLM output: uris must contain at least one path.')
	}
	if (paths.length > maxCount) {
		throw new Error(`Invalid LLM output: uris has ${paths.length} paths; maximum is ${maxCount}.`)
	}
	return paths
}

const validateURIList = (urisUnknown: unknown, maxCount = MAX_READ_FILES_BATCH): URI[] => {
	return parseURIList(urisUnknown, maxCount).map(validateURI)
}

async function readFileContentsForTool(
	mcodeModelService: IVoidModelService,
	uri: URI,
	startLine: number | null,
	endLine: number | null,
): Promise<{ contents: string, totalNumLines: number }> {
	await mcodeModelService.initializeModel(uri)
	const { model } = await mcodeModelService.getModelSafe(uri)
	if (model === null) {
		throw new Error(`No contents; File does not exist: ${uri.fsPath}`)
	}

	const startLineNumber = startLine === null ? 1 : startLine
	const fromStartOfFile = startLine === null || startLine <= 1

	let contents: string
	if (startLine === null && endLine === null) {
		contents = model.getValue(EndOfLinePreference.LF)
	} else {
		const endLineNumber = endLine === null ? model.getLineCount() : endLine
		contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
	}

	contents = stripFileHeaderForToolOutput(contents, fromStartOfFile)
	contents = stripDiagramBlocksForToolOutput(contents)

	return { contents, totalNumLines: model.getLineCount() }
}

function formatReadFileBlock(uri: URI, contents: string): string {
	return `${uri.fsPath}\n\`\`\`\n${contents}\n\`\`\``
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService mcodeModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IMcodeCommandBarService private readonly commandBarService: IMcodeCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly mcodeSettingsService: IVoidSettingsService,
		@IVoidRagService private readonly ragService: IVoidRagService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			read_files: (params: RawToolParamsObj) => {
				const { uris: urisUnknown, page_number: pageNumberUnknown } = params
				const uris = validateURIList(urisUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uris, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			query_codebase_relations: (params: RawToolParamsObj) => {
				const {
					entity_name: entityNameUnknown,
					file_path: filePathUnknown,
					relation_type: relationTypeUnknown,
				} = params;
				const entityName = entityNameUnknown !== undefined ? validateStr('entity_name', entityNameUnknown) : undefined;
				const filePath = filePathUnknown !== undefined ? validateStr('file_path', filePathUnknown) : undefined;
				let relationType: 'calls' | 'imports' | 'inherits' | 'contains' | undefined = undefined;
				if (relationTypeUnknown !== undefined) {
					const rel = validateStr('relation_type', relationTypeUnknown);
					if (rel === 'calls' || rel === 'imports' || rel === 'inherits' || rel === 'contains') {
						relationType = rel;
					} else {
						throw new Error(`Invalid relation_type: ${rel}. Allowed values: 'calls', 'imports', 'inherits', 'contains'.`);
					}
				}
				return { entityName, filePath, relationType };
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown, command: commandUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const command = validateOptionalStr('command', commandUnknown) ?? undefined
				return { cwd, command };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				const { contents, totalNumLines } = await readFileContentsForTool(mcodeModelService, uri, startLine, endLine)

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1)
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			read_files: async ({ uris, pageNumber }) => {
				const fileResults = await Promise.all(uris.map(async (uri) => {
					try {
						const { contents, totalNumLines } = await readFileContentsForTool(mcodeModelService, uri, null, null)
						return {
							uri,
							block: formatReadFileBlock(uri, contents),
							totalNumLines,
							totalFileLen: contents.length,
						}
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e)
						return {
							uri,
							block: `${uri.fsPath}\n\`\`\`\nError: ${message}\n\`\`\``,
							totalNumLines: 0,
							totalFileLen: 0,
							error: message,
						}
					}
				}))

				const combined = fileResults.map(f => f.block).join('\n\n')
				const pageSize = MAX_READ_FILES_COMBINED_PAGE
				const fromIdx = pageSize * (pageNumber - 1)
				const toIdx = pageSize * pageNumber - 1
				const combinedContents = combined.slice(fromIdx, toIdx + 1)
				const hasNextPage = (combined.length - 1) - toIdx >= 1
				return {
					result: {
						combinedContents,
						totalCombinedLen: combined.length,
						hasNextPage,
						files: fileResults.map(f => ({
							uri: f.uri,
							totalNumLines: f.totalNumLines,
							totalFileLen: f.totalFileLen,
							...(f.error ? { error: f.error } : {}),
						})),
					},
				}
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await mcodeModelService.initializeModel(uri);
				const { model } = await mcodeModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			query_codebase_relations: async ({ entityName, filePath, relationType }) => {
				console.log(`[Tool] query_codebase_relations executed: entityName="${entityName || ''}", filePath="${filePath || ''}", relationType="${relationType || ''}"`);
				const relations = await this.ragService.queryRelations(entityName, filePath, relationType);
				console.log(`[Tool] query_codebase_relations results: returned ${relations.length} relations.`);
				return { result: { relations } };
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				await mcodeModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await mcodeModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd, command }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				if (command) {
					const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
					const wrappedResPromise = (async () => {
						const { result, resolveReason } = await resPromise
						return { persistentTerminalId, result, resolveReason }
					})()
					return { result: wrappedResPromise, interruptTool: interrupt }
				}
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				const nextPage = params.pageNumber + 1
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info: file has ${result.totalNumLines} lines (${result.totalFileLen} chars). Pages are ${MAX_FILE_CHARS_PAGE} chars. ACTION REQUIRED: call read_file again with the SAME uri and page_number=${nextPage}.` : ''}`
			},
			read_files: (params, result) => {
				const pageSize = MAX_READ_FILES_COMBINED_PAGE
				const nextPage = params.pageNumber + 1
				return `${result.combinedContents}${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info: combined ${result.totalCombinedLen} chars across ${params.uris.length} files. Pages are ${pageSize} chars. ACTION REQUIRED: call read_files again with the SAME uris and page_number=${nextPage}.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return capSearchPathListResult(
					result.uris.map(uri => uri.fsPath),
					params.pageNumber,
					result.hasNextPage,
					nextPageStr(result.hasNextPage),
				);
			},
			search_for_files: (params, result) => {
				return capSearchPathListResult(
					result.uris.map(uri => uri.fsPath),
					params.pageNumber,
					result.hasNextPage,
					nextPageStr(result.hasNextPage),
				);
			},
			search_in_file: (params, result) => {
				const { model } = mcodeModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			query_codebase_relations: (params, result) => {
				if (!result.relations || result.relations.length === 0) {
					return 'No codebase relations found matching the criteria.';
				}
				return result.relations.map(rel => {
					const fromStr = rel.from.symbolName ? `${rel.from.symbolName} (${rel.from.filePath}:${rel.from.startLine})` : rel.from.filePath;
					const toStr = rel.to.symbolName ? `${rel.to.symbolName} (${rel.to.filePath}:${rel.to.startLine})` : rel.to.filePath;
					return `- ${fromStr} ${rel.kind === 'calls' ? 'calls' : 'imports'} ${toStr}`;
				}).join('\n');
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.mcodeSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.mcodeSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by MCode after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (params, result) => {
				const { persistentTerminalId } = result;
				let msg = `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
				if (params.command && result.result) {
					msg += `\nExecuted command: "${params.command}"\nInitial Output:\n${result.result}`;
				}
				return msg;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
