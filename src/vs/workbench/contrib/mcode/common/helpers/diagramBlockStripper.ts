/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Fenced blocks that are rendered in UI but waste LLM context (mermaid/drawio/manim). */
const DIAGRAM_FENCE_RE = /```(?:mermaid|drawio|manim)\b[^\n]*\r?\n[\s\S]*?```/gi;

/**
 * Replace diagram fenced code blocks with a short placeholder before sending text to an LLM
 * (RAG context, read_file, chat history). Keeps surrounding prose intact.
 */
export function stripDiagramBlocksForLlm(text: string): string {
	if (!text || !/```(?:mermaid|drawio|manim)\b/i.test(text)) {
		return text;
	}
	return text.replace(DIAGRAM_FENCE_RE, (match) => {
		const lineCount = match.split('\n').length;
		const lang = match.match(/```(mermaid|drawio|manim)/i)?.[1]?.toLowerCase() ?? 'diagram';
		return `[${lang} diagram omitted — ${lineCount} lines]`;
	});
}

/** Strip diagram blocks from tool read_file output (after optional header strip). */
export function stripDiagramBlocksForToolOutput(content: string): string {
	return stripDiagramBlocksForLlm(content);
}
