# Sift

从混杂内容中筛选出真正有价值的信息，并辅助人系统性掌握一个主题。

## 定位

Sift 以 DSH 工作区类型（`profile = sift`）的形式运行。进入 sift 类型的工作区后，界面为三栏：Reference ｜ Document ｜ 原生会话。

它是一个由 AI 协作的学习型知识梳理工具。Sift 不是替你总结，而是陪你走完从低密度原始材料到一篇自己真正认可的 Markdown 笔记的完整过程。这个过程本质是三次信息收紧：

| 层        | 典型量级       | 回答的问题         |
| --------- | -------------- | ------------------ |
| Source    | 数十万～百万字 | 我有哪些信息       |
| Reference | 三千～一万字   | 我现在真正依据什么 |
| Document  | 一千～五千字   | 我最终决定留下什么 |

人的价值是在收紧的每一步做判断；AI 负责搜索、定位、压缩、比较与改写。核心结果不是一篇被动的总结，而是人在亲自选择、判断、修改和组织内容的过程中完成学习与稳固。

## 核心对象

* **Source（来源）**：Sift 能稳定访问的原始信息——工作区文件、本机外部文件、URL，或由粘贴内容直接落成的文件。Sift 只登记引用，不复制、不移动原文件。
* **Reference（参考）**：当前 Document 在思考和写作中真正在用的材料。它可能是短文件的全文、PDF 中的某几页、代码里的一个方法、AI 从多个 Source 提炼出的几条事实，或一段临时粘贴。判断标准只有一个：这个内容现在是否值得占据我的注意力。
* **Document（产出）**：用户真正准备长期维护和留下的正式 Markdown 笔记，也是 Sift 唯一的成果形态。

Reference 依附于 Document，是可恢复的短期工作现场；Source 与 Document 是长期资产。

## 核心循环

```text
从一个模糊的问题或念头出发
    ↓
挑选当前真正相关的 Reference
    ↓
AI 提出修改建议
    ↓
人接受、修改、否定或继续讨论
    ↓
结果写回 Markdown Document
    ↓
对目标的理解随每一步更新，据此决定下一步
```

循环同时作用于结构和内容：写一点结构，填一点内容，发现缺口或矛盾，再回到 Source 中验证和修正。

## 核心原则

* **人掌握判断权**：人决定梳理方向、知识结构、内容正误，以及一篇 Document 何时完成。
* **默认小步迭代**：AI 每次给出容易理解和审核的小修改，但节奏由人掌握——小步只是多数时候的习惯，不是硬约束。
* **持续收敛，而非制造碎片**：Source、Reference 和对话都是加工依据，最终持续汇入 Document。
* **不量化掌握程度**：不设掌握度或完成算法；是否真正掌握，只有使用者自己知道。
* **内容与关系分离**：原始文件保持独立，Sift 只管理引用、元信息与组织关系；移除引用不删除原内容。
* **内容优先**：一篇好的 Document 本身就可以直接分享，不需要精美的发布样式。

## 使用流程

```text
加入 Source（粘贴 / 文件 / URL）
    ↓
整理成 Reference
    ↓
打开或创建 Document
    ↓
挑选当前 Document 真正需要的 Reference
    ↓
阅读、对比，选中文字写“本轮批注”
    ↓
让 AI 分析、归纳或提出写作建议
    ↓
回到 Document 修改 Markdown
    ↓
继续补 Reference，重复下一轮
```

## 本地开发

当前开发环境要求：

* DSH `0.1.5-rc.2`
* Node.js 24 或更高版本
* pnpm `11.25.0`

安装依赖并执行静态验证：

```powershell
pnpm install
pnpm check
pnpm test
pnpm build
```

日常开发使用仓库内独立的 `.debug/development` 作为 `DSH_HOME`，通过 `link:` 加载当前源码，不修改正式 DSH Home 或 Profile：

```powershell
$env:SIFT_DSH_SOURCE = 'D:\mycode\deepseek-harness'
pnpm dev:setup
pnpm dev
pnpm dev:status
pnpm dev:clean
```

开发 Web 默认地址为 `http://127.0.0.1:9082`，可以通过 `SIFT_DEV_PORT` 修改端口。当前必需接口尚未进入已发布 DSH 包，开发脚本会校验 `SIFT_DSH_SOURCE` 与源码版本；旧 DSH 只显示升级提示，不退回旧弹窗方案。

开发期间，Client 修改会重新构建并交给 DSH Client HMR；Host、Bundle patch 或依赖修改会触发受控重启。

发布前使用隔离环境验证 tarball 的打包、安装、组合配置、文件完整性和卸载：

```powershell
pnpm verify:package
```

更多细节见[文档索引](docs/index.md)。本仓库开发不执行 npm 发布或 Git 推送。
