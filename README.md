# MCode 编辑器

MCode 是一款基于开源 AI 编辑器 Void（基于 VS Code 深度定制二次开发）进行深度优化、功能升级与全品牌重塑的下一代 AI 辅助编程集成开发环境（IDE）。

我们致力于解决 AI 在终端交互、任务流控制以及高负荷环境下的稳定性和交互痛点，打造极速、智能且高度可靠的本地化与云端协同的 AI 编码体验。

---

## 🚀 核心升级功能 (Upgraded Features)

MCode 针对原版 Void 在终端控制、异常处理、用户交互以及语义检索等层面的不足，进行了以下重大的重构与技术升级，重点凸显了 Aider-like 自主智能 Agent 循环与本地高性能 RAG 语义检索：

### 1. 深度整合 Aider 自主智能 Agent 循环 (Aider-like Agent Loop)
* **多步自主迭代**：深度增强了 AI 代理的自主执行循环（Agent Loop），使 AI 能够根据终端编译与测试反馈进行多步自主修正，自动读取、修改并校验代码，无需人工频繁插手。
* **终端指令感知与自动响应**：AI 代理能精准分析终端执行结果与报错日志，自适应判断是否需要修复 Bug、重新编译或继续执行下一步任务，形成完美的流程闭环。

### 2. 基于 LlamaIndex 的本地高性能 RAG 语义检索系统 (LlamaIndex-Powered RAG)

底层在 Electron **主进程**运行 LlamaIndex，通过 IPC 为 Chat 提供代码库语义检索；**Phase 0–10 已全部落地**（详见 [代码分析/TODO.md](./代码分析/TODO.md)）。

**索引与存储**

* **双后端**：本地磁盘 `VectorStoreIndex`（`%APPDATA%/MCode/LlamaStore/{workspaceHash}`）或 **Milvus 2.4+** 混合索引（Dense + BM25 Sparse + RRF）；可选双写本地副本。
* **tree-sitter 混合切片**：C++/TS/JS/Python 等 AST 优先，regex fallback；保留函数上方文档注释，剥离文件头版权块。
* **多类型索引**：`code_chunk` / `git_commit` / `doc_chunk`；增量文件同步 + **增量后自动刷新 Git commit 索引**。
* **Embedding**：OpenAI 或 Ollama（如 `nomic-embed-text`），维度自适应 + manifest v4 智能重建。

**检索与编排**

* **LSP + 向量双通道**：光标附近 LSP snippets 与向量检索结果合并注入 Chat（`mergeRagContexts`）。
* **编排层**（Settings 可开关）：Router（code/git/doc 分流）、SubQuestion 拆分（可选 LLM）、Hybrid Reranker、**CodeGraph 1–2 hop 扩展**、文档 `linkedFiles` → 源码召回。
* **Git 动态上下文**：「昨晚改了什么」类问题自动附加 `git diff` / `git log`（查询期，不入库）。

**产品能力**

* **Settings → Index**：索引进度、Rebuild、Milvus 连接测试、Retrieve/Final TopK、Orchestration 开关。
* **侧边栏 `@file` 依赖推荐**：CodeGraph 优先，LSP references 回退。
* **可选模型意图路由**：解释/调试类问题分流至 fast / reasoning 模型。

**快速上手**

1. 打开工作区 → **Settings → Index Settings** → 配置 Embedding → **Save & Apply** 或 **Rebuild Local Index**。
2. （可选 Milvus）见 [milvus/README.md](./milvus/README.md) 启动 Docker，Settings 中切换 Index Type 并 Test Connection。
3. Chat 提问即可自动注入 `[检索到的代码上下文]`；无图索引时 Settings 会提示 Rebuild（`graphEngine: code-graph-v2`）。
4. 若个别路径索引失败或无需入库（如 `external/`、`third_party/` 下的 vendored 代码），可在**工作区根目录**创建 [`.mcodeignore`](#-如何使用-mcodeignore排除-rag-索引路径) 追加排除规则，然后 **Rebuild Local Index**。

**开发与测试**

```bash
npm run test-rag   # 需先 compile；运行 electron-main/rag 单元测试
```

设计文档速览见下文 [📚 RAG 与架构文档](#-rag-与架构文档)。


### 3. 终端非活跃强杀与心跳自愈机制 (Heartbeat & Inactivity Protection)
* **秒退与挂起修复**：优化了底层临时终端的单点 IPC 订阅防挂起逻辑，彻底解决了复杂编译或多步执行中临时终端易秒退、挂起的痛点。
* **超时时间翻倍**：将默认的终端不活跃强杀超时时间由原先的 30 秒延长至 **1 分钟 (60s)**，以保障大型项目编译、测试或依赖安装能完整跑完。
* **日志流实时心跳重置**：通过拦截并流式传输终端日志到 AI 会话窗口，在实时更新前台界面的同时，将流式输出作为活跃心跳（Heartbeat）不断重置超时计数器，实现长生命周期任务的自愈。

### 4. 一键终端与持久化终端重用 (Merged Commands & Terminal Reuse)
* **一键开执**：合并了“打开终端”与“执行指令”的分步操作，支持单次操作直接拉起长线终端并立即运行，减少交互链路。
* **智能终端复用**：当再次触发 AI 终端命令时，系统会自动检测并重用已存在的持久化 AI 终端（名称为 `'MCode Agent'`，带有专属 Sparkle 图标），防止重复创建多个终端导致系统卡顿与资源浪费。
* **任务结束自动清理**：在临时终端任务执行完毕且获取信息后，系统会自动安全销毁该临时终端，保持终端面板的绝对整洁。

### 5. 智能取消与流程闭环 (Smart Cancel & Feedback Loop)
* **取消反馈机制**：优化了原先点击 Cancel 导致整个 AI 工作流强行中断且无后续的粗暴逻辑。在 MCode 中，当用户拒绝或取消某条命令的执行时，系统会捕捉该“拒绝反馈”并自动整理成上下文回传给 AI 模型，促使模型动态调整思路、重新规划更符合预期的方案。

---

## 🛠️ 编译与运行指南 (Build & Run Guide)

由于 MCode 包含了原生 Node.js C++ 插件（例如用于终端伪终端管理的 `node-pty`），在编译时需要配置适当的系统依赖项。

### 1. 环境准备 (Prerequisites)

* **Node.js**：推荐使用 **v20.18.2**（可通过 `.nvmrc` 进行管理，或使用 NVM 切换）。
* **构建依赖**：
  * **Windows**：
    1. 安装 [Visual Studio 2022 Community](https://visualstudio.microsoft.com/zh-hans/vs/)。
    2. 在“工作负载”中勾选：**“使用 C++ 的桌面开发”** 与 **“Node.js 开发工具”**。
    3. 在“单个组件”中勾选：`MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs`、`C++ ATL` 以及 `C++ MFC`（均选择最新版本并带 Spectre 缓解）。
  * **macOS**：安装 Xcode 和命令行工具（通常系统自带 Python 和 gcc 即可）。
  * **Linux**：安装 `build-essential`、`g++`、`libx11-dev`、`libxkbfile-dev`、`libsecret-1-dev`。

### 2. 开发编译步骤 (Compilation Steps)

在项目根目录下依次运行以下命令进行依赖安装和编译：

```bash
# 1. 安装项目所有依赖项（可能需要数分钟以编译 C++ 原生模块）
npm install

# 2. 构建 React 前端面板与设置中心
npm run buildreact

# 3. 编译 TypeScript 核心服务与底座逻辑
# 方式 A：一次性全量编译（由于项目极其庞大，推荐使用以下指令分配 8GB 内存进行编译，以防止 Node 内存溢出）
node --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js compile

# 方式 B：开启监听模式进行热编译开发（推荐，按 Ctrl+Shift+B 亦可启动）
npm run watch
```

### 3. 运行 MCode (Running the Editor)

编译完成后，可通过以下脚本直接启动 MCode 开发者模式窗口：

* **Windows**:
  ```bash
  .\scripts\code.bat
  ```
* **macOS / Linux**:
  ```bash
  ./scripts/code.sh
  ```

---

## 💡 如何使用 `.mcoderules`

在您的任何工程/工作区根目录下，可以创建一个名为 `.mcoderules` 的 Markdown 文件，在其中写入您的编码规约。例如：

```markdown
# MCode 团队编码规约

- 始终为新编写的函数添加详尽的 JSDoc 注释。
- 优先使用 React Hooks 和 TypeScript 进行强类型定义。
- 异步操作统一使用 async/await 语法，并用 try-catch 捕获异常。
```

当您在 MCode 中使用 AI 对话、代码补全或快捷编辑功能时，MCode 的 AI 代理会自动读取并严格遵循这些规则。

---

## 💡 如何使用 `.mcodeignore`（排除 RAG 索引路径）

在**工作区根目录**（非 MCode 安装目录）创建 `.mcodeignore` 文件，可指定不参与本地 RAG 索引的路径。适用于：

* 个别文件反复出现 `[RAG] Failed to read or chunk file`（如超大头文件、宏密集 `.h`）
* 无需检索的 vendored / 第三方树（如 `external/`、`third_party/`）
* 生成物或临时目录（内置已跳过 `node_modules`、`.git`、`.github` 等，此处可补充项目特有路径）

若不存在 `.mcodeignore`，会回退读取同目录下的 `.voidignore`（与 Void 兼容）。

**语法**

* 每行一条规则；以 `#` 开头的行为注释
* 路径相对于工作区根目录，支持 **minimatch** 通配（如 `**/*.gen.cpp`）
* 也支持目录前缀：`external/v8` 会排除该目录及其子路径

**示例**

```gitignore
# vendored C++（不参与语义检索）
external/
**/third_party/**

# 单文件或宏头文件
external/v8/src/third_party/google_benchmark_chrome/**

# 生成代码
**/*.generated.ts
```

修改并保存后，在 **Settings → Index Settings** 中执行 **Rebuild Local Index**，已入库的旧 chunk 才会被完全清除；仅保存 `.mcodeignore` 时会对后续增量扫描生效，但已索引文件建议仍 Rebuild 一次。

---

## 📚 RAG 与架构文档

完整索引：[代码分析/README.md](./代码分析/README.md)（含推荐阅读顺序与全部 `代码分析/*.md` 分类目录）。

### 任务与状态

| 文档 | 说明 |
| :--- | :--- |
| [TODO.md](./代码分析/TODO.md) | 分阶段任务（Phase 0–10 ✅）、已知限制、Phase 11 |
| [设计方案_RAG分阶段实施路线图.md](./代码分析/设计方案_RAG分阶段实施路线图.md) | 路线图、Phase 8–9 编排、§10 限制 |

### RAG 核心（建议优先阅读）

| 文档 | 说明 |
| :--- | :--- |
| [设计方案_LlamaIndex接入与优化方案.md](./代码分析/设计方案_LlamaIndex接入与优化方案.md) | 主架构、Settings、manifest、编排 §8 |
| [解析_切片规则.md](./代码分析/解析_切片规则.md) | tree-sitter / 语义切片、函数注释保留 |
| [解析_RAG与上下文检索机制.md](./代码分析/解析_RAG与上下文检索机制.md) | LSP + 向量双通道、`mergeRagContexts` |
| [解析_Git与文档索引机制.md](./代码分析/解析_Git与文档索引机制.md) | git_commit、doc_chunk、Milvus 分区 |
| [设计方案_Milvus混合索引与检索设计.md](./代码分析/设计方案_Milvus混合索引与检索设计.md) | Dense + Sparse + RRF、Schema |
| [设计方案_RAG智能推荐与模型路由.md](./代码分析/设计方案_RAG智能推荐与模型路由.md) | 依赖推荐、模型意图路由 |
| [milvus/README.md](./milvus/README.md) | Milvus Docker 一键启动 |

### 整体架构

| 文档 | 说明 |
| :--- | :--- |
| [解析_整体框架.md](./代码分析/解析_整体框架.md) | Browser / Main 多进程与模块划分 |
| [解析_browser目录解析.md](./代码分析/解析_browser目录解析.md) | 渲染进程服务与 React UI |
| [解析_electron-main目录解析.md](./代码分析/解析_electron-main目录解析.md) | 主进程 LLM、RAG、终端 |
| [解析_AgentLoop工作原理分析.md](./代码分析/解析_AgentLoop工作原理分析.md) | Agent 循环与工具调用 |
| [解析_终端执行原理.md](./代码分析/解析_终端执行原理.md) | 终端心跳、超时与 PTY |

更多设计稿与需求分析见 [代码分析/README.md § 其他设计方案](./代码分析/README.md#其他设计方案)。

---

## 📄 开源许可证 (License)

MCode 基于 **MIT** 许可证开源。基础 VS Code 平台及相关依赖受其各自开源许可证的约束。
