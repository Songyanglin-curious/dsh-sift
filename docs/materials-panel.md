# 素材标签页与引用关系

素材栏是工作区文件与网页的**引用关系**视图，不复制、不移动、不上传任何原文件。界面按 VS Code 标签页组织：顶部是横向标签栏，每个标签显示类型徽标（MD / PDF / DOCX / DOC / WEB）+ 文件名 + `×`，选中标签有顶部强调色和提亮底色，窄栏下标签栏横向滚动并自动把选中项带入视野。支持 ←/→、Home/End 切换，Delete/Backspace 直接移除当前标签。

## 新增与移除引用

- `＋` 打开菜单，两个入口：**添加工作区文件…** 和 **添加网页地址…**。文件入口是默认路径，不依赖工作区是否为空。
- 文件浏览器提供面包屑（工作区 › 子目录 …）、`↑ 上一级`、`↻` 刷新；只列出 Markdown/PDF/DOCX/DOC 与目录，跳过 `.git`、`.sift`、`node_modules` 和符号链接。已在标签中的文件显示“（已添加）”并置灰，避免重复引用。
- 网页入口只接受不含账号密码的 HTTP/HTTPS 地址，保存前规范化。
- 底部固定显示当前素材的引用目标，并提供“复制”按钮，便于在对话里以路径形式引用同一文件。
- 标签上的 `×` 只移除引用关系，磁盘上的原文件保持不变；移除最后一个引用后素材栏回到空状态，空状态里的“添加素材”直接打开文件浏览器。
- `↻`（工具栏右侧）按工作区重新读取引用列表，用于在外部编辑 `.sift/materials.json` 或换工作区后同步。

## 关系存储

工作区的 `.sift/materials.json` 保存版本号和引用数组，每条包含 `id`、`name`、`kind`、`target`。文件使用工作区相对路径；网页使用规范化的 HTTP/HTTPS URL。

Host 提供读取关系、浏览目录、新增关系、移除关系和读取素材内容五个 Remote 方法。新增自动去重，修改按工作区串行并通过临时文件替换写入，损坏的关系文件不会被静默覆盖。文件读取校验真实路径在当前工作区内。预览单个文件上限为 30 MB。

当前只关联工作区内文件；外部文件可先放入工作区再添加。关闭并重新打开工作区会恢复引用，默认选中第一项。此阶段素材只读，产出保持原有本地文件自动保存。

## 类型预览

| 类型 | 实现 |
| --- | --- |
| `.md` / `.markdown` | 与产出区共同调用 `createMarkdownSurface`，复用 Milkdown Crepe，素材开启只读 |
| `.pdf` | PDF.js 兼容构建，独立 Web Worker、Canvas 页面绘制和上一页/下一页；Worker 随脚本打包，无 CDN 请求 |
| `.docx` | docx-preview 渲染到禁用脚本的 iframe，隔离样式，关闭 HTML altChunk，图像使用 data URL |
| `.doc` | 提示不支持，建议转换为 DOCX/PDF；不尝试解析 |
| URL | sandbox iframe 展示网页，提供“打开原网页”；网站的 CSP/X-Frame-Options、登录或混合内容限制可能阻止内嵌 |
| 其他 | 提示不支持预览；文件仍在工作区中 |

PDF 页面对当前栏宽缩放显示；复杂文档、特殊字体的效果仍取决于 PDF.js。DOCX 使用 HTML 排版，并非 Word 原生排版引擎。

切换标签会取消旧预览，异步返回只更新当前标签。Markdown 编辑器、PDF Worker、对象 URL、iframe 在切换及卸载时清理。读取失败（文件被移动、重命名或删除）时预览区给出可操作的提示，引用本身保留，等待用户决定是否移除。

## 开发预览素材

`pnpm dev` 的隔离 Home 里，`scripts/workspace-profile.mjs` 会把 `scripts/runtime/samples/` 中的四个示例文件复制进 Sift 工作区并写好 `.sift/materials.json`（每种预览渲染器各一条）。这一步是幂等的：关系文件已存在时不做任何写入，示例文件已存在时不覆盖。目的是让开发页面一打开就能看到标签、类型徽标和四类预览，而不必手工准备文件。

## 验证

- Host 测试覆盖引用持久化、去重、并发新增、工作区隔离、路径越界拒绝、损坏元数据保护和移除不删除原文件。
- 面板测试覆盖标签渲染与徽标、标签切换、文件浏览器（进入子目录、已添加置灰）、网页新增规范化与选中宿主返回的既有引用、删除当前标签、删空回到空状态、引用失效提示、旧请求不覆盖新标签、外部同步后重新读取。
- 集成测试（`tests/materials-workspace.test.ts`）在临时工作区里用**真实的 Host 模块 + 真实面板 + 真实渲染器**跑通一条链路：从空状态用文件浏览器逐个添加 `scripts/runtime/samples/` 的样例、写入 `.sift/materials.json`、切换标签看到只读 Markdown（Crepe）、DOCX（docx-preview，脚本禁用 iframe）、URL（sandbox iframe）与 DOC 的不支持提示，最后删除引用并确认磁盘上的原文件仍然存在。PDF 由 `tests/pdf-rendering.test.ts` 用真实 PDF.js 单独验证（它需要专用 Worker，jsdom 不提供）。
- 运行中的开发实例已确认提供新面板：用隔离 Home 的探针令牌取得带令牌入口，`GET /` 返回 200，再从同一会话拉取 `@songyanglin/dsh-sift/client.js` 打包结果（约 21 MB），其中包含 `data-sift-material-toolbar`、`data-sift-material-menu`、`data-sift-material-empty`、`data-material-close` 与空状态文案，说明运行中的服务确实在下发新界面而不是磁盘上的旧产物。
- 仍待人工确认的是**视觉结果**：页面里的标签板宽窄、配色与滚动表现需要人眼在浏览器里过一遍。DSH Web 每次启动的入口令牌是进程内存里的 launch token（命令行无法取得），所以这一轮没有做浏览器内的截图核对。
