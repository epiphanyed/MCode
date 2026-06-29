# RAG 日志显示 indexReady=true 后长时间无 Chat 输出

## 现象

- DevTools 已打印：
  ```
  [RAG][hybrid] indexReady=true
  ```
  之后 Chat 长时间无 assistant 回复、无后续 RAG 日志。
- Ollama 终端可能出现 `prompt processing, n_tokens = 12288+`，预处理耗时数十秒。

## 原因

**不是索引仍在加载。** `indexReady=true` 表示 SQLite + HNSW 已就绪；卡顿发生在 **`queryContext` 检索 + 组装**（主进程）以及后续 **LLM prompt 预处理**：

| 阶段 | 典型耗时 |
|------|----------|
| Ollama embedding 冷启动 | 数十秒～数分钟 |
| 16 万 chunk 向量检索 + docType 路由 brute-force 回退 | 1～3 分钟 |
| Orchestrator（子问题、graph expand、doc 关联读文件） | 额外数秒～数十秒 |
| 超长 prompt（含 Mermaid/历史/tool 结果）送本地 LLM | 按 token 数线性增长 |

另外：`[RAG][hybrid]` 在**渲染进程 DevTools**；`[RAG][query]` / `[RAG][embed]` 在**主进程/启动终端**，易被误判为“程序挂死”。

## 修改方案

1. **后台预热**：索引 load 完成后 `warmQueryPipeline()` 预跑 embedding + 一次 similarity search。
2. **Workbench 早启动索引**：`mcodeRagInitContrib` 打开工作区即 bootstrap（见《RAG索引未就绪首条消息无上下文》）。
3. **分阶段耗时日志**：
   - 渲染进程：`queryContext start` → `queryContext done +XXXms`
   - 主进程：`[RAG][query] received`、`retrieve+assemble +XXXms`、`[RAG][embed] ollama +XXXms`
4. **诊断统计异步化**：`getChunkCount` / `getDocTypeCounts` 不再阻塞检索主路径。
5. **（配合）剥离 Mermaid 等 diagram 块**，降低 LLM prompt token（见《Mermaid块占用LLM超长上下文》）。

**涉及文件**：
- `electron-main/rag/llamaIndexService.ts`
- `browser/chatThreadService.ts`
- `common/helpers/ragDebugLog.ts`（`ragLogElapsed`）
