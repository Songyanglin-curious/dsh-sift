// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAnnotationAdapter } from '../src/client/annotations/adapter.js';

const symbol = Symbol.for('@songyanglin/dsh-annotations/service');
const readyEvent = 'dsh-annotations:ready';
const requestEvent = 'dsh-annotations:request';

type Adapter = { id: string; match(target: Node): { root: HTMLElement; source: { kind: string; uri: string; title: string } } | undefined };
type AnnotationWindow = Window & { [symbol]?: { registerSurface(adapter: Adapter): () => void } };

afterEach(() => { delete (window as AnnotationWindow)[symbol]; document.body.replaceChildren(); });

describe('Annotations 可选适配', () => {
  it('未安装插件时不影响 Sift，并在插件稍后就绪时注册', () => {
    const dispose = vi.fn();
    const registerSurface = vi.fn(() => dispose);
    const cleanup = installAnnotationAdapter();
    expect(registerSurface).not.toHaveBeenCalled();
    const service = { registerSurface };
    document.dispatchEvent(new CustomEvent(readyEvent, { detail: service }));
    expect(registerSurface).toHaveBeenCalledOnce();
    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('启动时主动请求服务，兼容 Annotations 先加载的顺序', () => {
    const registerSurface = vi.fn(() => () => {});
    const service = { registerSurface };
    const respond = () => document.dispatchEvent(new CustomEvent(readyEvent, { detail: service }));
    document.addEventListener(requestEvent, respond, { once: true });
    const cleanup = installAnnotationAdapter();
    expect(registerSurface).toHaveBeenCalledOnce();
    cleanup();
  });

  it('把 Reference 卡片解释成稳定的批注来源', () => {
    let adapter: Adapter | undefined;
    (window as AnnotationWindow)[symbol] = { registerSurface(value) { adapter = value; return () => {}; } };
    const cleanup = installAnnotationAdapter();
    const panel = document.createElement('div'); panel.dataset.siftRefPanel = ''; panel.dataset.annotationUri = 'references/a.json'; panel.dataset.annotationTitle = '研究材料';
    const card = document.createElement('article'); card.dataset.siftCard = ''; card.dataset.cardId = 'c1';
    const body = document.createElement('div'); body.dataset.siftCardBody = ''; body.textContent = '原文'; card.appendChild(body); panel.appendChild(card); document.body.appendChild(panel);
    const result = adapter?.match(body.firstChild!);
    expect(result?.root).toBe(body);
    expect(result?.source).toMatchObject({ kind: 'sift-reference-card', title: '研究材料' });
    expect(result?.source.uri).toContain('card:c1');
    cleanup();
  });
});
