# Browser 目录深度解析

`src/vs/workbench/contrib/mcode/browser/` 负责前端界面渲染、编辑器 Diff 差分展示、事件交互以及 AI 行为调度。

---

## 1. 📁 React UI 架构 (`react/src/`)

MCode 的配置面板、聊天面板与内联输入框等均基于 **React + TailwindCSS/Vanilla CSS** 编写，最终经打包生成为原生 VS Code 可用资源文件。

* **[sidebar-tsx/](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/react/src/sidebar-tsx)**：
  - **`Sidebar.tsx`** 和 **`SidebarChat.tsx`**：右侧 AI 侧边栏聊天界面的根组件。处理流式消息渲染、Markdown 解析、代码块高亮及上下文附带逻辑。
  - **`SidebarThreadSelector.tsx`**：管理会话历史记录（Threads），允许用户创建、删除或切换不同的聊天上下文。
* **[mcode-settings-tsx/](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/react/src/mcode-settings-tsx)**：
  - **`Settings.tsx`**：提供商与模型管理面板。用户可在此配置 OpenAI, Anthropic, Gemini, Ollama 等的 API Key、自定义 Endpoint 以及每个功能绑定的模型。
* **[quick-edit-tsx/](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/react/src/quick-edit-tsx)**：
  - **`index.tsx`** 和相关组件：当按下 `Ctrl+K`（Mac 下为 `Cmd+K`）时，弹出的行内 AI 编辑输入框界面。

---

## 2. ⚙️ 核心前端服务

### 2.1 [editCodeService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/editCodeService.ts)
该服务负责将 AI 生成的代码“应用”（Apply）到当前打开的编辑器文档中。
* **Fast Apply 机制**：向大模型发送特定 System Prompt，使其输出 Search/Replace 块（如 `<<<<<<< ORIGINAL` ... `=======` ... `>>>>>>> UPDATED`）。这使得在 1000+ 行的大文件中，AI 仅需生成被修改段落，大大节约了 Token 并提升了应用速度。
* **Slow Apply 机制**：直接将全量生成的代码内容替换到文档中。
* **DiffZone 机制**：管理行内的 Diff 区间（即编辑器中展示红/绿删除和添加的高亮背景）。每次接收到流式输出，`editCodeService` 会通过 [findDiffs.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/helpers/findDiffs.ts) 计算文本变化，动态调整 Diff 区域，并提供 Accept（接受）或 Reject（驳回）按钮。

### 2.2 [autocompleteService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/autocompleteService.ts)
处理代码自动补全逻辑。
* **预处理 (Preprocessing)**：检测光标位置。如果光标右侧有文字，或者光标位于空白行开头等，会自动触发补全。
* **流式生成**：将上下文（包括当前光标前后的代码，即 Fill-in-the-Middle 格式）打包发给大模型。
* **后处理 (Postprocessing)**：因为大模型容易生成不平衡的括号或多余的代码块，该服务会对输出结果进行括号自动平衡校验，并裁剪冗余的换行。
* **缓存管理**：内部实现了一个 `LRUCache`（最近最少使用缓存），基于前缀（Prefix）进行缓存。当用户撤销或继续输入时，能实现毫秒级的响应。

### 2.3 [toolsService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/toolsService.ts) & [terminalToolService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/terminalToolService.ts)
支持 agent 模式下的工具调用能力。
* **`toolsService`** 提供读取文件、修改文件、查找符号等基础 IDE 工具。
* **`terminalToolService`** 提供在 VS Code 终端中执行 Shell 命令并捕获输出的能力。

### 2.4 [mcodeCommandBarService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/mcodeCommandBarService.ts)
管理行内输入框（如 `Ctrl+K` 输入框）在编辑器视图中的绝对定位、生命周期以及快捷键处理。

---

## 3. ⌨️ 动作与注册

* **[sidebarActions.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/sidebarActions.ts)**：注册唤起侧边栏的命令（如快捷键 `Ctrl+L` / `Cmd+L`），将光标选中的代码段自动填入聊天输入框。
* **[quickEditActions.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/quickEditActions.ts)**：注册 `Ctrl+K` 行内编辑命令。
* **[mcode.contribution.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/mcode.contribution.ts)**：作为整个子模块的注册中心，负责将上述所有 Actions、UI 面板和 Singleton Services 挂载到 VS Code 全局运行时。
