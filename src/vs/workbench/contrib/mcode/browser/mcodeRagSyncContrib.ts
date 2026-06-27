/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidRagService, RagFileChange } from '../common/mcodeRagTypes.js';
import { extname } from '../../../../base/common/path.js';

const INCREMENTAL_DEBOUNCE_MS = 2000;
const INDEXABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cpp', '.h', '.hpp', '.c', '.py', '.md', '.txt', '.sci', '.sce', '.m', '.java']);
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git', '.build', 'out', 'build', 'dist']);

class McodeRagSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.mcode.ragSync';

	private readonly pendingChanges = new Map<string, RagFileChange['type']>();
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private workspaceRoot: string | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IVoidRagService private readonly ragService: IVoidRagService,
	) {
		super();

		this.syncWorkspaceRoot();
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.syncWorkspaceRoot();
			this.pendingChanges.clear();
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			if (!this.workspaceRoot) {
				return;
			}
			for (const uri of e.rawDeleted) {
				this.queueChange(uri, 'deleted');
			}
			for (const uri of e.rawAdded) {
				this.queueChange(uri, 'updated');
			}
			for (const uri of e.rawUpdated) {
				this.queueChange(uri, 'updated');
			}
		}));
	}

	private syncWorkspaceRoot(): void {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		this.workspaceRoot = folder?.uri.fsPath;
	}

	private queueChange(uri: URI, type: RagFileChange['type']): void {
		if (uri.scheme !== 'file' || !this.workspaceRoot) {
			return;
		}
		const fsPath = uri.fsPath;
		if (!fsPath.startsWith(this.workspaceRoot)) {
			return;
		}
		if (!this.isPotentiallyIndexable(fsPath)) {
			return;
		}

		if (type === 'deleted') {
			this.pendingChanges.set(fsPath, 'deleted');
		} else if (this.pendingChanges.get(fsPath) !== 'deleted') {
			this.pendingChanges.set(fsPath, 'updated');
		}

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => this.flushPendingChanges(), INCREMENTAL_DEBOUNCE_MS);
	}

	private isPotentiallyIndexable(fsPath: string): boolean {
		const baseName = fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
		if (baseName === 'compile_commands.json' || baseName === '.mcodeignore' || baseName === '.voidignore') {
			return true;
		}
		const segments = fsPath.replace(/\\/g, '/').split('/');
		if (segments.some(s => SKIPPED_DIR_NAMES.has(s))) {
			return false;
		}
		return INDEXABLE_EXTENSIONS.has(extname(fsPath).toLowerCase());
	}

	private async flushPendingChanges(): Promise<void> {
		this.debounceTimer = undefined;
		if (this.pendingChanges.size === 0) {
			return;
		}

		const changes: RagFileChange[] = [...this.pendingChanges.entries()].map(([filePath, type]) => ({ filePath, type }));
		this.pendingChanges.clear();

		try {
			const activeType = await this.ragService.getActiveIndexType();
			if (activeType !== 'local') {
				return;
			}
			await this.ragService.applyIncrementalChanges(changes);
		} catch (e) {
			console.error('[RAG] Incremental sync failed:', e);
		}
	}

	override dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		super.dispose();
	}
}

registerWorkbenchContribution2(McodeRagSyncContribution.ID, McodeRagSyncContribution, WorkbenchPhase.AfterRestored);
