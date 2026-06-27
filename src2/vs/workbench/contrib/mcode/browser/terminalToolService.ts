/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_CHARS, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ITerminalPtyService, TerminalStateMachine } from './terminalPtyService.js';

export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	listPersistentTerminalIds(): string[];
	runCommand(command: string, opts:
		| { type: 'persistent', persistentTerminalId: string }
		| { type: 'temporary', cwd: string | null, terminalId: string }
		// | { type: 'apply', terminalId: string }
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string, resolveReason: TerminalResolveReason }> }>;

	focusPersistentTerminal(terminalId: string): Promise<void>
	persistentTerminalExists(terminalId: string): boolean

	readTerminal(terminalId: string): Promise<string>

	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>
	killPersistentTerminal(terminalId: string): Promise<void>

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined

	getPtyId(terminalId: string): string | undefined;
	readonly onPtyAwaitingInput: Event<{ terminalId: string, promptText: string }>;
	readonly onPtyCreated: Event<{ terminalId: string, ptyId: string }>;
	readonly onPtyOutput: Event<{ terminalId: string, data: string }>;
}
export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');



// function isCommandComplete(output: string) {
// 	// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
// 	const completionMatch = output.match(/\]633;D(?:;(\d+))?/)
// 	if (!completionMatch) { return false }
// 	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
// 	return { exitCode: 0 }
// }


export const persistentTerminalNameOfId = (id: string) => {
	if (id === '1') return 'MCode Agent'
	return `MCode Agent (${id})`
}
export const idOfPersistentTerminalName = (name: string) => {
	if (name === 'MCode Agent') return '1'

	const match = name.match(/MCode Agent \((\d+)\)/)
	if (!match) return null
	if (Number.isInteger(match[1]) && Number(match[1]) >= 1) return match[1]
	return null
}

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = {}
	private terminalIdToPtyId: Record<string, string> = {}
	private ptyOnAwaitingInputEmitter = new Emitter<{ terminalId: string, promptText: string }>();
	readonly onPtyAwaitingInput: Event<{ terminalId: string, promptText: string }> = this.ptyOnAwaitingInputEmitter.event;
	private ptyOnCreatedEmitter = new Emitter<{ terminalId: string, ptyId: string }>();
	readonly onPtyCreated: Event<{ terminalId: string, ptyId: string }> = this.ptyOnCreatedEmitter.event;
	private ptyOnOutputEmitter = new Emitter<{ terminalId: string, data: string }>();
	readonly onPtyOutput: Event<{ terminalId: string, data: string }> = this.ptyOnOutputEmitter.event;

	getPtyId(terminalId: string): string | undefined {
		return this.terminalIdToPtyId[terminalId];
	}

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ITerminalPtyService private readonly terminalPtyService: ITerminalPtyService,
	) {
		super();

		// runs on ALL terminals for simplicity
		const initializeTerminal = (terminal: ITerminalInstance) => {
			// when exit, remove
			const d = terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title)
				if (terminalId !== null && (terminalId in this.persistentTerminalInstanceOfId)) delete this.persistentTerminalInstanceOfId[terminalId]
				d.dispose()
			})
		}


		// initialize any terminals that are already open
		for (const terminal of terminalService.instances) {
			const proposedTerminalId = idOfPersistentTerminalName(terminal.title)
			if (proposedTerminalId) this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal

			initializeTerminal(terminal)
		}

		this._register(
			terminalService.onDidCreateInstance(terminal => { initializeTerminal(terminal) })
		)

	}


	listPersistentTerminalIds() {
		return Object.keys(this.persistentTerminalInstanceOfId)
	}

	getValidNewTerminalId(): string {
		// {1 2 3} # size 3, new=4
		// {1 3 4} # size 3, new=2
		// 1 <= newTerminalId <= n + 1
		const n = Object.keys(this.persistentTerminalInstanceOfId).length;
		if (n === 0) return '1'

		for (let i = 1; i <= n + 1; i++) {
			const potentialId = i + '';
			if (!(potentialId in this.persistentTerminalInstanceOfId)) return potentialId;
		}
		throw new Error('This should never be reached by pigeonhole principle');
	}


	private async _createTerminal(props: { cwd: string | null, config: ICreateTerminalOptions['config'], hidden?: boolean }) {
		const { cwd: override_cwd, config, hidden } = props;

		const cwd: URI | string | undefined = (override_cwd ?? undefined) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: config && 'name' in config ? config.name : undefined,
				forceShellIntegration: true,
				hideFromUser: hidden ? true : undefined,
				// Copy any other properties from the provided config
				...config,
			},
			// Skip profile check to ensure the terminal is created quickly
			skipContributedProfileCheck: true,
		};

		const terminal = await this.terminalService.createTerminal(options)

		// // when a new terminal is created, there is an initial command that gets run which is empty, wait for it to end before returning
		// const disposables: IDisposable[] = []
		// const waitForMount = new Promise<void>(res => {
		// 	let data = ''
		// 	const d = terminal.onData(newData => {
		// 		data += newData
		// 		if (isCommandComplete(data)) { res() }
		// 	})
		// 	disposables.push(d)
		// })
		// const waitForTimeout = new Promise<void>(res => { setTimeout(() => { res() }, 5000) })

		// await Promise.any([waitForMount, waitForTimeout,])
		// disposables.forEach(d => d.dispose())

		return terminal

	}

	createPersistentTerminal: ITerminalToolService['createPersistentTerminal'] = async ({ cwd }) => {
		const terminalId = this.getValidNewTerminalId();
		const config = {
			name: persistentTerminalNameOfId(terminalId),
			title: persistentTerminalNameOfId(terminalId),
			icon: ThemeIcon.fromId('sparkle'),
		}
		const terminal = await this._createTerminal({ cwd, config, })
		this.persistentTerminalInstanceOfId[terminalId] = terminal
		return terminalId
	}

	async killPersistentTerminal(terminalId: string) {
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`);
		terminal.dispose()
		delete this.persistentTerminalInstanceOfId[terminalId]
		return
	}

	persistentTerminalExists(terminalId: string): boolean {
		return terminalId in this.persistentTerminalInstanceOfId
	}


	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.temporaryTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		return terminal
	}


	focusPersistentTerminal: ITerminalToolService['focusPersistentTerminal'] = async (terminalId) => {
		if (!terminalId) return
		const terminal = this.persistentTerminalInstanceOfId[terminalId]
		if (!terminal) return // should never happen
		this.terminalService.setActiveInstance(terminal)
		await this.terminalService.focusActiveInstance()
	}




	readTerminal: ITerminalToolService['readTerminal'] = async (terminalId) => {
		// Try persistent first, then temporary
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}

		// Ensure the xterm.js instance has been created – otherwise we cannot access the buffer.
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}

		// Collect lines from the buffer iterator (oldest to newest)
		const lines: string[] = [];
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}

		let result = removeAnsiEscapeCodes(lines.join('\n'));

		if (result.length > MAX_TERMINAL_CHARS) {
			const half = MAX_TERMINAL_CHARS / 2;
			result = result.slice(0, half) + `\n... (output truncated to ${MAX_TERMINAL_CHARS} chars — narrow the command or redirect output) ...\n` + result.slice(result.length - half);
		}

		return result
	};


	runCommand: ITerminalToolService['runCommand'] = async (command, params) => {
		const { type } = params;
		const isPersistent = type === 'persistent';
		let terminalId = isPersistent ? params.persistentTerminalId : params.terminalId;
		if (!terminalId) {
			terminalId = 'default-temp-terminal';
		}

		// --- Branch 1: Persistent Terminal (Runs visibly in the user's terminal panel) ---
		if (isPersistent) {
			const terminal = this.getPersistentTerminal(terminalId);
			if (!terminal) {
				throw new Error(`Persistent Terminal: Terminal with ID ${terminalId} does not exist.`);
			}

			let isInterrupted = false;
			let timeoutTimer: any;

			const interrupt = () => {
				if (isInterrupted) return;
				isInterrupted = true;
				if (timeoutTimer) clearTimeout(timeoutTimer);
				// Send Ctrl+C interrupt to the visible terminal
				terminal.sendText('\x03', false);
			};

			const resPromise = (async () => {
				// Focus the terminal so the user sees it running
				this.terminalService.setActiveInstance(terminal);
				await this.terminalService.focusActiveInstance();

				// Send the command text to the actual visible terminal instance and execute it
				await terminal.sendText(command, true);

				// Wait for MAX_TERMINAL_BG_COMMAND_TIME seconds to capture the initial output
				await new Promise<void>((resolve) => {
					timeoutTimer = setTimeout(() => {
						resolve();
					}, MAX_TERMINAL_BG_COMMAND_TIME * 1000);
				});

				// Read the captured output from the screen buffer of the visible terminal
				const output = await this.readTerminal(terminalId);
				return {
					result: output,
					resolveReason: { type: 'done', exitCode: 0 } as TerminalResolveReason
				};
			})();

			return {
				interrupt,
				resPromise
			};
		}

		// --- Branch 2: Temporary Terminal (Runs in a hidden background PTY) ---
		const cwd = params.cwd ?? null;
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const rootPath = workspaceFolders[0]?.uri.fsPath || '';
		const ptyCwd = cwd || rootPath;

		const ptyId = await this.terminalPtyService.createPty(ptyCwd);
		this.terminalIdToPtyId[terminalId] = ptyId;
		this.ptyOnCreatedEmitter.fire({ terminalId, ptyId });

		let result = '';
		let resolveReason: TerminalResolveReason | undefined;
		const disposables: IDisposable[] = [];

		const interrupt = () => {
			if (resolveReason) return;
			resolveReason = { type: 'timeout' };
			this.terminalPtyService.killPty(ptyId);
			delete this.terminalIdToPtyId[terminalId];
			disposables.forEach(d => d.dispose());
		};

		const waitForResult = async () => {
			return new Promise<{ result: string, resolveReason: TerminalResolveReason }>(async (resolve) => {
				const stateMachine = new TerminalStateMachine(
					// onCommandFinished
					(output) => {
						if (resolveReason) return;

						let exitCode = 0;
						const completionMatch = output.match(/\]633;D(?:;(\d+))?/);
						if (completionMatch && completionMatch[1] !== undefined) {
							exitCode = parseInt(completionMatch[1], 10);
						}

						resolveReason = { type: 'done', exitCode };
						result = output;
						this.terminalPtyService.killPty(ptyId);
						delete this.terminalIdToPtyId[terminalId];
						disposables.forEach(d => d.dispose());
						resolve({ result: removeAnsiEscapeCodes(result), resolveReason });
					},
					// onAwaitingInput
					(promptText) => {
						this.ptyOnAwaitingInputEmitter.fire({ terminalId, promptText });
					},
					// onOutput
					(data) => {
						// Stream data is collected
					}
				);

				const EOL = isWindows ? '\r' : '\n';

				// Wait for PTY to initialize and print its first prompt (e.g., shell start is complete)
				let hasInitialized = false;
				let initialBuffer = '';
				const promptRegex = /([$#>]|PS\s+[^>]+>)\s*$/;

				await new Promise<void>((resolveReady) => {
					const initListener = this.terminalPtyService.listenPtyData(ptyId)((data) => {
						initialBuffer += data;
						const lines = initialBuffer.split('\n');
						const lastLine = lines[lines.length - 1].trim();
						if (promptRegex.test(lastLine)) {
							hasInitialized = true;
							initListener.dispose();
							resolveReady();
						}
					});
					disposables.push(initListener);

					const initTimeout = setTimeout(() => {
						if (!hasInitialized) {
							initListener.dispose();
							resolveReady();
						}
					}, 2000);
					disposables.push(toDisposable(() => clearTimeout(initTimeout)));
				});

				stateMachine.state = 'Running';

				let timeoutTimer: any;

				const resetTimeout = () => {
					if (timeoutTimer) clearTimeout(timeoutTimer);

					const timeoutMs = MAX_TERMINAL_INACTIVE_TIME * 1000;
					timeoutTimer = setTimeout(() => {
						if (resolveReason) return;
						resolveReason = { type: 'timeout' };
						this.terminalPtyService.killPty(ptyId);
						delete this.terminalIdToPtyId[terminalId];
						disposables.forEach(d => d.dispose());
						
						let finalOutput = removeAnsiEscapeCodes(stateMachine['buffer'] || '');
						if (finalOutput.length > MAX_TERMINAL_CHARS) {
							const half = MAX_TERMINAL_CHARS / 2;
							finalOutput = finalOutput.slice(0, half) + `\n... (output truncated to ${MAX_TERMINAL_CHARS} chars) ...\n` + finalOutput.slice(finalOutput.length - half);
						}
						resolve({ result: finalOutput, resolveReason });
					}, timeoutMs);
				};

				const dataListener = this.terminalPtyService.listenPtyData(ptyId)((data) => {
					resetTimeout(); // Reset the inactive timer on any output activity
					stateMachine.feed(data);
					this.ptyOnOutputEmitter.fire({ terminalId, data });
				});
				disposables.push(dataListener);

				disposables.push(toDisposable(() => {
					if (timeoutTimer) clearTimeout(timeoutTimer);
				}));

				// Start the initial timeout countdown
				resetTimeout();

				// Send the command after PTY is fully ready
				await this.terminalPtyService.writePty(ptyId, command + EOL);
			});
		};

		const resPromise = waitForResult();

		return {
			interrupt,
			resPromise
		};
	}


}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
