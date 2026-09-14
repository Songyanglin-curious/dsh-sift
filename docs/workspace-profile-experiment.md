# Workspace 类型最小实验实现与验证

实现基于 DSH 0.1.5-rc.2 的公开 Workspace Registry、Session 列表和 Typert Remote。Host 只按原生 Workspace ID 查路径，再读取该路径下的 `.sift/config.json`；缺失配置是 `default`，合法 `schemaVersion: 1/profile: sift` 是 `sift`，损坏或未知格式返回可理解错误并保持 default，读取过程不会写回文件。

Client 计划在 root 级 `sidebar.footer.action` 插槽显示当前工作区标题和类型。它订阅原生工作区和会话状态，通过当前会话 ID 与 `sessionIds` 反查归属。每次归属改变都会重新请求 Host；请求清理函数丢弃快速切换产生的旧响应，因此不会复用上一工作区类型。Client 包声明 `immediately: true`，保证没有其他插件依赖 Sift 时也会主动加载。

## 可复现准备

先运行 `pnpm dev:setup`，再运行 `pnpm dev:workspace-profile`。脚本会在隔离 Home 的 `.debug/development/workspace-profile/` 下准备 `default/` 与 `sift/` 两个目录，并只在不存在时写入 Sift 配置。已有配置若不是可解析 JSON 会拒绝覆盖。将这两个绝对路径分别通过 DSH 原生工作区目录流程登记；同一路径重复登记会复用原生 Workspace。

## 自动化验证

`pnpm check`、`pnpm test`、`pnpm build` 均通过。单元测试覆盖缺配置、合法配置、损坏配置不写回、异步乱序，以及 Host、Client 和打包契约。

## 实机验证记录

开发服务器使用 `http://127.0.0.1:9084`。实测已经确认：default、sift 均由原生 Workspace Registry 登记；侧边栏可从 sift 切换到 default；开发服务器重启后两个工作区和当前选择仍可恢复。Host 读取结果为 default 目录 `default/missing`、sift 目录 `sift/ready`；临时移走 sift 配置后为 `default/missing`，恢复文件后再次为 `sift/ready`，且测试结束时配置已恢复。

浏览器当前仍未渲染类型文字。插件清单显示 Host 侧 `include:sift` 为“运行中”，HTML 启动图也已包含 `@songyanglin/dsh-sift/client.js`；因此类型存储、缺失回退和原生工作区切换已经通过，而 Client contribution 激活/渲染仍是一个未通过项，不能把本轮结果记成完整验收通过。下一步应从 Client Runner 的启动诊断继续定位，而不是扩展业务功能。
