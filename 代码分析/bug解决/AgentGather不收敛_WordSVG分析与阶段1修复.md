# Agent Gather 不收敛：Word SVG 任务分析与阶段 1 修复

> 原文件名：`0630.md`（2025-06-30 log 分析）  
> 基于仓库根目录 `log.txt`（2025-06-30 ~ 07-01 会话）。  
> 任务：**分析 Word 文档 SVG 处理流程，输出 `代码分析\svg.md`（含 mermaid）**。  
> Thread：`8ea68b1c-1cb1-4a99-9332-d9c2659e3c72`。

相关总览：[LLM不收敛.md](./LLM不收敛.md)

---

## 1. 结论（一句话）

**不是「同一文件反复读盘」的旧 loop**，而是 **广度 search/read 探索 + ACTIVE FILES 槽轮换 + 从未 `edit_file` 写 deliverable**；方案 7（ACTIVE FILES）已生效，但 **任务粒度与 prompt 仍允许无限 gather**。

**阶段 1（2026-07）** 已落地 **K3 + A1 + S1**，强制 gather 预算、扩 ACTIVE 槽、限制 search 体积。

---

## 2. 关键指标（log 统计）

| 指标 | 值 |
|------|-----|
| Agent 轮次（Qwen） | **≥16**（log 在 n=16 发送后截断） |
| 主模型 | `openAICompatible/Qwen3-Coder-Next-Q6` |
| `read-registry registered` | **18**（均为新 path/page） |
| `read-registry skipped duplicate` | **0** |
| assistant 调用 `edit_file` / `rewrite_file` | **0**（整份 log） |
| 首轮 `search_for_files "svg"` 结果体积 | **~34,911 chars** → 阶段 1 后 capped **≤8k** |
| payload 峰值 | **~100,243 chars**（n=12） |
| n=16 时 system 体积 | **~36,603 chars** |
| ACTIVE 槽（修复前） | **5** → 修复后 **8** |

---

## 3. 时间线（摘要）

| 阶段 | 行为 | 问题 |
|------|------|------|
| A n=1~4 | 全库 `search svg` ~35k | 探索面过大 |
| B n=5~12 | Word 侧 read + ACTIVE 槽满 | 早期文件被 prune |
| C n=12~16 | DesktopEditor/svg 子树 | 无 md 写入，不收敛 |

---

## 4. 问题点与方案状态

### P1 只 gather 不写 deliverable

| 方案 | 状态 | 实现 |
|------|------|------|
| K1 增量写 md prompt | ✅ | `prompts.ts` |
| K2 占位符导向 edit | ✅ | `convertToLLMMessageService.ts` |
| **K3 Gather 计数警告** | ✅ | `agentGatherBudget.ts` + `convertToLLMMessageService.ts` |
| K4 交付物 Pin | ⬜ | 阶段 2 |

### P2 ACTIVE 槽不足

| 方案 | 状态 | 实现 |
|------|------|------|
| **A1 MAX_ACTIVE_READS=8** | ✅ | `agentGatherBudget.ts`、`convertToLLMMessageService.ts`、`chatThreadService.ts` |
| A2 Pin 首读 | ⬜ | 阶段 3 |

### P3 search 过大

| 方案 | 状态 | 实现 |
|------|------|------|
| **S1 8k cap + 100/page** | ✅ | `prompts.ts`（`MAX_CHILDREN_URIs_PAGE=100`）、`toolsService.ts`、`agentGatherBudget.ts` |
| S2/S3 分析任务 / RAG 优先 | ⬜ | 阶段 2 |

### P4 REPOSITORY MAP read 虚高

| R2 Map 仅首轮 | ⬜ | 阶段 2 |

---

## 5. 阶段 1 代码变更（已实施）

### K3 — 连续 Gather 警告

- **文件**：`common/helpers/agentGatherBudget.ts`
- **逻辑**：倒序扫描 `chatMessages`，统计自上次 user/edit 以来的 gather 工具次数；≥2 时在 Agent system 尾部注入 `[WARNING: CONSECUTIVE GATHERS]`
- **交付物路径**：从 user 消息中的 `.md` 或历史 `edit_file`/`rewrite_file` 推断
- **日志**：`[RAG][gather-budget] count=N deliverable=...`

### A1 — ACTIVE 槽 8

- `MAX_ACTIVE_READS = 8`（统一常量）
- `convertToLLMMessageService` 与 `chatThreadService` registry slice 同步

### S1 — Search 结果上限

- `MAX_CHILDREN_URIs_PAGE`：500 → **100**
- `search_for_files` / `search_pathnames_only` 结果：**≤50 行、≤8000 字符**，超限提示 `search_in_folder`

### 单测

- `common/helpers/agentGatherBudget.test.ts`

---

## 6. 验收清单（待重跑 Word SVG 任务）

- [ ] n=3~5 出现对 `代码分析\svg.md` 的 `edit_file`/`rewrite_file`
- [ ] 无单次 search 结果 > 8k chars
- [ ] log 可见 `[RAG][gather-budget]` 且 n≥3 时 system 含 `CONSECUTIVE GATHERS`
- [ ] `slicedActiveKeysSet` 可达 8
- [ ] 整任务 ≤12 Agent 轮或用户可接受中断点

---

## 7. 后续阶段

| 阶段 | 内容 |
|------|------|
| **2** | K4、R2 Map 仅首轮、S2/S3、P1 fold search |
| **3** | A2 Pin 首读、R1、A3 prune 落盘、K3 硬拒绝 |

---

*最后更新：2026-07-01 · 阶段 1（K3/A1/S1）代码已落地，待同任务回归验证。*
