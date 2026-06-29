# RAG 向量检索 docType 过滤后 HNSW 零命中或过少

## 现象

- 大型仓库（10 万+ chunk）检索时日志出现：
  ```
  [RAG][search] HNSW docType filter 0/12; retrying searchK=...
  [RAG][search] HNSW still 0/12 ...; brute force on filtered rows
  ```
- 单次查询触发 **全库 brute-force 扫描**，耗时 1～3 分钟，Chat 长时间无响应。
- 文档类问题（如 Word/SVG 流程）路由到 `doc_chunk` 分区时更容易触发。

## 原因

启用 **Router** 后，`similaritySearch` 带 `docTypes` 过滤。HNSW 按向量近邻返回 topK，再按 `doc_type` 过滤；当目标类型在索引中占比较低时，topK 近邻可能**全部是 code_chunk**，过滤后 hits=0。

原实现过早 fallback 到 SQLite 全表 brute-force（对 16 万行 × 768 维做点积）。

## 修改方案

在 `localSqliteVectorStore.ts` 中改进 HNSW 检索策略：

1. **自适应 `searchK`**：根据 `doc_type` 在库中的占比放大 HNSW 搜索范围（`computeHnswSearchKForDocFilter`）。
2. **二次全量 HNSW 重试**：首次不足时以 `searchK = hnsw.size()` 再搜一轮。
3. **仍不足才 brute-force**：仅在前两步仍 `< topK` 时对过滤行做分批扫描（保留 `onBatchScanned` 让渡事件循环）。
4. 增加 `[RAG][search]` 阶段日志，记录 mode、hits、topScores、样本路径。

**涉及文件**：`electron-main/rag/localSqliteVectorStore.ts`
