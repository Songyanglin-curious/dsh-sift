import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { isWorkspaceAddButton } from './dsh-adapter/selectors.js';
import type { ProfileResult } from './dsh-adapter/workspace-entry.js';

/** Creator 需用的上下文（installWorkspaceTypeCreator 的参数子集）。 */
interface CreatorCtx {
  uiWorkspace?: { pickDirectory(): Promise<string | null>; openWorkspace(workspaceId: string): Promise<void> };
  workspaces?: { create(input: { path: string }): Promise<{ workspaceId: string }> };
}

type SetProfile = (input: { workspaceId: string; profile: 'default' | 'sift' }) => Promise<ProfileResult>;

/** 模块级引用，让非 React 的捕获点击处理器能调用 setOpen(true)。 */
let showCreator: (() => void) | undefined;

/** DSH Modal 包裹的工作区类型选择与创建流程。 */
function CreatorModal({ ctx, setProfile }: { ctx: CreatorCtx; setProfile: SetProfile }) {
  const [isOpen, setOpen] = useState(false);
  const [profile, setProfile_] = useState<'default' | 'sift'>('sift');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    showCreator = () => { setOpen(true); setError(undefined); };
    return () => { if (showCreator) showCreator = undefined; };
  }, []);

  const close = () => { setOpen(false); setBusy(false); setError(undefined); };

  const handleCreate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const path = await ctx.uiWorkspace?.pickDirectory();
      if (!path) { setBusy(false); return; }
      if (!ctx.workspaces) throw new Error('工作区服务不可用。');
      const workspace = await ctx.workspaces.create({ path });
      const result = await setProfile({ workspaceId: workspace.workspaceId, profile });
      if (result.status !== 'ready') throw new Error(result.message ?? '工作区类型保存失败。');
      close();
      await ctx.uiWorkspace?.openWorkspace(workspace.workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建工作区失败。');
      setBusy(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={close}
      title="创建工作区"
      closeLabel="关闭"
      description="选择这个工作区使用的类型。"
      footer={
        <>
          <button type="button" onClick={close} disabled={busy}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
            取消
          </button>
          <button type="button" onClick={handleCreate} disabled={busy}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #4c8dff', background: busy ? '#8ab4ff' : '#4c8dff', color: '#fff', cursor: 'pointer' }}>
            {busy ? '创建中…' : '选择目录并创建'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
        {(['default', 'sift'] as const).map(type => (
          <button
            key={type}
            type="button"
            onClick={() => setProfile_(type)}
            disabled={busy}
            style={{
              boxSizing: 'border-box', display: 'grid', gap: 2, justifyItems: 'start',
              padding: '12px 14px', borderRadius: 10, textAlign: 'left', cursor: 'pointer',
              border: profile === type ? '2px solid #4c8dff' : '1px solid rgba(127,127,127,.35)',
              background: profile === type ? 'rgba(76,141,255,.1)' : 'transparent',
              color: 'inherit',
              font: 'inherit',
              opacity: busy ? .55 : 1,
            }}
          >
            <strong style={{ fontSize: 15 }}>{type === 'default' ? 'default' : 'sift'}</strong>
            <small style={{ opacity: .72, fontSize: 12 }}>
              {type === 'default' ? '保持原生单栏对话界面' : '启用参考、文档、对话三栏界面'}
            </small>
          </button>
        ))}
      </div>
      {error && <p style={{ margin: '8px 0 0', color: '#e5484d', fontSize: 12 }} role="alert">{error}</p>}
    </Modal>
  );
}

/**
 * 拦截原生"添加工作区"按钮的点击（捕获阶段），阻止默认目录流程，
 * 打开 DSH Modal 让用户选择类型后再走 pickDirectory → create → setProfile → openWorkspace。
 */
export function installWorkspaceTypeCreator(ctx: CreatorCtx, setProfile: SetProfile): () => void {
  const container = document.createElement('div');
  container.dataset.siftCreator = '';
  const root = createRoot(container);
  flushSync(() => root.render(<CreatorModal ctx={ctx} setProfile={setProfile} />));

  const onCaptureClick = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button) return;
    if (!isWorkspaceAddButton(button as HTMLButtonElement | null)) return;
    event.preventDefault();
    event.stopPropagation();
    showCreator?.();
  };

  document.addEventListener('click', onCaptureClick, true);

  return () => {
    document.removeEventListener('click', onCaptureClick, true);
    root.unmount();
    container.remove();
    showCreator = undefined;
  };
}
