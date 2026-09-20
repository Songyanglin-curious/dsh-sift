# 文档索引

## 执行计划

- [计划索引](plan/index.md)：当前待执行方案与实施顺序。
- [Reference / Output 联动下一步计划](plan/reference-output-workflow.md)：从 Reference Step 1 收口到 Output Tabs、Relations 和生命周期补齐的分阶段执行方案。

## v0.2

- [v0.2 设计方案](v0.2-design.md)：把 Sift 重构为 DSH Workspace Profile，Source → Reference → Document 工作流、三个核心对象、界面与成功标准。
- [v0.2 实施文档](v0.2-implementation.md)：三个技术接缝（SourceResolver / ReferenceCodec / DocumentChangeTool）、模块结构、Phase 0～10 阶段划分与完成标准。
- [v0.2 Phase 0：清死代码与接缝 spike](v0.2-phase0.md)：删除 2420 行死代码、ReferenceCodec 与 DocumentChangeTool 两个接缝的实现位置、自动检查与真实 DSH 运行时证据、待人工确认项。
- [v0.2 Phase 1：骨架](v0.2-phase1.md)：dsh-adapter 拆分、三栏改为参考/文档/原生对话、Untitled Document 与工作区落盘、Default Workspace 不受影响的证据、本轮踩到的三个真问题。

## DSH 能力调研（v0.2 依赖）

- [DSH 自定义 @reference 类型 API 调研](dsh-reference-api-research.md)：0.1.5-rc.2 已安装包中引用契约、`ctx.inputTriggers` 注册、codec 序列化链路、编程式插入 chip 的公开入口与版本坑（逐条 path:line 引用）。
- [DSH 插件自有 Agent 工具注册 API 调研](dsh-tool-registration-api-research.md)：0.1.5-rc.2 已安装包中 `ctx.tools.register` 契约、参数 schema DSL、handler 与返回值形状、全局/Agent 作用域、销毁语义、package.json 约定（逐条 path:line 引用）。

## Workspace Profile

- [Workspace 类型可行性调查](workspace-profile-feasibility.md)：DSH 0.1.5-rc.2 的工作区元信息、导航、布局扩展能力与实验结论。
- [Workspace 类型实验计划](workspace-profile-experiment-plan.md)：default/sift 最小实验的范围、执行步骤与验收标准。
- [Workspace 类型实验记录](workspace-profile-experiment.md)：最小实现、测试目录及验证结果。
- [创建工作区时选择类型](workspace-profile-creation.md)：default / sift 类型选择、写入时机与手工验收步骤。

## v0.1 现有能力（v0.2 期间逐步接管）

- [Sift 三栏布局最小接线](sift-three-column-layout.md)：Profile 驱动主面板切换、实测步骤及原生对话组合边界。
- [素材标签页与引用关系](materials-panel.md)：文件与网页引用维护、分类预览、持久化和验证边界。
- [产出栏 Markdown 编辑器](markdown-editor.md)：Milkdown Crepe 接入、本地文件选择、保存和验证边界。
