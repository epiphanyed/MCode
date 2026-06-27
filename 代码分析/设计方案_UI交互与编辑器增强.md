# 设计方案：UI 交互与编辑器增强 (Monaco Diff/Composer/补全防抖)

---

## 1. 痛点一：Monaco 实时流式 Diff 的性能与撤销栈损坏

### 1.1 痛点分析
在当前 Void 的 [editCodeService.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/browser/editCodeService.ts) 中，AI 生成代码是直接流式写入 Monaco 活跃文档：
1. **渲染卡顿**：流式写入高频触发 Monaco 的语法高亮（Tokenizer）与布局（Layout）重绘。在长文件（>1000行）中会导致编辑器帧率骤降。
2. **撤销栈（Undo Stack）损坏**：当流式写入中途用户手动敲击键盘或取消任务时，VS Code 的 `IUndoRedoService` 会将用户输入与 AI 写入混杂，导致撤销逻辑错乱。

### 1.2 优化策略
- **流写隔离**：将 AI 写入过程与主编辑器渲染分离，避免高频 Monaco 重绘。
- **输入拦截（锁）**：在流式生成期间，锁定编辑区或当前生成区间。
- **事务合并**：把 AI 全程的编辑块包装成单一撤销元素。

### 1.3 方案选型
* **方案 1**：使用 Monaco 原生 `ViewZone` 遮罩层，直接阻断整个编辑器输入。缺点是阻碍了用户在别处编辑的自由。
* **方案 2（首选）**：**基于 Shadow Model 异步计算 + 行区间锁 + 事务合并**。在内存中维护隐藏文档计算 Diff，使用 Monaco 的 `model.pushEditOperations` 批量推送，并锁定指定编辑行区间。

### 1.4 具体方案
1. **行区间锁实现**：
   在编辑器上注册 `onKeyDown` 拦截器：
   ```typescript
   editor.onKeyDown((e) => {
       const selection = editor.getSelection();
       const lockedRange = editCodeService.getActiveDiffZoneRange(); // 获取 AI 写入的 StartLine/EndLine
       if (lockedRange && selection && Range.areIntersecting(selection, lockedRange)) {
           e.preventDefault();
           e.stopPropagation();
           notificationService.warn("AI 正在此处生成代码，暂不支持编辑该区域。");
       }
   });
   ```
2. **Shadow Model 与批量 Patch**：
   AI 字符只追加到虚拟 `shadowModel`。设置 `throttle(50ms)` 频率：
   - 使用 Web Worker 计算 `shadowModel` 与主 `model` 的行 diff。
   - 通过 `model.pushEditOperations` 发起最小范围的 `push`，将其作为单个 `UndoRedo` 组：
     ```typescript
     model.pushStackElement(); // 开始撤销组
     model.pushEditOperations(..., [{ range, text }], ...);
     model.pushStackElement(); // 结束撤销组
     ```

---

## 2. 痛点二：多文件协同修改的“全局预览/撤销”视图 (Composer Mode)

### 2.1 痛点分析
Void 目前的修改完全限定在“单文件”层面。当 AI 执行跨文件复杂重构时，用户无法一次性纵览所有文件发生的变动，也无法一键整体接受/拒绝，极大降低了复杂重构的安全感。

### 2.2 优化策略
- **修改暂存化**：引入内存预修改缓冲区，AI 生成的文件改动不直接写盘。
- **全局 Diff 面板**：设计全局多文件 Diff 并排（Side-by-Side）对比视图。
- **原子事务合并**：用户对多文件修改拥有一键 Accept All / Reject All 的全局事务控制权。

### 2.3 方案选型
* **方案 1**：在 VS Code 活动侧栏中渲染树形 Diff 目录，用户双击打开临时 Diff 编辑器。这是主流 VS Code 插件的做法（如 Git）。
* **方案 2（首选）**：**多文件 Composer 专有视图**。在编辑器区域弹出一个多文件 Diff 滚动合并组件（类似 Cursor Composer），支持勾选合并。

### 2.4 具体方案
1. **多文件修改缓冲区（Staging Buffer）**：
   ```typescript
   export interface StagedFileChange {
       fileUri: string;
       originalContent: string;
       proposedContent: string;
       isAccepted: boolean;
   }
   ```
2. **全局 SCM 提交**：
   - 渲染 React 侧边栏列表，显示变更文件及 Diff 计数。
   - 点击“Accept All”时，执行批量写入并清除缓冲区：
     ```typescript
     async function acceptAllChanges(changes: StagedFileChange[]) {
         const fileEdits = changes.filter(c => c.isAccepted);
         for (const edit of fileEdits) {
             await mcodeModelService.writeTextModel(URI.parse(edit.fileUri), edit.proposedContent);
         }
         clearStagingBuffer();
     }
     ```

---

## 3. 痛点三：自动补全的延迟、高额 API 成本与高频打断

### 3.1 痛点分析
当前的补全在用户每一次敲击键盘时高频触发，带来了三个问题：
1. **打断用户思路**：未写完的代码补全闪烁频繁。
2. **高延迟与高费用**：每次击键都请求云端 API 产生昂贵成本且极慢。

### 3.2 优化策略
- **端云混合路由**：90% 的小颗粒度、语法级补全由本地 SLM（小模型）离线超快速响应；复杂的逻辑和跨文件类补全触发云端大模型。
- **动态防抖（Dynamic Debouncing）**：根据用户实时输入速度（打字间隔）动态缩减/延长补全探测时机。

### 3.3 方案选型
* **方案 1**：在前端设置固定 `300ms` 延迟防抖。缺点是死板，当打字快时依旧会触发多次无效请求。
* **方案 2（首选）**：**WPM 动态防抖 + 本地 Wasm 向量距离判定 + Ollama 端侧分流**。

### 3.4 具体方案
1. **动态防抖逻辑**：
   ```typescript
   let lastKeyPressTime = Date.now();
   let keystrokeIntervals: number[] = [];

   function getDynamicDebounceDelay(): number {
       const avgInterval = keystrokeIntervals.reduce((a, b) => a + b, 0) / (keystrokeIntervals.length || 1);
       if (avgInterval < 150) return 1200; // 用户打字飞快时，延长防抖，静默等待
       if (avgInterval > 600) return 150;  // 停顿时，缩短防抖，立刻触发补全
       return 350;
   }
   ```
2. **端云分流路由**：
   - 用户触发补全时，首先在主进程调用本地运行的 SLM（如 DeepSeek-Coder-1.5B 跑在 localhost:11434）。
   - 本地补全响应速度控制在 150ms 以内。
   - 若本地 SLM 生成的文本可信度（Logprob）极高，直接渲染补全并终结请求；若可信度低，且用户仍处于停顿，则向云端大模型发起 FIM 请求以补全复杂的函数体逻辑。
