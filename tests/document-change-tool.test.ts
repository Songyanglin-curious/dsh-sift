import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_CHANGE_TOOL_NAME, createDocumentChangeTool, type CurrentDocumentTarget } from '../src/host/document/change-tool.js';
import type { JsonSchemaNode } from '../src/host/tools/contract.js';

const SUPPORTED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title']);
function assertSchema(schema: JsonSchemaNode, path = 'schema'): void {
  for (const key of Object.keys(schema)) expect(SUPPORTED, `${path}.${key}`).toContain(key);
  if (schema.type === 'object') {
    expect(typeof schema.additionalProperties).toBe('boolean');
    for (const [key, child] of Object.entries(schema.properties ?? {})) assertSchema(child, `${path}.${key}`);
  }
}

const target: CurrentDocumentTarget = { workspaceId: 'workspace-1', documentId: 'doc-1', path: 'notes/a.md' };
const exec = { signal: new AbortController().signal };
const setup = () => {
  const current = vi.fn(async () => target);
  const write = vi.fn(async () => {});
  return { current, write, definition: createDocumentChangeTool(current, write) };
};

describe('sift_update_current_document 定义', () => {
  it('只接受完整正文，不允许模型指定路径或 Document id', () => {
    const { definition } = setup();
    expect(definition.name).toBe(DOCUMENT_CHANGE_TOOL_NAME);
    expect(definition.parameters).toMatchObject({ type: 'object', required: ['content'] });
    expect(Object.keys(definition.parameters.properties as object)).toEqual(['content', 'reason']);
    expect(definition.description).toContain('当前打开');
    expect(definition.description).toContain('不能指定路径');
    assertSchema(definition.output.schema);
  });
});

describe('sift_update_current_document 执行', () => {
  it('解析当前绑定目标并直接写入完整正文', async () => {
    const { definition, current, write } = setup();
    const value = await definition.execute({ content: '# 新正文', reason: '整理' }, exec);
    expect(current).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(target, '# 新正文');
    expect(value).toEqual({ documentId: 'doc-1', path: 'notes/a.md', status: 'updated' });
    expect(definition.output.render({}, value as never)[0]?.text).toContain('已更新');
  });

  it('没有当前 Document 时不写入', async () => {
    const write = vi.fn(async () => {});
    const definition = createDocumentChangeTool(async () => { throw new Error('没有当前 Document'); }, write);
    await expect(definition.execute({ content: 'x' }, exec)).rejects.toThrow('没有当前 Document');
    expect(write).not.toHaveBeenCalled();
  });

  it('拒绝非法参数和已取消调用', async () => {
    const { definition, write } = setup();
    await expect(definition.execute(null, exec)).rejects.toThrow('参数必须是对象');
    await expect(definition.execute({}, exec)).rejects.toThrow('content 必须是字符串');
    await expect(definition.execute({ content: 'x', reason: 1 }, exec)).rejects.toThrow('reason 必须是字符串');
    const controller = new AbortController(); controller.abort();
    await expect(definition.execute({ content: 'x' }, { signal: controller.signal })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
