/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';

const MARKDOWN_LINK_REGEX = /!?\[[^\]]*\]\(([^)]+)\)/g;
const ANGLE_LINK_REGEX = /<([^>]+\.[a-zA-Z0-9]+)>/g;

const SKIP_SCHEMES = /^(?:https?:|mailto:|tel:|#|data:)/i;

function normalizeLinkedPath(linkTarget: string, docFilePath: string, workspaceRoot?: string): string | null {
	let target = linkTarget.trim();
	if (target.length === 0 || SKIP_SCHEMES.test(target)) {
		return null;
	}
	target = target.split('#')[0]!.split('?')[0]!;
	if (target.length === 0) {
		return null;
	}

	const docDir = path.dirname(docFilePath);
	let resolved: string;
	if (path.isAbsolute(target)) {
		resolved = path.normalize(target);
	} else {
		resolved = path.normalize(path.join(docDir, target));
	}

	if (workspaceRoot) {
		const rel = path.relative(path.normalize(workspaceRoot), resolved);
		if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
			return rel.replace(/\\/g, '/');
		}
	}
	return resolved.replace(/\\/g, '/');
}

/** Extract resolvable relative/absolute file links from Markdown content. */
export function extractMarkdownLinkedFiles(
	content: string,
	docFilePath: string,
	workspaceRoot?: string,
): string[] {
	const linked = new Set<string>();

	const collect = (rawTarget: string) => {
		const normalized = normalizeLinkedPath(rawTarget, docFilePath, workspaceRoot);
		if (normalized) {
			linked.add(normalized);
		}
	};

	let match: RegExpExecArray | null;
	MARKDOWN_LINK_REGEX.lastIndex = 0;
	while ((match = MARKDOWN_LINK_REGEX.exec(content)) !== null) {
		if (!match[0].startsWith('!')) {
			collect(match[1]);
		}
	}

	ANGLE_LINK_REGEX.lastIndex = 0;
	while ((match = ANGLE_LINK_REGEX.exec(content)) !== null) {
		collect(match[1]);
	}

	return [...linked].sort();
}
