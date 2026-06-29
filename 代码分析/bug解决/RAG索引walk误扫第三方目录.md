# 索引 walk 误扫 node_modules / third_party 等目录

## 现象

- 全量建索引时扫描 `.git`、`node_modules`、`third_party`、`out`、`build` 等目录。
- 索引体积膨胀、建索引时间极长，embedding 阶段易触发 context length 错误或主进程长时间阻塞。
- 对 OnlyOffice 类含大量 `third_party` 的项目尤为严重。

## 原因

`llamaIndexService.ts` 的目录 walk 原先仅跳过少量目录名，未统一维护 VCS/构建/第三方依赖目录黑名单，与 `.mcodeignore` 规则也不完全一致。

## 修改方案

1. 新增 `electron-main/rag/ragWalkFilters.ts`：
   - `SKIPPED_DIR_NAMES`：`.git`、`node_modules`、`third_party`、`out`、`build`、`dist` 等。
   - `pathContainsSkippedDirectory()`：路径任一段命中即跳过。
2. `walkDir` / 增量同步（`mcodeRagSyncContrib.ts`）共用同一过滤逻辑。
3. 补充单元测试 `ragWalkFilters.test.ts`。

**涉及文件**：
- `electron-main/rag/ragWalkFilters.ts`
- `electron-main/rag/llamaIndexService.ts`
- `browser/mcodeRagSyncContrib.ts`
