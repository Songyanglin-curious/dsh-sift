/**
 * 编辑卡片内容与来源信息的弹窗。
 *
 * - 编辑器复用 createMarkdownSurface（Milkdown Crepe）；
 * - 弹窗外壳、按钮、输入框全部使用 DSH primitives（Modal / Button / Input），
 *   不自己造 UI；仅用一张很小的样式表覆盖 Modal 默认宽度（默认仅 380px）并约束编辑器高度。
 */

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Input, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives';
import { createMarkdownSurface } from '../markdown-surface.js';
import { injectStyle, SIFT_PLUGIN_ID } from './inject-style.js';
import cardEditCss from './card-edit.css?inline';
import type { ReferenceCardSource } from '../../references.js';

type SourceKind = 'none' | 'web' | 'file';

interface CardEditInitial {
  content: string;
  source?: ReferenceCardSource;
}

let currentInitial: CardEditInitial | null = null;
let onSaveCallback: ((content: string, source?: ReferenceCardSource) => Promise<void>) | null = null;
let showEditor: (() => void) | undefined;

/**
 * 本机文件选择（由 panel 注入，走 Host 的原生文件对话框）。
 * 浏览器拿不到本地绝对路径，所以必须由 Host 打开对话框。
 */
let pickFilePath: (() => Promise<{ path?: string; cancelled?: boolean; message?: string }>) | undefined;

export interface CardEditorOptions {
  /** 打开本机文件对话框取绝对路径；未注入时「文件」来源只能手动填写。 */
  readonly pickFilePath?: () => Promise<{ path?: string; cancelled?: boolean; message?: string }>;
}

export function triggerCardEdit(
  data: CardEditInitial,
  onSave: (content: string, source?: ReferenceCardSource) => Promise<void>,
): void {
  currentInitial = data;
  onSaveCallback = onSave;
  showEditor?.();
}

function CardEditModal() {
  const [isOpen, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const editorRef = useRef<Awaited<ReturnType<typeof createMarkdownSurface>> | null>(null);
  const editorRoot = useRef<HTMLDivElement | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>('none');
  const [sourceUri, setSourceUri] = useState('');

  useEffect(() => {
    showEditor = () => {
      if (!currentInitial) return;
      const src = currentInitial.source;
      setSourceKind(src && (src.type === 'web' || src.type === 'file') ? src.type : 'none');
      setSourceUri(src?.uri ?? '');
      setError(undefined);
      setOpen(true);
    };
    return () => { showEditor = undefined; };
  }, []);

  // 弹窗打开时才挂载 Milkdown（Modal 关闭时不渲染 children）
  useEffect(() => {
    if (!isOpen) return;
    const root = editorRoot.current;
    if (!root || !currentInitial) return;

    let cancelled = false;
    void (async () => {
      try {
        const editor = await createMarkdownSurface(root, currentInitial!.content);
        if (cancelled) { await editor.destroy(); return; }
        editorRef.current = editor;
      } catch (err) {
        if (!cancelled) setError(`编辑器加载失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    return () => {
      cancelled = true;
      editorRef.current?.destroy().catch(() => {});
      editorRef.current = null;
    };
  }, [isOpen]);

  const close = () => { setOpen(false); setBusy(false); setError(undefined); };

  /** 「文件」来源：调用 Host 的原生文件对话框，避免手填路径。 */
  const chooseFile = async () => {
    if (!pickFilePath) return;
    setError(undefined);
    try {
      const result = await pickFilePath();
      if (result.path !== undefined) setSourceUri(result.path);
      else if (result.message !== undefined) setError(result.message);
      else if (result.cancelled !== true) setError('未能获取文件路径，请手动填写。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开文件对话框失败。');
    }
  };

  const handleSave = async () => {
    const editor = editorRef.current;
    if (!editor) { setError('编辑器尚未加载完成。'); return; }
    const content = editor.getMarkdown();
    if (content.trim() === '') { setError('内容不能为空。'); return; }

    let source: ReferenceCardSource | undefined;
    if (sourceKind !== 'none') {
      const uri = sourceUri.trim();
      if (uri === '') { setError(sourceKind === 'web' ? '请输入网页地址。' : '请输入文件路径。'); return; }
      source = { type: sourceKind, uri };
    }

    setBusy(true);
    setError(undefined);
    try {
      if (!onSaveCallback) throw new Error('保存回调未设置。');
      await onSaveCallback(content, source);
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
      title="编辑卡片"
      closeLabel="关闭"
      description="修改卡片内容与来源信息。"
      className="sift-card-modal"
      footer={
        <>
          <Button variant="outline" className="sift-card-modal-action" onClick={close} disabled={busy}>取消</Button>
          <Button variant="primary" className="sift-card-modal-action" onClick={handleSave} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div className="sift-card-field-label">内容（Markdown）</div>
          <div ref={editorRoot} className="sift-card-editor" />
        </div>

        <div>
          <div className="sift-card-field-label">来源（可选）</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {(['none', 'web', 'file'] as const).map(kind => (
              <Pill key={kind} active={sourceKind === kind} disabled={busy} onClick={() => { if (!busy) setSourceKind(kind); }}>
                {kind === 'none' ? '无来源' : kind === 'web' ? '网页' : '文件'}
              </Pill>
            ))}
            {sourceKind !== 'none' && (
              <Input
                className="sift-card-uri"
                value={sourceUri}
                disabled={busy}
                aria-label="来源地址"
                placeholder={sourceKind === 'web' ? 'https://…' : 'D:\\path\\to\\file.md'}
                onChange={e => setSourceUri(e.target.value)}
              />
            )}
            {sourceKind === 'file' && pickFilePath && (
              <Button variant="outline" disabled={busy} onClick={() => { void chooseFile(); }}>
                选择文件…
              </Button>
            )}
          </div>
        </div>

        {error && <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12 }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function mountCardEditor(options: CardEditorOptions = {}): () => void {
  const disposeCss = injectStyle(SIFT_PLUGIN_ID, 'card-edit.css', cardEditCss);
  pickFilePath = options.pickFilePath;
  const container = document.createElement('div');
  container.dataset.siftCardEditor = '';
  const root = createRoot(container);
  root.render(<CardEditModal />);
  return () => {
    root.unmount();
    container.remove();
    disposeCss();
    pickFilePath = undefined;
    showEditor = undefined;
    onSaveCallback = null;
    currentInitial = null;
  };
}
