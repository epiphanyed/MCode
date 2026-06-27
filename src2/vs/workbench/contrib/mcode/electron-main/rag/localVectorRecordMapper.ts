/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Document, MetadataMode, type BaseNode } from 'llamaindex';
import { resolveMilvusDocType } from './milvusRecordMapper.js';

export interface LocalVectorRecord {
	chunkId: string;
	filePath: string;
	docType: string;
	textContent: string;
	metadata: Record<string, unknown>;
	embedding: number[];
}

export function nodeToLocalVectorRecord(node: BaseNode, embedding: number[]): LocalVectorRecord {
	const metadata = { ...node.metadata } as Record<string, unknown>;
	const docType = resolveMilvusDocType(metadata);
	const textContent = node.getContent(MetadataMode.NONE);
	const filePath = String(metadata.filePath ?? metadata.fileName ?? 'unknown');
	return {
		chunkId: String(node.id_ ?? filePath),
		filePath,
		docType,
		textContent,
		metadata,
		embedding,
	};
}

export function localVectorRecordToNode(record: LocalVectorRecord): BaseNode {
	return new Document({
		id_: record.chunkId,
		text: record.textContent,
		metadata: record.metadata,
	});
}
