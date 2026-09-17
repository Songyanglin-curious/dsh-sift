/**
 * 编辑参考名称与描述的小弹窗。
 *
 * 全部使用 DSH primitives（Modal / Button / Input）；描述是多行文本，
 * primitives 未提供 Textarea，故用原生 <textarea> + 主题变量的样式表。
 *
 * 挂载模式与 workspace-creator 一致：模块级 callback，挂载时写入，点击 ✎ 时触发。
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { injectStyle, SIFT_PLUGIN_ID } from '../renderer/inject-style.js';
import referenceEditCss from './reference-edit.css?inline';

let currentInitial: { name: string; description: string } | null = null;
let onSaveCallback: ((name: string, description: string) => Promise<void>) | null = null;
let showEditor: (() => void) | undefined;

export function triggerEdit(
  name: string,
  description: string,
  onSave: (name: string, description: string) => Promise<void>,
): void {
  currentInitial = { name, description };
  onSaveCallback = onSave;
  showEditor?.();
}

function EditModal() {
  const [isOpen, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    showEditor = () => {
      if (currentInitial) {
        setName(currentInitial.name);
        setDescription(currentInitial.description);
      }
      setError(undefined);
      setOpen(true);
    };
    return () => { showEditor = undefined; };
  }, []);

  const close = () => { setOpen(false); setBusy(false); setError(undefined); };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName === '') { setError('名称不能为空。'); return; }
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
    <Modal
      open={isOpen}
      onClose={close}
      title="编辑参考"
      closeLabel="关闭"
      description="修改当前参考的名称与描述。"
      className="sift-ref-modal"
      footer={
        <>
          <Button variant="outline" className="sift-ref-modal-action" onClick={close} disabled={busy}>取消</Button>
          <Button variant="primary" className="sift-ref-modal-action" onClick={handleSave} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div className="sift-ref-field-label">名称</div>
          <Input
            value={name}
            disabled={busy}
            aria-label="参考名称"
            placeholder="例如：DSH 插件设计资料"
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div>
          <div className="sift-ref-field-label">描述</div>
          <textarea
            className="sift-ref-textarea"
            rows={4}
            value={description}
            disabled={busy}
            aria-label="参考描述"
            placeholder="这份参考是关于什么的（可选）"
            onChange={e => setDescription(e.target.value)}
          />
        </div>
        {error && <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12 }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function mountReferenceEditor(): () => void {
  const disposeCss = injectStyle(SIFT_PLUGIN_ID, 'reference-edit.css', referenceEditCss);
  const container = document.createElement('div');
  container.dataset.siftReferenceEditor = '';
  const root = createRoot(container);
  root.render(<EditModal />);
  return () => {
    root.unmount();
    container.remove();
    disposeCss();
    showEditor = undefined;
    onSaveCallback = null;
    currentInitial = null;
  };
}
