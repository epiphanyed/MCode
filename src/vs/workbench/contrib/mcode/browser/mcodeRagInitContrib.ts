/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidRagService } from '../common/mcodeRagTypes.js';
import { IVoidSettingsService } from '../common/mcodeSettingsService.js';
import { startMcodeRagBootstrap } from './mcodeRagBootstrap.js';

/** Eagerly load the RAG index when a workspace opens, without waiting for chat. */
class McodeRagInitContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.mcode.ragInit';

	constructor(
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IVoidRagService private readonly ragService: IVoidRagService,
	) {
		super();
		void startMcodeRagBootstrap(this.settingsService, this.workspaceContextService, this.ragService);
	}
}

registerWorkbenchContribution2(McodeRagInitContribution.ID, McodeRagInitContribution, WorkbenchPhase.AfterRestored);
