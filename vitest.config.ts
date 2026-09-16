import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 多个用例要在 jsdom 里跑真实 Milkdown Crepe / docx-preview / PDF.js，
    // 并行执行时会互相饿死，表现为 20 秒等待超时（单独跑全部通过）。
    // 这些是主链验收依赖的测试，可靠性优先于总耗时。
    fileParallelism: false,
  },
});
