# DSH 集成说明

> 旧版说明：本文描述已经退出主线的解决方案、项目会话和批注发送模型，不能作为当前 Sift 集成说明。

## 最低兼容边界

当前开发基线是 DSH `0.1.3-alpha.2` 源码工作树，并需要三项尚未发布的接口：`shell.surface` 组合布局、`conversation.submissions` 原生发送扩展、以及 Agent 工具的最终 `confine` 能力约束。开发脚本要求显式设置 `SIFT_DSH_SOURCE`，避免误用全局安装版本。

旧 DSH 能加载插件时，Sift 只在侧栏显示“需要升级 DSH”的禁用入口；不会复制内部 React 组件、移动现有 DOM 或回退到全屏弹窗。卸载插件会注销 surface、输入框 dock、发送扩展、远程接口和会话能力贡献。

## 布局与会话

Sift 通过 `shell.surface` 接收由 DSH 提供的原生 Conversation React 节点，组成素材目录、内容区和对话区。窄窗口只切换内容/对话，并在两个视图都保留切换入口。DSH 原生消息流的每个定位节点提供 `data-chat-anchor-key` 和键盘焦点，Sift 只在自己的组合容器监听选区，不复制消息组件或移动 DOM。解决方案先通过 DSH `workspaces.create({ path })` 创建或复用原生工作区，项目讨论再通过 `sessions.create({ workspaceId })` 创建；普通 DSH 页面切换会话不会改写项目绑定。

## 发送扩展

Sift 在 `conversation.input.dock` 显示批注列表和只读发送预览。面板内按钮均显式使用非提交类型，不会误触发 DSH 原生表单。`conversation.submissions` 的同一个 transform 同时用于预览、普通发送和排队发送，也允许空正文加批注发送。发送前保存当前笔记草稿；保存失败会阻止原生 admission。

before-submit 阶段冻结实际消息文本和批注评论版本。只有 Host 接受消息或入队后才写发送记录；失败不清除待发送选择。若发送期间评论产生新版本，结算只清除已经发送的旧版本，新版继续待发送。

## 项目会话能力

项目会话最终只暴露只读通用工具与 `sift_note_read`、`sift_note_insert`、`sift_note_replace_lines`、`sift_note_replace_text`。最终约束在同 scope 工具合并后应用，因此命令行、通用写入、子代理和之后注册的写工具也不能绕过。普通 DSH 会话不应用该约束。

笔记写工具从调用 Agent 的会话 ID 解析项目，不接受任意路径；素材、批注、关系数据和其他项目笔记没有 AI 写接口。每次写入比较版本并形成修订，可查看差异和回退。
