/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Event } from '../../../../base/common/event.js';

export interface ITerminalPtyService {
	readonly _serviceBrand: undefined;
	createPty(cwd: string): Promise<string>;
	writePty(ptyId: string, data: string): Promise<void>;
	killPty(ptyId: string): Promise<void>;
	listenPtyData(ptyId: string): Event<string>;
}

export const ITerminalPtyService = createDecorator<ITerminalPtyService>('voidTerminalPtyService');

class TerminalPtyService extends Disposable implements ITerminalPtyService {
	readonly _serviceBrand: undefined;
	private readonly _channel: any;

	constructor(@IMainProcessService private readonly mainProcessService: IMainProcessService) {
		super();
		this._channel = this.mainProcessService.getChannel('void-channel-pty');
	}

	async createPty(cwd: string): Promise<string> {
		return this._channel.call('createPty', { cwd });
	}

	async writePty(ptyId: string, data: string): Promise<void> {
		return this._channel.call('writePty', { ptyId, data });
	}

	async killPty(ptyId: string): Promise<void> {
		return this._channel.call('killPty', { ptyId });
	}

	listenPtyData(ptyId: string): Event<string> {
		return this._channel.listen('onPtyData', { ptyId });
	}
}

export class TerminalStateMachine {
	private buffer: string = '';
	public state: 'Idle' | 'Running' | 'AwaitingInput' = 'Idle';

	// Matches typical prompt markers like: user@host:~$ or C:\Users> or PS >
	private readonly promptRegex = /([$#>]|PS\s+[^>]+>)\s*$/;
	// Matches typical interactive prompts: confirm?, [y/N], [Y/n], Password:, y/n ?
	private readonly interactRegex = /(confirm\??|\[y\/n\]|\[Y\/n\]|Password:|y\/n\s*\?)\s*$/i;

	constructor(
		private readonly onCommandFinished: (output: string) => void,
		private readonly onAwaitingInput: (promptText: string) => void,
		private readonly onOutput: (data: string) => void
	) {}

	public feed(data: string) {
		this.buffer += data;
		if (this.buffer.length > 100000) {
			this.buffer = this.buffer.slice(-20000);
		}

		this.onOutput(data);

		const lines = this.buffer.split('\n');
		const rawLastLine = lines[lines.length - 1].trim();
		// Clean up ANSI escape codes and VS Code Shell Integration sequences (e.g. \u001b]633;B\u0007)
		const lastLine = rawLastLine
			.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
			.replace(/\u001b\][^\u0007]*\u0007/g, '')
			.trim();

		if (this.state === 'Running') {
			if (this.promptRegex.test(lastLine)) {
				this.state = 'Idle';
				const out = this.buffer;
				this.buffer = '';
				this.onCommandFinished(out);
			} else if (this.interactRegex.test(lastLine)) {
				this.state = 'AwaitingInput';
				this.onAwaitingInput(lastLine);
			}
		} else if (this.state === 'AwaitingInput') {
			// If it matches prompt now, we are back to Idle or Running
			if (this.promptRegex.test(lastLine)) {
				this.state = 'Idle';
				const out = this.buffer;
				this.buffer = '';
				this.onCommandFinished(out);
			}
		}
	}

	public reset(newState: 'Idle' | 'Running' | 'AwaitingInput') {
		this.state = newState;
		this.buffer = '';
	}
}

registerSingleton(ITerminalPtyService, TerminalPtyService, InstantiationType.Delayed);
