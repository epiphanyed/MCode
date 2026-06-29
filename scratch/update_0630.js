const fs = require('fs');
const path = require('path');

const content = `# 0630 log 分析：Word SVG 任务 Agent 多轮不收敛

基于仓库根目录 \`log.txt\`（2025-06-30 ~ 07-01 会话）。  
任务：**分析 Word 文档 SVG 处理流程，输出 \`代码分析\\svg.md\`（含 mermaid）**。  
Thread：\`8ea68b1c-1cb1-4a99-9332-d9c2659e3c72\`。

相关总览文档：[LLM不收敛.md](./LLM不收敛.md)

---

## 1. 结论（一句话）

**不是「同一文件反复读盘」的旧 loop**，而是 **广度 search/read 探索 + ACTIVE FILES 5 槽轮换 + 从未 \`edit_file\` 写 deliverable**；方案 7（ACTIVE FILES）已生效，但 **任务粒度与 prompt 仍允许无限 gather**。

---

## 2. 关键指标（log 统计）

| 指标 | 值 |
|------|-----|
| Agent 轮次（Qwen） | **≥16**（log 在 n=16 发送后截断） |
| 主模型 | \`openAICompatible/Qwen3-Coder-Next-Q6\`（中间曾切 Gemini，本文不展开） |
| \`read-registry registered\` | **18**（均为新 path/page） |
| \`read-registry skipped duplicate\` | **0** |
| assistant 调用 \`edit_file\` / \`rewrite_file\` | **0**（整份 log） |
| 首轮 \`search_for_files "svg"\` 结果体积 | **~34,911 chars** |
| payload 峰值 | **~100,243 chars**（n=12） |
| n=16 时 system 体积 | **~36,603 chars**（含 ACTIVE FILES + REPOSITORY MAP + tools） |
| \`was pruned\` 占位符出现 | **多次**（CSvgFile、CSvgParser、SvgReader 等） |

---

## 3. 时间线

### 阶段 A：n=1~4 — 全库搜索

\`\`\`text
用户：分析 Word SVG → 代码分析\\svg.md
assistant → search_for_files "svg"        → ~35k 字符路径列表
assistant → search_for_files "word svg"   → 空
assistant → search_for_files "OOXShapeReader" → 命中 RtfFile/OOXml/Reader
\`\`\`

问题点：**搜索面过大**，尚未聚焦 Word 主路径。

### 阶段 B：n=5~12 — Word 侧阅读 + payload 涨

- \`read_file\` \`OOXShapeReader.cpp\` **p1 → p2 → p3**（分页正常）
- 再读 \`OOXDrawingGraphicReader.cpp\`、\`OdfFile/.../svg_parser.cpp\` 等
- \`[ACTIVE FILES CONTEXT]\` 生效：\`hasKey: true\`，history 为短占位符
- \`slicedActiveKeysSet\` 从 1 个 key 增至 **5 个**（槽满）
- payload：15k → 51k → **100k**

问题点：**读文件数超过 5 槽**，早期 Word 文件被 **prune** 出 ACTIVE。

### 阶段 C：n=12~16 — DesktopEditor/svg 子树

- 探索重心转到 \`DesktopEditor\\raster\\Metafile\\svg\\\`（CSvgFile、CSvgParser、SvgReader、CContainer…）
- REPOSITORY MAP 引导 **按行号区间 read**（如 \`CSvgParser.cpp lines 1-200\`），read key 数量进一步膨胀
- n=16 最后一调仍为 \`read_file\` → \`CContainer.cpp\`
- log 结束，**无 md 写入**

问题点：**Word 路径信息已 prune**，模型继续在另一子树 gather，**不收敛到写 md**。

---

## 4. 问题点拆解

### P1. 任务不收敛：只 gather，不写 deliverable（主因）

- 整份 log **无任何** assistant 发出的 \`edit_file\` / \`rewrite_file\`
- 用户目标明确（\`代码分析\\svg.md\`），模型行为却是 **search → read → read → …**
- 与旧案例（43 轮读同一 4 文件）不同：本次是 **不断读新文件**

**根因**：Agent prompt 原强调「**ALL relevant context 再改**」；分析类任务在 monorepo 上等价于 **无限探索**。

**已修（0630 后）**：\`prompts.ts\` 强制 **增量写 md**（读 1–2 文件 → edit_file 追加 → 再读；连续 2 次 read/search 后必须 edit）。见 [LLM不收敛.md §11](./LLM不收敛.md)。

---

### P2. ACTIVE FILES 5 槽 → 轮换 + prune 提示再读

- \`MAX_ACTIVE_READS = 5\`：第 6 个 read 起，最早文件不在 \`[ACTIVE FILES CONTEXT]\`
- history 占位符：\`content was pruned … Call read_file again\`
- 模型既 **读新文件**，也可能 **为「补全记忆」再读旧文件** → 轮次增加，仍不写 md

**与旧 compaction summary loop 的区别**：全文在 system 的 ACTIVE 块里，history 已轻量化；瓶颈是 **同时需要的文件数 > 5**。

**待观察 / 可选改**：\`MAX_ACTIVE_READS\` 5→8；pruned 文案已改为「优先 edit md，仅为新章节再 read」（\`convertToLLMMessageService.ts\`）。

---

### P3. search 结果过大，扰动前几轮

- 首次 \`search_for_files "svg"\` → **~35k chars** 进 history
- 加剧 payload 膨胀与模型「路径过多、不知先读谁」

**可选改**：限制 search 结果条数/字符上限，或 prompt 要求先缩小 \`search_in_folder\`。

---

### P4. REPOSITORY MAP + 行号 read → read 次数虚高

- system 鼓励：见 REPOSITORY MAP 后用 \`start_line\` / \`end_line\` 精读
- 同一文件可能出现 **整页 read** + **lines 1-200 read** 两个 key（如 \`csvgparser.cpp:p1\` 与 \`:p1:lines1-200\`）
- 占用 active 槽，加速 prune

**已修（方案 H）**：区间纳入 active key 与 CONTEXT 标题。仍会增加 read 调用次数，需配合 **增量写 md** 才能收敛。

---

### P5. payload / system 仍偏大（性能，非主因）

| 轮次 | payload totalChars |
|------|-------------------|
| n=1 | ~15,804 |
| n=5 | ~74,441 |
| n=12 | ~100,243 |
| n=16 | ~43,466 |

- system ~36k：tools 定义 + **REPOSITORY MAP** + **ACTIVE FILES**（多文件时）
- ACTIVE 内容变化 → llama-server **KV cache 前缀可能失效**（若仍有 \`erased invalidated checkpoint\`，见 [解析_context体积与KV_cache原理.md](../解析_context体积与KV_cache原理.md)）

方案 7 已避免 history 里堆全文；**system 变动**仍是性能变量。

---

### P6. 已读列表：本次未触发 duplicate 拦截

- \`skipped duplicate\` = **0** → 不是「同 key 反复读盘」
- \`registered\` = 18 → 几乎每次 read 都是 **新 path/page**
- 说明 **read-registry + ACTIVE 同步** 对「重复读盘」有效，**不能单独解决「读不完、不写 md」**

---

## 5. 与旧 SVG 案例（43 轮同 4 文件）对比

| 维度 | 旧案例 | **0630 log** |
|------|--------|--------------|
| 重复读盘 | 同一 4 文件 43+ 次 | **无**（0 skipped duplicate） |
| 机制 | compaction fold → 以为没读过 | **5 槽 prune + 广度 search/read** |
| ACTIVE FILES | 无 / 早期 | **有**，占位符 + system 注入 |
| 写 md | 无 | **仍无** |
| 修复方向 | read-registry | **增量写 md + 任务拆分** |

---

## 6. 已实施修复（与本 log 相关）

| 方案 | 状态 | 本 log 是否体现 |
|------|------|----------------|
| RAG 仅首轮注入 | ✅ | \`[RAG][inject] skipped\` n≥2 |
| read_files 16k 合并页 | ✅ | 分页 p1~p3 正常 |
| 线程 read-registry | ✅ | 18× registered，0 duplicate |
| ACTIVE FILES（方案 7） | ✅ | \`[ACTIVE FILES CONTEXT]\`、\`hasKey: true\` |
| 区间 key / read_files 分页对齐（H/J） | ✅ 代码已有 | 本次有 lines1-200 key |
| **强制增量写 md（§11）** | ✅ 0630 后改 prompt | **本 log 早于该改动** |

---

## 7. 复现后验证 checklist

重新 \`gulp compile\` 后，同一任务看 log：

1. **n=3~5** 内出现 \`rewrite_file\` / \`edit_file\` 写 \`代码分析\\svg.md\`
2. 连续 read/search **不超过 2 次** 后必有 edit（prompt 硬规则）
3. \`[read_file success] … edit_file to append\` 占位符出现
4. \`skipped duplicate\` 仍可为 0（正常，说明在读新文件而非重复读盘）
5. payload 仍可能 40k~80k，但 **轮次应 <10 完成 md**（若模型服从 prompt）

**用户指令建议（配合 prompt）**：

\`\`\`text
先只分析 RtfFile/OOXml/Reader/OOXShapeReader*，读完立即写 代码分析\\svg.md 第一节；
再读 CSvgFile 相关，追加第二节。不要全库 search svg。
\`\`\`

---

## 8. 相关文件

| 文件 | 作用 |
|------|------|
| \`log.txt\` | 原始控制台 log |
| \`common/prompt/prompts.ts\` | Agent 增量写 md 规则 |
| \`browser/convertToLLMMessageService.ts\` | ACTIVE FILES + 占位符 |
| \`browser/chatThreadService.ts\` | read-registry 与 agent 循环 |
| \`common/helpers/agentReadRegistry.ts\` | 已读 key / already-read 文案 |

---

## 9. 修改方案（针对 0630 问题点 — 优化版）

按 **问题 → 方案 → 涉及模块** 汇总；✅ 表示 0630 会话后已落地，⬜ 待做。

### 9.1 写不出 deliverable（P1 — 最高优先级）

| 方案 | 内容 | 状态 | 涉及文件 |
|------|------|------|----------|
| **K1 增量写 md prompt** | 读 1–2 文件 → edit/rewrite 目标 .md；连续 2 次 read/search 后必须 edit；禁止 ALL context 再写 | ✅ | \`prompts.ts\` |
| **K2 占位符导向 edit** | ACTIVE / already-read / pruned 文案指向 append deliverable .md | ✅ | \`convertToLLMMessageService.ts\`、\`agentReadRegistry.ts\` |
| **K3 动态 Gather 计数警告（优化版）** | 无状态计算当前 turn 的连续 gather 次数（倒序扫描 \`chatMessages\` 直到 \`user\` 或编辑成功）；≥2 时在 system prompt 尾部注入 \`[WARNING: CONSECUTIVE GATHERS]\` 强警告 | ⬜ | \`convertToLLMMessageService.ts\` |
| **K4 交付物自动置顶 Pin（优化版）** | 提取历史中被 \`edit_file\` / \`rewrite_file\` 修改过的交付物/代码文件，读取最新内容并固定注入到 \`[MODIFIED DELIVERABLES CONTEXT]\` 中，解决折叠后的遗忘问题 | ⬜ | \`convertToLLMMessageService.ts\` |

**目标**：log 中 **n≤5** 出现对 \`代码分析\\svg.md\` 的 edit，整任务 **n≤12** 完成。

---

### 9.2 ACTIVE 槽不足与 prune（P2）

| 方案 | 内容 | 状态 | 涉及文件 |
|------|------|------|----------|
| **A1 提高槽位** | \`MAX_ACTIVE_READS\` 5 → **8**（65536 ctx 下可接受） | ⬜ | \`convertToLLMMessageService.ts\`、\`chatThreadService.ts\`（registry 同步处） |
| **A2 Pin 首读文件** | 每 thread 前 2 个 read key **不参与 prune 轮换**（或通过 K4 机制对已编辑文件置顶） | ⬜ | \`convertToLLMMessageService.ts\` |
| **A3 prune 落盘（中长期）** | 被挤出 ACTIVE 的全文写 thread 缓存文件；CONTEXT 留 path，需要时用 read 读 cache | ⬜ | 新 \`activeReadCache.ts\` + tool 或 internal read |

**目标**：Word 侧 OOXShapeReader p1~p3 在写 md 第一节期间 **始终在 ACTIVE 或 Pin**。

---

### 9.3 search / 探索面过大（P3）

| 方案 | 内容 | 状态 | 涉及文件 |
|------|------|------|----------|
| **S1 全局结果上限（优化版）** | 将全局 \`MAX_CHILDREN_URIs_PAGE\` 从 500 降低至 **100**（约 7k-8k 字符），规避单次 search 结果过大。需要时可通过 page_number 分页。 | ⬜ | \`prompts.ts\` |
| **S2 分析任务 prompt** | 检测到输出 \`.md\` 时：禁止全库泛搜 \`query=svg\`；必须先 \`search_in_folder\` 或 RAG | ⬜ | \`prompts.ts\` 或 \`chatThreadService.ts\` 动态 system 片段 |
| **S3 RAG 优先** | Agent 首轮已有 RAG 时，system 加一句：**勿重复 search 全库** | ⬜ | \`chatThreadService.ts\`（RAG inject 处） |

**目标**：首轮 tool 结果 **<10k chars**，避免 35k 路径列表进 history。

---

### 9.4 REPOSITORY MAP 与 read 虚高（P4）

| 方案 | 内容 | 状态 | 涉及文件 |
|------|------|------|----------|
| **R1 Map 按需** | 仅为 **当前 ACTIVE 文件** 生成签名，不每轮对 opened+recent 全量 map | ⬜ | \`convertToLLMMessageService.ts\`、\`repositoryMapService.ts\` |
| **R2 Map 仅首轮（优化版）** | 无状态判断首轮：检查 \`chatMessages[chatMessages.length - 1].role === 'user'\`。仅首轮注入 REPOSITORY MAP，后续轮次完全省略以稳定 KV Cache 并节省 Token。 | ⬜ | \`convertToLLMMessageService.ts\` |
| **R3 区间 read 软限** | prompt：已有整页 read 后 **同一文件不再 lines read**，除非 edit 需要补细节 | ⬜ | \`prompts.ts\` read_file 描述 |

**目标**：system 体积 **稳定**，减少「map 指路 → 再 read 10 个文件」链。

---

### 9.5 payload / 性能（P5 — 次要）

| 方案 | 内容 | 状态 | 涉及文件 |
|------|------|------|----------|
| **P1 fold search 结果** | compaction 对 \`search_*\` / \`get_dir_tree\` / \`ls_dir\` 折叠为摘要（read 仍走 ACTIVE） | ⬜ | \`agentContextCompaction.ts\` |
| **P2 llama 后端** | \`--parallel 1\`、\`-c 65536\` 与 IDE sync | ✅ | 运维 |
| **P3 system 前缀稳定** | Pin 文件 + Map 首轮-only → 提高 KV cache 命中 | ⬜ | 依赖 A2、R2 |

---

### 9.6 用法层（零代码，与代码方案并行）

| 做法 | 说明 |
|------|------|
| **拆对话** | 对话 1：Word 路径 + md 第一节；对话 2：DesktopEditor svg + 第二节 |
| **窄指令** | 明确目录 + 禁止 \`search svg\` 全库 |
| **@ 文件** | 用 @ 钉住 OOXShapeReader，减少盲目 search |

---

## 10. 修改计划（分阶段执行 — 优化版）

### 阶段 0 — 已完成（0630 后）

| 序号 | 项 | 验证 |
|------|-----|------|
| 0.1 | K1 + K2 增量写 md prompt / 占位符 | 重跑任务，查 log 是否 n≤5 有 edit |
| 0.2 | 文档 | \`LLM不收敛.md §11\`、\`0630.md\` |

---

### 阶段 1 — 下一批（小改、高 ROI，建议 1~2 天）

| 序号 | 方案 | 改动量 | 预期效果 |
|------|------|--------|----------|
| 1.1 | **K3** 动态 Gather 计数警告（无状态） | 小 | 连续 2 次以上只读不写时强力纠偏，避免死循环 |
| 1.2 | **A1** \`MAX_ACTIVE_READS = 8\` | 小 | 提升活跃缓存槽，减少 prune 与 re-read 次数 |
| 1.3 | **S1** search 页容量降至 100 | 小 | 避免 35k 超长路径列表撑爆 context |

**验收**（同 §7 checklist +）：
- [ ] n=3~5 必有 \`edit_file\`/\`rewrite_file\` 写目标 md  
- [ ] 无单次 \`search_for_files_result\` > 8k chars  
- [ ] \`slicedActiveKeysSet\` 可达 8 个 key  
- [ ] 同一任务 **≤12 Agent 轮** 或用户可接受的中断点  

**涉及 PR 文件**：\`convertToLLMMessageService.ts\`、\`prompts.ts\`、\`chatThreadService.ts\`。

---

### 阶段 2 — 收敛与性能（3~5 天）

| 序号 | 方案 | 改动量 | 预期效果 |
|------|------|--------|----------|
| 2.1 | **K4** 交付物自动置顶 Pin | 中 | 已编辑文件在 system prompt 头部置顶且为最新内容，防折叠后遗忘 |
| 2.2 | **R2** REPOSITORY MAP 仅首轮 | 小 | 后续轮次移除 map，极大稳定 KV Cache，降低 Prefill 耗时 |
| 2.3 | **S2 + S3** 分析任务禁全库 search / RAG 优先 | 小 | 探索面可控 |
| 2.4 | **P1** fold search 类 tool 结果 | 小 | payload 峰值下降 |

**验收**：
- [ ] n=12 时 payload **<80k**（同任务对比 0630 的 100k）  
- [ ] system 中 REPOSITORY MAP 仅 n=1 (首轮) 出现  
- [ ] 完成 md 后 assistant 以总结消息结束，非继续 read  

---

### 阶段 3 — 可选增强（按需）

| 序号 | 方案 | 触发条件 |
|------|------|----------|
| 3.1 | **A2** Pin 首读 2 文件 | 阶段 1 后仍频繁 prune 丢 Word 上下文 |
| 3.2 | **R1** Map 仅 ACTIVE 文件 | Map 仍 >5k chars/轮 |
| 3.3 | **A3** ACTIVE prune 落盘 | 需要 re-read 被 prune 内容且不想扩 ctx |

---

### 10.1 优先级总览

```text
P0（必做）  K3 + A1 + S1     ← 阶段 1
P1（建议）  K4 + R2 + S2/S3 + P1  ← 阶段 2
P2（按需）  A2 / R1 / A3     ← 阶段 3
已完成      K1 K2 + ACTIVE + registry + 分页/区间 key
```

### 10.2 不建议本阶段做

| 项 | 原因 |
|----|------|
| sticky 折叠全文 | 易超 65536（历史 69703 教训） |
| dedupe replay 全文 | context snowball |
| 整段 Codex 式 auto-compact | 改动面大；先靠 ACTIVE + 增量 md |
| Gemini read_files 路径 JSON | 用户明确暂不处理 |

---

## 11. 阶段 1 实施清单（开发可直接拆 task — 优化版）

1. **\`convertToLLMMessageService.ts\` — K3 (动态连续 Gather 计数)**
   - 在 \`prepareLLMChatMessages\` 中倒序遍历当前转的 \`chatMessages\`。
   - 遇到 \`user\` 角色或成功编辑工具 (\`edit_file\` / \`rewrite_file\` / \`create_file_or_folder\` / \`delete_file_or_folder\`) 停止。
   - 累加其中的 gather 工具调用数 (\`read_file\`, \`read_files\`, \`search_for_files\`, \`search_in_folder\`, \`ls_dir\`, \`get_dir_tree\`)。
   - 若计数 \`consecutiveGathers >= 2\`，在 system prompt (即 \`systemMessage\`) 的末尾拼入警告段落：
     \`[WARNING: CONSECUTIVE GATHERS] You have called read/search tools \${consecutiveGathers} times in a row without making any edits or writing progress. To avoid infinite loops and context thrashing, you MUST now write your findings or changes to the target file (using edit_file or rewrite_file) to record your progress. Do NOT call read_file, read_files, search_for_files, or search_in_folder again until you have written/modified a file.\`

2. **\`convertToLLMMessageService.ts\` — A1 (MAX_ACTIVE_READS 扩容)**
   - 修改 \`const MAX_ACTIVE_READS = 8;\`
   - 修改 \`chatThreadService.ts\` 同步 activeReadRegistry 处的 slice 长度为 8：\`const activeReadRegistry = activeReadKeys.slice(0, 8);\`

3. **\`prompts.ts\` — S1 (全局 Search 单页上限降为 100)**
   - 将 \`export const MAX_CHILDREN_URIs_PAGE = 100\` （原来为 500）。

4. **回归**
   - \`gulp compile\` + 0630 同任务 + 对照 §7 checklist。
`;

fs.writeFileSync(path.join(__dirname, '../代码分析/bug解决/0630.md'), content, 'utf8');
console.log('Successfully updated 0630.md!');
