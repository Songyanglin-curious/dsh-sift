import { describe, expect, it } from 'vitest';
import {
  createLatestProfileReader,
  layoutStorageKey,
  resolveCurrentWorkspace,
  shouldEnableSift,
  type ProfileResult,
  type SessionSnapshot,
  type WorkspaceSnapshot,
} from '../src/client/dsh-adapter/workspace-entry.js';

const readyWorkspaces: WorkspaceSnapshot = {
  phase: 'ready',
  items: [
    { workspaceId: 'ws-a', title: 'A', sessionIds: ['session-a'] },
    { workspaceId: 'ws-b', title: 'B', sessionIds: [] },
  ],
};

function profile(overrides: Partial<ProfileResult>): ProfileResult {
  return { workspaceId: 'ws-a', title: 'A', profile: 'sift', status: 'ready', ...overrides };
}

describe('当前工作区推导', () => {
  it('列表未就绪时返回 undefined，而不是当作 default', () => {
    expect(resolveCurrentWorkspace(undefined, { current: 'session-a', phase: 'ready' })).toBeUndefined();
    expect(resolveCurrentWorkspace({ items: [], phase: 'pending' }, { current: 'session-a', phase: 'ready' })).toBeUndefined();
    expect(resolveCurrentWorkspace(readyWorkspaces, undefined)).toBeUndefined();
    expect(resolveCurrentWorkspace(readyWorkspaces, { phase: 'pending' })).toBeUndefined();
  });

  it('没有当前会话或会话不属于任何工作区时返回 undefined', () => {
    expect(resolveCurrentWorkspace(readyWorkspaces, { phase: 'ready' })).toBeUndefined();
    expect(resolveCurrentWorkspace(readyWorkspaces, { current: 'session-unknown', phase: 'ready' })).toBeUndefined();
    expect(resolveCurrentWorkspace(readyWorkspaces, { current: 'session-b', phase: 'ready' })).toBeUndefined();
  });

  it('由当前会话反查所属工作区', () => {
    const snapshot: SessionSnapshot = { current: 'session-a', phase: 'ready' };
    expect(resolveCurrentWorkspace(readyWorkspaces, snapshot)?.workspaceId).toBe('ws-a');
  });
});

describe('Sift 界面启用条件', () => {
  it('只有 profile=sift 且配置有效时启用', () => {
    expect(shouldEnableSift(profile({ profile: 'sift', status: 'ready' }))).toBe(true);
  });

  it('default、配置缺失或损坏都回落到原生界面', () => {
    expect(shouldEnableSift(profile({ profile: 'default', status: 'ready' }))).toBe(false);
    expect(shouldEnableSift(profile({ profile: 'sift', status: 'missing' }))).toBe(false);
    expect(shouldEnableSift(profile({ profile: 'sift', status: 'invalid' }))).toBe(false);
    expect(shouldEnableSift(undefined)).toBe(false);
  });

  it('按工作区生成布局偏好键', () => {
    expect(layoutStorageKey('ws-a')).toBe('dsh-sift:layout:ws-a');
  });
});

describe('世代守卫', () => {
  it('较慢的旧请求返回后会被丢弃', async () => {
    const resolvers = new Map<string, (value: ProfileResult) => void>();
    const reader = (id: string) => new Promise<ProfileResult>(resolvePromise => resolvers.set(id, resolvePromise));
    const latest = createLatestProfileReader(reader);
    const older = latest('ws-a');
    const newer = latest('ws-b');
    resolvers.get('ws-b')!(profile({ workspaceId: 'ws-b', title: 'B' }));
    resolvers.get('ws-a')!(profile({ workspaceId: 'ws-a', title: 'A' }));
    await expect(newer).resolves.toMatchObject({ workspaceId: 'ws-b' });
    await expect(older).resolves.toBeUndefined();
  });
});
