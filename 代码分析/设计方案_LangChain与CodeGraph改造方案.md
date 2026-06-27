# LlamaIndex 与 CodeGraph 接入改造方案 (彻底替代 LangChain)

> [!NOTE]
> **架构更新说明**：经过对系统 RAG 与 Agent 机制的深度 Review，我们决定**彻底弃用 LangChain，全面拥抱 LlamaIndex**。
> 原因在于：Void 已经拥有了原生且高度定制的 TypeScript Agent 循环（`_runChatAgent`），并不需要 LangChain 复杂的 Agent/Chain 编排层；而在数据检索、分片、向量库管理以及代码图谱构建方面，LlamaIndex (TypeScript) 具有比 LangChain 更加深厚、专精的技术积淀。

---

## 1. 现状痛点与改造目标

### 1.1 现状痛点
目前的 `IContextGatheringService` 依赖 VS Code 内存中的 TextModel 和正在运行的 LSP 插件。这带来了几个限制：
1. **范围限制**：只能检索已被 VS Code 打开或加载的活跃文件，无法对**全量项目代码库**进行全局语义搜索。
2. **缺乏语义检索**：完全依赖硬编码的符号引用和跳转，无法处理“查找所有与用户系统支付模块相关的逻辑”这种模糊语义查询。
3. **性能瓶颈**：多级递归 LSP 调用在大型项目中可能会阻塞前端渲染进程，且难以接入 Rerank（重排）模型或复杂的检索链。

### 1.2 改造目标
* **LlamaIndex 数据层**：使用 LlamaIndex (TS/JS) 代替 LangChain，作为底层统一的 RAG 数据框架，实现海量文件的切片、向量索引与混合召回。
* **CodeGraph 索引层**：基于 Tree-sitter，构建全量项目的 AST（抽象语法树）+ 符号引用图，并与 LlamaIndex 的 `PropertyGraph` 深度整合。
* **分进程执行**：将繁重的索引与向量计算下沉到 **Electron Main 主进程**，前端仅作触发和结果接收，确保编辑器流畅无卡顿。

---

## 2. 改造后系统架构设计

```mermaid
graph TD
    subgraph Browser Process (渲染进程)
        Editor[Monaco Editor / Chat UI] -->|触发上下文获取| ContextGathering[IContextGatheringService Client]
        ContextGathering -->|IPC: queryRagContext| RagChannel[ragChannel.ts]
    end

    subgraph Electron Main Process (主进程)
        RagChannel -->|路由分发| RagService[RagService.ts]
        RagService -->|LlamaIndex Query Engine| QueryEngine[RetrieverQueryEngine / SubQuestion]
        
        subgraph LlamaIndex & CodeGraph
            QueryEngine -->|图谱检索| GraphIndex[PropertyGraphIndex]
            QueryEngine -->|向量相似度查询| VectorIndex[VectorStoreIndex]
            
            GraphIndex -->|本地/云端存储| VectorDB[(Milvus / Local Store)]
            VectorIndex -->|本地/云端存储| VectorDB
        end
    end
    
    VectorDB -.->|全量扫描生成| Indexer[CodeIndexer Daemon]
    Indexer -.->|监听文件变化| WorkspaceFiles[Workspace Files]
```

---

## 3. 详细改造步骤

### 📂 步骤一：安装依赖 (主进程)
在 Void 的主程序依赖中，引入 LlamaIndex 库，彻底移除 `@langchain/*` 系列包。
在 `package.json` 中添加：
```json
{
  "dependencies": {
    "llamaindex": "^0.8.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0"
  }
}
```

---

### 📂 步骤二：实现 CodeGraph 静态分析器 (主进程)
新建主进程图生成器 `src/vs/workbench/contrib/mcode/electron-main/rag/codeGraph.ts`：
* 利用 `tree-sitter` 提取文件内的 `Class`、`Method`、`Function` 定义。
* 扫描 `import` 语句建立文件/模块之间的依赖边。
* 将节点与边存入本地轻量数据库（如 SQLite 或内存 Map）。

```typescript
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

export interface GraphNode {
    id: string; // 比如 "file://path/to/file.ts#myFunction"
    type: 'class' | 'function' | 'file';
    filePath: string;
    content: string;
}

export class CodeGraph {
    private nodes = new Map<string, GraphNode>();
    private edges = new Map<string, string[]>(); // nodeID -> adjacentNodeIDs

    public async indexFile(filePath: string, code: string) {
        const parser = new Parser();
        parser.setLanguage(TypeScript);
        const tree = parser.parse(code);
        
        // 遍历 AST 提取 Function & Class 节点并存入 nodes 与 edges
        // ...
    }
    
    public getNeighbors(nodeId: string): GraphNode[] {
        const neighbors = this.edges.get(nodeId) || [];
        return neighbors.map(id => this.nodes.get(id)!).filter(Boolean);
    }
}
```

---

### 📂 步骤三：基于 LlamaIndex 编写混合检索引擎 (主进程)
创建 `src/vs/workbench/contrib/mcode/electron-main/rag/ragService.ts`。使用 LlamaIndex 的 `RetrieverQueryEngine` 规范，将图结构邻居节点搜索与向量检索结合。

```typescript
import { 
    VectorStoreIndex, 
    Settings, 
    OpenAIEmbeddings,
    NodeWithScore,
    TextNode
} from "llamaindex";
import { CodeGraph } from "./codeGraph.js";

export class LlamaIndexHybridRetriever {
    constructor(
        private vectorIndex: VectorStoreIndex,
        private codeGraph: CodeGraph
    ) {}

    public async retrieve(query: string): Promise<NodeWithScore[]> {
        // 1. 获取向量索引检索器
        const retriever = this.vectorIndex.asRetriever({ similarityTopK: 5 });
        
        // 2. 从向量库进行语义检索获取 Top-K 相关节点
        const vectorResults = await retriever.retrieve({ query });
        const finalResults = new Map<string, NodeWithScore>();

        for (const nodeWithScore of vectorResults) {
            const nodeId = nodeWithScore.node.id_;
            finalResults.set(nodeId, nodeWithScore);

            // 3. 顺着 CodeGraph 召回与其有直接调用/继承关系的邻居节点（结构化上下文）
            const neighbors = this.codeGraph.getNeighbors(nodeId);
            for (const neighbor of neighbors) {
                if (!finalResults.has(neighbor.id)) {
                    const textNode = new TextNode({
                        id_: neighbor.id,
                        text: neighbor.content,
                        metadata: { filePath: neighbor.filePath }
                    });
                    finalResults.set(neighbor.id, {
                        node: textNode,
                        score: nodeWithScore.score * 0.9 // 邻居节点得分微降级
                    });
                }
            }
        }

        return Array.from(finalResults.values());
    }
}
```

---

### 📂 步骤四：架设 IPC 桥梁
在主进程和渲染进程之间注册一个新的 RAG 频道。

1. **主进程端**：新建 `src/vs/workbench/contrib/mcode/electron-main/ragChannel.ts`
```typescript
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RagService } from './rag/ragService.js';

export class VoidRagChannel implements IServerChannel {
    constructor(private readonly ragService: RagService) {}

    listen(_: unknown, event: string): Event<any> {
        throw new Error(`Event not supported: ${event}`);
    }

    async call(_: unknown, command: string, params: any): Promise<any> {
        if (command === 'queryRagContext') {
            const { query, activeFileUri, cursorLine, localEditorContext } = params;
            // 执行 LlamaIndex 检索和 Rerank 压缩
            return await this.ragService.query(query, activeFileUri, cursorLine, localEditorContext);
        }
        throw new Error(`Unhandled command: ${command}`);
    }
}
```

2. **渲染进程端**：重构 `src/vs/workbench/contrib/mcode/browser/contextGatheringService.ts`
把原来浏览器端深度递归的 LSP 符号寻源逻辑移除，替换为捕获**最靠近光标的物理行区间（如上下各 15 行）**，连同查询一起作为“实时编辑上下文”发送给主进程：

```diff
 export class ContextGatheringService extends Disposable implements IContextGatheringService {
-    // 旧逻辑：在浏览器端调度 DocumentSymbolProvider、ReferenceProvider、DefinitionProvider
-    public async updateCache(model: ITextModel, pos: Position): Promise<void> {
-        ... 
-    }
+    private readonly channel: IChannel;
+
+    constructor(
+        @IMainProcessService private readonly mainProcessService: IMainProcessService,
+    ) {
+        super();
+        this.channel = this.mainProcessService.getChannel('void-channel-rag');
+    }
+
+    public async updateCache(model: ITextModel, pos: Position): Promise<void> {
+        const startLine = Math.max(pos.lineNumber - 15, 1);
+        const endLine = Math.min(pos.lineNumber + 15, model.getLineCount());
+        const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
+        
+        // 捕获最直接的光标临近物理代码（包含未保存的最新更改）
+        const localEditorContext = model.getValueInRange(range);
+        const query = model.getLineContent(pos.lineNumber);
+
+        // 将 RAG 计算逻辑全部卸载到主进程
+        const snippets = await this.channel.call('queryRagContext', {
+            query,
+            activeFileUri: model.uri.toString(),
+            cursorLine: pos.lineNumber,
+            localEditorContext // 传递给主进程的实时局部代码
+        });
+        this._cache = snippets;
+    }
 }
```

> [!NOTE]
> **关于“附近片段检索”是否保留的释义**：
> 1. **物理片段依然必须保留**：因为用户在编辑器中处于实时输入状态，很多修改还未保存到磁盘或建立向量索引。将当前光标周边 `±15` 行的最新代码（`localEditorContext`）直接上传，可以作为大模型最信赖的“第一顺位上下文”。
> 2. **获取方式彻底简化**：原方案中在浏览器端深度递归调用 LSP 去找“附近符号的定义”的复杂算法被**彻底移除**。主进程在拿到 `localEditorContext` 后，其中的符号可以直接作为 CodeGraph 的起点节点（Seeds），利用主进程的多线程和后台静态索引迅速关联出定义，无需再让浏览器渲染线程去频繁阻塞查询。

---

## 4. 方案对比与评估

| 评估维度 | 当前 LSP 静态遍历方案 | LlamaIndex + CodeGraph 改造方案 |
| :--- | :--- | :--- |
| **检索精确度** | 中等。仅限于符号跳转，无法应对模糊语义查询。 | **极高**。内置 PropertyGraph，结构与语义混合双重精准召回。 |
| **检索范围** | 仅限 VS Code 当前已加载/打开的活跃文件。 | **全项目**。支持在主进程对整个工作区进行全量索引和后台增量刷新。 |
| **渲染线程负载** | 较重。深层 LSP 递归容易阻塞前端渲染。 | **极轻**。计算全部移交主进程，前端仅作极轻量的行捕获与异步等待。 |
| **框架冗余度** | **零消耗**。无外部框架依赖。 | **极低**。抛弃了重量级的 LangChain，RAG 逻辑极简且完全在后台运行。 |

---

## 5. 如何清理与移除旧有 LSP 逻辑

在重构 [contextGatheringService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/contextGatheringService.ts) 时，需要彻底清除原有的前端静态分析逻辑，以释放内存占用并保持代码库整洁：

### 5.1 🚫 步骤一：清理无用的依赖导入与接口
在文件头部，删除所有仅用于本地 LSP 抓取和 AST 遍历的依赖：
```diff
- import { CancellationToken } from '../../../../base/common/cancellation.js';
- import { DocumentSymbol, SymbolKind } from '../../../../editor/common/languages.js';
- import { Range, IRange } from '../../../../editor/common/core/range.js';
- import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
- import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
```
同时删除已经无用的区间过滤接口：
```diff
- interface IVisitedInterval {
-     uri: string;
-     startLine: number;
-     endLine: number;
- }
```

### 5.2 🚫 步骤二：清理服务构造函数中的服务注入
将不再需要直接调用的 LSP 门面服务（Language Features Service）和编辑器视图服务从构造器中移除：
```diff
  class ContextGatheringService extends Disposable implements IContextGatheringService {
      _serviceBrand: undefined;
-     private readonly _NUM_LINES = 3;
-     private readonly _MAX_SNIPPET_LINES = 7;
      private _cache: string[] = [];
-     private _snippetIntervals: IVisitedInterval[] = [];
  
      constructor(
-         @ILanguageFeaturesService private readonly _langFeaturesService: ILanguageFeaturesService,
          @IModelService private readonly _modelService: IModelService,
-         @ICodeEditorService private readonly _codeEditorService: ICodeEditorService
+         @IMainProcessService private readonly mainProcessService: IMainProcessService
      ) {
          super();
```

### 5.3 🚫 步骤三：彻底删除私有辅助检索函数（删除约 270 行代码）
直接删除 [contextGatheringService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/contextGatheringService.ts) 中以下**所有**本地静态检索私有方法：
* `_getSnippetForRange` (代码片段截取)
* `_cleanSnippet` / `_normalizeSnippet` (文本格式清洗)
* `_addSnippetIfNotOverlapping` / `_isRangeVisited` (防重叠区间过滤器)
* `_gatherNearbySnippets` (核心递归 LSP 符号寻源)
* `_gatherParentSnippets` (核心外层包裹函数溯源)
* `_getSymbolsNearPosition` / `_getSymbolsNearRange` / `_getSymbolsInRange` (LSP 符号抓取)
* `_flattenSymbols` (AST 树平铺)
* `_rangesIntersect` / `_positionInRange` (Range 几何计算)
* `_getDefinitionSymbols` (LSP 寻找声明源头)
* `_findContainerFunction` (LSP 寻找包围函数)

---

## 6. 向量数据库选型与存储介质设计

作为一个运行在用户本地的桌面端 Electron 编辑器，向量数据库的存储必须满足**零外部依赖、轻量高效、支持本地文件持久化**的要求。以下是三种主流的本地存储方案对比和推荐：

### 6.1 方案 A：LNSWLib 本地文件持久化（推荐首选）
* **存储方式**：LlamaIndex 默认支持本地文件存储，冷启动时快速加载本地索引文件。
  在主进程中，将索引数据和 HNSW 向量索引存储在专用的本地 LlamaStore 目录中（包含 SQLite `<WorkspaceStoreName>.db` 数据库及 `<WorkspaceStoreName>.usearch` 索引）：
  - Windows: `%APPDATA%\MCode\LlamaStore\<WorkspaceStoreName>\`
  - macOS: `~/MCode/LlamaStore/<WorkspaceStoreName>/`

---

### 6.2 方案 B：LanceDB 嵌入式数据库（备选方案）
* **存储方式**：LanceDB 是一种专为 AI 设计的**嵌入式无服务器（Serverless）向量数据库**。它使用高效的 `Lance` 列式存储格式直接保存在本地硬盘中，无需拉起额外的数据库进程。

---

### 6.3 方案 C：SQLite-VSS 插件存储
* **存储方式**：直接存放在本地标准的 SQLite `.db` 文件中，通过加载二进制扩展库 `sqlite-vss` 提供向量相似度运算。

---

### 6.4 方案 D：Milvus 集中式数据库（企业团队级首选）
* **存储方式**：客户端-服务端（Client-Server）架构。在 Electron 主进程中引入 `@zilliz/milvus-sdk-node` 作为客户端，通过 gRPC 协议连接到内网部署的 Milvus 服务端集群或 Zilliz Cloud 云端托管服务。
* **读写流程**：
  ```typescript
  import { MilvusClient } from "@zilliz/milvus-sdk-node";
  import { MilvusVectorStore } from "llamaindex";
  
  const client = new MilvusClient({ 
      address: milvusConfig.address, // 例如 "192.168.1.100:19530" 或 "https://in01-..."
      username: milvusConfig.username,
      password: milvusConfig.password,
      token: milvusConfig.token, // 用于 Zilliz Cloud Token 认证
  });
  const vectorStore = new MilvusVectorStore({
      address: milvusConfig.address,
      username: milvusConfig.username,
      password: milvusConfig.password,
      token: milvusConfig.token,
      collectionName: milvusConfig.collectionName || `void_code_index_${workspaceHash}`,
  });
  ```

---

### 6.5 🛠️ 向量存储可配置化改造方案

为了灵活支持个人本地轻量使用以及团队大型项目共享，我们将向量存储设计为**可动态配置切换**。

#### 1. 配置数据结构声明 (`mcodeSettingsTypes.ts`)
在全局设置中引入 RAG 相关的配置字段：
```typescript
export type RAGVectorStoreType = 'local' | 'cloud'; // local: HNSWLib, cloud: Milvus

export interface MilvusSettings {
    address: string;      // 服务器 gRPC 端口或 HTTPS URL (例如 "192.168.1.100:19530")
    username?: string;    // 用户名 (可选)
    password?: string;    // 密码 (可选)
    token?: string;       // API 认证令牌 (用于 Zilliz Cloud 托管实例，可选)
    collectionName?: string; // 向量集合名称 (可选，默认使用 workspaceHash 自动生成)
}

export interface RAGGlobalSettings {
    vectorStoreType: RAGVectorStoreType;
    milvusConfig: MilvusSettings;
}
```

#### 2. 主进程动态初始化工厂 (`ragService.ts`)
在主进程服务中，根据当前的全局配置，动态加载和初始化对应的向量数据库客户端：
```typescript
import { VectorStoreIndex, MilvusVectorStore, storageContextFromDefaults } from "llamaindex";
import { OpenAIEmbeddings } from "@langchain/openai"; // 可以继续替换为 LlamaIndex OpenAIEmbeddings

export class VectorStoreFactory {
    public static async createIndex(
        type: RAGVectorStoreType,
        workspaceHash: string,
        milvusConfig: MilvusSettings,
        storagePath: string
    ): Promise<VectorStoreIndex> {
        if (type === 'local') {
            const storageContext = await storageContextFromDefaults({ persistDir: storagePath });
            return await VectorStoreIndex.init({ storageContext });
        } else {
            const vectorStore = new MilvusVectorStore({
                address: milvusConfig.address,
                username: milvusConfig.username,
                password: milvusConfig.password,
                token: milvusConfig.token,
                collectionName: milvusConfig.collectionName || `void_code_index_${workspaceHash}`
            });
            const storageContext = await storageContextFromDefaults({ vectorStore });
            return await VectorStoreIndex.init({ storageContext });
        }
    }
}
```
