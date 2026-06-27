# tree-sitter 加载方案（Phase 5 / P5-1）

Electron Main 进程 RAG 切片使用与 VS Code 编辑器相同的 WASM 加载路径。

## 可行方案

| 方案 | 结论 |
| :--- | :--- |
| `require('@vscode/tree-sitter-wasm/wasm/tree-sitter.js')` | ❌ UMD 工厂返回值未挂到 `module.exports`，`Parser` 为 `undefined` |
| 独立 `web-tree-sitter` npm 包 | ❌ 与 `@vscode/tree-sitter-wasm` 的 WASM 版本不匹配，`tree_sitter_progress_callback` 导入失败 |
| **`createRequire` + global `define.amd`** | ✅ 真实 Node 模块上下文加载，支持 `Parser.init()` 内 dynamic import |
| `importAMDNodeModule` (amdX vm) | ⚠️ vm 沙箱内 `Parser.init()` 会因缺少 dynamic import 回调失败 |

## 实现路径

```
treeSitterRuntime.ts
  └─ global define.amd + createRequire(tree-sitter.js)  // 真实 Node 上下文
  └─ Parser.init({ locateFile: () => .../tree-sitter.wasm })
  └─ Language.load(fs.readFileSync(.../tree-sitter-cpp.wasm))

treeSitterChunker.ts
  └─ createTreeSitterParser(grammar) → parse → 语义节点 → SemanticCodeChunk[]

semanticCodeChunker.ts
  └─ chunkCodeForIndexing(): AST 优先，失败或无语法 → chunkCodeSemantically() 正则
```

## WASM 路径

开发态：`{process.cwd()}/node_modules/@vscode/tree-sitter-wasm/wasm/`  
打包态：与 amdX 相同，通过 `FileAccess` 解析 `node_modules`（`importAMDNodeModule` 内部处理）。

Grammar 映射见 `treeSitterChunker.ts` 中 `EXT_TO_GRAMMAR`。

## manifest v2

`index_manifest.json` 增加 `chunkEngine: "tree-sitter-hybrid-v1"`，`version: 2`。  
与 v1 不兼容，启动索引时会自动触发 rebuild。
