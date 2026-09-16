/**
 * 「当前该不该显示 Sift 界面」的唯一判定处。
 *
 * 这里只处理 DSH 暴露的只读状态（工作区列表、会话列表）与 Sift 自己的
 * `.sift/config.json` 结果，不碰 DOM。DOM 侧见 selectors.ts / layout.ts。
 */

export interface WorkspaceView {
  readonly workspaceId: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
}

export interface WorkspaceSnapshot {
  readonly items: readonly WorkspaceView[];
  readonly phase: 'pending' | 'ready';
}

export interface SessionSnapshot {
  readonly current?: string;
  readonly phase?: 'pending' | 'ready';
  readonly sessions?: readonly { readonly id: string }[];
}

export type WorkspaceProfile = 'default' | 'sift';

export interface ProfileResult {
  readonly workspaceId: string;
  readonly title: string;
  readonly profile: WorkspaceProfile;
  readonly status: 'ready' | 'missing' | 'invalid';
  readonly message?: string;
}

/**
 * DSH 没有独立的「当前工作区」读取源，只能由当前会话反查所属工作区。
 * 列表未就绪时返回 undefined，调用方必须当作「还不知道」而不是「是 default」。
 */
export function resolveCurrentWorkspace(
  workspaces: WorkspaceSnapshot | undefined,
  sessions: SessionSnapshot | undefined,
): WorkspaceView | undefined {
  if (!workspaces || workspaces.phase !== 'ready') return undefined;
  if (!sessions || sessions.phase === 'pending') return undefined;
  const currentId = sessions.current;
  if (currentId === undefined) return undefined;
  return workspaces.items.find(item => item.sessionIds.includes(currentId));
}

/** 只有配置合法且为 sift 时才启用 Sift 界面；缺失或损坏都回落到原生体验。 */
export function shouldEnableSift(profile: ProfileResult | undefined): boolean {
  return profile?.profile === 'sift' && profile.status === 'ready';
}

/**
 * 异步读取的世代守卫：切换工作区时，先发出的请求返回得更晚也不能覆盖新结果。
 * 返回 undefined 表示这次结果已过期，调用方应丢弃。
 */
export function createLatestProfileReader(reader: (workspaceId: string) => Promise<ProfileResult>) {
  let generation = 0;
  return async (workspaceId: string): Promise<ProfileResult | undefined> => {
    const request = ++generation;
    const result = await reader(workspaceId);
    return request === generation ? result : undefined;
  };
}

/** 按工作区保存的布局偏好键。 */
export function layoutStorageKey(workspaceId: string): string {
  return `dsh-sift:layout:${workspaceId}`;
}
