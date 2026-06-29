# read_file 将 Copyright 文件头大量送入 LLM

## 现象

- Agent 对 OnlyOffice 等大型 C++ 项目多次 `read_file` 时，LLM 上下文反复出现：
  ```
  * (c) Copyright Ascensio System SIA 2010-2023
  ```
- 单次 read 可能占用数百 token 的纯版权信息，挤占有效代码上下文。
- RAG 索引路径已对 chunk 做 header 剥离，但 **tool 读文件路径未剥离**，行为不一致。

## 原因

`toolsService.ts` 的 `read_file` 直接将 `model.getValue()` 全文返回给 LLM，未像索引侧 `semanticCodeChunker.ts` 那样调用 `stripLeadingFileHeader`。

## 修改方案

1. 新增/复用 `common/helpers/fileHeaderStripper.ts`：
   - `stripLeadingFileHeader()`：识别 block/line 注释中的 copyright、license、SPDX 等关键字。
   - `stripFileHeaderForToolOutput(content, fromStartOfFile)`：从文件开头读取时剥离并插入简短说明：
     `/* (N lines of copyright/license header omitted) */`
2. 在 `read_file` 实现中，`getValue` 后调用 `stripFileHeaderForToolOutput`（仅 `startLine` 从文件首行开始时生效）。
3. `electron-main/rag/fileHeaderStripper.ts` 改为 re-export common 模块，索引与 tool 共用逻辑。

**涉及文件**：
- `common/helpers/fileHeaderStripper.ts`
- `browser/toolsService.ts`
- `electron-main/rag/fileHeaderStripper.ts`
- `electron-main/rag/semanticCodeChunker.ts`（索引侧已有）
