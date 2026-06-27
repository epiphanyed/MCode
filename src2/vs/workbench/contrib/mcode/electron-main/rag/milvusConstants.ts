/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Milvus metadata types — no SDK dependency (safe to import at startup). */

export type MilvusDocType = 'code_chunk' | 'git_commit' | 'doc_chunk';

export type SparseVectorDic = Record<string, number>;

export const MILVUS_PARTITIONS: Record<MilvusDocType, string> = {
	code_chunk: 'code_partition',
	git_commit: 'git_partition',
	doc_chunk: 'doc_partition',
};
