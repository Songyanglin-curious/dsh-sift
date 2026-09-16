import {
  SIFT_REFERENCE_SOURCE,
  type CandidateRequest,
  type ClientSessionContext,
  type InputTriggerCandidate,
  type InputTriggerSource,
} from '../dsh-adapter/input-trigger.js';
import { referenceClipboardText, referencePromptText, type SiftReferenceRecord } from './codec.js';

/**
 * 把一个「参考记录读取器」包装成 DSH 的 `@` 触发源。
 *
 * Phase 0 只验证通道：调用方传入硬编码的 R1/R2/R3。
 * Phase 5 接入真正的 Reference Board 后，调用方换成当前 Document 的 Reference Store，
 * 本文件不需要改动。
 */

/** 候选分组标题。自定义 source 名无法注册 locale 词条，所以用 section 提供可见标题。 */
const SECTION = '当前参考';

function candidateOf(record: SiftReferenceRecord): InputTriggerCandidate {
  const detail = [record.sourceTitle, record.locator].filter(value => value !== undefined && value !== '').join(' · ');
  return {
    name: record.label,
    ...(detail === '' ? {} : { description: detail }),
    icon: 'file',
    section: SECTION,
    value: record.id,
  };
}

function matches(record: SiftReferenceRecord, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return [record.label, record.sourceTitle ?? '', record.locator ?? '', record.content]
    .some(value => value.toLowerCase().includes(needle));
}

export function createSiftReferenceSource(readRecords: () => readonly SiftReferenceRecord[]): InputTriggerSource {
  const find = (ref: string) => readRecords().find(record => record.id === ref);
  return {
    trigger: '@',
    name: SIFT_REFERENCE_SOURCE,
    order: 100,
    showGroupTitle: false,
    async candidates(_session: ClientSessionContext, request: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
      if (request.signal.aborted) return [];
      return readRecords().filter(record => matches(record, request.query)).map(candidateOf);
    },
    onPick(pick) {
      const record = pick.candidate.value === undefined ? undefined : find(pick.candidate.value);
      if (!record) return undefined;
      return {
        insert: {
          source: SIFT_REFERENCE_SOURCE,
          ref: record.id,
          label: record.label,
          clipboardText: referenceClipboardText(record),
        },
      };
    },
    codec: {
      clipboardText: ref => {
        const record = find(ref);
        return record ? referenceClipboardText(record) : `@参考:${ref}`;
      },
      // 找不到记录必须抛错：契约规定失败会阻断发送，绝不静默降级。
      serialize: async (ref, signal) => {
        if (signal.aborted) throw new Error('Sift 参考序列化已取消。');
        const record = find(ref);
        if (!record) throw new Error(`找不到参考：${ref}`);
        return referencePromptText(record);
      },
    },
  };
}
