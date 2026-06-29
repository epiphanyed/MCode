/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMode } from '../mcodeSettingsTypes.js';
import { BuiltinToolName } from '../toolsServiceTypes.js';

export function isAgentDeferredEditTool(toolName: string): toolName is 'edit_file' | 'rewrite_file' {
	return toolName === 'edit_file' || toolName === 'rewrite_file';
}

/** Agent 模式下 edit 工具是否应跳过逐次审核、改为任务结束后批量 review。 */
export function shouldDeferAgentEditReview(
	chatMode: ChatMode,
	agentDeferredEditReview: boolean,
	toolName: string,
): boolean {
	return chatMode === 'agent'
		&& agentDeferredEditReview
		&& isAgentDeferredEditTool(toolName);
}
