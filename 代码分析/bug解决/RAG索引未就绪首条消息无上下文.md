# RAG 索引未就绪时首条 Chat 无向量上下文

## 现象

- 打开工作区后立刻在 Chat 提问，日志显示：
  - `vectorContextChars=57`
  - 内容为 `"No context found. RAG index has not been initialized yet."`
  - `hasVector=false`，仅有极少量 LSP 上下文。
- 本地 `%APPDATA%/MCode/LlamaStore/` 下已有完整索引，但首条消息仍像“未建索引”。

## 原因

存在**竞态**：

1. `initializeIndex()` 在后台异步加载 SQLite + HNSW，函数本身很快返回。
2. Chat 发消息时若索引仍在加载，`queryContext()` 时 `localVectorStore` 尚未就绪，返回占位文案。
3. RAG 初始化原先仅绑定在 `ChatThreadService` 构造时触发；若用户未打开 Chat 或 init 未完成，首条查询必然失败。

## 修改方案

1. **`waitForIndexReady(timeoutMs)`**（`llamaIndexService.ts`）：在 `queryContext` 前等待后台 load 完成或超时。
2. **`mcodeRagBootstrap.ts` + `mcodeRagInitContrib.ts`**：工作区 `AfterRestored` 阶段即启动索引加载，不依赖打开 Chat。
3. **`_gatherHybridRagContext`**：先 `await _ragInitPromise`，再 `await waitForIndexReady(120_000)`，最后才 `queryContext`。

**涉及文件**：
- `electron-main/rag/llamaIndexService.ts`
- `browser/mcodeRagBootstrap.ts`
- `browser/mcodeRagInitContrib.ts`
- `browser/chatThreadService.ts`
- `common/mcodeRagTypes.ts`、`browser/mcodeRagService.ts`、`electron-main/mcodeRagMainService.ts`
