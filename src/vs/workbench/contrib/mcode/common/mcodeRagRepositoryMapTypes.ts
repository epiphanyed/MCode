/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Result of building [REPOSITORY MAP] content from RAG index (symbol map + code graph). */
export type RepositoryMapIndexResult = {
	content: string;
	/** Paths with no indexed symbols — caller should fall back to live editor text. */
	missingPaths: string[];
};
