# MCode RAG 与架构文档索引

> **实现基线（2026-06）**：RAG Phase 0–10 ✅ · Phase 11（模型能力 CDN）⏳  
> **任务追踪**：[TODO.md](./TODO.md) · **路线图**：[设计方案_RAG分阶段实施路线图.md](./设计方案_RAG分阶段实施路线图.md)  
> **已知限制**：[TODO § 已知限制](./TODO.md#已知限制当前实现) · [LlamaIndex §8.5](./设计方案_LlamaIndex接入与优化方案.md#85-已知限制与后续)

---

## 推荐阅读顺序

| 顺序 | 文档 | 适合读者 |
| :--- | :--- | :--- |
| 1 | [TODO.md](./TODO.md) | 想快速了解「做了什么 / 还有什么」 |
| 2 | [设计方案_LlamaIndex接入与优化方案.md](./设计方案_LlamaIndex接入与优化方案.md) | RAG 架构、Settings、IPC、manifest |
| 3 | [解析_切片规则.md](./解析_切片规则.md) | 索引质量、tree-sitter 切片 |
| 4 | [解析_RAG与上下文检索机制.md](./解析_RAG与上下文检索机制.md) | LSP + 向量双通道合并 |
| 4b | [context痛点与优化.md](./context痛点与优化.md) | **Token 消耗痛点与 Phase A–D 优化计划**（Phase A ✅） |
| 5 | [解析_Git与文档索引机制.md](./解析_Git与文档索引机制.md) | git_commit、doc、Milvus 分区 |
| 6 | [设计方案_Milvus混合索引与检索设计.md](./设计方案_Milvus混合索引与检索设计.md) | 上 Milvus、Schema、RRF |
| 7 | [设计方案_RAG智能推荐与模型路由.md](./设计方案_RAG智能推荐与模型路由.md) | 依赖推荐、意图路由 |

---

## RAG 与检索

| 文档 | 说明 |
| :--- | :--- |
| [TODO.md](./TODO.md) | 分阶段任务清单、已知限制、Phase 11 |
| [设计方案_RAG分阶段实施路线图.md](./设计方案_RAG分阶段实施路线图.md) | Phase 0–11 路线图、§7 编排、§10 限制 |
| [设计方案_LlamaIndex接入与优化方案.md](./设计方案_LlamaIndex接入与优化方案.md) | LlamaIndex 主架构、Settings、编排 §8 |
| [解析_RAG与上下文检索机制.md](./解析_RAG与上下文检索机制.md) | Hybrid RAG：LSP + 向量、`mergeRagContexts` |
| [解析_切片规则.md](./解析_切片规则.md) | 语义 / tree-sitter 切片、版权头、doc 注释 |
| [解析_Git与文档索引机制.md](./解析_Git与文档索引机制.md) | Git commit、动态 diff、linkedFiles、增量刷新 |
| [设计方案_Milvus混合索引与检索设计.md](./设计方案_Milvus混合索引与检索设计.md) | Milvus Collection、三分区、Dense+Sparse+RRF |
| [设计方案_本地向量模型设计.md](./设计方案_本地向量模型设计.md) | Ollama / 本地 Embedding 选型 |
| [设计方案_RAG智能推荐与模型路由.md](./设计方案_RAG智能推荐与模型路由.md) | `@file` 依赖推荐、fast/reasoning 路由 |
| [设计方案_LangChain与CodeGraph改造方案.md](./设计方案_LangChain与CodeGraph改造方案.md) | CodeGraph 长期演进、ContextGathering 主进程化 |
| [milvus/README.md](../milvus/README.md) | Milvus Docker 部署与连接 |

---

## 代码架构解析

| 文档 | 说明 |
| :--- | :--- |
| [解析_整体框架.md](./解析_整体框架.md) | 多进程架构、Browser / Main 分工 |
| [解析_browser目录解析.md](./解析_browser目录解析.md) | 渲染进程 `contrib/mcode/browser` |
| [解析_electron-main目录解析.md](./解析_electron-main目录解析.md) | 主进程 LLM、RAG、终端 |
| [解析_common目录解析.md](./解析_common目录解析.md) | 共享类型、Settings、Prompt |
| [解析_ContextWindow管理机制.md](./解析_ContextWindow管理机制.md) | 上下文窗口与 Token 预算 |
| [context痛点与优化.md](./context痛点与优化.md) | Context 组装痛点、Token 量化、CTX-A–D 优化路线 |

---

## Agent、终端与 Git 集成

| 文档 | 说明 |
| :--- | :--- |
| [解析_AgentLoop工作原理分析.md](./解析_AgentLoop工作原理分析.md) | Agent 循环、工具调用 |
| [解析_终端执行原理.md](./解析_终端执行原理.md) | 终端 PTY、心跳、超时 |
| [解析_Aider的Git自动提交与回滚机制.md](./解析_Aider的Git自动提交与回滚机制.md) | `/undo`、自动 commit |
| [设计方案_Aider终端执行器改造方案.md](./设计方案_Aider终端执行器改造方案.md) | 终端执行器设计 |

---

## 其他设计方案

| 文档 | 说明 |
| :--- | :--- |
| [设计方案_UI交互与编辑器增强.md](./设计方案_UI交互与编辑器增强.md) | UI / 编辑器增强 |
| [设计方案_AI图表生成校验与自我修复机制.md](./设计方案_AI图表生成校验与自我修复机制.md) | Mermaid 图表校验 |
| [设计方案_数据安全与MCP沙箱隔离.md](./设计方案_数据安全与MCP沙箱隔离.md) | MCP 与安全 |
| [需求分析_Void深度痛点与优化分析.md](./需求分析_Void深度痛点与优化分析.md) | Void → MCode 痛点分析 |
| [需求分析_Void隐藏痛点与安全隐私分析.md](./需求分析_Void隐藏痛点与安全隐私分析.md) | 安全与隐私 |
| [痛点及优化方案.md](./痛点及优化方案.md) | RAG 索引与 Git SCM 优化分析 |
| [设计方案_Java语义切片优化.md](./设计方案_Java语义切片优化.md) | Java 语义切片与多语言 AST 优化 |
| [设计方案_Scilab语义切片优化.md](./设计方案_Scilab语义切片优化.md) | Scilab 语义切片重构设计 |

---

## 关键代码路径（RAG）

| 路径 | 职责 |
| :--- | :--- |
| `src/vs/workbench/contrib/mcode/electron-main/rag/` | 切片、索引、Milvus、编排、Git |
| `src/vs/workbench/contrib/mcode/electron-main/mcodeRagMainService.ts` | RAG IPC 主进程门面 |
| `src/vs/workbench/contrib/mcode/browser/mcodeRagService.ts` | RAG IPC 渲染进程代理 |
| `src/vs/workbench/contrib/mcode/browser/chatThreadService.ts` | Chat 注入、Hybrid RAG |
| `src/vs/workbench/contrib/mcode/browser/contextGatheringService.ts` | LSP 上下文、依赖推荐 |
| `src/vs/workbench/contrib/mcode/browser/mcodeRagSyncContrib.ts` | 文件变更增量同步 |

**测试**：`npm run test-rag`（需先 `compile`）
