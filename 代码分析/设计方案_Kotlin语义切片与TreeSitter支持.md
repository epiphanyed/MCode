# 设计方案：Kotlin 语义切片与 Tree-sitter AST 索引支持

本文档描述 MCode 本地向量 RAG 索引中对 Kotlin（`.kt` / `.kts`）的扫描、语义切片、Code Graph 与索引集成方案。

**方案选型**：方案 B — Tree-sitter WASM 主路径 + 正则稳健降级。

**实现状态**：已落地（2026-07）。下文「设计」与「实现」合并描述，标注与初版方案的差异。

---

## 1. 背景与目标

### 1.1 原有问题（已解决）

| 问题 | 现状 |
|------|------|
| `.kt` / `.kts` 不在索引白名单 | 已加入 `llamaIndexService`、`codeGraphBuilder`、`gitDynamicContext` |
| `@vscode/tree-sitter-wasm` 无 Kotlin grammar | 通过 `postinstall` 额外下载 `tree-sitter-kotlin.wasm` |
| 无 Kotlin regex fallback | 已实现 `KT_PATTERNS`，避免整文件单 chunk |
| AST 符号名 / 类型 / Graph 边缺失 | 已实现 `simple_identifier`、`property_declaration`、Graph Kotlin 适配 |

### 1.2 目标

- 工作区 Kotlin 源码进入向量索引与 Code Graph
- 优先 Tree-sitter AST 切片；WASM 不可用或失败时 regex 降级
- `code_symbol_map.json` 中具备正确的 `symbolType` / `symbolName`
- Code Graph 支持 Kotlin 的 import / call / inherit（尽力解析）

---

## 2. 架构概览

```
.kt / .kts 文件
    │
    ▼
llamaIndexService（CODE_EXTENSIONS 白名单）
    │
    ▼
chunkCodeForIndexing()
    ├─► treeSitterChunker.chunkWithTreeSitter()   ← 主路径
    │       tree-sitter-kotlin.wasm
    └─► semanticCodeChunker.chunkCodeSemantically() ← fallback（KT_PATTERNS）
    │
    ▼
codeGraphBuilder + codeGraphTreeSitter
    ├─ import / call / inherit 边
    └─ code_symbol_map.json
```

---

## 3. 文件白名单

已在以下文件加入 `.kt`、`.kts`：

| 文件 | 作用 |
|------|------|
| `src/vs/workbench/contrib/mcode/electron-main/rag/llamaIndexService.ts` | RAG 索引扫描 |
| `src/vs/workbench/contrib/mcode/electron-main/rag/codeGraphBuilder.ts` | Code Graph 构建 |
| `src/vs/workbench/contrib/mcode/electron-main/rag/gitDynamicContext.ts` | Git 动态上下文 |

---

## 4. Tree-sitter Kotlin WASM

### 4.1 来源与版本

- **npm 包** `@vscode/tree-sitter-wasm@0.1.4` **不包含** Kotlin grammar（仅 cpp/ts/js/py/java 等）
- **额外下载**：`tree-sitter-wasms@1.3.0` 中的 `tree-sitter-kotlin.wasm`（约 4MB）
- **目标路径**：`node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-kotlin.wasm`

### 4.2 自动下载（postinstall）

`package.json`：

```json
"postinstall": "node build/npm/postinstall.js"
```

`build/npm/postinstall.js` 末尾 `downloadKotlinWasm()`：

- `npm install` / `npm ci` 结束后**同步**执行
- 文件已存在且 ≥ 100KB → 跳过
- 否则 `curl -fsSL` 下载；Windows 失败时回退 PowerShell `Invoke-WebRequest`
- 下载失败 → `process.exit(1)`，避免静默缺失

**注意**：不要使用 `npm install --ignore-scripts`，否则会跳过下载。

### 4.3 打包白名单

`build/.moduleignore` 对 `@vscode/tree-sitter-wasm/wasm/tree-sitter-*.wasm` 默认排除，以下 grammar **显式放行**（含 RAG 所需的全部语言 + Kotlin）：

- `tree-sitter-cpp`、`typescript`、`tsx`、`javascript`、`python`、`java`、`go`、`rust`、`c-sharp`、`ruby`
- `tree-sitter-kotlin`（postinstall 下载，非 npm 包自带）
- 编辑器用：`regex`、`ini`、`css`

---

## 5. Grammar 映射

`treeSitterGrammarMap.ts`：

```typescript
'.kt': 'tree-sitter-kotlin',
'.kts': 'tree-sitter-kotlin',
```

`.kts`（如 `build.gradle.kts`）与 `.kt` 共用同一 WASM grammar。

---

## 6. AST 切片（treeSitterChunker.ts）

### 6.1 节点 → symbolType 映射

| Kotlin AST 节点 | symbolType | 说明 |
|-----------------|------------|------|
| `class_declaration` | `class` | 普通 class |
| `class_declaration`（文本以 `interface` 开头） | `interface` | grammar 中 interface 也用 `class_declaration` |
| `class_declaration`（文本以 `enum class` 开头） | `enum` | 枚举类 |
| `object_declaration` | `class` | object / companion |
| `function_declaration` | `function` | 顶层或成员 fun |
| `property_declaration` | `property` | val / var |

> 初版设计中的 `interface_declaration` 节点在 **fwcd/tree-sitter-kotlin** grammar 里实际为 `class_declaration` + `interface` 关键字，通过 `resolveSymbolType()` 按文本前缀区分。

### 6.2 符号名提取

| 场景 | 实现 |
|------|------|
| class / object 名 | `type_identifier`（`findDescendantIdentifier`） |
| fun 名 | `kotlinFunctionName()` → 首个 `simple_identifier` |
| property 名 | `kotlinPropertyName()` → `variable_declaration` 内 `simple_identifier` |
| 文本 fallback | `extractNameFromText` 支持 `fun`、`val`/`var`、`interface`、`enum class` |

**标识符类型集合**：`identifier`、`type_identifier`、`property_identifier`、**`simple_identifier`**（Kotlin 专用，初版遗漏项）。

### 6.3 嵌套与 dedupe

- 类内部的 `fun processData` 等**不单独切 chunk**，合并在 class chunk 内（与 C++/TS 行为一致，`dedupeNestedSpans` 去嵌套）
- 顶层 `fun`、`val`、`interface`、`enum class` 独立 chunk

---

## 7. 正则降级（semanticCodeChunker.ts）

当 Tree-sitter 不可用、解析失败或 defer 重试仍失败时，走 `KT_PATTERNS`：

```typescript
const KT_PATTERNS: PatternDef[] = [
  { type: 'enum',      regex: /\benum\s+class\s+[\w$]+/g, hasBlock: true },
  { type: 'interface', regex: /…interface\s+[\w$]+/g,     hasBlock: true },
  { type: 'class',     regex: /…(?:class|object)\s+[\w$]+/g, hasBlock: true },
  { type: 'function',  regex: /…fun\s+[\w$`]+/g,         hasBlock: true },
  { type: 'function',  regex: /…fun\s+[\w$`]+…=/g,         endAtLine: true },  // expression body
  { type: 'property',  regex: /\b(?:val|var)\s+…/g,         endAtLine / hasBlock },
];
```

支持多 modifier（`suspend`、`inline`、`data` 等）、`fun foo() = 42` 表达式体、`enum class`。

---

## 8. Code Graph（Kotlin 适配）

### 8.1 Tree-sitter 边提取（codeGraphTreeSitter.ts）

| 边类型 | Kotlin AST | 实现要点 |
|--------|------------|----------|
| **import** | `import_header` | `kotlinImportSpec()`，支持 `import x.y as Alias` |
| **call** | `call_expression` | `simple_identifier`、`navigation_expression`（`foo.bar()` → `bar`） |
| **inherit** | `delegation_specifier` | `class A : Base(), IFace` → `Base`、`IFace` |

### 8.2 路径解析（codeGraphBuilder.ts）

| import 形式 | 解析策略 |
|-------------|----------|
| 相对 `import ./Foo` | 同 TS，尝试 `.kt` / `.kts` |
| FQCN `import com.example.Foo` | 启发式：`{workspace}/src/main/kotlin/com/example/Foo.kt`，次选 `src/`、`/` 下同名路径；存在则返回，否则返回首选猜测路径 |

> FQCN 不做完整 Gradle/Maven 模块解析；非标准目录布局可能路径不准，但同 workspace 内 symbol 级 call/inherit 仍可用。

### 8.3 Regex fallback（Graph）

- `KT_IMPORT_REGEX`：AST 不可用时的 import 提取
- `KT_CLASS_INHERIT_REGEX`：`class A : Base(), IFace` 继承提取

---

## 9. 测试

| 测试文件 | 覆盖 |
|----------|------|
| `treeSitterChunker.test.ts` | `canTreeSitterParse('a.kt')`；Kotlin AST 切片（class/interface/enum/property/expression-body fun）；`chunkCodeForIndexing` 集成 |
| `semanticCodeChunker.test.ts` | regex fallback：class/object/interface/enum/property/fun |

运行（需先 `npm run compile`）：

```bash
npm run compile
npm run test-node -- --grep treeSitterChunker
npm run test-node -- --grep semanticCodeChunker
```

Tree-sitter 相关用例在 WASM 不可加载时会 `skip`。

---

## 10. 手动验收

1. `npm install`（确认 postinstall 日志含 kotlin wasm）
2. `npm run compile`，**完全重启** MCode
3. 工作区放入 `Main.kt`（含 class、interface、enum、val、fun）
4. Settings → **Rebuild Index**
5. 检查 `%APPDATA%\MCode\LlamaStore\<project>\`：
   - `index_manifest.json` — 文件/chunk 计数增加
   - `code_symbol_map.json` — 含 `MyClass`、`topLevelFun` 等条目，`symbolType` 正确
6. RAG 提问 Kotlin 相关代码，返回 chunk 含正确 `symbolName` metadata

---

## 11. 已知限制（非缺陷，后续可选增强）

| 项 | 说明 |
|----|------|
| 类内成员 fun | 不单独 chunk，合并在 class 内 |
| FQCN import | 启发式路径，非全 Gradle 工程模型 |
| `companion_object` / `secondary_constructor` | 未单独映射为 chunk |
| `.kts` Gradle DSL | 走通用 Kotlin grammar，无 DSL 专用规则 |
| WASM 版本 | 锁定 `tree-sitter-wasms@1.3.0`；升级 `@vscode/tree-sitter-wasm` 时需回归 ABI 兼容性 |

---

## 12. 关键文件索引

| 模块 | 路径 |
|------|------|
| 索引白名单 | `llamaIndexService.ts` |
| Grammar 映射 | `treeSitterGrammarMap.ts` |
| WASM 运行时 | `treeSitterRuntime.ts` |
| AST 切片 | `treeSitterChunker.ts` |
| Regex 降级 | `semanticCodeChunker.ts` |
| Graph AST | `codeGraphTreeSitter.ts` |
| Graph 路径/regex | `codeGraphBuilder.ts` |
| WASM 下载 | `build/npm/postinstall.js` |
| 打包白名单 | `build/.moduleignore` |
