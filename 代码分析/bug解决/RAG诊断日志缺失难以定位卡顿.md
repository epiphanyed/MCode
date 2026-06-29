# RAG 各阶段无日志，难以定位检索卡顿与 LLM  payload

## 现象

- Chat 使用 RAG 时仅能看到零散 `console.log`，无法判断卡在：
  - 索引等待、embedding、HNSW、rerank、graph expand，还是 LLM 发送。
- 排查 “indexReady 后无输出”“RAG 未注入” 等问题需反复加临时 log。

## 原因

RAG 流水线跨 **渲染进程 → IPC → 主进程 → Ollama**，原先缺少统一的阶段化日志与 LLM 发送摘要，DevTools 与主进程输出也未对齐。

## 修改方案

新增 `common/helpers/ragDebugLog.ts`，提供：

- `ragLogStage(stage, message)` → `[RAG][stage] ...`
- `ragLogJson` / `ragLogPreview`（超长 body 截断）
- `ragLogElapsed(stage, label, startMs)` → `+XXXms`
- `summarizeRetrievedNodes()` → 检索结果摘要

在以下路径插入日志：

| 阶段 tag | 位置 |
|----------|------|
| `hybrid` | `chatThreadService._gatherHybridRagContext` |
| `query` / `embed` / `search` / `route` / `subq` / `graph` / `doclink` / `assemble` | `llamaIndexService.ts` |
| `merge` / `inject` | `ragContextMerger.ts`、`chatThreadService` |
| `LLM][send` | `sendLLMMessageService.ts`（payload 字符数摘要） |

**涉及文件**：
- `common/helpers/ragDebugLog.ts`
- `electron-main/rag/llamaIndexService.ts`
- `electron-main/rag/localSqliteVectorStore.ts`
- `browser/chatThreadService.ts`
- `common/helpers/ragContextMerger.ts`
- `common/sendLLMMessageService.ts`
