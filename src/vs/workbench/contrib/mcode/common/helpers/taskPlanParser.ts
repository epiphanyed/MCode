/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TaskPlanItem = {
	id: string;
	text: string;
	initialChecked: boolean;
};

export type TaskPlan = {
	title: string;
	items: TaskPlanItem[];
};

export type ExtractTaskPlanResult = {
	plan: TaskPlan | null;
	/** Message content with the task block removed (trimmed). */
	body: string;
};

const TASK_SECTION_HEADER = /^(?:#{1,4}\s*)?(?:任务(?:分解|拆解|计划)|(?:task\s*)?(?:breakdown|plan|list)|(?:todo|to-do)s?)[:：]?\s*$/i;

const MARKDOWN_HEADING = /^#{1,6}\s+\S/;

const TASK_LINE_WITH_MARKER = /^(?:\s*)(?:(?:\d+\.)|(?:[-*•])|(?:\[[ xX]\]))\s*(?:\[[ xX]\]\s*)?(.+)$/;

const GFM_TASK_LINE = /^(?:\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/;

function simpleHash(text: string): string {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) - h + text.charCodeAt(i)) | 0;
	}
	return Math.abs(h).toString(36);
}

function makeItemId(index: number, text: string): string {
	return `${index}-${simpleHash(text.trim())}`;
}

function parseTaskLine(line: string): { text: string; initialChecked: boolean } | null {
	const gfm = line.match(GFM_TASK_LINE);
	if (gfm) {
		return { text: gfm[2].trim(), initialChecked: gfm[1].toLowerCase() === 'x' };
	}
	const marked = line.match(TASK_LINE_WITH_MARKER);
	if (marked) {
		const checkedMatch = line.match(/\[[ xX]\]/);
		return {
			text: marked[1].trim(),
			initialChecked: checkedMatch ? checkedMatch[0].toLowerCase() === '[x]' : false,
		};
	}
	return null;
}

function isPlainTaskLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	if (MARKDOWN_HEADING.test(trimmed)) return false;
	if (TASK_SECTION_HEADER.test(trimmed)) return false;
	if (parseTaskLine(trimmed)) return false;
	return trimmed.length >= 3;
}

function buildPlan(title: string, rawItems: { text: string; initialChecked: boolean }[]): TaskPlan | null {
	if (rawItems.length < 2) return null;
	return {
		title,
		items: rawItems.map((item, index) => ({
			id: makeItemId(index, item.text),
			text: item.text,
			initialChecked: item.initialChecked,
		})),
	};
}

function extractTitledSection(lines: string[]): { plan: TaskPlan | null; removeLineRanges: [number, number][] } {
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!TASK_SECTION_HEADER.test(trimmed)) continue;

		const title = trimmed.replace(/^#{1,4}\s*/, '').replace(/[:：]\s*$/, '').trim() || '任务分解';
		const rawItems: { text: string; initialChecked: boolean }[] = [];
		let j = i + 1;
		let blankRun = 0;

		while (j < lines.length) {
			const line = lines[j];
			const t = line.trim();

			if (MARKDOWN_HEADING.test(t) && j > i + 1) break;
			if (!t) {
				blankRun++;
				if (blankRun >= 2) break;
				j++;
				continue;
			}
			blankRun = 0;

			const parsed = parseTaskLine(t);
			if (parsed) {
				rawItems.push(parsed);
				j++;
				continue;
			}
			if (isPlainTaskLine(t)) {
				rawItems.push({ text: t, initialChecked: false });
				j++;
				continue;
			}
			if (rawItems.length > 0) break;
			j++;
		}

		const plan = buildPlan(title, rawItems);
		if (plan) {
			return { plan, removeLineRanges: [[i, j - 1]] };
		}
	}
	return { plan: null, removeLineRanges: [] };
}

function extractGfmTaskList(lines: string[]): { plan: TaskPlan | null; removeLineRanges: [number, number][] } {
	const rawItems: { text: string; initialChecked: boolean; lineIdx: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const parsed = parseTaskLine(lines[i].trim());
		if (parsed && GFM_TASK_LINE.test(lines[i].trim())) {
			rawItems.push({ ...parsed, lineIdx: i });
		} else if (rawItems.length > 0 && !lines[i].trim()) {
			break;
		} else if (rawItems.length > 0 && !GFM_TASK_LINE.test(lines[i].trim())) {
			break;
		}
	}

	if (rawItems.length < 3) return { plan: null, removeLineRanges: [] };

	const plan = buildPlan('Tasks', rawItems.map(({ text, initialChecked }) => ({ text, initialChecked })));
	if (!plan) return { plan: null, removeLineRanges: [] };

	const start = rawItems[0].lineIdx;
	const end = rawItems[rawItems.length - 1].lineIdx;
	return { plan, removeLineRanges: [[start, end]] };
}

function removeLineRanges(lines: string[], ranges: [number, number][]): string {
	if (ranges.length === 0) return lines.join('\n');
	const removeSet = new Set<number>();
	for (const [start, end] of ranges) {
		for (let i = start; i <= end; i++) removeSet.add(i);
	}
	return lines.filter((_, idx) => !removeSet.has(idx)).join('\n').trim();
}

/** Extract an interactive task plan from assistant markdown, if present. */
export function extractTaskPlanFromMarkdown(markdown: string): ExtractTaskPlanResult {
	if (!markdown?.trim()) return { plan: null, body: markdown ?? '' };

	const lines = markdown.split('\n');

	const titled = extractTitledSection(lines);
	if (titled.plan) {
		return {
			plan: titled.plan,
			body: removeLineRanges(lines, titled.removeLineRanges),
		};
	}

	const gfm = extractGfmTaskList(lines);
	if (gfm.plan) {
		return {
			plan: gfm.plan,
			body: removeLineRanges(lines, gfm.removeLineRanges),
		};
	}

	return { plan: null, body: markdown };
}

export function taskPlanProgress(plan: TaskPlan, isChecked: (itemId: string, defaultChecked: boolean) => boolean): { done: number; total: number } {
	const total = plan.items.length;
	const done = plan.items.filter(item => isChecked(item.id, item.initialChecked)).length;
	return { done, total };
}

/** Find the latest assistant message index that contains a task plan. */
export function findLatestTaskPlanInMessages(
	messages: { role: string; displayContent?: string }[],
): { messageIdx: number; plan: TaskPlan } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'assistant' || !m.displayContent) continue;
		const { plan } = extractTaskPlanFromMarkdown(m.displayContent);
		if (plan) return { messageIdx: i, plan };
	}
	return null;
}

export function taskPlanItemKey(messageIdx: number, itemId: string): string {
	return `${messageIdx}:${itemId}`;
}

export function gfmTaskItemId(listIndex: number, text: string): string {
	return makeItemId(listIndex, text);
}
