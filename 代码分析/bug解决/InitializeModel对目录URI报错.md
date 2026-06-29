# InitializeModel 对目录 URI 报错

## 现象

- 控制台反复出现：
  ```
  InitializeModel error: ...
  ```
- 多发生在打开工作区、资源管理器展开或 Chat 引用路径时，路径实际为**目录**而非文件。

## 原因

`mcodeModelService.ts` 的 `initializeModel(uri)` 未区分文件与目录，对文件夹 URI 也尝试创建 TextModel，底层 file service 无法按文本文件打开目录从而抛错。

## 修改方案

在 `initializeModel` 开头增加 stat 检查：

```typescript
const stat = await this.fileService.resolve(uri);
if (stat.isDirectory) return;
```

仅对普通文件创建/缓存 editor model。

**涉及文件**：`common/mcodeModelService.ts`
