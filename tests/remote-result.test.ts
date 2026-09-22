import { describe, expect, it } from 'vitest';
import { unwrapRemoteResult } from '../src/client/dsh-adapter/remote-result.js';

describe('DSH Remote result', () => {
  it('解包成功结果并兼容直接返回值', () => {
    const value = { id: 'reference-1' };
    expect(unwrapRemoteResult({ ok: true, value })).toBe(value);
    expect(unwrapRemoteResult(value)).toBe(value);
  });

  it('抛出 Remote 失败分支中的真实错误', () => {
    const error = new Error('模型调用失败');
    expect(() => unwrapRemoteResult({ ok: false, error })).toThrow(error);
  });
});
