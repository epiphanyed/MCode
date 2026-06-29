/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo } from 'react';
import { Check, ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import { useAccessor, useChatThreadsState } from '../util/services.js';
import { TaskPlan, taskPlanProgress } from '../../../../common/helpers/taskPlanParser.js';

type TaskPlanPanelProps = {
	plan: TaskPlan;
	threadId: string;
	messageIdx: number;
	compact?: boolean;
};

const TaskCheckbox = ({ checked }: { checked: boolean }) => (
	<span
		className={`
			flex-shrink-0 flex items-center justify-center
			w-4 h-4 mt-0.5 rounded-full border
			${checked
				? 'bg-[var(--vscode-checkbox-selectBackground)] border-[var(--vscode-checkbox-border)] text-[var(--vscode-checkbox-foreground)]'
				: 'border-[var(--vscode-checkbox-border)] bg-[var(--vscode-checkbox-background)]'
			}
		`}
	>
		{checked ? <Check size={10} strokeWidth={3} /> : null}
	</span>
);

export const TaskPlanPanel = ({ plan, threadId, messageIdx, compact = false }: TaskPlanPanelProps) => {
	const accessor = useAccessor();
	const chatThreadsService = accessor.get('IChatThreadService');
	const chatThreadsState = useChatThreadsState();

	const collapsed = chatThreadsService.isTaskPlanCollapsed(threadId, messageIdx);

	const isChecked = useCallback((itemId: string, defaultChecked: boolean) => {
		return chatThreadsService.getTaskPlanItemChecked(threadId, messageIdx, itemId, defaultChecked);
	}, [chatThreadsService, threadId, messageIdx, chatThreadsState]);

	const { done, total } = useMemo(() => taskPlanProgress(plan, isChecked), [plan, isChecked]);

	const toggleCollapsed = useCallback(() => {
		chatThreadsService.setTaskPlanCollapsed(threadId, messageIdx, !collapsed);
	}, [chatThreadsService, threadId, messageIdx, collapsed]);

	const onToggleItem = useCallback((itemId: string, defaultChecked: boolean) => {
		chatThreadsService.toggleTaskPlanItem(threadId, messageIdx, itemId, defaultChecked);
	}, [chatThreadsService, threadId, messageIdx]);

	const allDone = done === total && total > 0;

	return (
		<div className={`rounded-lg border border-void-border-3 bg-void-bg-2 overflow-hidden ${compact ? 'my-1' : 'my-2'}`}>
			<button
				type="button"
				onClick={toggleCollapsed}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-void-bg-3 transition-colors"
			>
				{collapsed
					? <ChevronRight size={14} className="text-void-fg-3 shrink-0" />
					: <ChevronDown size={14} className="text-void-fg-3 shrink-0" />
				}
				<ListTodo size={14} className="text-void-fg-2 shrink-0" />
				<span className={`text-sm font-medium truncate ${allDone ? 'text-void-fg-3' : 'text-void-fg-1'}`}>
					{plan.title}
				</span>
				<span className={`ml-auto text-xs shrink-0 px-1.5 py-0.5 rounded ${allDone ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-void-bg-1 text-void-fg-3'}`}>
					{done}/{total}
				</span>
			</button>

			{!collapsed && (
				<div className="border-t border-void-border-3 py-1">
					{plan.items.map(item => {
						const checked = isChecked(item.id, item.initialChecked);
						return (
							<div
								key={item.id}
								role="button"
								tabIndex={0}
								onClick={() => onToggleItem(item.id, item.initialChecked)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										onToggleItem(item.id, item.initialChecked);
									}
								}}
								className="flex items-start gap-2.5 px-3 py-1.5 mx-1 rounded cursor-pointer hover:bg-void-bg-3 transition-colors select-none"
							>
								<TaskCheckbox checked={checked} />
								<span className={`text-sm leading-snug ${checked ? 'line-through text-void-fg-3' : 'text-void-fg-1'}`}>
									{item.text}
								</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

/** Sticky summary bar shown while agent is running. */
export const TaskPlanStickyBar = ({ threadId, messageIdx, plan }: { threadId: string; messageIdx: number; plan: TaskPlan }) => {
	return (
		<div className="mx-2 mb-1">
			<TaskPlanPanel plan={plan} threadId={threadId} messageIdx={messageIdx} compact />
		</div>
	);
};
