import { describe, expect, it, vi } from 'vitest';
import { analyzeConversation, analyzeConversationTopic, type ConversationLlm } from '../src/host/conversation/analyzer.js';
import type { ConversationReferenceDocument } from '../src/references.js';

function reference(count: number): ConversationReferenceDocument {
  return {
    kind: 'conversation',
    name: '测试会话',
    description: '',
    source: { type: 'conversation', uri: 'test.md', format: 'chatgpt-markdown', importedAt: '2026-09-22T00:00:00.000Z' },
    warnings: [],
    groups: Array.from({ length: count }, (_, index) => ({
      id: `q-${String(index + 1).padStart(3, '0')}`,
      user: { content: `问题 ${index + 1}` },
      assistant: { content: `回答 ${index + 1}`, name: 'ChatGPT' },
      sourceRange: { startLine: index * 4 + 1, endLine: index * 4 + 4 },
      collapsed: true,
      contextDependency: 'unknown',
    })),
  };
}

function fakeLlm(): ConversationLlm & { prepareCall: ReturnType<typeof vi.fn> } {
  const prepareCall = vi.fn(async config => ({
    config,
    retryPolicy: {},
    stream: async function* (options: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) {
      const prompt = options.messages[0].content[0].text ?? '';
      const ids = [...prompt.matchAll(/^\[(\d+)\] /gm)].map(match => Number(match[1]));
      const items = ids.filter(id => id === 10).map(id => ({ id, level: 3 }));
      yield { type: 'text-delta', index: 0, text: JSON.stringify(items) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  }));
  return { prepareCall } as unknown as ConversationLlm & { prepareCall: ReturnType<typeof vi.fn> };
}

describe('Conversation analyzer', () => {
  it('使用设置中的模型与思考强度，并返回有限等级结果', async () => {
    const llm = fakeLlm();
    const events: string[] = [];
    const result = await analyzeConversation(reference(12), 'q-010', {
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
    }, llm, undefined, event => events.push(event));
    expect(llm.prepareCall).toHaveBeenCalledTimes(1);
    expect(llm.prepareCall.mock.calls[0][0]).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', maxTokens: 8000,
    });
    expect(result.items).toHaveLength(12);
    expect(result.items.find(item => item.groupId === 'q-010')).toMatchObject({ relevance: 'strong', continuity: 'none' });
    expect(result.promptVersion).toBe('weak-user-turns-v1');
    expect(events).toEqual([
      'analyze.start', 'cache.miss', 'batches.created', 'batch.prepare.start', 'batch.prepare.end',
      'batch.stream.start', 'batch.stream.firstChunk', 'batch.stream.end', 'batch.parse.end', 'analyze.end',
    ]);
  });

  it('超过 100 组时按 User Turn 分批并行，最终每组只保留一个结果', async () => {
    const llm = fakeLlm();
    const result = await analyzeConversation(reference(120), 'q-010', {
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    }, llm);
    expect(llm.prepareCall).toHaveBeenCalledTimes(2);
    expect(result.items.map(item => item.groupId)).toEqual(reference(120).groups.map(group => group.id));
  });

  it('没有明确模型配置时拒绝调用', async () => {
    await expect(analyzeConversation(reference(2), 'q-001', {}, fakeLlm()))
      .rejects.toThrow('设置 → Sift');
  });

  it('可按用户输入主题扫描会话', async () => {
    const result = await analyzeConversationTopic(reference(6), '人的认知带宽', {
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    }, fakeLlm());
    expect(result.topic).toBe('人的认知带宽');
    expect(result.anchorGroupId).toBeUndefined();
    expect(result.items).toHaveLength(6);
  });

  it('同一会话版本、目标、模型与 prompt 版本直接复用缓存', async () => {
    const llm = fakeLlm();
    const source = reference(6);
    const first = await analyzeConversationTopic(source, '人的认知带宽', {
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    }, llm);
    const second = await analyzeConversationTopic({ ...source, analysis: first }, '人的认知带宽', {
      provider: 'deepseek-official', model: 'deepseek-v4-pro',
    }, llm);
    expect(second).toBe(first);
    expect(llm.prepareCall).toHaveBeenCalledTimes(1);
  });
});
