import { materialFormat, normalizeMaterialUrl, type Material } from '../materials.js';
import { createMarkdownSurface } from './markdown-surface.js';

export async function previewMaterial(root: HTMLElement, material: Material, data: Uint8Array, signal: AbortSignal): Promise<() => void> {
  const format = materialFormat(material);
  if (format === 'md') {
    root.dataset.siftEditor = '';
    const editor = await createMarkdownSurface(root, new TextDecoder().decode(data), { readonly: true });
    return () => { void editor.destroy().catch(error => console.error('Markdown preview cleanup failed', error)); };
  }
  if (format === 'pdf') return previewPdf(root, data, signal);
  if (format === 'docx') {
    const { renderAsync } = await import('docx-preview');
    if (signal.aborted) return () => {};
    // Isolate document styles and links from the application. No scripts run here.
    const frame = document.createElement('iframe');
    frame.title = material.name;
    frame.dataset.format = 'docx';
    frame.setAttribute('sandbox', 'allow-same-origin');
    root.append(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error('无法初始化 DOCX 预览。');
    await renderAsync(data, doc.body, doc.head, { ignoreWidth: true, ignoreHeight: true, useBase64URL: true, renderAltChunks: false });
    const style = doc.createElement('style');
    style.textContent = 'body{margin:0}.docx-wrapper{padding:12px;background:#f3f4f6}.docx-wrapper>section.docx{max-width:100%;box-sizing:border-box;margin-bottom:12px}';
    doc.head.append(style);
    return () => frame.remove();
  }
  if (format === 'url') {
    const url = normalizeMaterialUrl(material.target);
    const help = document.createElement('p');
    help.textContent = '若网页禁止内嵌或需要登录，可在新标签页打开。';
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开原网页 ↗';
    const frame = document.createElement('iframe');
    frame.title = material.name; frame.src = url; frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    root.append(link, help, frame);
    return () => { frame.src = 'about:blank'; frame.remove(); };
  }
  root.textContent = format === 'doc' ? '暂不支持 .doc，请转换为 .docx 或 PDF 后添加。' : '暂不支持此文件类型。';
  return () => {};
}

async function previewPdf(root: HTMLElement, data: Uint8Array, signal: AbortSignal): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { default: workerSource } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw');
  if (signal.aborted) return () => {};
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  let port: Worker;
  try { port = new Worker(workerUrl, { type: 'module' }); }
  catch (error) { URL.revokeObjectURL(workerUrl); throw error; }
  const worker = pdfjs.PDFWorker.create({ port });
  const loading = pdfjs.getDocument({ data, worker, useSystemFonts: true });
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cleanup);
    // Let PDF.js finish its Terminate handshake before terminating the owned port.
    void loading.destroy().catch(error => console.error('PDF preview cleanup failed', error)).finally(() => {
      worker.destroy(); port.terminate(); URL.revokeObjectURL(workerUrl);
    });
  };
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    const pdf = await loading.promise;
    if (signal.aborted) { cleanup(); return cleanup; }
    const toolbar = document.createElement('nav');
    const previous = document.createElement('button'); previous.textContent = '上一页'; previous.type = 'button';
    const next = document.createElement('button'); next.textContent = '下一页'; next.type = 'button';
    const label = document.createElement('span'); label.setAttribute('aria-live', 'polite');
    toolbar.append(previous, label, next);
    const canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img');
    root.append(toolbar, canvas);
    let number = 1;
    const draw = async () => {
      previous.disabled = next.disabled = true;
      try {
        const page = await pdf.getPage(number);
        if (closed) return;
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.max(240, root.clientWidth - 24) / natural.width });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = '100%'; canvas.style.height = 'auto';
        await page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise;
        label.textContent = `${number} / ${pdf.numPages}`;
        canvas.setAttribute('aria-label', `PDF 第 ${number} 页，共 ${pdf.numPages} 页`);
      } catch (error) { if (!closed) label.textContent = `预览失败：${String(error)}`; }
      finally { previous.disabled = number <= 1; next.disabled = number >= pdf.numPages; }
    };
    previous.addEventListener('click', () => { number--; void draw(); });
    next.addEventListener('click', () => { number++; void draw(); });
    await draw();
    return cleanup;
  } catch (error) { cleanup(); throw error; }
}
