import { basename } from 'node:path';
import type { ConversationReferenceDocument } from '../../references.js';

interface Heading {
  readonly role: 'user' | 'assistant';
  readonly assistantName?: string;
  readonly line: number;
  readonly contentStart: number;
}

function cleanSection(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start, end).join('\n').replace(/^\s+|\s+$/g, '');
}

/** 解析 ChatGPT / DeepSeek 的 Markdown 导出；无法识别的内容只告警，不静默丢弃。 */
export function parseConversationMarkdown(input: {
  readonly content: string;
  readonly sourcePath: string;
  readonly importedAt?: string;
}): ConversationReferenceDocument {
  const normalized = input.content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headings: Heading[] = [];
  let sourceUrl: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (index === 0) sourceUrl = /^> From:\s*(\S+)/.exec(line)?.[1];
    if (line === '# you asked') headings.push({ role: 'user', line: index + 1, contentStart: index + 1 });
    if (line === '# chatgpt response') headings.push({ role: 'assistant', assistantName: 'ChatGPT', line: index + 1, contentStart: index + 1 });
    if (line === '# deepseek response') headings.push({ role: 'assistant', assistantName: 'DeepSeek', line: index + 1, contentStart: index + 1 });
  }

  const warnings: string[] = [];
  const groups: ConversationReferenceDocument['groups'] = [];
  if (headings.length === 0) throw new Error('未找到可识别的 “# you asked” 会话段落。');
  if (headings[0].line > 3) warnings.push(`首个问答前存在 ${headings[0].line - 1} 行未归组内容。`);

  for (let index = 0; index < headings.length; index += 1) {
    const userHeading = headings[index];
    if (userHeading.role !== 'user') {
      warnings.push(`第 ${userHeading.line} 行的回答没有对应问题。`);
      continue;
    }
    const assistantHeading = headings[index + 1];
    if (!assistantHeading || assistantHeading.role !== 'assistant') {
      warnings.push(`第 ${userHeading.line} 行的问题没有对应回答。`);
      continue;
    }
    const nextHeading = headings[index + 2];
    const userLines = lines.slice(userHeading.contentStart, assistantHeading.line - 1);
    let messageTime: string | undefined;
    const metadataIndex = userLines.findIndex(line => /^message time:\s*/.test(line.trim()));
    if (metadataIndex >= 0) {
      messageTime = userLines[metadataIndex].trim().replace(/^message time:\s*/, '');
      userLines.splice(metadataIndex, 1);
    }
    const endLine = (nextHeading?.line ?? (lines.length + 1)) - 1;
    groups.push({
      id: `q-${String(groups.length + 1).padStart(3, '0')}`,
      user: { content: cleanSection(userLines, 0, userLines.length), ...(messageTime ? { messageTime } : {}) },
      assistant: {
        content: cleanSection(lines, assistantHeading.contentStart, endLine),
        name: assistantHeading.assistantName ?? 'Assistant',
      },
      sourceRange: { startLine: userHeading.line, endLine },
      collapsed: true,
      contextDependency: 'unknown',
    });
    index += 1;
  }

  if (groups.length === 0) throw new Error('没有找到完整的 User / Assistant 问答组。');
  const format = headings.some(item => item.assistantName === 'DeepSeek') ? 'deepseek-markdown' : 'chatgpt-markdown';
  const fileName = basename(input.sourcePath).replace(/\.md$/i, '');
  return {
    kind: 'conversation',
    name: fileName || '导入会话',
    description: `${groups.length} 组问答`,
    source: {
      type: 'conversation',
      uri: input.sourcePath,
      ...(sourceUrl ? { title: sourceUrl } : {}),
      format,
      importedAt: input.importedAt ?? new Date().toISOString(),
    },
    groups,
    warnings,
  };
}
