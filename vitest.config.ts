import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/mocks/dsh-client-ui-primitives.tsx', import.meta.url)),
    },
  },
  test: {
    // 多个用例要在 jsdom 里跑 docx-preview / PDF.js，
    // 并行执行时会互相饿死，表现为 20 秒等待超时（单独跑全部通过）。
    // 这些是主链验收依赖的测试，可靠性优先于总耗时。
    fileParallelism: false,
  },
});
