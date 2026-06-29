# edit_file 报 ORIGINAL 与文件内容不匹配

## 现象

- Agent 调用 `edit_file` 时频繁失败，错误类似：
  - `ORIGINAL block did not match file content`
  - 模型给出的 `-` 行与文件中 `#` 标题、缩进或换行不一致。
- 对 Markdown、混合 CRLF 文件尤其常见，导致多轮重试仍无法应用编辑。

## 原因

`editCodeService.ts` 原先使用较严格的字符串/行级相等匹配：

1. Markdown 中模型常用 `-` 列表表示删除行，文件实际为 `#` 标题。
2. `\r\n` vs `\n` 未统一归一化。
3. 模型在 ORIGINAL 中夹带 ` ``` ` 围栏，与磁盘内容不一致。
4. 匹配失败时错误信息缺少文件邻近上下文，模型难以自我纠正。

## 修改方案

1. 新增 `browser/helpers/findTextInCode.ts`，提供分层匹配策略：
   - 精确匹配 → CRLF 归一化 → 去围栏 → Markdown 宽松匹配（`-`/`#`/列表等）。
2. `editCodeService.ts` 改用 `findTextInCode`，失败时附带目标位置附近文件片段。
3. `prompts.ts` 中补充 edit_file 提示：ORIGINAL 必须与磁盘一致、注意 Markdown 标题格式。

**涉及文件**：
- `browser/helpers/findTextInCode.ts`
- `browser/editCodeService.ts`
- `common/prompt/prompts.ts`
