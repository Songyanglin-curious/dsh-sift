/**
 * ClipboardSnapshot → ReferenceCardData 的映射。
 *
 * 原则（用户约定）：
 * - Reference 以内容为主，来源是可选增强信息；没来源正常建卡，什么都不显示；
 * - 排序即数组顺序，数据模型不携带 order 等管理字段；
 * - files（剪贴板里的文件路径）第一版不读取文件正文，只生成文件名链接卡片。
 *
 * 注意：这里只 import type，运行时零依赖（类型会被编译器擦除），
 * 千万不要改成值导入，否则 koffi 会被打进浏览器 bundle。
 */

import type { ClipboardSnapshot } from '../../host/clipboard/index.js';
import type { ReferenceCardData, ReferenceCardSource } from './card.js';

/** 生成卡片 id：时间戳 + 随机后缀，够防碰撞即可。 */
export function newCardId(): string {
  return `card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 从路径取文件名，兼容 Windows 反斜杠与正斜杠。 */
function fileNameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * 把剪贴板快照转成卡片数据（可能多张：多文件时一文件一卡）。
 *
 * 内容优先级：text > url > html.fragment（text 最干净；fragment 只是罕见兜底）。
 * 来源：html.sourceUrl 优先，其次独立 url 格式；文件路径跟着各自的卡片走。
 * 快照里没有任何可用内容时返回空数组，由调用方提示用户。
 */
export function snapshotToCards(snapshot: ClipboardSnapshot): ReferenceCardData[] {
  // 文件：每个文件一张卡，内容是文件名链接，来源记 file 路径。不读正文。
  if (snapshot.files !== undefined && snapshot.files.length > 0) {
    return snapshot.files.map(path => ({
      id: newCardId(),
      content: `[${fileNameOf(path)}](${path})`,
      source: { type: 'file', uri: path } as ReferenceCardSource,
    }));
  }

  const content = snapshot.text ?? snapshot.url ?? snapshot.html?.fragment;
  if (content === undefined || content.trim() === '') return [];

  const sourceUri = snapshot.html?.sourceUrl ?? snapshot.url;
  return [{
    id: newCardId(),
    content,
    ...(sourceUri === undefined ? {} : { source: { type: 'web', uri: sourceUri } as ReferenceCardSource }),
  }];
}
