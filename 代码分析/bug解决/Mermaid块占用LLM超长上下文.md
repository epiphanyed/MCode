# Mermaid 代码块导致 Ollama prompt 超长、预处理极慢

## 现象

- Ollama / llama.cpp 日志连续出现：
  ```
  erased invalidated context checkpoint (n_tokens = 16052, size = 75.376 MiB)
  slot print_timing: prompt processing, n_tokens = 14336, t = 33.73 s
  ```
- Chat 在 RAG 检索完成后仍长时间无输出。
- 分析任务涉及 `svg.md` 等含大量 ` ```mermaid ` 的文档时尤为明显。

## 原因

Mermaid / Draw.io / Manim 块在 **UI 渲染** 有用，但对 LLM **几乎无语义价值**，却占大量 token：

1. **RAG 检索**：`.md` 索引与 `resolveDisplayContent` 原样带回完整 diagram 源码。
2. **`read_file`**：读取 markdown 时原样返回 Mermaid。
3. **对话历史**：assistant 上一轮生成的 Mermaid 在后续 turn 中重复送入 prompt。
4. 多路叠加后单次请求可达 **1.6 万+ token**，本地模型仅 prompt 预处理就需 30s+。

`erased invalidated context checkpoint` 是 llama.cpp 长 prompt 分段写入 KV cache 的**警告**，不是 Mermaid 语法解析错误。

## 修改方案

新增 `common/helpers/diagramBlockStripper.ts`：

```typescript
stripDiagramBlocksForLlm(text)
// 将 ```mermaid / ```drawio / ```manim 替换为：
// [mermaid diagram omitted — N lines]
```

应用位置：

| 路径 | 作用 |
|------|------|
| `llamaIndexService.chunkFile`（`.md` 索引） | 新索引不再 embed 大段 diagram |
| `resolveDisplayContent` / `assignDocParentChunks` | RAG 注入 LLM 时忽略 diagram |
| `toolsService.read_file` | tool 输出剥离 diagram |
| `convertToLLMMessageService._chatMessagesToSimpleMessages` | 历史 user/assistant/tool 消息剥离 |

UI 侧 `DiagramContainer.tsx` / Mermaid 校验逻辑**不变**，仅影响送 LLM 的文本。

已有索引中的旧 chunk 在 display 层仍会剥离；建议 Settings 中 **Rebuild** 一次以获得更干净的 embedding。

**涉及文件**：
- `common/helpers/diagramBlockStripper.ts`
- `electron-main/rag/llamaIndexService.ts`
- `electron-main/rag/ragQueryHelpers.ts`
- `browser/toolsService.ts`
- `browser/convertToLLMMessageService.ts`
