import { describe, expect, it } from 'vitest';
import { emptySourceIndex, fileNameOf, isAbsolutePath, normalizeSourceUrl, sourceIndexSchema } from '../src/sources.js';

describe('网页地址规范化', () => {
  it('接受 http/https 并补全为规范形式', () => {
    expect(normalizeSourceUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeSourceUrl('  https://example.com/a b  ')).toBe('https://example.com/a%20b');
    expect(normalizeSourceUrl('http://example.com/x?q=1#h')).toBe('http://example.com/x?q=1#h');
  });

  it('拒绝非 http/https、带账号密码和空串', () => {
    expect(() => normalizeSourceUrl('ftp://example.com')).toThrow('HTTP 或 HTTPS');
    expect(() => normalizeSourceUrl('file:///c:/x')).toThrow('HTTP 或 HTTPS');
    expect(() => normalizeSourceUrl('https://u:p@example.com')).toThrow('HTTP 或 HTTPS');
    expect(() => normalizeSourceUrl('')).toThrow();
  });
});

describe('路径工具', () => {
  it('从 Windows 与 POSIX 路径里取文件名', () => {
    expect(fileNameOf('D:\\Downloads\\61850.pdf')).toBe('61850.pdf');
    expect(fileNameOf('docs/fiber.md')).toBe('fiber.md');
    expect(fileNameOf('docs/')).toBe('docs');
    expect(fileNameOf('plain.md')).toBe('plain.md');
  });

  it('识别绝对路径', () => {
    expect(isAbsolutePath('D:\\Downloads')).toBe(true);
    expect(isAbsolutePath('C:/temp')).toBe(true);
    expect(isAbsolutePath('/usr/local')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('docs/fiber.md')).toBe(false);
    expect(isAbsolutePath('./rel')).toBe(false);
  });
});

describe('登记表模型', () => {
  it('空登记表带 schemaVersion', () => {
    expect(emptySourceIndex()).toEqual({ schemaVersion: 1, items: [] });
  });

  it('拒绝未知 schemaVersion 与缺少字段的记录', () => {
    expect(sourceIndexSchema.safeParse({ schemaVersion: 2, items: [] }).success).toBe(false);
    expect(sourceIndexSchema.safeParse({ schemaVersion: 1, items: [{ id: 'a' }] }).success).toBe(false);
    expect(sourceIndexSchema.safeParse({ schemaVersion: 1, items: [{ id: 'a', type: 'url', title: 't', target: 'https://x/', createdAt: 'now' }] }).success).toBe(true);
  });
});
