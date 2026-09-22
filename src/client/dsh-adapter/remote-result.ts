/** 同时兼容 DSH Remote 的标准结果包装与旧版直接返回值。 */
export function unwrapRemoteResult<T extends object>(
  result: T | { ok: true; value: T } | { ok: false; error: Error },
): T {
  if (!('ok' in result)) return result;
  if (result.ok) return result.value;
  throw result.error;
}
