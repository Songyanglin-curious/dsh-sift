import { describe, expect, it, vi } from 'vitest';
import { createSiftReferenceSource } from '../src/client/reference/source.js';
import { referenceClipboardText, referencePromptText, type SiftReferenceRecord } from '../src/client/reference/codec.js';
import { registerInputTriggerSource, type CandidateRequest, type InputTriggerSource } from '../src/client/dsh-adapter/input-trigger.js';

const records: readonly SiftReferenceRecord[] = [
  { id: 'R1', label: 'Workspace 与实际目录绑定', content: 'Workspace 注册的是已有目录，不复制文件。', sourceTitle: 'architecture.md', locator: 'L120-L150' },
  { id: 'R2', label: '相同路径复用已有 Workspace', content: '同一规范化路径只会有一条 Workspace 记录。', sourceTitle: 'workspace.ts', locator: 'L42' },
  { id: 'R3', label: '删除 Workspace 不删除目录', content: '移除登记关系不会触碰磁盘上的目录。', sourceTitle: 'workspace.ts', locator: 'L88' },
];

function request(query: string, signal = new AbortController().signal): CandidateRequest {
  return { query, position: 'leading', drilled: false, signal };
}

const session = { sessionId: 'session-1' };
const span = { start: 0, end: 2, draftRev: 7 };

describe('Sift @ 引用源', () => {
  it('把每条参考暴露为一条候选，并带分组标题', async () => {
    const source = createSiftReferenceSource(() => records);
    const candidates = await source.candidates(session, request(''));
    expect(source.trigger).toBe('@');
    expect(source.name).toBe('sift');
    expect(source.showGroupTitle).toBe(false);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ name: 'Workspace 与实际目录绑定', icon: 'file', section: '当前参考', value: 'R1' });
    expect(candidates[0]?.description).toBe('architecture.md · L120-L150');
  });

  it('按标题、来源和正文过滤候选', async () => {
    const source = createSiftReferenceSource(() => records);
    expect((await source.candidates(session, request('workspace.ts'))).map(item => item.value)).toEqual(['R2', 'R3']);
    expect((await source.candidates(session, request('规范化路径'))).map(item => item.value)).toEqual(['R2']);
    expect((await source.candidates(session, request('不存在的关键词'))).length).toBe(0);
  });

  it('取消后不再返回候选', async () => {
    const source = createSiftReferenceSource(() => records);
    const controller = new AbortController();
    controller.abort();
    expect(await source.candidates(session, request('', controller.signal))).toHaveLength(0);
  });

  it('选择候选产生指向本 source 的 insert', () => {
    const source = createSiftReferenceSource(() => records);
    const outcome = source.onPick({ candidate: { name: 'x', value: 'R2' }, session, position: 'leading', via: 'menu', action: 'pick', span });
    expect(outcome).toEqual({
      insert: {
        source: 'sift',
        ref: 'R2',
        label: '相同路径复用已有 Workspace',
        clipboardText: '@参考:相同路径复用已有 Workspace',
      },
    });
  });

  it('选择未知候选不产生结果', () => {
    const source = createSiftReferenceSource(() => records);
    expect(source.onPick({ candidate: { name: 'x' }, session, position: 'leading', via: 'menu', action: 'pick', span })).toBeUndefined();
  });

  it('序列化把参考正文送给模型', async () => {
    const source = createSiftReferenceSource(() => records);
    const text = await source.codec!.serialize('R1', new AbortController().signal);
    expect(text).toBe(referencePromptText(records[0]!));
    expect(text).toContain('[Sift Reference]');
    expect(text).toContain('Source:\narchitecture.md');
    expect(text).toContain('Locator:\nL120-L150');
    expect(text).toContain('Content:\nWorkspace 注册的是已有目录，不复制文件。');
  });

  it('序列化未知参考必须抛错，而不是静默降级', async () => {
    const source = createSiftReferenceSource(() => records);
    await expect(source.codec!.serialize('R404', new AbortController().signal)).rejects.toThrow('找不到参考：R404');
  });

  it('序列化已取消时抛错', async () => {
    const source = createSiftReferenceSource(() => records);
    const controller = new AbortController();
    controller.abort();
    await expect(source.codec!.serialize('R1', controller.signal)).rejects.toThrow('已取消');
  });
});

describe('reference 文本投影', () => {
  it('省略空的来源与定位段落', () => {
    const text = referencePromptText({ id: 'R1', label: '标题', content: '正文' });
    expect(text).toBe('[Sift Reference]\n\nContent:\n正文');
  });

  it('clipboardText 单行且不含占位符码位', () => {
    const text = referenceClipboardText({ id: 'R1', label: '多行\n标题  带空格', content: '正文' });
    expect(text).toBe('@参考:多行 标题 带空格');
    expect(/[\uFFFC\uE100-\uE11D]/u.test(text)).toBe(false);
  });

  it('clipboardText 在标题为空时回落到 id', () => {
    expect(referenceClipboardText({ id: 'R9', label: '   ', content: '正文' })).toBe('@参考:R9');
  });
});

describe('注册与释放', () => {
  function fixture() {
    const disposers: (() => void)[] = [];
    const sources: InputTriggerSource[] = [];
    const inputTriggers = {
      registerSource: vi.fn((source: InputTriggerSource) => {
        sources.push(source);
        const dispose = vi.fn();
        disposers.push(dispose);
        return dispose;
      }),
    };
    const cleanups: (() => void)[] = [];
    const effect = vi.fn((factory: () => () => void) => { cleanups.push(factory()); });
    return { inputTriggers, effect, sources, disposers, cleanups };
  }

  it('通过 ctx.effect 注册，并由返回的清理函数注销', () => {
    const { inputTriggers, effect, sources, disposers, cleanups } = fixture();
    const source = createSiftReferenceSource(() => records);
    registerInputTriggerSource({ inputTriggers, effect }, source);
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'sift: @sift source');
    expect(inputTriggers.registerSource).toHaveBeenCalledWith(source);
    expect(sources).toHaveLength(1);
    cleanups[0]!();
    expect(disposers[0]).toHaveBeenCalledTimes(1);
  });

  it('手动注销是幂等的', () => {
    const { inputTriggers, sources, disposers, cleanups } = fixture();
    const dispose = registerInputTriggerSource({ inputTriggers, effect: undefined }, createSiftReferenceSource(() => records));
    expect(sources).toHaveLength(1);
    dispose(); dispose();
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(cleanups).toHaveLength(0);
  });
});
