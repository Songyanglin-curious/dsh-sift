import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AnnotationAnchor, BinaryDocument, SourcePreview } from '../domain/model.js';

export interface ReaderSelection {
  quote: string;
  anchor: AnnotationAnchor;
}

interface MarkdownEditorProps {
  value: string;
  version: string;
  readonly: boolean;
  sourceMode: boolean;
  onChange?(value: string): void;
  onSelect?(selection: ReaderSelection): void;
}

function textSelection(container: HTMLElement, content: string): ReaderSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !container.contains(selection.anchorNode)) return null;
  const quote = selection.toString();
  if (!quote.trim()) return null;
  const start = content.indexOf(quote);
  return {
    quote,
    anchor: start < 0 ? null : {
      kind: 'text', start, end: start + quote.length,
      prefix: content.slice(Math.max(0, start - 80), start),
      suffix: content.slice(start + quote.length, start + quote.length + 80),
    },
  };
}

function selectAllText(event: ReactKeyboardEvent<HTMLElement>, content: string, onSelect: (selection: ReaderSelection) => void): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a' || !content.trim()) return false;
  event.preventDefault();
  onSelect({ quote: content, anchor: { kind: 'text', start: 0, end: content.length, prefix: '', suffix: '' } });
  return true;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  if (props.sourceMode) return <CodeMirrorMarkdown {...props} />;
  return <MilkdownMarkdown {...props} />;
}

function MilkdownMarkdown({ value, version, readonly, onChange, onSelect }: MarkdownEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!root.current) return;
    let disposed = false;
    let destroy: (() => Promise<void>) | undefined;
    void import('@milkdown/crepe').then(async module => {
      if (disposed || !root.current) return;
      const { Crepe } = module as unknown as {
        Crepe: new (config: { root: HTMLElement; defaultValue: string }) => {
          setReadonly(value: boolean): void;
          on(callback: (listener: { markdownUpdated(callback: (_ctx: unknown, markdown: string, previous: string) => void): void }) => void): void;
          create(): Promise<void>;
          destroy(): Promise<void>;
        };
      };
      const editor = new Crepe({ root: root.current, defaultValue: value });
      editor.setReadonly(readonly);
      if (!readonly && onChange) editor.on(listener => listener.markdownUpdated((_ctx, markdown, previous) => {
        if (markdown !== previous) onChange(markdown);
      }));
      await editor.create();
      destroy = () => editor.destroy();
    });
    return () => {
      disposed = true;
      if (destroy) void destroy();
    };
  }, [version, readonly]);
  const capture = () => {
    if (!root.current || !onSelect) return;
    const selected = textSelection(root.current, valueRef.current);
    if (selected) onSelect(selected);
  };
  return <div className="sift-milkdown" ref={root} onMouseUp={capture} onKeyUp={capture} />;
}

function CodeMirrorMarkdown({ value, version, readonly, onChange, onSelect }: MarkdownEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    let destroyed = false;
    let destroy: (() => void) | undefined;
    void Promise.all([
      import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/lang-markdown'),
    ]).then(([{ EditorState }, { EditorView, keymap, lineNumbers }, { markdown }]) => {
      if (destroyed || !root.current) return;
      const view = new EditorView({
        parent: root.current,
        state: EditorState.create({
          doc: value,
          extensions: [
            lineNumbers(), markdown(), keymap.of([]), EditorView.lineWrapping,
            EditorView.editable.of(!readonly),
            EditorView.updateListener.of(update => {
              if (update.docChanged) onChange?.(update.state.doc.toString());
              if (update.selectionSet && onSelect) {
                const range = update.state.selection.main;
                if (!range.empty) onSelect({
                  quote: update.state.sliceDoc(range.from, range.to),
                  anchor: {
                    kind: 'text', start: range.from, end: range.to,
                    prefix: update.state.sliceDoc(Math.max(0, range.from - 80), range.from),
                    suffix: update.state.sliceDoc(range.to, Math.min(update.state.doc.length, range.to + 80)),
                  },
                });
              }
            }),
          ],
        }),
      });
      destroy = () => view.destroy();
    });
    return () => { destroyed = true; destroy?.(); };
  }, [version, readonly]);
  return <div className="sift-codemirror" ref={root} />;
}

export function PdfReader({ document, onSelect }: { document: BinaryDocument; onSelect(selection: ReaderSelection): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [pageText, setPageText] = useState('');
  const data = useRef<Uint8Array | null>(null);
  if (data.current === null) data.current = Uint8Array.from(atob(document.contentBase64), character => character.charCodeAt(0));

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { destroy(): Promise<void> } | undefined;
    void Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]).then(async ([pdfjs, worker]) => {
      if (cancelled || !canvas.current || !textLayer.current) return;
      (globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      loadingTask = pdfjs.getDocument({ data: data.current!.slice() });
      const pdf = await (loadingTask as unknown as { promise: Promise<{ numPages: number; getPage(page: number): Promise<any> }> }).promise;
      if (cancelled) return;
      setPages(pdf.numPages);
      const pdfPage = await pdf.getPage(Math.min(page, pdf.numPages));
      const viewport = pdfPage.getViewport({ scale });
      const context = canvas.current!.getContext('2d');
      if (!context) return;
      canvas.current!.width = Math.ceil(viewport.width);
      canvas.current!.height = Math.ceil(viewport.height);
      canvas.current!.style.width = `${viewport.width}px`;
      canvas.current!.style.height = `${viewport.height}px`;
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      textLayer.current!.replaceChildren();
      textLayer.current!.style.width = `${viewport.width}px`;
      textLayer.current!.style.height = `${viewport.height}px`;
      const textContent = await pdfPage.getTextContent();
      setPageText(textContent.items.map((item: { str?: string }) => item.str ?? '').join(' '));
      const layer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayer.current!, viewport });
      await layer.render();
      setError(null);
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; if (loadingTask) void loadingTask.destroy(); };
  }, [document.version, page, scale]);

  const capture = () => {
    if (!textLayer.current) return;
    const selection = window.getSelection();
    const quote = selection?.toString() ?? '';
    if (!selection || selection.isCollapsed || !quote.trim() || !selection.anchorNode || !textLayer.current.contains(selection.anchorNode)) return;
    onSelect({ quote, anchor: { kind: 'pdf', page, start: 0, end: quote.length } });
  };
  return <div className="sift-pdf-reader">
    <div className="sift-reader-toolbar">
      <button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button>
      <span>{page} / {pages}</span>
      <button disabled={page >= pages} onClick={() => setPage(value => value + 1)}>下一页</button>
      <button onClick={() => setScale(value => Math.max(0.6, value - 0.2))}>缩小</button>
      <button onClick={() => setScale(value => Math.min(2.6, value + 0.2))}>放大</button>
    </div>
    {error && <p role="alert">PDF 无法读取：{error}</p>}
    <div className="sift-pdf-page" tabIndex={0} aria-label={`PDF 第 ${page} 页`} onMouseUp={capture} onKeyUp={capture} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && pageText.trim()) {
        event.preventDefault(); onSelect({ quote: pageText, anchor: { kind: 'pdf', page, start: 0, end: pageText.length } });
      }
    }}>
      <canvas ref={canvas} />
      <div className="textLayer" ref={textLayer} />
    </div>
  </div>;
}

export function DocxReader({ document, onSelect }: { document: BinaryDocument; onSelect(selection: ReaderSelection): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!root.current) return;
    root.current.replaceChildren();
    const bytes = Uint8Array.from(atob(document.contentBase64), character => character.charCodeAt(0));
    void import('docx-preview').then(({ renderAsync }) => renderAsync(bytes.buffer, root.current!, undefined, {
      inWrapper: true, breakPages: true, renderHeaders: true, renderFooters: true,
    })).then(() => setError(null)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [document.version]);
  const capture = () => {
    if (!root.current) return;
    const selection = textSelection(root.current, root.current.innerText);
    if (selection) onSelect(selection);
  };
  return <>{error && <p role="alert">DOCX 无法读取：{error}</p>}<div className="sift-docx" ref={root} tabIndex={0} aria-label="Word 文档正文" onMouseUp={capture} onKeyUp={capture} onKeyDown={event => { if (root.current) selectAllText(event, root.current.innerText, onSelect); }} /></>;
}

export function WebReader({ document, onSelect }: { document: SourcePreview; onSelect(selection: ReaderSelection): void }) {
  const [article, setArticle] = useState<{ title: string; content: string; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([import('@mozilla/readability'), import('dompurify')]).then(([{ Readability }, { default: DOMPurify }]) => {
      const parsed = new DOMParser().parseFromString(document.content, 'text/html');
      const result = new Readability(parsed, { charThreshold: 50 }).parse();
      const content = DOMPurify.sanitize(result?.content ?? parsed.body.innerHTML, {
        USE_PROFILES: { html: true }, FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
      });
      if (active) setArticle({ title: result?.title ?? document.title, content, text: result?.textContent ?? parsed.body.textContent ?? '' });
    });
    return () => { active = false; };
  }, [document.version]);
  if (!article) return <p>正在提取网页正文…</p>;
  const capture = (element: HTMLElement) => {
    const selection = textSelection(element, article.text);
    if (selection) onSelect(selection);
  };
  return <article className="sift-web-reader" tabIndex={0} aria-label="网页正文" onMouseUp={event => capture(event.currentTarget)} onKeyUp={event => capture(event.currentTarget)} onKeyDown={event => { selectAllText(event, article.text, onSelect); }}>
    <h1>{article.title}</h1>
    <a href={document.location} target="_blank" rel="noreferrer">打开原网页</a>
    <div dangerouslySetInnerHTML={{ __html: article.content }} />
  </article>;
}
