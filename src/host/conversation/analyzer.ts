import { createUserMessage, ReasoningEffortId, type GenerateOptions, type LlmCallConfig, type PreparedLlmCall } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import {
  conversationAnalysisItemSchema,
  type ConversationAnalysisItem,
  type ConversationAnalysis,
  type ConversationReferenceDocument,
} from '../../references.js';
import type { ConversationAnalysisSettings } from '../../settings-contract.js';

const batchResultSchema = z.object({ items: z.array(conversationAnalysisItemSchema) });
const BATCH_SIZE = 18;
const BATCH_OVERLAP = 2;

export interface ConversationLlm {
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
}

function anchorContext(reference: ConversationReferenceDocument, anchorIndex: number): string {
  return reference.groups.slice(Math.max(0, anchorIndex - 2), Math.min(reference.groups.length, anchorIndex + 2))
    .map(group => `[${group.id}] USER:\n${group.user.content}\nASSISTANT:\n${group.assistant.content}`)
    .join('\n\n');
}

function buildPrompt(reference: ConversationReferenceDocument, anchorIndex: number, groups: ConversationReferenceDocument['groups']): string {
  const anchor = reference.groups[anchorIndex];
  return `你在帮助用户从长会话中定位与锚点问答相关的内容。请对批次内每个 Q/A Group 分别判断，不能因为它们来自同一会话就默认相关。

锚点：${anchor.id}
锚点及有限前后文（前 2、后 1）：
${anchorContext(reference, anchorIndex)}

待判断批次：
${groups.map(group => `[${group.id}] USER:\n${group.user.content}\nASSISTANT:\n${group.assistant.content}`).join('\n\n')}

只返回 JSON，不要 Markdown：
{"items":[{"groupId":"q-001","relevance":"strong|related|weak|none","continuity":"continues_previous|returns_to_anchor|context_only|none","contextDependency":"standalone|needs_previous|unknown","evidenceGroupIds":["q-001"],"reason":"不超过 40 个汉字"}]}

要求：items 必须覆盖批次内全部 groupId 且只出现一次；evidenceGroupIds 只能使用已有 groupId。`;
}

function buildTopicPrompt(topic: string, groups: ConversationReferenceDocument['groups']): string {
  return `你在帮助用户从长会话中定位与指定主题相关的内容。请对批次内每个 Q/A Group 分别判断，不能因为它们来自同一会话就默认相关。

指定主题：${topic}

待判断批次：
${groups.map(group => `[${group.id}] USER:\n${group.user.content}\nASSISTANT:\n${group.assistant.content}`).join('\n\n')}

只返回 JSON，不要 Markdown：
{"items":[{"groupId":"q-001","relevance":"strong|related|weak|none","continuity":"continues_previous|returns_to_anchor|context_only|none","contextDependency":"standalone|needs_previous|unknown","evidenceGroupIds":["q-001"],"reason":"不超过 40 个汉字"}]}

要求：items 必须覆盖批次内全部 groupId 且只出现一次；evidenceGroupIds 只能使用已有 groupId。`;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON 对象。');
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function runBatch(
  llm: ConversationLlm,
  config: LlmCallConfig,
  prompt: string,
  expectedIds: readonly string[],
  signal?: AbortSignal,
): Promise<ConversationAnalysisItem[]> {
  let prepared: PreparedLlmCall;
  try {
    prepared = await llm.prepareCall(config, signal);
  } catch (error) {
    throw new Error(`准备模型调用失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const options: GenerateOptions = {
    ...prepared.config,
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: '@songyanglin/dsh-sift' },
    })],
    signal,
  };
  let text = '';
  let failure: string | undefined;
  try {
    for await (const chunk of prepared.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        failure = `${chunk.reason.failure.code}: ${chunk.reason.failure.message}`;
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
        failure = '请求已取消。';
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') {
        failure = '模型输出达到上限，尚未返回完整分析结果。';
      }
    }
  } catch (error) {
    throw new Error(`读取模型响应失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (failure) throw new Error(`会话分析调用失败：${failure}`);
  const result = batchResultSchema.parse(parseJson(text));
  const expected = new Set(expectedIds);
  const received = new Set(result.items.map(item => item.groupId));
  if (received.size !== expected.size || [...expected].some(id => !received.has(id)) || result.items.some(item => !expected.has(item.groupId))) {
    throw new Error('模型返回的 groupId 与当前分析批次不一致。');
  }
  return result.items;
}

const relevanceRank = { none: 0, weak: 1, related: 2, strong: 3 } as const;

/** 批次重叠项不取伪精确平均值：保留更高相关级，证据取并集，并记录两批理由。 */
function mergeItem(left: ConversationAnalysisItem, right: ConversationAnalysisItem): ConversationAnalysisItem {
  const primary = relevanceRank[right.relevance] > relevanceRank[left.relevance] ? right : left;
  return {
    ...primary,
    evidenceGroupIds: [...new Set([...left.evidenceGroupIds, ...right.evidenceGroupIds])],
    reason: left.reason === right.reason ? left.reason : `${left.reason}；${right.reason}`.slice(0, 80),
  };
}

export async function analyzeConversation(
  reference: ConversationReferenceDocument,
  anchorGroupId: string,
  settings: ConversationAnalysisSettings,
  llm: ConversationLlm,
  signal?: AbortSignal,
): Promise<ConversationAnalysis> {
  if (!settings.provider || !settings.model) throw new Error('请先在设置 → Sift 中选择会话解析模型。');
  const anchorIndex = reference.groups.findIndex(group => group.id === anchorGroupId);
  if (anchorIndex < 0) throw new Error(`找不到锚点问答：${anchorGroupId}`);
  const config: LlmCallConfig = {
    provider: settings.provider,
    model: settings.model,
    ...(settings.reasoningEffort ? { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) } : {}),
    maxTokens: 16000,
  };
  const merged = new Map<string, ConversationAnalysisItem>();
  const step = BATCH_SIZE - BATCH_OVERLAP;
  for (let start = 0; start < reference.groups.length; start += step) {
    const groups = reference.groups.slice(start, start + BATCH_SIZE);
    const items = await runBatch(llm, config, buildPrompt(reference, anchorIndex, groups), groups.map(group => group.id), signal);
    for (const item of items) merged.set(item.groupId, merged.has(item.groupId) ? mergeItem(merged.get(item.groupId)!, item) : item);
    if (start + BATCH_SIZE >= reference.groups.length) break;
  }
  return {
    anchorGroupId,
    model: { provider: settings.provider, model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) },
    createdAt: new Date().toISOString(),
    items: reference.groups.map(group => merged.get(group.id)!).filter(Boolean),
  };
}

export async function analyzeConversationTopic(
  reference: ConversationReferenceDocument,
  topic: string,
  settings: ConversationAnalysisSettings,
  llm: ConversationLlm,
  signal?: AbortSignal,
): Promise<ConversationAnalysis> {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic) throw new Error('分析主题不能为空。');
  if (!settings.provider || !settings.model) throw new Error('请先在设置 → Sift 中选择会话解析模型。');
  const config: LlmCallConfig = {
    provider: settings.provider,
    model: settings.model,
    ...(settings.reasoningEffort ? { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) } : {}),
    maxTokens: 16000,
  };
  const merged = new Map<string, ConversationAnalysisItem>();
  const step = BATCH_SIZE - BATCH_OVERLAP;
  for (let start = 0; start < reference.groups.length; start += step) {
    const groups = reference.groups.slice(start, start + BATCH_SIZE);
    const items = await runBatch(llm, config, buildTopicPrompt(normalizedTopic, groups), groups.map(group => group.id), signal);
    for (const item of items) merged.set(item.groupId, merged.has(item.groupId) ? mergeItem(merged.get(item.groupId)!, item) : item);
    if (start + BATCH_SIZE >= reference.groups.length) break;
  }
  return {
    topic: normalizedTopic,
    model: { provider: settings.provider, model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) },
    createdAt: new Date().toISOString(),
    items: reference.groups.map(group => merged.get(group.id)!).filter(Boolean),
  };
}
