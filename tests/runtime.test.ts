import { describe, expect, it } from 'vitest';
import { SiftClientRuntime } from '../src/client/runtime.js';
import { emptyCatalog, type Catalog } from '../src/domain/model.js';
import type { SiftRequest } from '../src/contracts/remote.js';

function fixture() {
  const catalog: Catalog = emptyCatalog();
  catalog.solutions.push({ id: 'solution', name: '主题', description: '', workspaceId: 'workspace', workspacePath: 'D:/topic', createdAt: '', updatedAt: '' });
  catalog.projects.push({ id: 'project', solutionId: 'solution', title: '项目', goal: '', notePath: 'D:/topic/note.md', sourceIds: [], sessionIds: ['session'], activeSessionId: 'session', createdAt: '', updatedAt: '' });
  catalog.annotations.push({ id: 'annotation', projectId: 'project', target: 'note', targetId: null, snapshot: { quote: '证据', title: '成果笔记', location: 'D:/topic/note.md', documentVersion: 'v1', anchor: null }, comments: [{ version: 1, comment: '判断', createdAt: '' }], currentCommentVersion: 1, createdAt: '', updatedAt: '' });
  catalog.workStates.push({ projectId: 'project', openTabs: ['note'], activeTab: 'note', readingLocations: {}, noteDraft: null, noteDraftBaseVersion: null, selectedAnnotationIds: ['annotation'], materialWidth: 280, conversationWidth: 480, materialTreeCollapsed: false, updatedAt: '' });
  const requests: SiftRequest[] = [];
  const remote = { dispatch: async (request: SiftRequest) => {
    requests.push(request);
    return { ok: true as const, value: request.type === 'catalog.get' ? catalog : {} };
  } };
  return { catalog, requests, runtime: new SiftClientRuntime(remote) };
}

describe('Sift submission lifecycle', () => {
  it('freezes the exact annotation version before admission and retains an edited newer version', async () => {
    const { catalog, requests, runtime } = fixture();
    await runtime.refresh(); runtime.setActiveProject('project');
    const text = runtime.transform({ sessionId: 'session', text: '请整理', mode: 'queue' });
    await runtime.beforeSubmit({ sessionId: 'session', text, mode: 'queue', signal: new AbortController().signal });
    catalog.annotations[0]!.comments.push({ version: 2, comment: '新版判断', createdAt: '' });
    catalog.annotations[0]!.currentCommentVersion = 2;
    await runtime.settled({ sessionId: 'session', text, mode: 'queue', outcome: { kind: 'success' } });
    const record = requests.find(request => request.type === 'annotation.send.record');
    expect(record).toMatchObject({ annotationVersions: [{ annotationId: 'annotation', commentVersion: 1 }] });
  });

  it('does not record a failed admission and handles repeated identical sends independently', async () => {
    const { requests, runtime } = fixture();
    await runtime.refresh(); runtime.setActiveProject('project');
    const text = runtime.transform({ sessionId: 'session', text: '', mode: 'steer' });
    await runtime.beforeSubmit({ sessionId: 'session', text, mode: 'steer', signal: new AbortController().signal });
    await runtime.beforeSubmit({ sessionId: 'session', text, mode: 'steer', signal: new AbortController().signal });
    await runtime.settled({ sessionId: 'session', text, mode: 'steer', outcome: { kind: 'error' } });
    await runtime.settled({ sessionId: 'session', text, mode: 'steer', outcome: { kind: 'success' } });
    expect(requests.filter(request => request.type === 'annotation.send.record')).toHaveLength(1);
  });

  it('uses the same untruncated message for preview and native submission', async () => {
    const { runtime } = fixture();
    await runtime.refresh(); runtime.setActiveProject('project');
    const preview = runtime.preview('session', '正文', 'queue');
    const submitted = runtime.transform({ sessionId: 'session', text: '正文', mode: 'queue' });
    expect(preview).toBe(submitted);
    expect(preview).toContain('正文');
    expect(preview).toContain('> 证据');
    expect(preview).toContain('批注：判断');
  });

  it('blocks admission when saving the current note draft fails', async () => {
    const { runtime } = fixture();
    await runtime.refresh(); runtime.setActiveProject('project');
    runtime.registerDraftSaver('project', async () => { throw new Error('草稿保存失败'); });
    await expect(runtime.beforeSubmit({ sessionId: 'session', text: '正文', mode: 'queue', signal: new AbortController().signal })).rejects.toThrow('草稿保存失败');
  });
});
