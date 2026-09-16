/**
 * Sift 与 DSH 输入触发器（`@` 引用）之间的唯一适配点。
 *
 * 集中在这里的原因：这是一份对 DSH 内部契约的复制，而不是 Sift 自己的模型。
 * DSH 升级后只需重新核对本文件，业务代码（reference/source.ts 等）不受影响。
 *
 * 契约来源：`@deepseek-ai/dsh-client-ui-input-trigger/client` 的公开再导出
 * （该包未安装在本仓库，故此处按 0.1.5-rc.2 逐字复刻所需子集）。
 * 依据见 docs/dsh-reference-api-research.md 第 1、2、3 节，含 path:line 引用。
 */

/** 注册入口：`ctx.inputTriggers` 服务面。 */
export interface InputTriggerServiceContract {
  /** 注册一个触发源；同一 trigger 下 name 重复会抛错。返回注销函数。 */
  registerSource(source: InputTriggerSource): () => void;
}

/** chip 的模型序列化契约；产生 insert 的 source 必须提供。 */
export interface ReferenceCodec {
  /** 复制/持久化投影，例如 `@参考:标题`。 */
  clipboardText(ref: string): string;
  /** 送给模型的正文；抛错会阻断整次发送，不会退回 clipboardText。 */
  serialize(ref: string, signal: AbortSignal): Promise<string>;
}

/** 插入到输入框的 chip 数据。 */
export interface ReferenceInsert {
  /** 必须是产生它的 source 的 name，也是提交时的序列化路由键。 */
  readonly source: string;
  /** source 自己的不透明 id，原样回传给 `codec.serialize`。 */
  readonly ref: string;
  readonly label: string;
  /** 闭集；省略时 chip 渲染触发标记。 */
  readonly appearance?: 'session' | 'file' | 'folder';
  readonly clipboardText: string;
}

/** `@` 菜单的一行候选，纯展示数据。 */
export interface InputTriggerCandidate {
  readonly name: string;
  readonly description?: string;
  /** 闭集。 */
  readonly icon?: 'file' | 'folder' | 'session';
  readonly hint?: string;
  /** 相邻候选共享的分组标题；配合 showGroupTitle:false 使用。 */
  readonly section?: string;
  /** source 私有的选择载荷（放引用 id）。 */
  readonly value?: string;
  readonly drill?: boolean;
}

export interface ClientSessionContext {
  readonly sessionId: string;
}

export interface CandidateRequest {
  readonly query: string;
  readonly quoted?: boolean;
  readonly position: 'leading' | 'inline';
  readonly drilled: boolean;
  readonly signal: AbortSignal;
}

export interface TokenSpan {
  readonly start: number;
  readonly end: number;
  readonly draftRev: number;
}

export interface InputTriggerPick {
  readonly candidate: InputTriggerCandidate;
  readonly session: ClientSessionContext;
  readonly position: 'leading' | 'inline';
  readonly via: 'menu' | 'space' | 'enter';
  readonly action: 'pick' | 'drill';
  readonly span: TokenSpan;
}

/**
 * 选择结果。这里只复刻 Sift 会产生的分支：
 * `{ claim }`（命令认领）与 `handled` 对引用源无意义，故省略。
 */
export type PickOutcome =
  | { readonly insert: ReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | 'handled'
  | undefined;

export interface InputTriggerSource {
  readonly trigger: '@';
  /** 同一 trigger 下全局唯一；同时是分组标题与序列化路由键。 */
  readonly name: string;
  readonly order?: number;
  /** 自定义 source 名无法注册 slash.menu 词条，需置 false 并用候选的 section 提供标题。 */
  readonly showGroupTitle?: boolean;
  candidates(session: ClientSessionContext, request: CandidateRequest): Promise<readonly InputTriggerCandidate[]>;
  onPick(pick: InputTriggerPick): PickOutcome;
  /** 产生 insert 结果的 source 必需。 */
  readonly codec?: ReferenceCodec;
}

/** Sift 的 source 名，同时是 chip 的序列化路由键。 */
export const SIFT_REFERENCE_SOURCE = 'sift';

/** 注册所需的 ctx 子集。 */
export interface InputTriggerHost {
  readonly inputTriggers: InputTriggerServiceContract;
  effect?(factory: () => () => void, label?: string): unknown;
}

/**
 * 把 source 注册到 `ctx.inputTriggers`，并交给 `ctx.effect` 托管释放
 * （与内置 ui-reference 的写法一致）。返回手动注销函数，便于测试与提前释放。
 */
export function registerInputTriggerSource(host: InputTriggerHost, source: InputTriggerSource): () => void {
  let dispose: (() => void) | undefined;
  const register = () => {
    dispose ??= host.inputTriggers.registerSource(source);
    return () => { dispose?.(); dispose = undefined; };
  };
  if (host.effect) host.effect(register, `sift: @${source.name} source`);
  else register();
  return () => { dispose?.(); dispose = undefined; };
}
