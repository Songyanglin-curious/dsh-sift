/**
 * 剪贴板读取器 —— 公开接口。
 *
 * 只依赖 win32.ts（Koffi FFI），不感知任何 Sift 业务类型。
 * 调用方只需 import { readClipboard } 即可拿到当前剪贴板快照。
 */

import {
  openClipboardWithRetry,
  closeClipboard,
  readUnicodeText,
  readHDropFiles,
  readHtml,
  readUrl,
} from './win32.js';
import type { ClipboardSnapshot } from './win32.js';
export type { ClipboardSnapshot } from './win32.js';

/**
 * 一次性读取当前 Windows 剪贴板快照。
 *
 * 返回所有可用格式的数据；某种格式不存在时，对应字段不出现在结果中。
 * 打开剪贴板失败时抛出可读错误。
 */
export function readClipboard(): ClipboardSnapshot {
  if (!openClipboardWithRetry()) {
    throw new Error('无法打开剪贴板。请确认没有其他程序正在占用。');
  }

  try {
    const result: ClipboardSnapshot = {};

    const text = readUnicodeText();
    if (text !== undefined) result.text = text;

    const files = readHDropFiles();
    if (files !== undefined) result.files = files;

    const html = readHtml();
    if (html !== undefined && (html.fragment !== undefined || html.sourceUrl !== undefined)) {
      result.html = html;
    }

    const url = readUrl();
    if (url !== undefined) result.url = url;

    return result;
  } finally {
    closeClipboard();
  }
}