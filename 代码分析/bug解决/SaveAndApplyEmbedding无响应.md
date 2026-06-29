# Save & Apply Embedding Model 点击无响应

## 现象

- 在 Settings 中点击 **Save & Apply Embedding Model** 后界面无反馈。
- DevTools 报错：
  ```
  Failed to initialize RAG index with new embedding settings:
  TypeError: Cannot read properties of undefined (reading 'initializeIndex')
      at handleSaveAndApplyEmbedding (index.js:...)
  ```

## 原因

`Settings.tsx` 通过 React 的 `useAccessor()` 获取 `IVoidRagService`：

```typescript
const mcodeRagService = accessor.get('IVoidRagService')
await mcodeRagService.initializeIndex(...)
```

但 `browser/react/src/util/services.tsx` 的 `useAccessor` 映射表中**未注册** `IVoidRagService`，`accessor.get('IVoidRagService')` 返回 `undefined`，调用 `.initializeIndex()` 时抛错并被 `catch` 吞掉，表现为“无响应”。

## 修改方案

1. 在 `services.tsx` 中 import `IVoidRagService`。
2. 在 `useAccessor` 返回对象中增加：
   ```typescript
   IVoidRagService: accessor.get(IVoidRagService),
   ```
3. 执行 `npm run buildreact` 重新打包 React 前端后再 `gulp compile`。

**涉及文件**：`browser/react/src/util/services.tsx`
