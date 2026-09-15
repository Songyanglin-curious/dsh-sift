# 素材标签页与引用关系

素材栏使用横向标签页切换当前预览，样式参考 VS Code：选中标签显示顶边强调色，长文件名省略，完整相对路径放在提示中。支持左右方向键、Home/End 切换。`+` 展开工作区目录和网页地址入口；每个标签的 `×` 移除引用，不删除源文件。

## 关系存储

工作区的 `.sift/materials.json` 保存版本号和引用数组，每条包含 `id`、`name`、`kind`、`target`。文件使用工作区相对路径；网页使用规范化的 HTTP/HTTPS URL。不复制原文件，也不上传到文档转换服务。

Host 提供读取关系、浏览目录、新增关系、移除关系和读取素材内容五个 Remote 方法。新增自动去重，修改按工作区串行并通过临时文件替换写入，损坏的关系文件不会被静默覆盖。文件读取校验真实路径在当前工作区内。目录列表跳过 `.git`、`.sift`、`node_modules` 和符号链接。预览单个文件上限为 30 MB。

当前只关联工作区内文件；外部文件可先放入工作区再添加。关闭并重新打开工作区会恢复引用，默认选中第一项。此阶段素材只读，产出保持原有本地文件自动保存。

## 类型预览

| 类型 | 实现 |
| --- | --- |
| `.md` / `.markdown` | 与产出区共同调用 `createMarkdownSurface`，复用 Milkdown Crepe，素材开启只读 |
| `.pdf` | PDF.js 兼容构建，独立 Web Worker、Canvas 页面绘制和上一页/下一页；Worker 随脚本打包，无 CDN 请求 |
| `.docx` | docx-preview 渲染到禁用脚本的 iframe，隔离样式，关闭 HTML altChunk，图像使用 data URL |
| `.doc` | 提示不支持，建议转换为 DOCX/PDF；不尝试解析 |
| URL | sandbox iframe 展示网页，提供“打开原网页”；网站的 CSP/X-Frame-Options、登录或混合内容限制可能阻止内嵌 |

PDF 页面对当前栏宽缩放显示；复杂文档、特殊字体的效果仍取决于 PDF.js。DOCX 使用 HTML 排版，并非 Word 原生排版引擎。

切换标签会取消旧预览，异步返回只更新当前标签。Markdown 编辑器、PDF Worker、对象 URL、iframe 在切换及卸载时清理。

## 验证

- Host 测试覆盖引用持久化、去重、并发新增、工作区隔离、路径越界拒绝、损坏元数据保护和移除不删除原文件。
- UI 测试覆盖新增引用、切换标签、删除当前标签、旧文件请求不覆盖新标签。
- 真实渲染测试使用 Crepe 渲染只读 Markdown、docx-preview 渲染中文 DOCX、PDF.js 解析并绘制真实 PDF。URL 验证 iframe 沙箱和原网页链接；DOC 验证不支持提示。
- 本地浏览器访问返回 `ERR_BLOCKED_BY_CLIENT`，尚未完成运行中 DSH 页面的视觉检查和浏览器 PDF Worker 端到端检查。
