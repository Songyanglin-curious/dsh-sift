/**
 * Win32 剪贴板 API 的 Koffi FFI 绑定。
 *
 * 只处理 Windows x64，不关心其他平台。
 */

import koffi from 'koffi';
import { Buffer } from 'node:buffer';

// ── DLL 加载 ───────────────────────────────────────────

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

// ── Koffi pointer 类型简写 ──────────────────────────────

const voidPtr = koffi.pointer('void');

// ── 函数声明 ────────────────────────────────────────────

const OpenClipboard = user32.func('OpenClipboard', 'bool', [voidPtr]);       // HWND → pass null
const CloseClipboard = user32.func('CloseClipboard', 'bool', []);
const IsClipboardFormatAvailable = user32.func('IsClipboardFormatAvailable', 'bool', ['uint']);
const GetClipboardData = user32.func('GetClipboardData', voidPtr, ['uint']);
const RegisterClipboardFormatW = user32.func('RegisterClipboardFormatW', 'uint', ['string16']);

const GlobalLock = kernel32.func('GlobalLock', voidPtr, [voidPtr]);
const GlobalUnlock = kernel32.func('GlobalUnlock', 'bool', [voidPtr]);
const GlobalSize = kernel32.func('GlobalSize', 'size_t', [voidPtr]);

// DragQueryFileW: UINT(HDROP hDrop, UINT iFile, LPWSTR lpszFile, UINT cch)
// iFile=0xFFFFFFFF → 返回文件数；lpszFile=null → 返回单个路径长度
const DragQueryFileW = shell32.func('DragQueryFileW', 'uint', [voidPtr, 'uint', voidPtr, 'uint']);

// ── 剪贴板格式常量 ─────────────────────────────────────

const CF_UNICODETEXT = 13;
const CF_HDROP = 15;

/** 注册格式：HTML Format */
const CF_HTML = RegisterClipboardFormatW('HTML Format');

/** 注册格式：UniformResourceLocatorW（Unicode） */
const CF_INETURL_W = RegisterClipboardFormatW('UniformResourceLocatorW');

// ── 返回值类型 ─────────────────────────────────────────

export interface HtmlData {
  fragment?: string;
  sourceUrl?: string;
}

export interface ClipboardSnapshot {
  text?: string;
  files?: string[];
  html?: HtmlData;
  url?: string;
}

// ── 重试常量 ───────────────────────────────────────────

const RETRY_MAX = 5;
const RETRY_DELAY_MS = 10;

// ── 公开函数 ───────────────────────────────────────────

export function openClipboardWithRetry(): boolean {
  for (let i = 0; i < RETRY_MAX; i++) {
    if (OpenClipboard(null)) return true;
    if (i < RETRY_MAX - 1) sleep(RETRY_DELAY_MS);
  }
  return false;
}

export function closeClipboard(): void {
  CloseClipboard();
}

export function isFormatAvailable(format: number): boolean {
  return IsClipboardFormatAvailable(format);
}

/**
 * 读取 CF_UNICODETEXT。
 * 必须在 OpenClipboard / CloseClipboard 之间调用。
 */
export function readUnicodeText(): string | undefined {
  if (!isFormatAvailable(CF_UNICODETEXT)) return undefined;
  const hData = GetClipboardData(CF_UNICODETEXT);
  if (hData == null) return undefined;
  return readWideStringFromHandle(hData);
}

/**
 * 读取 CF_HDROP（资源管理器复制文件列表）。
 * 必须在 OpenClipboard / CloseClipboard 之间调用。
 */
export function readHDropFiles(): string[] | undefined {
  if (!isFormatAvailable(CF_HDROP)) return undefined;
  const hDrop = GetClipboardData(CF_HDROP);
  if (hDrop == null) return undefined;

  // 先获取文件数：iFile = 0xFFFFFFFF, lpszFile = null, cch = 0
  const count = DragQueryFileW(hDrop, 0xFFFF_FFFF, null, 0);
  if (count === 0) return [];

  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    // 获取单个文件路径长度（不含终止符的字符数）
    const charLen = DragQueryFileW(hDrop, i, null, 0);
    if (charLen === 0) continue;

    // 用 Node Buffer 做输出缓冲区
    const buf = Buffer.alloc((charLen + 1) * 2); // UTF-16LE, 2 字节每字符
    const written = DragQueryFileW(hDrop, i, buf, charLen + 1);
    if (written > 0) {
      files.push(buf.toString('utf16le', 0, written * 2));
    }
  }
  return files.length > 0 ? files : undefined;
}

/**
 * 读取 CF_HTML。
 * 必须在 OpenClipboard / CloseClipboard 之间调用。
 */
export function readHtml(): HtmlData | undefined {
  if (!isFormatAvailable(CF_HTML)) return undefined;
  const hData = GetClipboardData(CF_HTML);
  if (hData == null) return undefined;
  const raw = readAnsiStringFromHandle(hData);
  if (raw === undefined || raw.length === 0) return undefined;
  return parseCFHtml(raw);
}

/**
 * 读取 UniformResourceLocatorW（Unicode URL）。
 * 必须在 OpenClipboard / CloseClipboard 之间调用。
 */
export function readUrl(): string | undefined {
  if (!isFormatAvailable(CF_INETURL_W)) return undefined;
  const hData = GetClipboardData(CF_INETURL_W);
  if (hData == null) return undefined;
  return readWideStringFromHandle(hData);
}

// ── 内部辅助：从 HGLOBAL 读取字符串 ─────────────────

/**
 * 从 GlobalLock 的 handle 读取 null-terminated wchar_t 字符串。
 * 内部处理 Lock/Unlock。
 */
function readWideStringFromHandle(hGlobal: unknown): string | undefined {
  const ptr = GlobalLock(hGlobal);
  if (ptr == null) return undefined;
  try {
    return koffi.decode.wstring(ptr);
  } finally {
    GlobalUnlock(ptr);
  }
}

/**
 * 从 GlobalLock 的 handle 读取 null-terminated UTF-8 字符串。
 * CF_HTML 在剪贴板中以 UTF-8 编码存储。
 */
function readAnsiStringFromHandle(hGlobal: unknown): string | undefined {
  const ptr = GlobalLock(hGlobal);
  if (ptr == null) return undefined;
  try {
    const size = Number(GlobalSize(hGlobal));
    if (size <= 0) return undefined;
    // 读字节数组，找到 null 终止位置
    const bytes = new Uint8Array(koffi.view(ptr, size));
    const nullIdx = bytes.indexOf(0);
    const valid = nullIdx === -1 ? bytes : bytes.slice(0, nullIdx);
    return new TextDecoder().decode(valid);
  } finally {
    GlobalUnlock(ptr);
  }
}

// ── CF_HTML 解析 ──────────────────────────────────────

/**
 * CF_HTML 格式解析。
 *
 * Windows CF_HTML 使用字节 offset 标识 fragment 位置：
 *   Version:1.0
 *   StartHTML:0000000105
 *   EndHTML:0000000250
 *   StartFragment:0000000140
 *   EndFragment:0000000210
 *   SourceURL:https://example.com/page
 *
 * 不要按字符数切——offset 是 byte offset。
 */
function parseCFHtml(raw: string): HtmlData {
  const result: HtmlData = {};

  const sourceUrl = extractField(raw, 'SourceURL');
  if (sourceUrl !== undefined) result.sourceUrl = sourceUrl;

  const startFrag = parseInt(extractField(raw, 'StartFragment') ?? '', 10);
  const endFrag = parseInt(extractField(raw, 'EndFragment') ?? '', 10);

  if (!isNaN(startFrag) && !isNaN(endFrag) && startFrag >= 0 && endFrag > startFrag && endFrag <= raw.length) {
    const fragment = raw.slice(startFrag, endFrag).trim();
    if (fragment.length > 0) result.fragment = fragment;
  }

  // Fallback：offset 解析失败时用 <!--StartFragment--> 标记
  if (result.fragment === undefined) {
    const sm = '<!--StartFragment-->';
    const em = '<!--EndFragment-->';
    const s = raw.indexOf(sm);
    const e = raw.indexOf(em);
    if (s !== -1 && e !== -1 && e > s) {
      const f = raw.slice(s + sm.length, e).trim();
      if (f.length > 0) result.fragment = f;
    }
  }

  return result;
}

function extractField(raw: string, field: string): string | undefined {
  const prefix = `${field}:`;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(prefix)) {
      const v = t.slice(prefix.length).trim();
      if (v.length > 0) return v;
    }
  }
  return undefined;
}

function sleep(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { /* busy-wait */ }
}