# AI 生成图表（Mermaid, Draw.io, Manim）的语法校验、渲染与自愈设计方案

在 AI 编程场景下，智能体常常需要输出直观的图表（如架构图、交互流程图、数学动画等）来辅助开发者理解。然而，大模型生成的 Mermaid、Draw.io XML 或 Manim (Python) 代码时常带有语法错误或运行报错。

本方案旨在设计一套集 **语法校验、双模呈现（源码/预览）、AI 自愈纠错（Self-Repair Loop）** 于一体的图表处理子系统，并无缝集成到 Void 的 React 聊天界面及 Agent Loop 中。

---

## 1. 🔍 痛点分析 (Pain Points)

1. **图表语法极易出错**：
   - **Mermaid**：AI 经常在节点标签中混用圆括号 `()` 或方括号 `[]`，或者忘记转义特殊字符（如引号、标点），导致 Mermaid 解析器直接抛出语法异常。
   - **Draw.io**：其 XML 图元数据（基于 mxGraph 规范）格式极其冗长复杂，大模型生成的 XML 经常存在闭合标签缺失或属性冲突。
   - **Manim**：作为 Python 数学动画库，代码的运行高度依赖特定的 Python 环境与 Manim API 版本。AI 输出的代码常因调用已废弃的方法或参数类型不符导致运行崩溃。
2. **预览与源码割裂**：
   - 目前 Markdown 渲染器只能以原始代码块形式显示它们，用户必须将代码复制到外部工具（如 Mermaid Live Editor、Draw.io 网站）中去查看，操作极其繁琐。
3. **用户调试成本高**：
   - 当图表报错时，用户被迫充当“编译器”，手动排查并修复 AI 的语法低级错误，导致人机协作体验被严重打断。

---

## 2. 💡 优化策略与自愈机制 (Optimization & Self-Repair)

为解决上述痛点，我们设计了 **“三层防护自愈环”**：

1. **前端 JIT 语法哨兵（JIT Validator）**：
   - 在 Markdown 渲染层，一旦解析到 ````mermaid````、````drawio```` 或 ````manim```` 代码块，首先通过前端编译器/解析器执行静态语法分析。
2. **双模渲染呈现（Toggleable Renderer）**：
   - 渲染引擎不再只渲染代码块，而是提供一个 Tab 切换组件：**[ 效果预览 ]** 和 **[ 原始源码 ]**。预览模式下直接显示 SVG（Mermaid）、互动画布（Draw.io）或视频播放器（Manim）。
3. **智能纠错自愈环（Self-Repair Loop）**：
   - 当验证器或编译器检测到语法错误或运行报错时，**自动拦截当前的 Agent 循环**。
   - 将“错误堆栈”、“源码”以及“纠错指令提示词”封装，在后台自动重新发起一次大模型请求（自愈请求），限额重试 $N$ 次（默认 2 次）。如果自愈成功，则将正确图表呈现给用户；若失败，再降级展示错误信息和源码。

---

## 3. 🏗️ 系统架构设计 (Architecture)

本方案的集成涉及 Void 的 React 前端、Electron 主进程后台服务、以及 Agent Loop 编排层：

```mermaid
graph TD
    subgraph 1. FrontEnd UI (React / Markdown)
        ChatUI[Sidebar Chat / Walkthrough] -->|解析 Code Block| MarkdownDisp[Void Markdown Component]
        MarkdownDisp -->|分发图表组件| DiagramWrapper[Diagram Tab Controller]
        DiagramWrapper -->|Tab 1: 渲染器| RenderView[Mermaid SVG / Drawio Canvas / Video Player]
        DiagramWrapper -->|Tab 2: 源码器| CodeView[Monaco Code View]
    end

    subgraph 2. Electron Main Process (Backend Services)
        PtyExecutor[PTY / Process Manager] -->|执行 Python/Manim 编译| PythonEnv[Python Subprocess]
        Validator[Diagram Validator Service] -->|Mermaid / Drawio 静态分析| ParseResult[语法树 AST / XML 验证结果]
    end

    subgraph 3. Agent Loop (Orchestrator)
        AgentLoop[chatThreadService.ts] -->|检测到 AI 输出图表| HookValidator[Validate Output Hook]
        HookValidator -->|校验失败| ErrorIntercept[提取编译报错 & 注入 Correction Prompt]
        ErrorIntercept -->|自愈请求| ReCallLLM[重新呼叫 LLM 修复]
        HookValidator -->|校验成功| FinishLoop[应用修改 / 输出结果]
    end
    
    DiagramWrapper <-->|IPC Tunnel| Validator
    PythonEnv <-->|输出 mp4/png 路径| RenderView
```

---

## 4. 🛠️ 各图表类型接入与校验具体方案

### 4.1. Mermaid 校验、渲染与自愈

#### A. 语法校验与渲染（前端）
在前端利用轻量级的 `mermaid` 官方库进行静态解析。

```typescript
import mermaid from 'mermaid';

// 初始化
mermaid.initialize({ startOnLoad: false, theme: 'dark' });

export async function validateAndRenderMermaid(code: string): Promise<{ success: boolean; svg?: string; error?: string }> {
    try {
        // 1. 语法校验
        await mermaid.parse(code);
        // 2. 渲染为 SVG
        const { svg } = await mermaid.render('mermaid-temp-id', code);
        return { success: true, svg };
    } catch (err: any) {
        // 提取精准的错误行号和错误提示
        return { success: false, error: err.message || 'Unknown Mermaid parsing error' };
    }
}
```

#### B. 自愈机制对接（Agent Loop）
在 `chatThreadService.ts` 的流输出结束时拦截处理：

```typescript
// 伪代码：在 LLM 返回完成后拦截
const handleMermaidSelfRepair = async (mermaidCode: string, threadId: string, retryCount = 0) => {
    const checkResult = await validateAndRenderMermaid(mermaidCode);
    if (checkResult.success) return mermaidCode; // 验证通过，直接返回

    if (retryCount >= 2) {
        // 超过重试次数，降级显示错误信息给用户
        return `\`\`\`mermaid\n${mermaidCode}\n\`\`\`\n> ⚠️ Mermaid 语法解析失败:\n\`\`\`\n${checkResult.error}\n\`\`\``;
    }

    // 构建纠错提示词发送给大模型
    const correctionPrompt = `
你刚刚生成的 Mermaid 图表代码存在语法错误，导致解析器报错。
报错信息如下：
${checkResult.error}

请严格遵守 Mermaid 语法规范，修复上述错误，并重新输出完整的 Mermaid 代码块。请不要包含任何解释性文字。
错误代码：
\`\`\`mermaid
${mermaidCode}
\`\`\`
`;

    // 后台静默调用 LLM 重新生成
    const fixedCode = await callLLMForCorrection(correctionPrompt, threadId);
    // 递归校验
    return handleMermaidSelfRepair(fixedCode, threadId, retryCount + 1);
};
```

---

### 4.2. Draw.io 校验、渲染与自愈

Draw.io 数据通常以压缩后的 `mxGraph` XML 存储。

#### A. 渲染方案 (React WebView)
在前端引入 Draw.io 官方的静态静态阅读器（Viewer）：
```tsx
import React from 'react';

export const DrawioViewer = ({ xmlData }: { xmlData: string }) => {
    // 使用 Draw.io static viewer API，通过 iframe 或 mxGraph 引擎加载
    const encodedXml = encodeURIComponent(xmlData);
    const viewerUrl = `https://viewer.diagrams.net/?embed=1&proto=json`;

    return (
        <iframe
            src={viewerUrl}
            className="w-full h-96 border-none"
            onLoad={(e) => {
                const iframe = e.currentTarget;
                // 向 iframe 发送 XML 数据进行动态渲染
                iframe.contentWindow?.postMessage(JSON.stringify({
                    action: 'load',
                    xml: xmlData,
                    autosave: 1
                }), '*');
            }}
        />
    );
};
```

#### B. 语法校验（前端 / 后端）
在后端使用 XML 解析器检查 XML 格式和 `mxGraphModel` 核心元素是否存在：
```typescript
import { DOMParser } from 'xmldom';

export function validateDrawioXML(xmlStr: string): { success: boolean; error?: string } {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlStr, 'text/xml');
        
        // 检查是否包含 mxGraphModel 根节点
        const hasGraphModel = doc.getElementsByTagName('mxGraphModel').length > 0;
        if (!hasGraphModel) {
            return { success: false, error: 'XML is missing required <mxGraphModel> root element.' };
        }
        return { success: true };
    } catch (e: any) {
        return { success: false, error: `Invalid XML syntax: ${e.message}` };
    }
}
```
*自愈逻辑同 Mermaid：若 XML 解析失败或缺失必要图元，提取 XML Parse Error 发送回 LLM 重新纠错生成。*

---

### 4.3. Manim 校验、运行与呈现

Manim 生成的是 Python 代码，必须在本地 Python 环境中执行渲染。

#### A. 编译执行与校验（Electron 主进程 PTY）
主进程提供 `ManimRenderService`，利用后台终端执行器拉起子进程：
```typescript
import { exec } from 'child_process';
import * as path from 'path';

export class ManimRenderService {
    // 编译 Python 代码并渲染为视频/图片
    public async renderManimScene(pythonCode: string, cwd: string): Promise<{ success: boolean; mediaPath?: string; error?: string }> {
        // 1. 将代码写入临时 Python 文件
        const tempFilePath = path.join(cwd, 'temp_manim_scene.py');
        await fs.writeFile(tempFilePath, pythonCode);

        // 2. 执行 manim 渲染指令（-ql 代表低画质快速渲染方便快速预览）
        // 假设当前系统已配置 Python 和 manim 环境
        return new Promise((resolve) => {
            exec(`manim -ql ${tempFilePath}`, { cwd }, (error, stdout, stderr) => {
                if (error) {
                    // 编译或运行报错，捕获 Traceback 错误输出
                    resolve({ success: false, error: stderr || stdout || error.message });
                } else {
                    // 3. 解析 stdout 提取生成的 .mp4 文件绝对路径
                    const mp4Path = this.extractMp4Path(stdout);
                    resolve({ success: true, mediaPath: mp4Path });
                }
            });
        });
    }
}
```

#### B. 前端呈现
前端拿到编译成功后的 `.mp4` 绝对路径后，直接使用 HTML5 `<video>` 进行行内渲染播放，并支持循环、倍速播放，极大方便用户调试。

#### C. 自愈纠错（错误反馈）
由于 Manim 经常抛出 Python 的 AttributeError 或 NameError，后台捕获到的完整的 Python Traceback 会被直接当做纠错输入：
```markdown
【纠错输入示例】：
你的 Manim 动画代码在编译时报错。
错误堆栈如下：
Traceback (most recent call last):
  File "temp_manim_scene.py", line 12, in construct
    self.play(ShowCreation(circle))
NameError: name 'ShowCreation' is not defined (在 Manim v3 中此方法已更改为 Create)

请根据 Manim 的最新 API 规范进行修复并重新输出代码。
```

---

## 5. 💡 前端 UI 交互设计 (User Interface)

为了保证一流的视觉体验，我们将图表渲染封装在 Tab 组中：

```tsx
import React, { useState } from 'react';

export const DiagramContainer = ({ type, code, errorMsg, renderedSvg, videoUrl }) => {
    const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');

    return (
        <div className="border border-void-border-3 rounded-lg overflow-hidden bg-void-bg-2 my-2">
            {/* Header 控制栏 */}
            <div className="flex justify-between items-center bg-void-bg-1 px-3 py-1.5 border-b border-void-border-3 text-xs">
                <span className="font-mono text-void-fg-3 uppercase">{type} 图表</span>
                <div className="flex gap-1.5">
                    <button 
                        className={`px-2 py-0.5 rounded transition ${activeTab === 'preview' ? 'bg-void-primary text-white' : 'text-void-fg-3 hover:bg-void-bg-3'}`}
                        onClick={() => setActiveTab('preview')}
                    >
                        效果预览
                    </button>
                    <button 
                        className={`px-2 py-0.5 rounded transition ${activeTab === 'code' ? 'bg-void-primary text-white' : 'text-void-fg-3 hover:bg-void-bg-3'}`}
                        onClick={() => setActiveTab('code')}
                    >
                        原始源码
                    </button>
                </div>
            </div>

            {/* 内容呈现区 */}
            <div className="p-3 overflow-auto max-h-96">
                {activeTab === 'preview' ? (
                    errorMsg ? (
                        <div className="text-red-500 text-xs font-mono whitespace-pre-wrap bg-red-950/20 p-2 rounded border border-red-900">
                            <strong>⚠️ 渲染失败:</strong><br/>{errorMsg}
                        </div>
                    ) : type === 'mermaid' ? (
                        <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: renderedSvg }} />
                    ) : type === 'drawio' ? (
                        <DrawioViewer xmlData={code} />
                    ) : (
                        <video src={`file://${videoUrl}`} controls className="w-full rounded" />
                    )
                ) : (
                    <pre className="text-xs font-mono text-void-fg-2 bg-void-bg-1 p-2 rounded">{code}</pre>
                )}
            </div>
        </div>
    );
};
```

---

## 6. 📈 校验与自愈的整体验证计划 (Verification Plan)

### A. 单元测试设计
在 `d:\work\void\scratch/` 中编写图表校验单元测试，模拟 AI 输出各种坏代码：
1. **测试 Mermaid 报错校验**：提供缺括号、中文逗号等坏代码，验证是否触发 Error 回调。
2. **测试 Draw.io XML 校验**：提供不闭合的 XML，验证校验器能否拦截。
3. **测试自愈 Prompt 的拼接**：确保生成的纠错 Prompt 完美包含错误 Traceback 和原始代码。

### B. 手动环境集成测试
1. 安装 Python 并在宿主机配置 Manim 环境，使用 Void 聊天界面命令 AI 生成“用 Manim 绘制傅里叶变换的动态动画”。
2. 人为引入 API 错误，观察后台是否静默拦截，大模型是否成功读取错误信息并自愈生成正确且可以直接在 React UI 播放的 MP4 视频。
3. 在 Markdown 渲染模块验证 Tab 组件切换是否流畅，确保深浅色主题适配。
