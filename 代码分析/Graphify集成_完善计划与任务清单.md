# Graphify 集成：完善计划与任务清单

> 需求：[需求_集成Graphify知识图谱与GraphRAG服务.md](./需求_集成Graphify知识图谱与GraphRAG服务.md)  
> 方案：[方案设计_原生JS集成Graphify与GraphRAG.md](./方案设计_原生JS集成Graphify与GraphRAG.md)  
> 存储：[解析_图存储架构选型.md](./解析_图存储架构选型.md)

---

## 任务总览

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| T0 | Repository Map（symbol + 1-hop graph） | ✅ | `repositoryMapFormatter` |
| T2 | `query_codebase_relations` 工具 | ✅ | calls/imports/inherits/contains |
| T3 | 度中心性 + view payload | ✅ | `computeNodeDegrees` |
| T4 | Webview 刷新、Hub 面板、度大小 | ✅ | `mcodeGraphWebview.ts` |
| T5 | inherits / contains 边 | ✅ | `code-graph-v3` |
| T6 | ~~边表 SQLite 镜像~~ | ➡️ T11 | 原 `code_graph_relations.db` 已废弃 |
| T7 | 离线 graph-vendor bundle | ✅ | `npm run copy-mcode-graph-vendor` |
| T8 | GRAPH_REPORT 架构摘要 | ✅ | payload + Webview |
| T9 | 按文件 hash 跳过图更新 | ✅ | `code_graph_file_hashes.json` |
| T10 | Louvain 社区发现 | ✅ | `graphLouvainCommunities.ts` |
| **T11** | **独立 `code_graph.db` 存储** | ✅ | `codeGraphSqliteStore.ts` |
| **T12** | **DB 按文件增量 sync + 文件级 Louvain + Milvus graph-only** | ✅ | 见 [解析_图存储架构选型.md](./解析_图存储架构选型.md) §3.4 |

---

## T12：图谱增量与社区优化（2026-07）

### 实现要点

1. **`syncFileFromGraph`**：增量索引时按文件更新 SQLite，全量索引结束仍 `syncFromGraph`。
2. **文件级 Louvain**：符号节点 &gt; 6000 时在 file 图上跑 Louvain（`louvain-file`），替代连通分量。
3. **Webview payload 缓存**：`getCodeGraphViewPayload` 按图 revision 缓存 Louvain 结果。
4. **Milvus graph-only**：`mcodeRagSyncContrib` 在 Milvus 模式下仍触发图谱增量（不 re-embed）。

### 验收

- [ ] 单文件保存后 `code_graph.db` 仅更新该文件相关行（非全表 DELETE）。
- [ ] 大图 Graph 面板 Communities 显示 `File-level Louvain`。
- [ ] Milvus 模式下改代码后 Graph / `query_codebase_relations` 仍更新。

---

## T11：图存储重构（2026-07）

### 目标

将图谱持久化从「JSON + 无用边表镜像」升级为 **内存热路径 + JSON checkpoint + 独立 SQLite**。

### 实现要点

1. **新增** `codeGraphSqliteStore.ts`：`code_entities` + `code_relations` + `code_graph_meta`。
2. **删除** `codeGraphRelationStore.ts` / `code_graph_relations.db`。
3. **`llamaIndexService`**：bootstrap、sidecar 写、`queryRelations` SQL 路由。
4. **单测** `codeGraphSqliteStore.test.ts` roundtrip。

---

## 关联解析文档

| 主题 | 文档 |
|------|------|
| 离线 bundle + Louvain | [解析_Graphify离线Bundle与社区发现.md](./解析_Graphify离线Bundle与社区发现.md) |
| 存储选型 | [解析_图存储架构选型.md](./解析_图存储架构选型.md) |

---

*最后更新：2026-07-01 · T12 增量 sync / 文件级 Louvain / Milvus graph-only。*
