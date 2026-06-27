# 设计方案：RAG 智能推荐与模型路由 (Auto-Context/模型路由/能力动态注册)

> **实施阶段**：**Phase 9** ✅ 已实现（依赖 Phase 1 LSP；CodeGraph 可选依赖 Phase 8）。  
> 任务：[TODO.md § Phase 9](./TODO.md#phase-9--智能推荐与模型路由扩展p4) · 路线图：[设计方案_RAG分阶段实施路线图.md](./设计方案_RAG分阶段实施路线图.md) §7

---

## 1. 痛点一：上下文关联丢失（依赖感知 Staging 缺失）

### 1.1 痛点分析
用户在侧边栏手动通过 `@file` 提及文件容易出现遗漏。例如修改了一个公共服务类（如 `PaymentService`），但忘记添加依赖它的调用方文件（如 `payment_handler.ts`）。大模型由于没有看到调用方的入参和出参定义，容易写出编译不通过、或者接口对不上的废代码。

### 1.2 优化策略
- **图依赖解析**：当用户向上下文添加文件 A 时，利用后台 CodeGraph 解析文件 A 相关的依赖项。
- **主动式上下文推荐**：在 UI 界面上向用户呈现智能依赖推荐提示。

### 1.3 方案选型
* **方案 1**：直接将所有依赖文件全量强行塞入大模型上下文。缺点是会瞬间耗尽上下文 Token 额度，增加不必要的 API 消耗。
* **方案 2（首选）**：**启发式相关依赖图推荐（一键式 UI 提示）**。只解析一级出入度依赖，并在侧边栏给出明确的图标和“推荐理由”，由用户一键添加。

### 1.4 具体方案
1. **依赖度图提取**：
   在 `contextGatheringService` 中封装 `getRelatedDependencies(fileUri)`：
   ```typescript
   export async function getRelatedDependencies(fileUri: string): Promise<string[]> {
       // 1. 从 CodeGraph 找到对应的 FileNode
       const node = await codeGraph.getFileNode(fileUri);
       // 2. 寻找与该文件节点相连的直接出边和入边 (依赖它的文件 / 它依赖的文件)
       const edges = await codeGraph.getDirectEdges(node.id);
       return edges.map(edge => edge.targetPath);
   }
   ```
2. **UI 侧边栏联动**：
   在 `SelectedFiles`  staging 栏下增加推荐组件：
   ```tsx
   const StagingDependencyRecommender = ({ currentSelections }) => {
       const [recommendations, setRecommendations] = useState<string[]>([]);
       // 触发副作用异步拉取推荐文件，一键点击后更新 selections
       // ...
   };
   ```

---

## 2. 痛点二：缺乏意图感知的智能模型路由（Intent-based Model Routing）

### 2.1 痛点分析
开发人员通常在 Void 中绑定一个主力高级模型（如 `Claude 3.5 Sonnet`），所有的交互（例如要求“解释这行代码”、“帮我起个变量名”或是“写个单元测试”）均使用该顶级模型：
1. **极度浪费 Token 费用**。
2. **速度过慢**，降低开发交互流畅度。

### 2.2 优化策略
- **问答意图分类**：引入极其轻量级的意图分类器，在本地识别请求任务类型。
- **多轨分流（Model Routing）**：将简单解释分流至快轨（Fast Mode），复杂逻辑重构分流至代码轨（Code Mode），疑难 Debug 探索分流至推理轨（Reasoning Mode）。

### 2.3 方案选型
* **方案 1**：在云端中转网关进行分析。缺点是仍然会有一次中转网络延迟，且网关服务容易单点失效。
* **方案 2（首选）**：**本地正则 + 轻量级语义 Intent 分类器**。主进程本地进行毫秒级意图匹配，并将匹配结果直接映射到 `mcodeSettingsService` 配置的对应模型上。

### 2.4 具体方案
1. **意图路由映射配置**：
   在 `mcodeSettingsTypes.ts` 中新增路由定义：
   ```typescript
   export interface ModelRouterConfig {
       fastModel: ModelSelection;      // 针对解释、问答、起名（如 gpt-4o-mini）
       codeModel: ModelSelection;      // 针对生成、重构、补全（如 claude-3-5-sonnet）
       reasoningModel: ModelSelection; // 针对排错、逻辑推演（如 deepseek-r1 / o3-mini）
   }
   ```
2. **本地分类器实现**：
   ```typescript
   export function routeModelByIntent(query: string, config: ModelRouterConfig): ModelSelection {
       // 正则快速拦截常见轻量问答意图
       const fastPattern = /^(解释|起名|翻译|翻译下|这是什么|how to use|what is)/i;
       if (fastPattern.test(query.trim())) return config.fastModel;

       // 判定是否是 Debug 意图
       const debugPattern = /(error|failed|crash|bug|报错|死锁|crash|内存泄露)/i;
       if (debugPattern.test(query)) return config.reasoningModel;

       // 默认代码生成与修改使用高级代码模型
       return config.codeModel;
   }
   ```

---

## 3. 痛点三：硬编码模型能力映射导致的能力漂移（Capabilities Drift）

### 3.1 痛点分析
在 Void 当前实现 [modelCapabilities.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/common/modelCapabilities.ts) 中，所有模型的上下文额度（Context Window）以及支持的高级特性均是硬编码的静态表。一旦大模型服务商更新了上下文大小（如 Gemini 的升级）或者发布了全新的大模型，Void 用户由于使用旧版本包，其模型高级功能将无法加载。

### 3.2 优化策略
- **动态拉取同步**：编辑器在启动或空闲时，动态拉取并合并最新的云端能力映射配置文件。
- **本地自适应能力探测**：当用户连接本地 Ollama 模型或私有微调端点时，自适应握手以探测模型是否支持高级 API 功能。

### 3.3 方案选型
* **方案 1**：完全依赖用户在 UI 设置面板中手动填写每一个模型的 Context 限制和功能。缺点是体验非常繁琐，门槛过高。
* **方案 2（首选）**：**在线动态同步（CDN Fallback）+ 本地 JSON-Schema 自适应握手探测（Handshake Probe）**。

### 3.4 具体方案
1. **后台 CDN 缓存合并**：
   主进程启动时，通过 `https://config.voideditor.com/models.json` 异步获取最新模型能力表，并缓存在本地：
   `C:\Users\<user>\.gemini\antigravity\model_capabilities_cached.json`。
   在代码加载能力时优先加载缓存，若缓存不存在则回退至硬编码的 `modelCapabilities.ts` 默认表。
2. **自适应能力探测处理器（Handshake Prober）**：
   在 `mcodeSettingsService.ts` 中，当用户新增自定义或第三方提供商（如 Ollama）的模型时，触发一次静默握手：
   ```typescript
   export async function probeModelCapabilities(endpoint: string, modelName: string) {
       try {
           // 发送一个包含极其简单的 mock tool 声明的空请求
           const res = await callLLMWithFakeTool(endpoint, modelName);
           if (res.status === 200) {
               return { supportsTools: true, supportsSystemRole: true };
           }
       } catch {
           // 若报错，标记不支持原生 tool 调用，需降级为 prompt XML 拼接
           return { supportsTools: false, supportsSystemRole: false };
       }
   }
   ```
