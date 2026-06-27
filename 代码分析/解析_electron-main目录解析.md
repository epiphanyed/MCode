# Electron-Main 目录解析

`src/vs/workbench/contrib/mcode/electron-main/` 包含了运行在 Electron 主进程（Main Process）的代码，负责处理原生 Node.js API 交互、网络请求、MCP 服务器生命周期管理以及后台通道中转。

---

## 1. 📡 主进程 IPC 通道 (Channels)

在 VS Code 架构中，主进程的入口会注册多个 `IServerChannel`，用于接收来自渲染进程的跨进程消息（`call` 与 `listen`）。

* **[sendLLMMessageChannel.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/sendLLMMessageChannel.ts)**：
  - 注册为 `void-channel-llm` 通道。
  - 接收来自前端渲染进程的 `sendChat`、`sendFIM`、`listModels` 以及 `abort` 等底层调用。
  - 支持会话流式的多路复用，并将主进程接收到的流式 Token 即时推送回前端展示。
* **[mcpChannel.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/mcpChannel.ts)**：
  - 注册为 `void-channel-mcp` 通道。
  - 负责维护 MCP (Model Context Protocol) 服务的连接与调用。
  - 实现 `refreshMCPServers`（通过 Node.js 子进程启动配置文件中的 stdio 传输进程，或建立 SSE HTTP 传输）、`closeAllMCPServers`、`toggleMCPServer` 及 `callTool` 等原生操作。

---

## 2. 🤖 LLM 网络层实现

* **[llmMessage/sendLLMMessage.impl.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/llmMessage/sendLLMMessage.impl.ts)**：
  - 整个 MCode 的 LLM 执行核心，负责具体各大云端与本地大模型提供商的请求拼接和状态机处理。
  - 引入了各大服务商的官方 NodeJS SDK（如 `@anthropic-ai/sdk`、`openai`、`ollama`、`@google/genai`）。
  - **请求适配与归一化**：将 common 层的标准 `LLMChatMessage[]` 数据归一化为各家 Provider 接受的数据格式（例如 Google GenAI SDK、OpenAI System Message 等）。
  - **Tool & Agent 处理**：将侧边栏或 MCP 提供的 Tools 注入到大模型请求的 payload 中，并格式化输出的模型工具调用（Tool Calls）。
  - **流式合并与推理模式支持**：拦截流式 Token 输出，并支持如 Claude 3.7 / DeepSeek R1 的推理流模式（将 reasoning 思考文本分离传输，单独传递 `onText` 与 `onReasoning` 等）。
* **[llmMessage/extractGrammar.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/llmMessage/extractGrammar.ts)**：
  - 包含语法和格式解析逻辑，用于提取模型流式生成中的 `<thought>`（思考标签）和 XML 格式的工具调用块。

---

## 3. 🛠️ 原生服务组件

* **[mcodeSCMMainService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/mcodeSCMMainService.ts)**：
  - 提供与 Git 等源代码控制工具交互的原生底层方法，如快速暂存代码、生成提交信息等。
* **[mcodeUpdateMainService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/mcodeUpdateMainService.ts)**：
  - 利用主进程的网络与文件操作能力，后台拉取 GitHub Releases 新版本，下载二进制包并安全替换，实现软件的热更新与升级逻辑。
