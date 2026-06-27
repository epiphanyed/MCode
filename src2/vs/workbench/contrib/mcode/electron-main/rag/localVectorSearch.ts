/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** L2-normalize embedding so cosine similarity equals dot product. */
export function normalizeToFloat32(values: number[] | Float32Array): Float32Array {
	const out = values instanceof Float32Array ? new Float32Array(values) : Float32Array.from(values);
	let sumSq = 0;
	for (let i = 0; i < out.length; i++) {
		sumSq += out[i] * out[i];
	}
	const norm = Math.sqrt(sumSq) || 1;
	for (let i = 0; i < out.length; i++) {
		out[i] /= norm;
	}
	return out;
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		sum += a[i] * b[i];
	}
	return sum;
}

export function embeddingBufferToFloat32(buffer: Buffer, dim: number): Float32Array {
	if (buffer.byteLength !== dim * 4) {
		throw new Error(`[RAG] Embedding buffer size mismatch: expected ${dim * 4}, got ${buffer.byteLength}`);
	}
	return new Float32Array(buffer.buffer, buffer.byteOffset, dim);
}

export function float32ToBuffer(values: Float32Array): Buffer {
	return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

export interface ScoredItem<T> {
	item: T;
	score: number;
}

/** Min-heap keeping the top-K highest scores (ascending order internally). */
export class TopKScoreHeap<T> {
	private readonly maxSize: number;
	private readonly items: ScoredItem<T>[] = [];

	constructor(maxSize: number) {
		this.maxSize = Math.max(1, maxSize);
	}

	push(item: T, score: number): void {
		if (this.items.length < this.maxSize) {
			this.items.push({ item, score });
			this.bubbleUp(this.items.length - 1);
			return;
		}
		if (score <= this.items[0].score) {
			return;
		}
		this.items[0] = { item, score };
		this.bubbleDown(0);
	}

	toSortedDesc(): ScoredItem<T>[] {
		return [...this.items].sort((a, b) => b.score - a.score);
	}

	private bubbleUp(index: number): void {
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (this.items[parent].score <= this.items[index].score) {
				break;
			}
			[this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
			index = parent;
		}
	}

	private bubbleDown(index: number): void {
		const length = this.items.length;
		while (true) {
			const left = index * 2 + 1;
			const right = left + 1;
			let smallest = index;
			if (left < length && this.items[left].score < this.items[smallest].score) {
				smallest = left;
			}
			if (right < length && this.items[right].score < this.items[smallest].score) {
				smallest = right;
			}
			if (smallest === index) {
				break;
			}
			[this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
			index = smallest;
		}
	}
}
