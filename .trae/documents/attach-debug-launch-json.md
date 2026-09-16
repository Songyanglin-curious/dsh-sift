# 计划：补齐附加进程调试能力（launch.json + Host inspector）

## 结论先行

可以通过附加进程调试，且条件基本齐备：

- DSH 是由 `pnpm dev`（[scripts/dev.mjs](d:\mycode\dsh-sift\scripts\dev.mjs)）通过 `launchDsh`（[scripts/runtime/process.mjs](d:\mycode\dsh-sift\scripts\runtime\process.mjs)）启动的**子 Node 进程**，host 插件代码（`src/host/**`）就运行在这个进程里。
- esbuild 构建 host/client 时均已开启 `sourcemap: true`（[scripts/build.mjs:21,35](d:\mycode\dsh-sift\scripts\build.mjs)），断点映射回 TS 源码的前提已满足。
- 唯一缺口：`launchDsh` 用 `spawn(process.execPath, [dshEntry(), ...])` 启动子进程，**没有传 `--inspect`**，子进程不开放 inspector 端口，所以现在无法附加。项目也没有 `.vscode/launch.json`。

## 改动清单

### 1. [scripts/runtime/process.mjs](d:\mycode\dsh-sift\scripts\runtime\process.mjs) — `launchDsh` 支持 inspector 端口

```js
// 从 options 中解构出 inspectPort（非 spawn 选项），其余原样传给 spawn
export function launchDsh(args, { inspectPort, ...options } = {}) {
  const invocation = dshInvocation(args);
  // 传入 inspectPort 时在 node 入口前插入 --inspect，供 VS Code 附加调试
  const inspectArgs = inspectPort ? [`--inspect=${inspectPort}`] : [];
  return spawn(process.execPath, [...inspectArgs, ...invocation.args], {
    windowsHide: true,
    ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
    ...options,
  });
}
```

要点：
- node CLI 标志必须在入口脚本之前，prepend 到 args 数组最前面即可；`SIFT_DSH_SOURCE`（tsx 模式）下同样兼容。
- 短命调用（`runDsh` → `--version` / `plugin add` / `--dump-config`）**不传** `inspectPort`，避免多个进程抢同一端口。

### 2. [scripts/dev.mjs](d:\mycode\dsh-sift\scripts\dev.mjs) — 读取端口环境变量并传给长驻 DSH

在现有 `port`/`probePort` 常量旁新增（保持既有 env 约定风格，如 `SIFT_DEV_PORT`/`SIFT_DEV_HOME`）：

```js
// 附加调试 inspector 端口，默认 9230（避开常被占用的 9229），设为 0 可关闭
const inspectPort = Number(process.env.SIFT_DEV_INSPECT_PORT ?? 9230);
```

- 校验逻辑仿照现有 `port`：`0`（关闭）或 `1~65534` 整数，否则抛错。
- 只在 `boot()` 里传：`launchDsh([...], { env, stdio: 'inherit', inspectPort: inspectPort || undefined })`。
- 启动日志追加一行提示，例如：`Host 调试：附加到 127.0.0.1:9230（launch.json「附加 DSH Host 进程」）。`

### 3. 新建 `.vscode/launch.json`

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "附加 DSH Host 进程",
      "port": 9230,
      "restart": true,
      "continueOnAttach": true,
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
    },
    {
      "type": "chrome",
      "request": "launch",
      "name": "调试 Sift Client (Chrome)",
      "url": "http://127.0.0.1:9082",
      "webRoot": "${workspaceFolder}/dist/client",
      "sourceMapPathOverrides": {
        "../../src/*": "${workspaceFolder}/src/*"
      }
    },
    {
      "type": "msedge",
      "request": "launch",
      "name": "调试 Sift Client (Edge)",
      "url": "http://127.0.0.1:9082",
      "webRoot": "${workspaceFolder}/dist/client",
      "sourceMapPathOverrides": {
        "../../src/*": "${workspaceFolder}/src/*"
      }
    }
  ]
}
```

设计说明：

- **Node attach `restart: true`**：dev.mjs 在 host 代码变更后会杀掉并重启 DSH 子进程，该选项让 VS Code 断线后自动重新附加，配合 watch 流程无缝续调。
- **浏览器配置**：client 产物 `dist/client/index.js` 由 DSH 下发到页面，esbuild 外置 sourcemap 的 `sources` 是相对路径 `../../src/client/...`，需用 `sourceMapPathOverrides` 映射回工作区源码，才能在 `src/client/**/*.tsx` 上打断点（直接调试当前 #185 无限重渲染崩溃）。
- Chrome 与 Edge 各一份，用户按本机浏览器选用；浏览器配置用独立实例启动，不影响日常浏览器。
- `webRoot` 固定指向 `dist/client`，与 `buildClient` 的 `outfile` 一致。
- 端口 9082 与 dev.mjs 默认 `SIFT_DEV_PORT` 一致；若用户自定义了端口，浏览器配置里的 `url` 同步改即可。

## 不做的事（保持最小改动）

- 不加 "Run pnpm dev" 的 `node-terminal` 启动配置——用户已在终端跑 `pnpm dev`，attach 配置与谁启动进程无关。
- 不做 compound 组合配置——attach 依赖 `pnpm dev` 先就绪，组合启动会有时序问题。
- 不改 `runDsh`、`probe.mjs`、构建脚本——sourcemap 已开启，无需改动。

## 验证步骤

1. `pnpm check` 确认类型无误（沙箱内可跑，无子进程）。
2. 用户在终端重启 `pnpm dev`（当前运行的旧实例 PID 48976 没有 inspector，必须重启才生效），确认输出中出现 `Debugger listening on ws://127.0.0.1:9230/...`。
3. VS Code F5 选「附加 DSH Host 进程」→ 在 `src/host/index.ts`（如插件 apply/startup 处）打断点 → 刷新 DSH 页面或触发相应逻辑，断点命中且调用栈/变量可见。
4. 修改任一 `src/host/**` 文件触发 watcher 重启 DSH → 确认 VS Code 自动重新附加（顶部调试条恢复）。
5. F5 选「调试 Sift Client (Chrome/Edge)」→ 在 `src/client/index.tsx`（如 `installWorkspaceTypeCreator` 或嫌疑崩溃点 `WorkspaceProfileBadge` 渲染逻辑）打断点 → 页面加载即命中，配合控制台排查 #185。
6. 设 `SIFT_DEV_INSPECT_PORT=0` 重启 `pnpm dev`，确认无 inspector 输出（开关生效）。

## 假设与决策

- inspector 端口默认 **9230**：9229 是 Node 默认值、易与其他调试会话冲突；项目自身端口约定（9082/9083）也避开了它。
- **默认开启** inspector：`pnpm dev` 是纯本地开发场景，多开一个本地回环端口无副作用；可用环境变量关闭。
- 单开发实例假设：与现有固定端口 9082 的设计一致，不做多实例端口协商。
- Host 断点依赖 `dist/host/*.js.map`（dev watcher 会自动重建），断的是构建产物再映射回源码——这是 link: 安装方式下的正确路径。
