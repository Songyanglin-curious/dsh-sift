/**
 * 剪贴板读取器测试脚本。
 *
 * 使用：先复制好内容，然后：
 *   npx tsx test-clipboard.ts
 *
 * 测试 5 个 Case：
 *   Case 1: 复制普通文字
 *   Case 2: 资源管理器复制一个文件
 *   Case 3: 同时复制多个文件
 *   Case 4: Chrome 网页中选一段文字复制
 *   Case 5: 复制一个 URL
 */

import { readClipboard } from './src/host/clipboard/index.js';

function main() {
  console.log('='.repeat(60));
  console.log('  Windows 剪贴板读取测试');
  console.log('='.repeat(60));
  console.log();

  try {
    const result = readClipboard();

    // 统计有哪些格式
    const formats: string[] = [];
    if (result.text !== undefined) formats.push('文本');
    if (result.files !== undefined) formats.push(`文件(${result.files.length}个)`);
    if (result.html !== undefined) formats.push('HTML');
    if (result.url !== undefined) formats.push('URL');

    console.log('可用格式:', formats.length > 0 ? formats.join(', ') : '(无)');
    console.log();

    if (result.text !== undefined) {
      console.log('─'.repeat(40));
      console.log('📝 文本:');
      console.log(result.text.length > 200
        ? result.text.slice(0, 200) + '…'
        : result.text);
    }

    if (result.files !== undefined && result.files.length > 0) {
      console.log('─'.repeat(40));
      console.log(`📁 文件 (${result.files.length} 个):`);
      for (const f of result.files) {
        console.log(`   ${f}`);
      }
    }

    if (result.html !== undefined) {
      console.log('─'.repeat(40));
      console.log('🌐 HTML:');
      if (result.html.fragment !== undefined) {
        console.log('  Fragment:', result.html.fragment.length > 150
          ? result.html.fragment.slice(0, 150) + '…'
          : result.html.fragment);
      }
      if (result.html.sourceUrl !== undefined) {
        console.log('  SourceURL:', result.html.sourceUrl);
      }
    }

    if (result.url !== undefined) {
      console.log('─'.repeat(40));
      console.log('🔗 URL:', result.url);
    }

    console.log();
    console.log('='.repeat(60));
    console.log('  ✅ 读取完成');
    console.log('='.repeat(60));
  } catch (err) {
    console.error('❌ 错误:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();