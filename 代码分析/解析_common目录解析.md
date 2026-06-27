# Common 目录解析

`src/vs/workbench/contrib/mcode/common/` 目录下存放了前端与后端共享的模型定义、配置服务声明和 IPC 数据通道结构。该目录下的代码具有高复用性，但不允许依赖任何仅在单一进程（如 `window` 对象或 Node.js 原生模块）中可用的 API。

---

## 1. ⚙️ 配置与状态持久化

* **[mcodeSettingsService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/mcodeSettingsService.ts)**：
  - 管理 MCode 各种模型提供商（Providers）的认证信息和模型关联绑定。
  - 通过注入 VS Code 原生的 `IStorageService`，将配置信息以加密或 JSON 字符串形式持久化到本地存储中（利用 [storageKeys.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/storageKeys.ts) 中定义的 `VOID_SETTINGS_STORAGE_KEY`）。
  - 对外暴露了 `onDidChangeState` 事件，以便当用户更改配置或模型绑定时，React 组件可以获得即时通知并更新 UI。
* **[mcodeSettingsTypes.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/mcodeSettingsTypes.ts)**：
  - 定义了整个项目支持的模型提供商类型：`ollama`, `openAI`, `anthropic`, `gemini`, `openRouter`, `groq`, `mistral`, `vLLM`, `liteLLM`, `lmStudio` 等。
  - 定义了功能绑定类型 `FeatureName`（如 `Autocomplete` | `Chat` | `CtrlK` | `Apply`）。

---

## 2. 🤖 模型元数据与基准能力

* **[modelCapabilities.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/modelCapabilities.ts)**：
  - 极为重要的配置文件。包含了各大服务商官方大模型的能力映射表（如：最大上下文 Token 限制、最大输出限制、是否支持 Reasoning 思考过程、是否支持 FIM 行内填充补全、是否支持原生 Tools 调用等）。
  - 当新增大模型（例如 Claude 3.7 Sonnet 或 GPT-4.5）时，需要修改该文件中的 `modelCapabilities`，以让 MCode 正确格式化 API 负载（Payload）并为用户显示相应的高级配置（例如推理时长配置）。

---

## 3. 📡 接口与管道协议定义

* **[sendLLMMessageService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/sendLLMMessageService.ts)** 与 **[sendLLMMessageTypes.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/sendLLMMessageTypes.ts)**：
  - 声明了 `ILLMMessageService` 接口，定义了 `sendChat`、`sendFIM`、`listModels` 等方法。
  - 定义了聊天消息的数据格式 `LLMChatMessage`（包括 `role`、`content` 等）和流式回调函数（如 `onText`、`onFinalMessage`、`onError`）。
* **[mcpService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/mcpService.ts)**：
  - 定义了 Model Context Protocol (MCP) 在渲染进程的交互服务 `IMCPService`。它通过 IPC 连接到主进程的 [mcpChannel.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/mcpChannel.ts)，在主进程拉起 MCP Server，并将其实际提供的工具返回给前端大模型 prompt。

---

## 4. 🗂️ 文件与模型交互

* **[mcodeModelService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/mcodeModelService.ts)**：
  - 提供了与 VS Code 编辑器内部 `ITextModel`（文本文档对象）的底层安全读写交互封装。
  - 屏蔽了复杂的文件生存期、保存同步等边界逻辑，让核心逻辑只需通过 `URI` 即可安全可靠地读写用户当前的代码文件。
