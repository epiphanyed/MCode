# read_files 分页截断后 LLM 不续读

## 问题现象

1. **`read_files` / `read_file` 返回被分页截断**，tool 结果末尾出现：
   ```text
   (more on next page...)

   More info: combined 64222 chars across 2 files. Pages are 8000 chars — use pageNumber for more.
   ```
2. **LLM 几乎从不请求第 2 页**：对同一组 `uris` 调用 `page_number=2` 的情况在 `log.txt` 中为 **0 次**。
3. **截断后 LLM 常见行为**：
   - 改读**另一批文件**（`read_files` 新路径）；
   - 或换工具（`get_dir_tree`、`edit_file` 等）；
   - **未读到的后半段源码从未进入上下文**，Agent 仍可能基于不完整信息写分析或改代码。

---

## log.txt 证据（同一线程）

| 指标 | 数量 |
|------|------|
| `(more on next page...)` / `use pageNumber for more` | **31** |
| assistant 调用中带 `<page_number>2</page_number>`（或任意非 1 的页码） | **0** |
| `<read_files>` 工具调用总数 | ≈82 |

### 典型片段 1：3 个 svg — 截断后换文件

```text
message[8] assistant → read_files(CSvgFile.cpp, CSvgParser.cpp, SvgReader.cpp)   # 无 page_number
message[9] tool result → 24162 chars，末尾 (more on next page...)
                       More info: combined 25960 chars across 3 files. Pages are 24000 chars — use pageNumber for more.

message[10] assistant → read_files(CContainer.h, CObjectBase.h, IRenderer.h)   # 新文件，不是 page 2
```

### 典型片段 2：2 个 Emf — 64k 只看了 16k

```text
message[15] tool result → 16162 chars，末尾 (more on next page...)
                       More info: combined 64222 chars across 2 files. Pages are 16000 chars — use pageNumber for more.

message[16] assistant → get_dir_tree(Wmf)   # 换工具，不是续页
```

约 **75% 的合并内容（46000+ chars）从未被 LLM 读取**。

### 对照：未截断的 read_files 正常

例如读 3 个头文件，结果约 **6356 chars**（低于当时页上限），无 `(more on next page...)`，后续分析可正常进行。

---

## 问题分析

### 1. 分页是「被动提示」，不是自动续读

MCode 在 `toolsService.ts` 中拼接截断提示：

```typescript
const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

read_files: (params, result) => {
  return `${result.combinedContents}${nextPageStr(result.hasNextPage)}${result.hasNextPage
    ? `\nMore info: combined ${result.totalCombinedLen} chars across ${params.uris.length} files. Pages are ${pageSize} chars — use pageNumber for more.`
    : ''}`
}
```

**是否续页完全依赖 LLM 下一次 tool 调用**；Agent 循环不会自动拉取下一页。

### 2. 当前 prompt 对分页约束过弱

`prompts.ts` 中所有带分页的工具共用：

```typescript
const paginationParam = {
  page_number: { description: 'Optional. The page number of the result. Default is 1.' }
}
```

`read_files` 描述仅说明批量读、去 header，**未说明截断后必须续页**：

```typescript
read_files: {
  description: `Read multiple files in one call. Prefer this when comparing or inspecting 2+ related files ... Max ${MAX_READ_FILES_BATCH} paths per call.`,
  params: { uris: ..., ...paginationParam },
}
```

`systemToolsXMLPrompt` 的 `Tool calling details` 也**没有**分页续读规则。

### 3. LLM 行为模式

| 行为 | 原因 |
|------|------|
| 截断后读别的文件 | 模型把「继续理解代码」等同于「再读一些相关路径」，而非「同一批 uri + page 2」 |
| 截断后 `get_dir_tree` / `edit_file` | 认为当前信息「够用」，或优先推进任务 |
| 从不填 `page_number` | 参数标为 Optional，默认 1；无 MUST 级约束 |

### 4. 与「固定 8k 合并页」的关系

已实现 `MAX_READ_FILES_COMBINED_PAGE = 8000`（不再按文件数 × 8k 放大），**截断会更频繁**，若 LLM 仍不续读，**丢内容问题会更突出**。本 bug 与上下文膨胀文档中的分页上限优化是**独立但叠加**的问题。

---

## 问题原因（归纳）

| # | 原因 | 说明 |
|---|------|------|
| 1 | **无 MUST 级续页规则** | system prompt / 工具描述未强制「见 `(more on next page...)` 必须续读」 |
| 2 | **`page_number` 描述过弱** | 仅 "Optional. Default is 1."，模型易忽略 |
| 3 | **被动分页设计** | 框架不自动 fetch 下一页，全靠 LLM 自觉 |
| 4 | **截断发生在文件中间** | 8k 可能在 `.cpp` 中段切断，模型误判「已读完」 |

---

## 修改方案：在 system prompt / read_files 描述中加硬规则

> **原则**：不引入 Agent 侧自动续读逻辑；仅通过 prompt 把「截断 → 续页」变成与「一次只能调一个 tool」同级别的硬约束。

### 方案 A：强化 `read_files` / `read_file` 工具描述（`prompts.ts`）

**`read_file.description` 追加**（单文件同样适用）：

```text
If the result ends with "(more on next page...)", you MUST immediately call read_file again with the SAME uri and page_number set to the next page (2, then 3, …) until that marker disappears. Do NOT switch to other files or tools until you have read all pages of the file you are analyzing.
```

**`read_files.description` 重写为**（保留原有 batch 语义 + 硬规则）：

```text
Read multiple files in one call. Prefer this when comparing or inspecting 2+ related files (e.g. header pairs). Copyright/license headers and mermaid/diagram blocks are stripped automatically. Max ${MAX_READ_FILES_BATCH} paths per call.

PAGINATION (required): Results are capped at ${MAX_READ_FILES_COMBINED_PAGE} combined chars per page. If the result ends with "(more on next page...)", you MUST call read_files again with the EXACT SAME uris array and page_number incremented (2, then 3, …) until the marker is gone. Do NOT read different files or call other tools until all pages for the current uris are fetched.
```

**`paginationParam.page_number.description` 改为**：

```text
Required when continuing pagination. Use 1 for the first page (default). If the previous result contained "(more on next page...)", you MUST call again with page_number = previous page + 1 and the SAME uri(s).
```

### 方案 B：在 Agent system prompt 增加全局分页规则（`prompts.ts` → `systemToolsXMLPrompt` 或 `chat_systemMessage` details）

在 `Tool calling details` 末尾追加（**仅 agent / gather 模式**，或所有带 read 工具的模式）：

```text
Pagination for read_file / read_files:
- When ANY read_file or read_files result ends with "(more on next page...)", your VERY NEXT tool call MUST be the same tool with the SAME path(s) and page_number = previous page + 1.
- Do NOT analyze, edit, or read unrelated paths until every page of the current read is complete (no "(more on next page...)" in the last read result).
- Treat missing pages as incomplete context — never assume the truncated snippet is the full file.
```

### 方案 C（可选，与 A/B 叠加）：tool 结果文案微调

在 `toolsService.ts` 的 `More info` 行把 `use pageNumber for more` 改为更指令化（非必须，A/B 为主）：

```text
ACTION REQUIRED: call read_files again with the SAME uris and page_number=<next>.
```

---

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/vs/workbench/contrib/mcode/common/prompt/prompts.ts` | `read_file` / `read_files` description、`paginationParam`、可选 `systemToolsXMLPrompt` / `chat_systemMessage` |
| `src/vs/workbench/contrib/mcode/browser/toolsService.ts` | （可选）`More info` 文案加强 |

**不改动**：分页切片逻辑、`MAX_READ_FILES_COMBINED_PAGE`、Agent 自动续读（本方案明确不做）。

---

## 验证方法

1. 编译并启动 MCode（改 prompt 后需 compile，无需 buildreact）：
   ```powershell
   node --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js compile
   .\scripts\code.bat
   ```
2. 构造必截断场景：Agent 一次 `read_files` 2~3 个大 `.cpp`（合并 > 8k chars）。
3. 观察 `log.txt` / 控制台 `[LLM][send]`：
   - 第一次 tool result 含 `(more on next page...)`
   - **下一次** assistant 应为 **相同 uris + `<page_number>2</page_number>`**
   - 重复直至无 `(more on next page...)`
4. 成功标准：同任务内 `page_number=2`（及更高页）出现次数 **> 0**，且截断后**不再**立即跳去读无关路径。

---

## 风险与边界

| 项 | 说明 |
|----|------|
| **prompt 仍可能被弱模型忽略** | 本地小模型 compliance 不稳定；若仍 0 续页，再考虑 Agent 侧 `hasNextPage` 自动续读（超出本文方案） |
| **续页增加 tool 轮次** | 大文件需多轮 read，总 latency 上升，但信息完整 |
| **与 context 折叠叠加** | `agentContextCompaction` 折叠旧 tool 摘要不影响「当前正在续读」的最近 2 条全文 |

---

## 相关文档

- `LLM不收敛.md` — 上下文膨胀、KV cache、compaction 重复读、已实施修复
- `RAG诊断日志缺失难以定位卡顿.md` — `[LLM][send]` payload 排查方法
