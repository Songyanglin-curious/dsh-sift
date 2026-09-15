// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { previewMaterial } from '../src/client/material-preview.js';

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
  it('renders Markdown using the same Crepe surface as the output editor, read-only', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const root = document.createElement('div'); document.body.append(root);
    const dispose = await previewMaterial(root, { id: 'md', kind: 'file', name: 'note.md', target: 'note.md' }, new TextEncoder().encode('# 素材标题\n\n正文内容'), new AbortController().signal);
    expect(root.querySelector('h1')?.textContent).toBe('素材标题');
    expect(root.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false');
    dispose(); root.remove(); vi.unstubAllGlobals();
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
