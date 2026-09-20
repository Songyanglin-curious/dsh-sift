import { describe, expect, it, vi } from 'vitest';
import { WorkspaceController } from '../src/client/workspace-controller.js';
import type { RelationLookup } from '../src/references.js';

function fixture(initial: Record<string, RelationLookup> = {}) {
  const relations = new Map(Object.entries(initial));
  const api = {
    getDocumentRelations: vi.fn(async ({ target }: { target: string }) =>
      relations.get(target) ?? { exists: false, references: [] }),
    setDocumentRelations: vi.fn(async ({ target, references }: { target: string; references: string[] }) => {
      relations.set(target, { exists: true, references: [...references] });
    }),
  };
  return { controller: new WorkspaceController(api), api, relations };
}

describe('WorkspaceController', () => {
  it('统一记录当前工作区打开的 Output Tabs', () => {
    const { controller } = fixture();
    controller.setOutputTabs(['doc-a', 'doc-b', 'doc-a']);
    expect(controller.snapshot().outputTabs).toEqual(['doc-a', 'doc-b']);
  });

  it('无 Output 时维护自由 Reference 工作集', async () => {
    const { controller, api } = fixture();
    await controller.addReferences(['ref-a', 'ref-b']);
    expect(controller.snapshot()).toMatchObject({
      activeReference: 'ref-b',
      freeReferenceTabs: ['ref-a', 'ref-b'],
      visibleReferences: ['ref-a', 'ref-b'],
    });
    expect(api.setDocumentRelations).not.toHaveBeenCalled();
  });

  it('切换 Output 只读取关系，不写关系', async () => {
    const { controller, api } = fixture({ 'doc-a': { exists: true, references: ['ref-a'] } });
    await controller.setActiveOutput('doc-a');
    expect(controller.snapshot()).toMatchObject({ activeOutput: 'doc-a', activeReference: 'ref-a', visibleReferences: ['ref-a'] });
    expect(api.setDocumentRelations).not.toHaveBeenCalled();
  });

  it('首次加入 Output 才继承当前可见参考，明确空关系不会被覆盖', async () => {
    const { controller, api, relations } = fixture({ 'doc-empty': { exists: true, references: [] } });
    await controller.addReferences(['ref-a']);
    await controller.initializeOutput('doc-new', controller.visibleReferences(), true);
    await controller.initializeOutput('doc-empty', ['ref-a'], true);
    expect(relations.get('doc-new')).toEqual({ exists: true, references: ['ref-a'] });
    expect(relations.get('doc-empty')).toEqual({ exists: true, references: [] });
    expect(api.setDocumentRelations).toHaveBeenCalledTimes(1);
  });

  it('有 Output 时添加参考只增量修改当前关系', async () => {
    const { controller, relations } = fixture({ 'doc-a': { exists: true, references: ['ref-a'] } });
    await controller.setActiveOutput('doc-a');
    await controller.addReferences(['ref-b', 'ref-a']);
    expect(relations.get('doc-a')).toEqual({ exists: true, references: ['ref-a', 'ref-b'] });
    expect(controller.snapshot().freeReferenceTabs).toEqual([]);
  });

  it('编辑关联可以保存明确空数组并同步 activeReference', async () => {
    const { controller, relations } = fixture({ 'doc-a': { exists: true, references: ['ref-a'] } });
    await controller.setActiveOutput('doc-a');
    await controller.replaceActiveRelations([]);
    expect(relations.get('doc-a')).toEqual({ exists: true, references: [] });
    expect(controller.snapshot().activeReference).toBeUndefined();
  });
});
