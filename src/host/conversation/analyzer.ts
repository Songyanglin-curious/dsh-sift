import { createHash } from 'node:crypto';
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type LlmCallConfig, type PreparedLlmCall } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import type { ConversationAnalysisItem, ConversationAnalysis, ConversationReferenceDocument } from '../../references.js';
import type { ConversationAnalysisSettings } from '../../settings-contract.js';

const weakMatchSchema = z.object({ id: z.number().int().positive(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]) });
const batchResultSchema = z.union([z.array(weakMatchSchema), z.object({ items: z.array(weakMatchSchema) })]);
const MAX_TURNS = 100;
const MAX_INPUT_TOKENS = 24_000;
const PROMPT_VERSION = 'weak-user-turns-v1';

export interface ConversationLlm { prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>; }
interface BatchTurn { readonly ordinal: number; readonly group: ConversationReferenceDocument['groups'][number]; }

function estimatedTokens(text: string): number { return Math.max(1, Math.ceil(text.length / 3)); }

function createBatches(reference: ConversationReferenceDocument): BatchTurn[][] {
  const batches: BatchTurn[][] = [];
  let current: BatchTurn[] = [];
  let tokens = 0;
  reference.groups.forEach((group, index) => {
    const turnTokens = estimatedTokens(group.user.content) + 8;
    if (current.length > 0 && (current.length >= MAX_TURNS || tokens + turnTokens > MAX_INPUT_TOKENS)) {
      batches.push(current); current = []; tokens = 0;
    }
    current.push({ ordinal: index + 1, group }); tokens += turnTokens;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildPrompt(target: string, turns: readonly BatchTurn[]): string {
  return `这是一次快速弱关联筛选。找出所有可能与目标有关的候选问题，优先不要漏掉明显相关内容，允许一定误报。不要解释原因，不要分析回答，只判断 User Turn。\n\n目标：\n${target}\n\n候选 User Turn：\n${turns.map(({ ordinal, group }) => `[${ordinal}] ${group.user.content}`).join('\n')}\n\n只返回 JSON 数组，例如：[{"id":3,"level":3},{"id":17,"level":2},{"id":40,"level":1}]。3=强相关，2=相关，1=弱相关；不相关项不要返回。id 必须来自候选编号且不得重复。`;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const arrayStart = trimmed.indexOf('['), objectStart = trimmed.indexOf('{');
  const startsWithArray = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart);
  const start = startsWithArray ? arrayStart : objectStart;
  const end = startsWithArray ? trimmed.lastIndexOf(']') : trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON。');
  return JSON.parse(trimmed.slice(start, end + 1));
}

function toAnalysisItem(turn: BatchTurn, level: 0 | 1 | 2 | 3): ConversationAnalysisItem {
  const relevance = level === 3 ? 'strong' : level === 2 ? 'related' : level === 1 ? 'weak' : 'none';
  return {
    groupId: turn.group.id, relevance, continuity: 'none',
    contextDependency: turn.group.user.content.trim().length <= 12 ? 'needs_previous' : 'unknown',
    evidenceGroupIds: level === 0 ? [] : [turn.group.id],
    reason: level === 0 ? '' : `${relevance === 'strong' ? '强相关' : relevance === 'related' ? '相关' : '弱相关'}候选`,
  };
}

async function runBatch(llm: ConversationLlm, config: LlmCallConfig, target: string, turns: readonly BatchTurn[], signal?: AbortSignal): Promise<ConversationAnalysisItem[]> {
  let prepared: PreparedLlmCall;
  try { prepared = await llm.prepareCall(config, signal); }
  catch (error) { throw new Error(`准备模型调用失败：${error instanceof Error ? error.message : String(error)}`); }
  const options: GenerateOptions = {
    ...prepared.config,
    messages: [createUserMessage({ content: [{ type: 'text', text: buildPrompt(target, turns) }], source: { kind: 'plugin', plugin: '@songyanglin/dsh-sift' } })], signal,
  };
  let text = '', failure: string | undefined;
  try {
    for await (const chunk of prepared.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = `${chunk.reason.failure.code}: ${chunk.reason.failure.message}`;
      if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') failure = '请求已取消。';
      if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') failure = '模型输出达到上限，尚未返回完整分析结果。';
    }
  } catch (error) { throw new Error(`读取模型响应失败：${error instanceof Error ? error.message : String(error)}`); }
  if (failure) throw new Error(`会话分析调用失败：${failure}`);
  const parsed = batchResultSchema.parse(parseJson(text));
  const matches = Array.isArray(parsed) ? parsed : parsed.items;
  const allowed = new Set(turns.map(turn => turn.ordinal));
  if (new Set(matches.map(item => item.id)).size !== matches.length || matches.some(item => !allowed.has(item.id))) throw new Error('模型返回的 id 与当前分析批次不一致。');
  const levels = new Map(matches.map(item => [item.id, item.level] as const));
  return turns.map(turn => toAnalysisItem(turn, levels.get(turn.ordinal) ?? 0));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }

async function analyze(reference: ConversationReferenceDocument, target: { anchorGroupId: string; text: string } | { topic: string; text: string }, settings: ConversationAnalysisSettings, llm: ConversationLlm, signal?: AbortSignal): Promise<ConversationAnalysis> {
  if (!settings.provider || !settings.model) throw new Error('请先在设置 → Sift 中选择会话解析模型。');
  const targetContentHash = hash(target.text);
  const conversationVersion = hash(reference.groups.map(group => `${group.id}\n${group.user.content}\n${group.assistant.content}`).join('\n---\n'));
  const cached = reference.analysis;
  const sameTarget = 'anchorGroupId' in target
    ? cached?.anchorGroupId === target.anchorGroupId
    : cached?.topic === target.topic;
  if (cached && sameTarget && cached.promptVersion === PROMPT_VERSION && cached.targetContentHash === targetContentHash
    && cached.conversationVersion === conversationVersion && cached.model.provider === settings.provider
    && cached.model.model === settings.model && cached.model.reasoningEffort === settings.reasoningEffort) return cached;
  const config: LlmCallConfig = { provider: settings.provider, model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) } : {}), maxTokens: 8000 };
  const items = (await Promise.all(createBatches(reference).map(batch => runBatch(llm, config, target.text, batch, signal)))).flat();
  return {
    ...('anchorGroupId' in target ? { anchorGroupId: target.anchorGroupId } : { topic: target.topic }),
    model: { provider: settings.provider, model: settings.model, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) },
    createdAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, targetContentHash, conversationVersion, items,
  };
}

export async function analyzeConversation(reference: ConversationReferenceDocument, anchorGroupId: string, settings: ConversationAnalysisSettings, llm: ConversationLlm, signal?: AbortSignal): Promise<ConversationAnalysis> {
  const anchor = reference.groups.find(group => group.id === anchorGroupId);
  if (!anchor) throw new Error(`找不到锚点问答：${anchorGroupId}`);
  return analyze(reference, { anchorGroupId, text: `USER:\n${anchor.user.content}\n\nASSISTANT:\n${anchor.assistant.content}` }, settings, llm, signal);
}

export async function analyzeConversationTopic(reference: ConversationReferenceDocument, topic: string, settings: ConversationAnalysisSettings, llm: ConversationLlm, signal?: AbortSignal): Promise<ConversationAnalysis> {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic) throw new Error('分析主题不能为空。');
  return analyze(reference, { topic: normalizedTopic, text: normalizedTopic }, settings, llm, signal);
}
