import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildArtifacts, buildClient, buildHost, root } from './build.mjs';
import { launchDsh, runDsh, stopChild } from './runtime/process.mjs';

const PACKAGE_NAME = '@songyanglin/dsh-sift';
const DSH_VERSION = '0.1.5-rc.2';
const action = process.argv[2] ?? 'start';
export const home = resolve(process.env.SIFT_DEV_HOME ?? resolve(root, '.debug/development'));
const profile = resolve(home, 'profiles/web');
const runtimeFile = resolve(home, 'sift-runtime.json');
const port = Number(process.env.SIFT_DEV_PORT ?? 9082);
const probePort = port + 1;
// 附加调试 inspector 端口，默认 9230（避开常被占用的 9229），设为 0 可关闭
const inspectPort = Number(process.env.SIFT_DEV_INSPECT_PORT ?? 9230);

if (!Number.isInteger(port) || port < 1 || port > 65534) {
    throw new Error('SIFT_DEV_PORT 必须是 1 到 65534 之间的整数。');
}

if (!Number.isInteger(inspectPort) || inspectPort < 0 || inspectPort > 65534) {
    throw new Error('SIFT_DEV_INSPECT_PORT 必须是 0 到 65534 之间的整数（0 表示关闭）。');
}

const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    SIFT_DEV_PROBE_PORT: String(probePort),
};

async function runtime() {
    return JSON.parse(await readFile(runtimeFile, 'utf8'));
}

export async function probe(path, config) {
    const connection = config ?? await runtime();
    const response = await fetch(`http://127.0.0.1:${connection.probePort}${path}`, {
        headers: { authorization: `Bearer ${connection.token}` },
        signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
}

async function setup({ build = true } = {}) {
    const version = (await runDsh(['--version'], { env })).trim();
    if (version !== DSH_VERSION) throw new Error(`需要 DSH ${DSH_VERSION}，当前 ${version}`);
    await mkdir(profile, { recursive: true });
    await writeFile(resolve(profile, 'pnpm-workspace.yaml'), 'allowBuilds:\n  koffi: true\n  esbuild: true\n');
    if (build) await buildArtifacts();

    let manifest;
    try {
        manifest = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'));
    } catch {
        manifest = undefined;
    }
    const expectedLink = `link:${root.replaceAll('\\', '/').replace(/\/$/, '')}`;
    const currentLink = manifest?.dependencies?.[PACKAGE_NAME]?.replace(/\/+$/, '');
    if (currentLink !== expectedLink) {
        console.log(await runDsh(['plugin', '--profile', 'web', 'add', `link:${root}`], { env }));
    }

    const patch = `# Generated only inside Sift's isolated development Home.\n- insert:\n    - id: sift-dev-probe\n      name: ${JSON.stringify(pathToFileURL(resolve(root, 'scripts/runtime/probe.mjs')).href)}\n`;
    await writeFile(resolve(profile, 'cordis.patch.yml'), patch);
    const composed = await runDsh(['--profile', 'web', '--dump-config'], { env });
    for (const expected of ['sift', 'sift-dev-probe']) {
        if (!composed.includes(expected)) throw new Error(`隔离 Profile 组合配置缺少 ${expected}。`);
    }
    console.log(`DSH ${version}; Home: ${home}; source: ${root}`);
}

async function start() {
    await setup();
    const token = randomBytes(24).toString('hex');
    const config = { port, probePort, token };
    env.SIFT_DEV_TOKEN = token;
    await writeFile(runtimeFile, JSON.stringify(config));

    let child;
    let shuttingDown = false;
    let updating = false;
    let pending = new Set();
    const boot = () => {
        child = launchDsh(['--profile', 'web', '--port', String(port), '--no-open'], {
            env,
            stdio: 'inherit',
            inspectPort: inspectPort || undefined,
        });
        child.on('error', error => console.error(error));
        child.on('exit', code => {
            if (!updating && !shuttingDown) {
                console.error(`DSH 已退出（${code}），修复错误后重新运行 pnpm dev。`);
            }
        });
    };
    boot();

    const watchers = [watch(resolve(root, 'src'), { recursive: true }, (_event, file) => {
        if (file) pending.add(`src/${String(file).replaceAll('\\', '/')}`);
    })];
    for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
        watchers.push(watch(resolve(root, file), () => pending.add(file)));
    }

    const timer = setInterval(async () => {
        if (!pending.size || updating || shuttingDown) return;
        updating = true;
        const changes = [...pending];
        pending = new Set();
        let stopped = false;
        try {
            const clientChanged = changes.some(file => file.startsWith('src/client/'));
            const hostChanged = changes.some(file => file.startsWith('src/') && !file.startsWith('src/client/'));
            const setupChanged = changes.some(file => /^(package\.json|pnpm-lock\.yaml)$/.test(file));
            const restart = changes.some(file => !file.startsWith('src/client/'));

            if (setupChanged) {
                await buildArtifacts();
                await stopChild(child);
                stopped = true;
                await setup({ build: false });
                boot();
                stopped = false;
            } else {
                const builds = [];
                if (hostChanged) builds.push(buildHost());
                if (clientChanged) builds.push(buildClient());
                await Promise.all(builds);
            }

            if (restart && !setupChanged) {
                await stopChild(child);
                boot();
            }
            if (restart) {
                console.log(`已更新并重启 DSH：${changes.join(', ')}；请刷新或等待页面重连。`);
            } else {
                console.log(`Client 已构建，等待 DSH Client HMR：${changes.join(', ')}`);
            }
        } catch (error) {
            console.error(`更新失败：${error instanceof Error ? error.message : String(error)}`);
            if (stopped) {
                try {
                    boot();
                    console.error('已重新启动 DSH，继续使用上一次成功构建的产物。');
                } catch (bootError) {
                    console.error(`DSH 恢复启动失败：${bootError instanceof Error ? bootError.message : String(bootError)}`);
                }
            }
        } finally {
            updating = false;
        }
    }, 600);

    async function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(timer);
        watchers.forEach(watcher => watcher.close());
        await stopChild(child);
    }
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    console.log(`开发 Web：http://127.0.0.1:${port}；Ctrl+C 只停止本次创建的进程。`);
    if (inspectPort) {
        console.log(`Host 调试：附加到 127.0.0.1:${inspectPort}（launch.json「附加 DSH Host 进程」）。`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (action === 'setup') await setup();
    else if (action === 'start') await start();
    else if (action === 'status') console.log(JSON.stringify(await probe('/state'), null, 2));
    else if (action === 'clean') {
        console.log(await runDsh(['plugin', '--profile', 'web', 'remove', PACKAGE_NAME], { env }));
    } else {
        throw new Error('用法：node scripts/dev.mjs start|setup|status|clean');
    }
}
