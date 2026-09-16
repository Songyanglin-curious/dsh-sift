import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolOutputDefinition, ToolRunContext } from '../tools/contract.js';

/**
 * v0.2 的第三个接缝（见实施文档 §3.3、§33–§36）：
 * AI 不直接覆盖 Document，只能通过工具提出一次修改提案，
 * 由用户在客户端比对 Current / Proposed 后接受或拒绝。
 *
 * Phase 0 只验证「Agent 能调用一个假的 document change tool」：
 * 提案先存在内存里，客户端读取通道（Remote）到 Phase 8 再接。
 */

export const DOCUMENT_CHANGE_TOOL_NAME = 'sift_propose_document_change';

export interface DocumentChangeProposal {
  readonly proposalId: string;
  readonly documentId: string;
  /** 提案的完整文档正文，Diff 由客户端计算。 */
  readonly content: string;
  readonly reason?: string;
  readonly createdAt: string;
}

/** 待确认提案的存放处。每个 Document 只保留最新一条。 */
export interface DocumentChangeStore {
  put(proposal: DocumentChangeProposal): void;
  /** 只读取，不消费；用于客户端刷新。 */
  peek(documentId: string): DocumentChangeProposal | undefined;
  /** 读取并移除；用户接受或拒绝后调用。 */
  take(documentId: string): DocumentChangeProposal | undefined;
  list(): readonly DocumentChangeProposal[];
}

export function createDocumentChangeStore(): DocumentChangeStore {
  const pending = new Map<string, DocumentChangeProposal>();
  return {
    put: proposal => { pending.set(proposal.documentId, proposal); },
    peek: documentId => pending.get(documentId),
    take: documentId => {
      const proposal = pending.get(documentId);
      pending.delete(documentId);
      return proposal;
    },
    list: () => [...pending.values()],
  };
}

/**
 * 手搓定义，所以没有 defineTool 的参数校验；这里自己校验 `args`，
 * 失败时抛出普通 Error（对模型表现为一次失败的调用，不会中断本轮）。
 */
function readArguments(args: unknown): { documentId: string; content: string; reason?: string } {
  if (typeof args !== 'object' || args === null) throw new Error('参数必须是对象。');
  const value = args as Record<string, unknown>;
  const { documentId, content, reason } = value;
  if (typeof documentId !== 'string' || documentId === '') throw new Error('documentId 必须是非空字符串。');
  if (typeof content !== 'string') throw new Error('content 必须是字符串。');
  if (reason !== undefined && typeof reason !== 'string') throw new Error('reason 必须是字符串。');
  return reason === undefined ? { documentId, content } : { documentId, content, reason };
}

/** output.schema 用的是 raw JSON Schema：手搓定义必须写 `required: string[]`。 */
const OUTPUT_SCHEMA: ToolOutputDefinition['schema'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proposalId: { type: 'string', description: '提案 id，用于接受或拒绝。' },
    documentId: { type: 'string' },
    status: { type: 'string', enum: ['pending'], description: '提案已提交，等待用户接受或拒绝。' },
  },
  required: ['proposalId', 'documentId', 'status'],
};

export function createDocumentChangeTool(
  store: DocumentChangeStore,
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => randomUUID(),
): ToolDefinition {
  return {
    name: DOCUMENT_CHANGE_TOOL_NAME,
    description: [
      '提出一次对当前 Document 的修改提案，用户在 Diff 中接受或拒绝后才生效。',
      '这是修改 Document 的唯一方式：不要用文件写入工具直接覆盖 Document 的 Markdown 文件。',
      'content 必须是修改后的完整文档正文，不是补丁片段。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        documentId: { type: 'string', description: '要修改的 Document id。' },
        content: { type: 'string', description: '修改后的完整文档正文（Markdown）。' },
        reason: { type: 'string', description: '可选：这次修改的简要理由，显示在 Diff 旁。' },
      },
      required: ['documentId', 'content'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const proposal = value as { status?: string };
        return [{
          type: 'text',
          text: proposal.status === 'pending'
            ? '已提交 Document 修改提案。用户会在 Diff 中接受或拒绝，接受前文档内容不会改变。'
            : 'Document 修改提案已提交。',
        }];
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      exec.signal.throwIfAborted();
      const input = readArguments(args);
      const proposal: DocumentChangeProposal = {
        proposalId: newId(),
        documentId: input.documentId,
        content: input.content,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        createdAt: now(),
      };
      store.put(proposal);
      return { proposalId: proposal.proposalId, documentId: proposal.documentId, status: 'pending' as const };
    },
  };
}
