# Sift

Sift 是 DSH 的轻量“当前文章参考”插件。它不再创建工作区类型、三栏工作台或 Document 区域；文章浏览、分栏、文件管理和会话继续使用 DSH 原生能力。

## 当前能力

- 打开 DSH 工作区中的 Markdown / 文本文件后，在原生文件工具栏显示“参考”图标；
- 点击图标，在文件预览旁打开只属于当前文章的并排参考栏；
- 直接粘贴剪贴板内容；没有参考时会自动创建并关联当前文章；
- 导入长会话并进行 User Turn 相关性定位；
- 文章与 References 的关系按文件路径保存；
- 与独立的 `@songyanglin/dsh-annotations` 协作，在文章、参考和对话中使用统一批注。

```text
DSH 原生文件预览
  ├─ 选中文字 → Annotations → 当前会话
  └─ 参考图标 → 当前文章并排参考栏
                    ├─ 粘贴 / 添加已有材料
                    └─ 会话相关性分析
```

## 开发

```powershell
pnpm install
pnpm check
pnpm test
pnpm build
```

当前适配 DSH `0.2.0-rc.2`，要求 Node.js 24 或更高版本。
