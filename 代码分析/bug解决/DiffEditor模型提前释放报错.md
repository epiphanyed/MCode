# SingleDiffEditor 报 TextModel 先于 DiffEditorWidget 被释放

## 现象

- 打开单文件 diff（Command Bar / Quick Edit 等）时控制台报错：
  ```
  TextModel got disposed before DiffEditorWidget
  ```
- Diff 视图可能空白或闪烁，影响查看 AI 建议的变更。

## 原因

`inputs.tsx` 中 `SingleDiffEditor` 的 React effect 在组件卸载或 model 切换时：

1. 直接 `dispose()` 了 original/modified `ITextModel`；
2. 但 `DiffEditorWidget` 仍持有对这些 model 的引用；
3. Monaco 要求**先** `diffEditor.setModel(null)` **再** dispose 底层 TextModel。

## 修改方案

合并为单一 `useEffect` 生命周期：

1. 创建/更新 model 并 `setModel({ original, modified })`。
2. cleanup 时顺序固定为：
   ```typescript
   diffEditor.setModel(null);
   originalModel.dispose();
   modifiedModel.dispose();
   diffEditor.dispose();
   ```

**涉及文件**：`browser/react/src/util/inputs.tsx`
