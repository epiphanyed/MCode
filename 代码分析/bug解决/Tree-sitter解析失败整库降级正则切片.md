# Tree-sitter 解析失败导致整库降级为正则切片

## 现象

- 建索引日志出现 tree-sitter WASM abort、解析超时或 `treeSitterChunker` 不可用。
- 个别大文件（>512KB）解析失败后，**整次会话**内所有文件均降级为正则切片，符号边界质量下降。
- 重建索引时偶发 SQLite `EBUSY`（HNSW 文件仍被占用）。

## 原因

1. **会话级降级**：一次 tree-sitter 失败后设置全局 flag，后续文件不再重试 WASM 解析。
2. **单文件体积限制过严**：超过阈值直接放弃 AST，大但可解析的源文件只能整文件 fallback。
3. **HNSW/SQLite 未释放**：重建索引时旧 store 未 close，Windows 下文件锁导致 EBUSY。

## 修改方案

1. **`treeSitterDeferRetry.ts`**：改为**按文件 defer + 后续重试**，不再 session-wide 永久降级 regex。
2. **解析上限** 512KB → **1MB**（`treeSitterRuntime.ts` / chunker 配置）。
3. 重建前 `localVectorStore.close()` / WAL checkpoint，释放 HNSW 文件句柄。
4. 单元测试 `treeSitterDeferRetry.test.ts`。

**涉及文件**：
- `electron-main/rag/treeSitterDeferRetry.ts`
- `electron-main/rag/treeSitterRuntime.ts`
- `electron-main/rag/semanticCodeChunker.ts`
- `electron-main/rag/llamaIndexService.ts`
- `electron-main/rag/localSqliteVectorStore.ts`
