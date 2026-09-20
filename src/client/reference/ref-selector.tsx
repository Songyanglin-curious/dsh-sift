/**
 * 通用 Reference 多选弹窗：添加已有参考与编辑 Output 关联共用视图，
 * 但具体是增量添加还是全量覆盖由调用方明确决定。
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { injectStyle, SIFT_PLUGIN_ID } from '../renderer/inject-style.js';

interface RefSelectorInitial {
  all: readonly { path: string; name: string }[];
  checked: string[];
  onSave: (selected: string[]) => void | Promise<void>;
}

let currentInitial: RefSelectorInitial | null = null;
let showSelector: (() => void) | undefined;

export function triggerRefSelector(initial: RefSelectorInitial): void {
  currentInitial = initial;
  showSelector?.();
}

function RefSelectorModal() {
  const [isOpen, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [all, setAll] = useState<readonly { path: string; name: string }[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    showSelector = () => {
      if (!currentInitial) return;
      setAll(currentInitial.all);
      setChecked(new Set(currentInitial.checked));
      setError(undefined);
      setOpen(true);
    };
    return () => { showSelector = undefined; };
  }, []);

  const close = () => { setOpen(false); setBusy(false); setError(undefined); };

  const toggle = (path: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const handleSave = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!currentInitial) throw new Error('状态未初始化。');
      await currentInitial.onSave([...checked]);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败。');
      setBusy(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={close}
      title="选择参考"
      closeLabel="关闭"
      description="勾选需要在当前 Tab Bar 显示和使用的参考。"
      footer={
        <>
          <Button variant="outline" className="sift-card-modal-action" onClick={close} disabled={busy}>取消</Button>
          <Button variant="primary" className="sift-card-modal-action" onClick={handleSave} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {all.map(item => (
          <label key={item.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer', borderRadius: 6, userSelect: 'none' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--dsw-alias-bg-raised, #f4f5f6)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <input
              type="checkbox"
              checked={checked.has(item.path)}
              disabled={busy}
              onChange={() => toggle(item.path)}
              style={{ accentColor: 'var(--dsw-alias-brand-primary, #4c8dff)', margin: 0, flex: 'none' }}
            />
            <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary, #111827)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {item.name}
            </span>
          </label>
        ))}
        {error && <p style={{ margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12 }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function mountRefSelector(): () => void {
  const container = document.createElement('div');
  container.dataset.siftRefSelector = '';
  const root = createRoot(container);
  root.render(<RefSelectorModal />);
  return () => {
    root.unmount();
    container.remove();
    showSelector = undefined;
    currentInitial = null;
  };
}
