import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('parses and renders an actual PDF with the installed PDF.js engine', async () => {
  const require = createRequire(import.meta.url);
  const canvasLibrary = createRequire(require.resolve('pdfjs-dist'))('@napi-rs/canvas');
  Object.assign(globalThis, { DOMMatrix: canvasLibrary.DOMMatrix, ImageData: canvasLibrary.ImageData, Path2D: canvasLibrary.Path2D });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 14 Tf 20 100 Td (Sift PDF preview) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(source.length); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = source.length;
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const loading = pdfjs.getDocument({ data: new TextEncoder().encode(source), useSystemFonts: true });
  try {
    const pdf = await loading.promise;
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    expect((await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join('')).toContain('Sift PDF preview');
    const canvas = canvasLibrary.createCanvas(200, 200);
    await page.render({ canvas, viewport: page.getViewport({ scale: 1 }) }).promise;
    expect(canvas.toBuffer('image/png').length).toBeGreaterThan(1000);
  } finally { await loading.destroy(); }
});
