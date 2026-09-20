# Reference / Output 联动下一步计划

## 1. 目标

在不回归 Reference Card 现有能力的前提下，完成左侧 Reference 与中间 Output 的基础工作流，并始终保持四类动作独立：

1. 创建对象：创建新的 Reference 文件或 Output 文件。
2. 选择已有对象：把已有 Reference 或 Output 加入当前工作区。
3. 维护关联：显式修改 `Output → References`。
4. 切换上下文：切换 Output 时只读取已有关系并更新左侧可见 Reference。

必须守住以下边界：

```text
创建文件 != 打开文件
打开文件 != 建立关联
切换文件 != 修改关联
关闭 Tab != 删除物理文件
```

## 2. 当前基线

### 2.1 已具备

- Reference 文件的创建、读取、保存和删除 Host API。
- Reference Tab、名称截断、完整名称 Tooltip、编辑名称和描述、新建入口。
- “添加已有参考”入口和选择弹窗。
- 自由模式 Reference Tab 关闭入口，关闭不会删除物理文件。
- Card 粘贴、编辑、删除、拖拽排序和 History 链路。
- `relations.json` 模型及 `getDocumentRelations`、`setDocumentRelations` Host API。
- 单 Document Markdown 编辑、自动保存、外部修改检测和未保存保护。

### 2.2 尚未完成

- 启动时仍会自动打开已有 Reference；没有 Reference 时仍会自动创建“未命名参考”。
- `freeReferenceTabs` 只是 Reference 面板内存状态，尚未形成工作区级状态。
- “添加已有参考”当前是全量多选覆盖，不是纯增量添加。
- 添加已有 Reference 后不会稳定地自动切换到新增项。
- Output 仍是单 Document 模型，没有 Output Tabs、添加已有 Output 或显式新建流程。
- Reference 与 Output 分别挂载，尚无共享状态控制器。
- Relation Host Store 虽已存在，但客户端尚未消费。
- 当前完整测试不是全绿，不能把现有能力判定为已完成回归验收。

## 3. 最终状态模型

```ts
interface WorkspaceState {
  activeOutput?: string
  activeReference?: string
  outputTabs: string[]
  freeReferenceTabs: string[]
}
```

关系保持独立：

```ts
interface RelationRecord {
  target: string
  references: string[]
}
```

左侧可见列表只有一个计算入口：

```ts
const visibleReferences = activeOutput
  ? relations[activeOutput] ?? []
  : freeReferenceTabs
```

禁止再引入第三套临时 Reference 列表，也禁止把自由列表与关联列表做 union。

## 4. 实施阶段

### Phase A：收口 Reference 自由工作模式

目标：不依赖 Output 和 Relation，先让 Reference 自身形成完整闭环。

任务：

1. 删除启动时自动创建 Reference 的行为。
2. 删除启动时自动打开第一个已有 Reference 的行为。
3. 增加真正的 Reference 空状态。
4. 保持 `＋` 只表示新建 Reference。
5. 将“添加已有参考”改成纯增量加入行为，不借此移除已有 Tab。
6. 添加成功后自动切换到被添加的 Reference。
7. 新建成功后原子地执行：加入自由 Tabs、设为活动 Reference、刷新界面。
8. 自由模式 Tab `×` 只从 `freeReferenceTabs` 移除，不删除 Reference 文件。
9. 当前 Reference 关闭后：优先选择相邻 Tab；没有 Tab 时进入空状态。
10. 明确 `freeReferenceTabs` 和 `activeReference` 的持久化位置；至少必须按 Workspace 隔离。

本阶段不做：

- 不读取或写入 Relation。
- 不判断 `activeOutput`。
- 不修改 Card 数据结构和 Card 核心交互。
- 不实现删除 Reference 文件的新入口。

验收：

- 空工作区打开后不产生 Reference 文件。
- 已有 Reference 不会在未选择时自动进入 Tab。
- 新建与添加已有是两个独立入口。
- 添加已有 Reference 后进入 Tab 并成为活动项。
- 关闭 Tab 不删除物理文件。
- 重新进入同一 Workspace 时按约定恢复自由工作集；不同 Workspace 不串状态。
- Card 粘贴、编辑、删除、排序和 History 行为不回归。

### Phase B：建立 Workspace Controller

目标：让 Reference 和 Output 消费同一个工作区状态，而不是组件互相调用。

任务：

1. 引入工作区级 Controller/Store，持有 `WorkspaceState`。
2. 将 Reference 面板内的 `currentPath` 映射为 `activeReference`。
3. 将 `freeReferenceTabs` 移出 Reference 面板局部状态。
4. 提供纯查询 `visibleReferences`。
5. 定义明确动作：
   - `createReference`
   - `addExistingReference`
   - `closeFreeReferenceTab`
   - `activateReference`
   - `createOutput`
   - `addExistingOutput`
   - `closeOutputTab`
   - `activateOutput`
   - `updateOutputRelations`
6. 所有跨栏联动由 Controller 编排；Reference Panel 和 Output Editor 只渲染状态、派发动作。

本阶段不做：

- 不实现完整 Output Tab UI。
- 不在切换动作中写 Relation。
- 不改变 Markdown Editor 的保存协议。

验收：

- Reference 局部组件不再保存第二份工作区状态。
- `visibleReferences` 只有一个定义位置。
- 切换 Workspace 后状态完全隔离。
- Controller 的状态转移有纯逻辑单元测试。

### Phase C：Output Tabs 与多文档生命周期

目标：完成 Output 工作集，但暂不接入 Reference Relation。

任务：

1. 增加 Output Tab Bar。
2. 增加“添加已有 Output”入口，只允许选择 `.md`。
3. 保持 `＋` 只表示新建 Output。
4. 新建流程明确为：选择目录、输入文件名、创建 `.md`、加入 `outputTabs`、设为 `activeOutput`。
5. 添加已有流程明确为：选择 `.md`、加入 `outputTabs`、设为 `activeOutput`。
6. 切换 Output 前捕获当前编辑器草稿；加载目标 Output 后再更新编辑器。
7. 保留现有自动保存、首次显式保存、外部修改检测和 `beforeunload` 保护。
8. 明确切换时保存失败或外部冲突的处理方式，禁止静默覆盖或丢弃草稿。
9. 实现 Output 空状态。

本阶段不做：

- 不初始化 Relation。
- 不因打开或切换 Output 修改 Reference Tabs。
- 不实现 Output 删除和重命名。

验收：

- 新建与添加已有语义独立。
- 多个 Output 可以加入、切换并保持各自草稿。
- 切换失败不会静默丢失正文。
- 只允许把 `.md` 作为已有 Output 加入。
- 切换 Output 不调用 `setDocumentRelations`。

### Phase D：接入 Output → References

目标：让左侧 Reference Tabs 成为当前 Output 的素材上下文。

任务：

1. Controller 加载和缓存当前 Workspace 的 Relations。
2. `activeOutput` 存在时，左侧只显示该 Output 的关联 References。
3. Output `✎` 打开“编辑关联”多选表单，数据源为当前 Workspace 下全部 Reference 文件。
4. 保存编辑关联后更新 `relations[activeOutput]`，左侧立即同步。
5. 有活动 Output 时，“添加已有参考”只向当前 Output 关系增量加入所选 Reference。
6. 无活动 Output 时，“添加已有参考”仍只修改 `freeReferenceTabs`。
7. 切换 Output 只查询关系，绝不创建或修改关系。
8. 更新可见列表后处理 `activeReference`：
   - 新列表仍包含当前项：保持。
   - 不包含：选择第一项。
   - 列表为空：设为 `undefined`。
9. 过滤不存在或损坏的 Reference，避免悬挂 Relation 路径破坏面板。

本阶段不做：

- 不因普通 Tab 切换修改关系。
- 有活动 Output 时不把 `freeReferenceTabs` 拼进关联列表。
- 不在 Reference Tab `×` 中隐式解除关联；关系修改统一走明确入口。

验收：

- 不同 Output 显示各自的 Reference Tabs。
- 切换 Output 前后 Relation 文件内容不变。
- 编辑当前 Output 关系后左侧立即同步。
- 有 Output 时添加已有 Reference 会增量写入当前关系。
- 无 Output 时 Reference 仍能独立工作。

### Phase E：Output 初始化与生命周期补齐

目标：完成首次加入规则以及关闭、重命名、删除后的清理边界。

任务：

1. 新建 Output 前先捕获切换前的 `visibleReferences`。
2. 新建成功后，用捕获结果初始化新 Output 的关系，再激活该 Output。
3. 添加已有 Output 前先捕获切换前的 `visibleReferences`。
4. 已存在 Relation 时原样保留，绝不覆盖。
5. 确实不存在 Relation 记录时，才用捕获结果初始化。
6. 调整 Relation Store，使“没有记录”和“明确为空的关系”可以区分；禁止用 `[]` 同时表示两种状态。
7. 实现有 Output 时新建 Reference 自动关联当前 Output。
8. 实现 Output Tab 关闭，只移出 `outputTabs`，不删除文件。
9. 实现 Output 重命名后的 Relation target 更新。
10. 实现 Output 删除后的 Relation 清理，并单独确认是否删除物理 `.md`。
11. 实现 Reference 物理删除后的全量 Relation 清理。

验收：

- 新建 Output 继承切换前的可见 Reference 工作集。
- 首次添加已有 Output 才初始化关系。
- 已有关联和明确空关联都不会被覆盖。
- 关闭 Tab 与删除文件保持独立。
- 重命名和删除不会留下错误的 Relation target。

## 5. 测试计划

### 5.1 先恢复可信基线

开始功能实现前，先分类并处理当前完整测试中的失败：

- History 分支记录用例。
- `open-path` 的异步 spawn 用例。
- `scaffold.test.ts` 在 Node 环境加载 `md-block` 的问题。
- `sift-layout-wiring.test.ts` 的 DSH UI primitives 解析问题。
- `workspace-creator.test.ts` 的 `.ts` 文件 JSX 转换问题。

这些问题未全部解决前，报告中必须区分：

- 本阶段新增测试是否通过。
- `pnpm check` 是否通过。
- 完整 `pnpm test` 是否通过。
- 哪些失败属于已知基线、哪些是本阶段新回归。

### 5.2 每阶段验证层级

1. 纯状态逻辑单元测试。
2. Reference Panel / Output Editor DOM 行为测试。
3. Host Store 与真实临时 Workspace 集成测试。
4. `pnpm check`。
5. `pnpm test`。
6. `pnpm build`。
7. 隔离 Profile 中验证插件挂载和实际工作区文件变化。
8. 人工验证真实浏览器中的 Tab、编辑器切换、拖拽和粘贴行为。

不要用“构建成功”代替真实交互验收，也不要把未执行的浏览器验收写成已完成。

## 6. 推荐提交边界

每个阶段单独提交，避免把 UI、状态重构和 Relation 行为混在一起：

1. `Reference free-workspace cleanup`
2. `Workspace state controller`
3. `Output tabs and switching`
4. `Output-reference relations`
5. `Initialization and lifecycle cleanup`

每次提交只包含该阶段文件和测试，保留当前工作区已有的无关未提交改动。

## 7. 本轮完成定义

只有以下条件同时满足，才可以宣布 Reference / Output 基础工作流完成：

- Reference 和 Output 都支持独立的“新建”与“添加已有”。
- 两侧 Tabs 都能切换，并正确维护活动项。
- 无 Output 时 Reference 可以独立工作。
- 有 Output 时左侧只由该 Output 的 Relation 决定。
- 切换 Output 不修改 Relation。
- 编辑 Relation 后左侧立即同步。
- 新建 Output 继承当前 Reference 工作集。
- 添加已有 Output 时只在没有 Relation 记录时初始化。
- Reference Card 的粘贴、编辑、删除、排序和 History 无回归。
- 静态检查、完整自动测试、构建和真实 DSH 工作区验证均有明确结果。
