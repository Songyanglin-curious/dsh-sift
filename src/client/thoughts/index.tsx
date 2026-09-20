import { useSyncExternalStore, useState } from 'react';
import thoughtCss from './thoughts.css?inline';
import { injectStyle, SIFT_PLUGIN_ID } from '../renderer/inject-style.js';
import { detectEnd, detectOffset, formatThought, SIFT_THOUGHT_SOURCE, thoughtLabel, thoughtRef, type Thought, type ThoughtSelection } from './model.js';
import type { InputTriggerSource, TokenSpan } from '../dsh-adapter/input-trigger.js';

interface InputOccurrence { readonly source: string; readonly ref: string; readonly offset: number; readonly length: number }
interface InputSnapshot { readonly draft: string; readonly draftRev: number; readonly phase: string; readonly occurrences: readonly InputOccurrence[] }
interface ScopedContext { bail(...args: unknown[]): unknown }
interface ThoughtSessionBinding { actx: ScopedContext; input?: InputSnapshot }

class ThoughtStore {
  private readonly values = new Map<string, Thought>();
  private readonly bindings = new Map<string, ThoughtSessionBinding>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.version;
  private emit() { this.version += 1; for (const listener of this.listeners) listener(); }

  bind(sessionId: string, actx: ScopedContext, input?: InputSnapshot): void {
    this.bindings.set(sessionId, { actx, input });
  }

  updateInput(sessionId: string, input: InputSnapshot): void {
    const binding = this.bindings.get(sessionId);
    if (binding) binding.input = input;
  }

  add(sessionId: string, selection: ThoughtSelection, text: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (!binding?.input || binding.input.phase !== 'plain') return false;
    const id = globalThis.crypto?.randomUUID?.() ?? `thought-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const thought: Thought = { ...selection, id, thought: text.trim() };
    const ref = thoughtRef(sessionId, id);
    this.values.set(ref, thought);
    const offset = detectEnd(binding.input.draft, binding.input.occurrences);
    const inserted = binding.actx.bail(binding.actx, 'slash/input-insert-reference', {
      reference: {
        source: SIFT_THOUGHT_SOURCE,
        ref,
        label: thoughtLabel(thought.thought),
        clipboardText: `@想法:${id.slice(0, 8)}`,
      },
      span: { start: offset, end: offset, draftRev: binding.input.draftRev },
    }) === true;
    if (!inserted) this.values.delete(ref);
    else this.emit();
    return inserted;
  }

  thought(ref: string): Thought | undefined { return this.values.get(ref); }

  active(sessionId: string, input: InputSnapshot): Array<{ thought: Thought; occurrence: InputOccurrence }> {
    return input.occurrences.flatMap(occurrence => {
      if (occurrence.source !== SIFT_THOUGHT_SOURCE) return [];
      const thought = this.values.get(occurrence.ref);
      return thought ? [{ thought, occurrence }] : [];
    });
  }

  edit(ref: string, text: string): void {
    const thought = this.values.get(ref);
    if (!thought || text.trim() === '') return;
    thought.thought = text.trim();
    this.emit();
  }

  remove(sessionId: string, occurrence: InputOccurrence): void {
    const binding = this.bindings.get(sessionId);
    if (!binding?.input || binding.input.phase !== 'plain') return;
    const start = detectOffset(occurrence, binding.input.occurrences);
    const span: TokenSpan = { start, end: start + 1, draftRev: binding.input.draftRev };
    const removed = binding.actx.bail(binding.actx, 'slash/input-insert-text', { text: '', span }) === true;
    if (removed) this.emit();
  }
}

const store = new ThoughtStore();

interface ThoughtDockProps {
  readonly thoughtSessionId: string;
  readonly input: InputSnapshot;
}

function ThoughtDock({ thoughtSessionId, input }: ThoughtDockProps) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  store.updateInput(thoughtSessionId, input);
  const [editing, setEditing] = useState<string>();
  const active = store.active(thoughtSessionId, input);
  if (active.length === 0) return null;
  return <div data-sift-thought-dock="">
    <div className="sift-thought-heading">本轮想法 · {active.length}</div>
    {active.map(({ thought, occurrence }) => {
      const ref = occurrence.ref;
      const isEditing = editing === ref;
      return <div className="sift-thought-row" key={ref} title={thought.selectedText}>
        <span className="sift-thought-area">{thought.area === 'reference' ? '参考' : '产出'} · {thought.sourceName}</span>
        <span className="sift-thought-selection">“{thought.selectedText}”</span>
        <span className="sift-thought-text">{thought.thought}</span>
        <button type="button" aria-label="编辑想法" title="编辑想法" onClick={() => setEditing(isEditing ? undefined : ref)}>✎</button>
        <button type="button" aria-label="移除想法" title="移除想法" onClick={() => store.remove(thoughtSessionId, occurrence)}>×</button>
        {isEditing && <ThoughtEdit thought={thought} onCancel={() => setEditing(undefined)} onSave={value => { store.edit(ref, value); setEditing(undefined); }} />}
      </div>;
    })}
  </div>;
}

function ThoughtEdit({ thought, onCancel, onSave }: { thought: Thought; onCancel(): void; onSave(value: string): void }) {
  const [value, setValue] = useState(thought.thought);
  return <div className="sift-thought-edit">
    <textarea aria-label="想法内容" value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) onSave(value);
    }} />
    <div><button type="button" onClick={onCancel}>取消</button><button type="button" onClick={() => onSave(value)} disabled={value.trim() === ''}>保存</button></div>
  </div>;
}

export interface ThoughtFeatureHost {
  readonly inputTriggers: { registerSource(source: InputTriggerSource): () => void };
  readonly sessions: { list: { getSnapshot(): { current?: string } }; scope(sessionId: string): ScopedContext | undefined };
  readonly slots: {
    inject(name: string, factory: () => unknown): unknown;
    register(options: { name: string; id: string; order?: number; inject?: (sessionId: string) => Record<string, unknown> }, component: unknown): () => void;
  };
  effect?(factory: () => () => void, label?: string): unknown;
}

export interface ThoughtFeature {
  capture(selection: ThoughtSelection, anchor: DOMRect, bounds: DOMRect): void;
}

export function installThoughtFeature(ctx: ThoughtFeatureHost): ThoughtFeature {
  injectStyle(SIFT_PLUGIN_ID, 'thoughts.css', thoughtCss);
  const source: InputTriggerSource = {
    trigger: '@', name: SIFT_THOUGHT_SOURCE, order: 5, showGroupTitle: false,
    candidates: async () => [], onPick: () => undefined,
    codec: {
      clipboardText: ref => `@想法:${ref.split(':').at(-1)?.slice(0, 8) ?? ''}`,
      serialize: async ref => {
        const thought = store.thought(ref);
        if (!thought) throw new Error('本轮想法已失效，请移除后重新添加。');
        return formatThought(thought);
      },
    },
  };
  const disposeSource = ctx.inputTriggers.registerSource(source);
  let disposeDock: (() => void) | undefined;
  ctx.slots.inject('conversation.input.dock', () => {
    disposeDock = ctx.slots.register({
      name: 'conversation.input.dock', id: 'sift-thoughts', order: 10,
      inject: sessionId => {
        const actx = ctx.sessions.scope(sessionId);
        if (!actx) throw new Error(`Sift 想法：找不到会话 ${sessionId}`);
        store.bind(sessionId, actx);
        return { thoughtSessionId: sessionId };
      },
    }, ThoughtDock);
    return disposeDock;
  });
  ctx.effect?.(() => () => { disposeDock?.(); disposeSource(); }, 'sift: thoughts');

  return {
    capture(selection, anchor, bounds) {
      const sessionId = ctx.sessions.list.getSnapshot().current;
      if (!sessionId) return;
      openThoughtComposer(anchor, bounds, selection, text => store.add(sessionId, selection, text));
    },
  };
}

let activePopover: HTMLElement | undefined;
function openThoughtComposer(anchor: DOMRect, bounds: DOMRect, selection: ThoughtSelection, add: (text: string) => boolean): void {
  activePopover?.remove();
  const quick = document.createElement('button');
  quick.type = 'button'; quick.dataset.siftThoughtQuick = ''; quick.textContent = '＋ 想法';
  document.body.appendChild(quick);
  positionQuick(quick, anchor, bounds);
  activePopover = quick;
  // 保留正文选区；否则按钮获得焦点时 selectionchange 会先把入口收掉。
  quick.addEventListener('mousedown', event => event.preventDefault());
  quick.addEventListener('click', event => {
    event.stopPropagation();
    const form = document.createElement('form'); form.dataset.siftThoughtEditor = '';
    const quote = document.createElement('small'); quote.textContent = `“${selection.selectedText.replace(/\s+/g, ' ')}”`;
    const input = document.createElement('textarea'); input.placeholder = '写下你的想法…'; input.setAttribute('aria-label', '想法内容');
    const footer = document.createElement('footer');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '加入本轮'; submit.disabled = true;
    input.addEventListener('input', () => { submit.disabled = input.value.trim() === ''; });
    input.addEventListener('keydown', key => {
      if (key.key === 'Escape') { key.preventDefault(); form.remove(); activePopover = undefined; }
      if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) { key.preventDefault(); form.requestSubmit(); }
    });
    cancel.addEventListener('click', () => { form.remove(); activePopover = undefined; });
    form.addEventListener('submit', submitEvent => {
      submitEvent.preventDefault();
      if (input.value.trim() !== '' && add(input.value)) { form.remove(); activePopover = undefined; }
    });
    footer.append(cancel, submit); form.append(quote, input, footer); quick.replaceWith(form); activePopover = form;
    const availableWidth = Math.max(180, Math.min(340, bounds.width - 16));
    form.style.width = `${availableWidth}px`;
    positionWithin(form, anchor.left, anchor.bottom + 8, bounds);
    input.focus();
  });
}

function positionWithin(element: HTMLElement, left: number, top: number, bounds: DOMRect): void {
  const gap = 8;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const minLeft = Math.max(gap, bounds.left + gap);
  const maxLeft = Math.min(window.innerWidth - width - gap, bounds.right - width - gap);
  const minTop = Math.max(gap, bounds.top + gap);
  const maxTop = Math.min(window.innerHeight - height - gap, bounds.bottom - height - gap);
  element.style.left = `${Math.max(minLeft, Math.min(left, Math.max(minLeft, maxLeft)))}px`;
  element.style.top = `${Math.max(minTop, Math.min(top, Math.max(minTop, maxTop)))}px`;
}

function positionQuick(element: HTMLElement, anchor: DOMRect, bounds: DOMRect): void {
  const gap = 8;
  const width = element.offsetWidth || 64;
  const height = element.offsetHeight || 26;
  const left = anchor.left + gap + width <= window.innerWidth - 8
    ? anchor.left + gap
    : anchor.left - width - gap;
  const top = anchor.top + gap + height <= window.innerHeight - 8
    ? anchor.top + gap
    : anchor.top - height - gap;
  positionWithin(element, left, top, bounds);
}

export function installSelectionCapture(
  root: HTMLElement,
  area: ThoughtSelection['area'],
  resolveSource: (target: Node) => { sourceId: string; sourceName: string } | undefined,
  capture: ThoughtFeature['capture'],
): () => void {
  const onMouseUp = (event: MouseEvent) => {
    const pointer = new DOMRect(event.clientX, event.clientY, 0, 0);
    queueMicrotask(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        if (activePopover?.matches('[data-sift-thought-quick]')) { activePopover.remove(); activePopover = undefined; }
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return;
      const selectedText = selection.toString().trim();
      if (selectedText === '') return;
      const source = resolveSource(range.commonAncestorContainer);
      if (!source) return;
      capture({ area, selectedText, ...source }, pointer, root.getBoundingClientRect());
    });
  };
  const onSelectionChange = () => {
    queueMicrotask(() => {
      if (!window.getSelection()?.isCollapsed) return;
      if (activePopover?.matches('[data-sift-thought-quick]')) { activePopover.remove(); activePopover = undefined; }
    });
  };
  root.addEventListener('mouseup', onMouseUp);
  document.addEventListener('selectionchange', onSelectionChange);
  return () => {
    root.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('selectionchange', onSelectionChange);
  };
}
