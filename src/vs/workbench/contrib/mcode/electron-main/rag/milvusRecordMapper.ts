/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { MetadataMode, type BaseNode } from 'llamaindex';
import { MILVUS_PARTITIONS, type MilvusDocType, type SparseVectorDic } from './milvusConstants.js';
import { encodeSparseVector } from './milvusSparseEncoder.js';

export type { MilvusDocType, SparseVectorDic };
export { MILVUS_PARTITIONS };

export interface MilvusRagRecord {
	chunk_id: string;
	dense_vector: number[];
	sparse_vector: SparseVectorDic;
	doc_type: MilvusDocType;
	text_content: string;
	file_path: string;
	metadata: Record<string, unknown>;
}

export function resolveMilvusDocType(metadata: Record<string, unknown>): MilvusDocType {
	const docType = String(metadata.docType ?? 'code_chunk');
	if (docType === 'git_commit' || docType === 'doc_chunk') {
		return docType;
	}
	return 'code_chunk';
}

export function nodeToMilvusRecord(node: BaseNode, denseVector: number[]): MilvusRagRecord {
	const metadata = { ...node.metadata } as Record<string, unknown>;
	const docType = resolveMilvusDocType(metadata);
	const text = node.getContent(MetadataMode.NONE);
	const filePath = String(metadata.filePath ?? metadata.fileName ?? 'unknown');
	return {
		chunk_id: String(node.id_ ?? filePath),
		dense_vector: denseVector,
		sparse_vector: encodeSparseVector(text),
		doc_type: docType,
		text_content: text,
		file_path: filePath,
		metadata,
	};
}

export function milvusHitToMetadata(hit: Record<string, unknown>): Record<string, unknown> {
	const raw = hit.metadata;
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		return { ...(raw as Record<string, unknown>) };
	}
	return {
		docType: hit.doc_type,
		filePath: hit.file_path,
	};
}
