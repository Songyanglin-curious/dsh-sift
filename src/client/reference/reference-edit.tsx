/**
 * 编辑参考名称与描述的小弹窗。
 *
 * 复用 DSH Modal（@deepseek-ai/dsh-client-ui-primitives），
 * 表单使用原生 input/textarea 加 DSH 主题变量内联样式，不自己造 UI 组件。
 *
 * 挂载模式与 workspace-creator 一致：
 * - 模块级 callback，挂载时写入，点击✎时触发打开。
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';

/** 当前名称与描述，由 panel 在点击✎时设入。 */
let currentInitial: { name: string; description: string } | null = null;
let onSaveCallback: ((name: string, description: string) => Promise<void>) | null = null;

/** ✎ 按钮点击时由 panel 调用，打开弹窗并填入当前值。 */
let openEditor: (() => void) | undefined;

export function triggerEdit(name: string, description: string, onSave: (name: string, description: string) => Promise<void>): void {
  currentInitial = { name, description };
  onSaveCallback = onSave;
  openEditor?.();
}

function EditModal() {
  const [isOpen, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    openEditor = () => {
      if (currentInitial) {
        setName(currentInitial.name);
        setDescription(currentInitial.description);
      }
      setError(undefined);
      setOpen(true);
    };
    return () => { openEditor = undefined; };
  }, []);

  const close = () => { setOpen(false); setBusy(false); setError(undefined); };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName === '') {
      setError('名称不能为空。');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (!onSaveCallback) throw new Error('保存回调未设置。');
      await onSaveCallback(trimmedName, description.trim());
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败。');
      setBusy(false);
    }
  };

  return (
    <Modal open={isOpen} onClose={close} title="编辑参考" closeLabel="关闭"
      description="修改当前参考的名称与描述。"
      footer={
        <>
          <button type="button" onClick={close} disabled={busy}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: 13 }}>
            取消
          </button>
          <button type="button" onClick={handleSave} disabled={busy}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #4c8dff', background: busy ? '#8ab4ff' : '#4c8dff', color: '#fff', cursor: 'pointer', font: 'inherit', fontSize: 13 }}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>名称</span>
          <input
            type="text" value={name} onChange={e => setName(e.target.value)} disabled={busy}
            style={{
              padding: '8px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l4, #d1d5db)',
              background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #111827)',
              font: 'inherit', fontSize: 13, outline: 'none',
            }}
            onFocus={e => e.currentTarget.style.borderColor = '#4c8dff'}
            onBlur={e => e.currentTarget.style.borderColor = ''}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>描述</span>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)} disabled={busy} rows={3}
            style={{
              padding: '8px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l4, #d1d5db)',
              background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #111827)',
              font: 'inherit', fontSize: 13, outline: 'none', resize: 'vertical',
            }}
            onFocus={e => e.currentTarget.style.borderColor = '#4c8dff'}
            onBlur={e => e.currentTarget.style.borderColor = ''}
          />
        </label>
        {error && <p style={{ margin: 0, color: '#e5484d', fontSize: 12 }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function mountReferenceEditor(): () => void {
  const container = document.createElement('div');
  container.dataset.siftReferenceEditor = '';
  const root = createRoot(container);
  root.render(<EditModal />);
  return () => { root.unmount(); container.remove(); openEditor = undefined; onSaveCallback = null; currentInitial = null; };
}