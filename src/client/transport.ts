import type { SiftRequest } from '../contracts/remote.js';

export type RemoteResult = { ok: true; value: unknown } | { ok: false; error: { message?: string } };

export interface SiftRemote {
  dispatch(request: SiftRequest): Promise<RemoteResult>;
}

export async function dispatch<T>(remote: SiftRemote, request: SiftRequest): Promise<T> {
  const response = await remote.dispatch(request);
  if (!response.ok) throw new Error(response.error.message ?? 'Sift 请求失败。');
  return response.value as T;
}
