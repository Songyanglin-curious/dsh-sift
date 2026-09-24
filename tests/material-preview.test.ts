// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { previewMaterial } from '../src/client/material-preview.js';

async function waitForElement(root: ParentNode, selector: string, timeoutMs = 1000): Promise<Element> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = root.querySelector(selector);
    if (element) return element;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等待渲染超时：${selector}`);
}

describe('real material renderers', () => {
  it('renders a real DOCX with docx-preview inside a script-disabled frame', async () => {
    const require = createRequire(import.meta.url);
    const JSZip = createRequire(require.resolve('docx-preview'))('jszip');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX 中文素材预览</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>');
    const data = await zip.generateAsync({ type: 'uint8array' });
    const root = document.createElement('div'); document.body.append(root);
    const dispose = await previewMaterial(root, { id: 'docx', kind: 'file', name: 'sample.docx', target: 'sample.docx' }, data, new AbortController().signal);
    expect(root.querySelector('iframe')?.contentDocument?.body.textContent).toContain('DOCX 中文素材预览');
    expect(root.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-scripts');
    dispose(); root.remove();
  });
  it('renders Markdown using DSH MarkdownText, read-only', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const dispose = await previewMaterial(root, { id: 'md', kind: 'file', name: 'note.md', target: 'note.md' }, new TextEncoder().encode('# 素材标题\n\n正文内容'), new AbortController().signal);
    await waitForElement(root, '[data-dsh-markdown-text] h1');
    expect(root.querySelector('h1')?.textContent).toBe('素材标题');
    expect(root.querySelector('[data-dsh-markdown-text]')).not.toBeNull();
    expect(root.querySelector('[contenteditable]')).toBeNull();
    dispose(); root.remove();
  });
  it('renders the project README with the complete DSH MarkdownText contract', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const readme = await readFile('README.md');
    const dispose = await previewMaterial(root, { id: 'readme', kind: 'file', name: 'README.md', target: 'README.md' }, readme, new AbortController().signal);
    await waitForElement(root, '[data-dsh-markdown-text] h1');
    expect(root.querySelector('[data-dsh-markdown-text]')).not.toBeNull();
    expect(root.querySelector('[data-code-copy-label]')?.getAttribute('data-code-copy-label')).toBe('复制代码');
    expect(root.querySelector('h1')?.textContent).toBe('Sift');
    dispose(); root.remove();
  });
  it('renders URLs in a sandbox with an original-page link and explains unsupported DOC', async () => {
    const root = document.createElement('div');
    const dispose = await previewMaterial(root, { id: 'url', kind: 'url', name: 'Example', target: 'https://example.com/' }, new Uint8Array(), new AbortController().signal);
    expect(root.querySelector('iframe')?.src).toBe('https://example.com/');
    expect(root.querySelector('a')?.href).toBe('https://example.com/');
    expect(root.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    dispose(); root.replaceChildren();
    await previewMaterial(root, { id: 'doc', kind: 'file', name: 'old.doc', target: 'old.doc' }, new Uint8Array(), new AbortController().signal);
    expect(root.textContent).toContain('暂不支持 .doc');
  });
});
