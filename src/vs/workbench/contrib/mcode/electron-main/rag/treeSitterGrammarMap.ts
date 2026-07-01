/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as path from 'path';

/** Maps file extension to @vscode/tree-sitter-wasm grammar file (without .wasm). */
export const TREE_SITTER_GRAMMAR_BY_EXT: Record<string, string> = {
	'.c': 'tree-sitter-cpp',
	'.h': 'tree-sitter-cpp',
	'.cpp': 'tree-sitter-cpp',
	'.hpp': 'tree-sitter-cpp',
	'.cc': 'tree-sitter-cpp',
	'.cxx': 'tree-sitter-cpp',
	'.ts': 'tree-sitter-typescript',
	'.tsx': 'tree-sitter-tsx',
	'.js': 'tree-sitter-javascript',
	'.jsx': 'tree-sitter-javascript',
	'.py': 'tree-sitter-python',
	'.java': 'tree-sitter-java',
	'.go': 'tree-sitter-go',
	'.rs': 'tree-sitter-rust',
	'.cs': 'tree-sitter-c-sharp',
	'.rb': 'tree-sitter-ruby',
	'.kt': 'tree-sitter-kotlin',
	'.kts': 'tree-sitter-kotlin',
};

export function canTreeSitterParse(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() in TREE_SITTER_GRAMMAR_BY_EXT;
}

export function getTreeSitterGrammarForFile(filePath: string): string | undefined {
	return TREE_SITTER_GRAMMAR_BY_EXT[path.extname(filePath).toLowerCase()];
}
