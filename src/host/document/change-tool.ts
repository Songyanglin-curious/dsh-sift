import type { ToolDefinition, ToolOutputDefinition, ToolRunContext } from '../tools/contract.js';

export const DOCUMENT_CHANGE_TOOL_NAME = 'sift_update_current_document';

export interface CurrentDocumentTarget {
  readonly workspaceId: string;
  readonly documentId: string;
  readonly path: string;
}

function readArguments(args: unknown): { content: string; reason?: string } {
  if (typeof args !== 'object' || args === null) throw new Error('参数必须是对象。');
  const value = args as Record<string, unknown>;
  if (typeof value.content !== 'string') throw new Error('content 必须是字符串。');
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('reason 必须是字符串。');
  return value.reason === undefined ? { content: value.content } : { content: value.content, reason: value.reason };
}

const OUTPUT_SCHEMA: ToolOutputDefinition['schema'] = {
  type: 'object', additionalProperties: false,
  properties: {
    documentId: { type: 'string' },
    path: { type: 'string' },
    status: { type: 'string', enum: ['updated'] },
  },
  required: ['documentId', 'path', 'status'],
};

/** AI 只能覆盖客户端当前绑定的 Document，不能提供任意路径或其他 Document id。 */
export function createDocumentChangeTool(
  current: () => Promise<CurrentDocumentTarget>,
  write: (target: CurrentDocumentTarget, content: string) => Promise<void>,
): ToolDefinition {
  return {
    name: DOCUMENT_CHANGE_TOOL_NAME,
    description: [
      '用完整 Markdown 正文更新 Sift 当前打开的 Document。',
      '目标由 Sift 当前界面固定，不能指定路径、Reference、关系数据或其他 Document。',
      'content 必须是修改后的完整文档正文。',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        content: { type: 'string', description: '修改后的完整 Markdown 正文。' },
        reason: { type: 'string', description: '可选：修改理由。' },
      },
      required: ['content'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { status?: string };
        return [{ type: 'text', text: result.status === 'updated' ? '当前 Document 已更新。' : 'Document 更新完成。' }];
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      exec.signal.throwIfAborted();
      const input = readArguments(args);
      const target = await current();
      exec.signal.throwIfAborted();
      await write(target, input.content);
      return { documentId: target.documentId, path: target.path, status: 'updated' as const };
    },
  };
}
