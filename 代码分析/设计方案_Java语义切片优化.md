# 设计方案_Java语义切片与多语言 AST 索引优化

本文档设计了将 Java 代码索引切片由脆弱的正则方案迁移至高精度的 Tree-sitter AST 方案，并扩展其它主流语言（Go、Rust、C#、Ruby）的 Tree-sitter 切片支持。

---

## 1. 痛点分析

目前 Java 代码的索引切片工作由 [javaSemanticChunker.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/rag/javaSemanticChunker.ts) 完成。这是一个完全基于正则表达式和括号匹配状态机的自定义切片器：
* **泛型与注解匹配脆弱**：Java 方法可能具有极其复杂的泛型修饰符（如 `<T extends Comparable<T>>`）和多行方法注解（如 `@Override`, `@RequestMapping`），正则难以实现 100% 稳定的匹配，容易导致方法头部解析分裂。
* **状态机边界死角**：括号计数匹配器 `findBlockEnd` 在面对复杂的 Lambda 表达式、内部类以及 Java 多行 Text Blocks 时容易被转义字符或特定注释干扰，导致匹配失效。
* **缺少对其它核心语言的语义支持**：工作区中已携带 `tree-sitter-go.wasm`、`tree-sitter-rust.wasm` 等高质量解析器，但未被映射启用，导致这些语言只能退化至普通文本切片或简单的正则前缀切片，索引质量低下。

---

## 2. 优化方案

将 Java 及其他语言迁移至 WebAssembly 版的 Tree-sitter 解析器：

### 2.1 扩展 Tree-sitter 语法映射
在 [treeSitterChunker.ts](file:///d:/work/void/src/vs/workbench/contrib/mcode/electron-main/rag/treeSitterChunker.ts) 中：
1. **添加后缀支持**：在 `EXT_TO_GRAMMAR` 映射中加入：
   * `.java`: `tree-sitter-java`
   * `.go`: `tree-sitter-go`
   * `.rs`: `tree-sitter-rust`
   * `.cs`: `tree-sitter-c-sharp`
   * `.rb`: `tree-sitter-ruby`
2. **添加 AST 节点转换**：在 `NODE_TYPE_TO_SYMBOL` 中添加各语言代表函数与类的 AST 节点：
   * `class_declaration`: `class` (Java, C#)
   * `interface_declaration`: `interface` (Java)
   * `enum_declaration`: `enum` (Java)
   * `method_declaration`: `method` (Java)
   * `constructor_declaration`: `constructor` (Java)
   * `function_declaration`: `function` (Go, Rust)
   * `method_declaration`: `method` (Go)
   * `struct_declaration`: `struct` (Go)
   * `struct_item`: `struct` (Rust)
   * `impl_item`: `class` (Rust)
