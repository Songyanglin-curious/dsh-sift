import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildHost(outdir = resolve(root, 'dist')) {
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ['src/host/index.ts', 'src/host/typert.ts'],
    outdir: resolve(outdir, 'host'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    target: 'node24',
    sourcemap: true,
  });
}

export async function buildClient(outdir = resolve(root, 'dist')) {
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ['src/client/index.tsx'],
    outfile: resolve(outdir, 'client/index.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    sourcemap: true,
    external: ['react', 'react/jsx-runtime'],
    banner: {
      js: 'window.__ModuleLoader__.load({id:"@songyanglin/dsh-sift",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
    },
    footer: { js: 'return module.exports;}});' },
  });
}

export async function buildArtifacts(outdir = resolve(root, 'dist')) {
  await Promise.all([buildHost(outdir), buildClient(outdir)]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildArtifacts();
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc')],
    { cwd: root, stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
