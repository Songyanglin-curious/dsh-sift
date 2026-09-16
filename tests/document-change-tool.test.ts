import { describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_CHANGE_TOOL_NAME,
  createDocumentChangeStore,
  createDocumentChangeTool,
} from '../src/host/document/change-tool.js';
import type { JsonSchemaNode, ToolDefinition } from '../src/host/tools/contract.js';

const SUPPORTED_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);

/**
 * 镜像 dsh-tools `assertSupportedJsonSchema` 的 enforced subset：
 * 不支持的或不支持位置的关键字会被拒绝，而不是静默接受。
 */
function assertSupportedSchema(schema: JsonSchemaNode, path = 'schema'): void {
  for (const key of Object.keys(schema)) expect(SUPPORTED_KEYWORDS, `${path}.${key} 不在受支持子集里`).toContain(key);
  if (schema.type === 'object') {
    expect(typeof schema.additionalProperties, `${path}.additionalProperties 必须显式声明`).toBe('boolean');
    for (const [key, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${path}.${key}`);
  }
  if (schema.items) assertSupportedSchema(schema.items, `${path}.items`);
}

function tool(): ToolDefinition {
  return createDocumentChangeTool(createDocumentChangeStore(), () => '2026-01-01T00:00:00.000Z', () => 'proposal-1');
}

const exec = { signal: new AbortController().signal };

describe('sift_propose_document_change 定义', () => {
  it('是注册表能接受的结构', () => {
    const definition = tool();
    expect(definition.name).toBe(DOCUMENT_CHANGE_TOOL_NAME);
    expect(definition.name.startsWith('sift_')).toBe(true);
    expect(typeof definition.execute).toBe('function');
    expect(typeof definition.output.render).toBe('function');
    assertSupportedSchema(definition.output.schema);
  });

  it('parameters 是 raw JSON Schema，用 required 字符串数组', () => {
    const { parameters } = tool();
    expect(parameters).toMatchObject({ type: 'object', required: ['documentId', 'content'] });
    expect(Object.keys(parameters.properties as Record<string, unknown>)).toEqual(['documentId', 'content', 'reason']);
  });

  it('output.schema 也用 required 字符串数组，而不是属性级 required', () => {
    const { schema } = tool().output;
    expect(schema.required).toEqual(['proposalId', 'documentId', 'status']);
    for (const property of Object.values(schema.properties ?? {})) {
      expect(property).not.toHaveProperty('required');
    }
  });

  it('描述里明确禁止直接写文件覆盖 Document', () => {
    expect(tool().description).toContain('完整文档正文');
    expect(tool().description).toContain('唯一方式');
  });
});

describe('sift_propose_document_change 执行', () => {
  it('记录提案并返回规范值', async () => {
    const store = createDocumentChangeStore();
    const definition = createDocumentChangeTool(store, () => '2026-01-01T00:00:00.000Z', () => 'proposal-1');
    const value = await definition.execute({ documentId: 'doc-1', content: '# 新正文', reason: '补充一节' }, exec);
    expect(value).toEqual({ proposalId: 'proposal-1', documentId: 'doc-1', status: 'pending' });
    expect(store.peek('doc-1')).toEqual({
      proposalId: 'proposal-1', documentId: 'doc-1', content: '# 新正文', reason: '补充一节', createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('render 告诉模型等待用户接受', async () => {
    const definition = tool();
    const value = await definition.execute({ documentId: 'doc-1', content: '# 新正文' }, exec);
    const blocks = definition.output.render({ documentId: 'doc-1', content: '# 新正文' }, value as never);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(blocks[0]!.text).toContain('接受或拒绝');
  });

  it('拒绝非法参数', async () => {
    const definition = tool();
    await expect(definition.execute(null, exec)).rejects.toThrow('参数必须是对象');
    await expect(definition.execute({ content: 'x' }, exec)).rejects.toThrow('documentId 必须是非空字符串');
    await expect(definition.execute({ documentId: 'doc-1', content: 42 }, exec)).rejects.toThrow('content 必须是字符串');
    await expect(definition.execute({ documentId: 'doc-1', content: 'x', reason: 1 }, exec)).rejects.toThrow('reason 必须是字符串');
  });

  it('已取消的调用立即失败且不写入提案', async () => {
    const store = createDocumentChangeStore();
    const definition = createDocumentChangeTool(store);
    const controller = new AbortController();
    controller.abort();
    await expect(definition.execute({ documentId: 'doc-1', content: 'x' }, { signal: controller.signal })).rejects.toThrow();
    expect(store.list()).toHaveLength(0);
  });
});

describe('待确认提案存储', () => {
  it('每个 Document 只保留最新一条，take 会消费', () => {
    let count = 0;
    const store = createDocumentChangeStore();
    const definition = createDocumentChangeTool(store, () => '2026-01-01T00:00:00.000Z', () => `proposal-${++count}`);
    return Promise.all([
      definition.execute({ documentId: 'doc-1', content: '第一版' }, exec),
      definition.execute({ documentId: 'doc-1', content: '第二版' }, exec),
      definition.execute({ documentId: 'doc-2', content: '另一篇' }, exec),
    ]).then(() => {
      expect(store.peek('doc-1')?.content).toBe('第二版');
      expect(store.list()).toHaveLength(2);
      expect(store.take('doc-1')?.proposalId).toBe('proposal-2');
      expect(store.take('doc-1')).toBeUndefined();
      expect(store.peek('doc-2')?.content).toBe('另一篇');
    });
  });
});

describe('宿主注册接线', () => {
  it('通过 ctx.tools.register 注册，并使用返回的 disposer', () => {
    const dispose = vi.fn();
    const tools = { register: vi.fn(() => dispose) };
    const registered = tools.register(createDocumentChangeTool(createDocumentChangeStore()));
    expect(tools.register).toHaveBeenCalledWith(expect.objectContaining({ name: DOCUMENT_CHANGE_TOOL_NAME }));
    registered();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
