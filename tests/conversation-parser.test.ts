import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConversationMarkdown } from '../src/host/conversation/parser.js';

describe('Conversation Markdown parser', () => {
  it.each([
    ['评估思路可行性-gpt.md', 'chatgpt-markdown', 15, 'ChatGPT'],
    ['Sift问题整理思路评估-deepseek.md', 'deepseek-markdown', 14, 'DeepSeek'],
  ] as const)('按真实导出格式解析 %s', async (file, format, count, assistantName) => {
    const sourcePath = resolve('tests', '对话测试', file);
    const result = parseConversationMarkdown({
      content: await readFile(sourcePath, 'utf8'),
      sourcePath,
      importedAt: '2026-09-22T00:00:00.000Z',
    });

    expect(result.source.format).toBe(format);
    expect(result.groups).toHaveLength(count);
    expect(result.groups[0].id).toBe('q-001');
    expect(result.groups.at(-1)?.id).toBe(`q-${String(count).padStart(3, '0')}`);
    expect(result.groups.every(group => group.assistant.name === assistantName)).toBe(true);
    expect(result.groups.every(group => group.user.content.length > 0 && group.assistant.content.length > 0)).toBe(true);
    expect(result.groups.every(group => group.sourceRange.endLine >= group.sourceRange.startLine)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('保留不完整结构的告警，不把异常段落伪装成完整问答', () => {
    const result = parseConversationMarkdown({
      content: '# chatgpt response\n孤立回答\n# you asked\nmessage time: 2026-09-22\n完整问题\n# chatgpt response\n完整回答\n# you asked\n缺少回答',
      sourcePath: 'broken.md',
      importedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].user).toEqual({ content: '完整问题', messageTime: '2026-09-22' });
    expect(result.warnings).toEqual([
      '第 1 行的回答没有对应问题。',
      '第 8 行的问题没有对应回答。',
    ]);
  });
});
