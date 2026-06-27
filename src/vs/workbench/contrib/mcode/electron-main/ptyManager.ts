import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import * as pty from 'node-pty';
import * as fs from 'fs';

class PtyInstance {
	public readonly onDataEmitter = new Emitter<string>();
	private ptyProcess: pty.IPty;

	constructor(cwd: string, env?: Record<string, string>) {
		const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
		
		// Validate cwd and throw a clear error if a specified directory does not exist.
		// If no directory is specified, safely fall back to user home or process cwd.
		let safeCwd = cwd;
		if (!safeCwd || typeof safeCwd !== 'string') {
			safeCwd = process.env.USERPROFILE || process.env.HOME || process.cwd() || 'C:\\';
		} else if (!fs.existsSync(safeCwd)) {
			throw new Error(`The directory "${safeCwd}" does not exist. Please verify the path.`);
		}

		this.ptyProcess = pty.spawn(shell, [], {
			name: 'void-agent-pty',
			cols: 120,
			rows: 40,
			cwd: safeCwd,
			env: { ...process.env, ...env }
		});

		this.ptyProcess.onData((data) => {
			this.onDataEmitter.fire(data);
		});
	}

	write(data: string) {
		this.ptyProcess.write(data);
	}

	kill() {
		try {
			if (process.platform !== 'win32') {
				// Send SIGINT to the process group
				process.kill(-this.ptyProcess.pid, 'SIGINT');
			} else {
				this.ptyProcess.kill();
			}
		} catch (e) {
			try {
				this.ptyProcess.kill();
			} catch (err) {
				// Ignore
			}
		}
		this.onDataEmitter.dispose();
	}
}

export class PtyManager {
	private readonly ptyInstances = new Map<string, PtyInstance>();

	createPty(cwd: string, env?: Record<string, string>): string {
		const ptyId = generateUuid();
		const instance = new PtyInstance(cwd, env);
		this.ptyInstances.set(ptyId, instance);
		return ptyId;
	}

	writePty(ptyId: string, data: string): void {
		const instance = this.ptyInstances.get(ptyId);
		if (instance) {
			instance.write(data);
		}
	}

	killPty(ptyId: string): void {
		const instance = this.ptyInstances.get(ptyId);
		if (instance) {
			instance.kill();
			this.ptyInstances.delete(ptyId);
		}
	}

	getOnDataEvent(ptyId: string): Event<string> {
		const instance = this.ptyInstances.get(ptyId);
		if (instance) {
			return instance.onDataEmitter.event;
		}
		return Event.None;
	}
}

export class PtyChannel implements IServerChannel {
	private readonly ptyManager = new PtyManager();

	listen(_: unknown, event: string, arg?: any): Event<any> {
		if (event === 'onPtyData') {
			const ptyId = arg?.ptyId;
			if (!ptyId) {
				throw new Error('onPtyData event requires ptyId argument');
			}
			return this.ptyManager.getOnDataEvent(ptyId);
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call(_: unknown, command: string, arg?: any): Promise<any> {
		try {
			if (command === 'createPty') {
				const cwd = arg?.cwd;
				const env = arg?.env;
				return this.ptyManager.createPty(cwd, env);
			} else if (command === 'writePty') {
				const ptyId = arg?.ptyId;
				const data = arg?.data;
				if (!ptyId || data === undefined) {
					throw new Error('writePty command requires ptyId and data arguments');
				}
				this.ptyManager.writePty(ptyId, data);
			} else if (command === 'killPty') {
				const ptyId = arg?.ptyId;
				if (!ptyId) {
					throw new Error('killPty command requires ptyId argument');
				}
				this.ptyManager.killPty(ptyId);
			} else {
				throw new Error(`Command not found: ${command}`);
			}
		} catch (e) {
			console.error(`PtyChannel call error:`, e);
			throw e;
		}
	}
}
