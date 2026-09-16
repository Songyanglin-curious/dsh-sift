# DSH 0.1.5-rc.2 自定义 `@reference` 类型 —— 已验证 API 调研报告

调研对象：本机已安装的 DSH `0.1.5-rc.2` 发布包（含 `.d.ts` 与编译产物 `lib/client.js` / `lib/index.js`）。

**路径前缀约定**（下文所有 `path:line` 引用都相对此根）：

```
⟦PKG⟧ = D:\ProgramFiles\code\volta\tools\image\packages\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai
```

所有结论均来自实际读到的文件内容；无法证实的部分集中列在最后的 **Unknowns / could not verify**。

---

## 0. 三个必须区分开的"reference"概念（先读这一节，否则后面会混）

DSH 里 "reference" 一词覆盖三层**互不相同**的东西：

| 层 | 名字 | 定义位置 | 与本任务的关系 |
|---|---|---|---|
| A. 编辑器 UI 原子引用（chip） | `ReferenceInsert` / `ReferenceChipNode` | `⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:54` | **本任务真正要插入的东西** |
| B. `@` 触发源契约 | `InputTriggerSource` + `ReferenceCodec` | `⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/types.d.ts:111` | **注册入口**：一个"reference type"就是一个 `trigger: '@'` 的 `InputTriggerSource` |
| C. Host 侧领域引用 | `FileReferenceService`（`ctx.fileReferences`）/ `SessionReferenceResolver`（`ctx.sessionReferenceResolver`） | `⟦PKG⟧/dsh-file-reference/lib/types/index.d.ts:19`、`⟦PKG⟧/dsh-session-reference/lib/types/index.d.ts` | **可选**：只有当候选/序列化内容需要 Host 数据时才用 |

内置的 `dsh-client-ui-reference` 是 B 层的一个**单一** source（`name: "reference"`），它在 `candidates()` 里去调 C 层的两个 Remote 拿数据（`⟦PKG⟧/dsh-client-ui-reference/lib/client.js:109-110`），在 `onPick()` 里把 C 层返回的 `mention` 变成 A 层的 `ReferenceInsert`（同文件 `:129-143`），并给出一个"原样返回"的 codec（同文件 `:145-148`）。

**A 层的 chip 不是按"类型"注册的**：`ReferenceChipNode` 只有 `source / ref / label / appearance / clipboardText / invalid` 六个字段（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/editor/chip-node.d.ts:14-36`），没有"自定义渲染器注册表"。所谓"自定义 reference 类型"实际是"自定义 `InputTriggerSource` + 自己的 `reference` 身份约定"。

---

## 1. 什么是 Reference —— 规范接口（逐字，含 path:line）

### 1.1 `ReferenceInsert`（插入/ chip 契约）

`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:54-61`

```ts
/** Structured reference inserted by an input-trigger source. */
export interface ReferenceInsert {
    readonly source: string;
    readonly ref: string;
    readonly label: string;
    readonly appearance?: 'session' | 'file' | 'folder';
    readonly clipboardText: string;
}
```

- `source` = 注册时 `InputTriggerSource.name`，是**提交时序列化的路由键**（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:285`）。
- `ref` = source 自己的不透明 id，原样回传给 `codec.serialize(ref, signal)`。
- `appearance` 是**闭集**：`'session' | 'file' | 'folder'`，不能自定义；缺省时 chip 渲染 trigger 标记而非图标（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/editor/ReferenceChip.d.ts:6-7`）。
- `clipboardText` 是复制/持久化投影，**不是**送给模型的形式（`:297`）。

### 1.2 `ReferenceCodec`（序列化契约）

`⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/types.d.ts:104-116`

```ts
/**
 * Reference codec owned by a source that produces {@link ReferenceInsert}
 * outcomes: the clipboard projection for copy/cut/persistence, and the model
 * serialization invoked per occurrence by the submit attempt (async, abort
 * rides the attempt signal; failure blocks the send — never a silent
 * downgrade to the clipboard text).
 */
export interface ReferenceCodec {
    /** Clipboard / persistence projection of one reference (e.g. `/name`). */
    clipboardText(ref: string): string;
    /** Model serialization of one reference (e.g. `<skill>name</skill>`). */
    serialize(ref: string, signal: AbortSignal): Promise<string>;
}
```

### 1.3 `InputTriggerSource`（source/provider 契约）

`⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/types.d.ts:117-190` —— 关键成员（逐字摘）

```ts
export interface InputTriggerSource {
    readonly trigger: TriggerChar;                       // '/' | '@'
    readonly name: string;                               // 菜单分组标签；同一 trigger 下唯一，重复注册抛错
    readonly order?: number;                             // 菜单分组顺序，越小越靠前，默认 0
    readonly showGroupTitle?: boolean;                   // 是否渲染 source 标题行；默认 true
    candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]>;
    header?(session: ClientSessionContext, req: HeaderRequest): readonly InputTriggerCrumb[] | undefined;
    onPick(pick: InputTriggerPick): PickOutcome;
    matchSpace?(session: ClientSessionContext, token: string): PickOutcome;
    matchEnter?(session: ClientSessionContext, line: string, signal: AbortSignal, envelope: SubmitEnvelope): Promise<PickOutcome>;
    warm?(session: ClientSessionContext): void;
    lexicon?(session: ClientSessionContext): readonly string[] | undefined;
    subscribeLexicon?(session: ClientSessionContext, listener: () => void): () => void;
    readonly codec?: ReferenceCodec;                     // 产生 insert 结果的 source 必需
}
```

配套类型（同文件）：
- `TriggerChar = '/' | '@'`（`:23`）
- `TriggerPosition = 'leading' | 'inline'`（`:25`）
- `PickVia = 'menu' | 'space' | 'enter'`（`:27`）
- `PickAction = 'pick' | 'drill'`（`:29`）
- `InputTriggerCandidateIcon = 'file' | 'folder' | 'session'`（`:31`）—— **闭集**
- `ClientSessionContext { readonly sessionId: SessionId }`（`:19-21`）
- `CandidateRequest { query; quoted?; position; drilled; signal: AbortSignal }`（`:85-93`）
- `InputTriggerPick { candidate; session; position; via; action; span: TokenSpan }`（`:95-103`）
- `SubmitEnvelope { attachments: number }`（`:80-83`）

### 1.4 `InputTriggerCandidate`（候选行契约）

`⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/types.d.ts:32-48`

```ts
/** One menu candidate. Pure display data — zero behavior declaration. */
export interface InputTriggerCandidate {
    readonly name: string;
    readonly description?: string;
    readonly icon?: InputTriggerCandidateIcon;
    readonly hint?: string;
    /** Optional visual heading shared by adjacent candidates; sectioned groups omit their source-title row. */
    readonly section?: string;
    /** Opaque source-owned pick payload. */
    readonly value?: string;
    readonly drill?: boolean;
}
```

**注意**：计划的 "id/title/content" 在这个契约里没有对应字段名。可用映射：`name` ← title，`description` ← 副标题，`value` ← **opaque payload（放 id）**，正文 content 只能靠 source 自己闭包持有（`value` 是 `string`，可放 JSON）。

### 1.5 `PickOutcome` / `InsertReferenceRequest` / `TokenSpan`

`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:62-70`

```ts
export type PickOutcome = {
    readonly claim: CommandClaim;
} | {
    readonly insert: ReferenceInsert;
} | {
    readonly text: string;
    readonly continue?: boolean;
} | 'handled' | undefined;
```

`:15-20`
```ts
export interface TokenSpan {
    readonly start: number;
    readonly end: number;
    readonly draftRev: number;
}
```

`:80-84`
```ts
/** Scoped request to insert a structured reference. */
export interface InsertReferenceRequest {
    readonly reference: ReferenceInsert;
    readonly span: TokenSpan;
}
```

### 1.6 `InputTarget` / `SessionInput`（公开的 chip 写入面）

`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:165-198`

```ts
export interface InputTarget {
    /** Replace the trigger span with claim.token and enter claimed (span-CAS'd). */
    beginCommand(claim: CommandClaim, span: TokenSpan): boolean;
    /** Replace the trigger span with one reference chip (span-CAS'd). */
    insertReference(ref: ReferenceInsert, span: TokenSpan): boolean;
}
/** Per-session input facade owned by the conversation wiring layer. */
export interface SessionInput extends InputTarget {
    setDraft(text: string): void;
    addAttachments(ids: readonly DraftAttachmentId[]): boolean;
    removeAttachment(id: DraftAttachmentId): boolean;
    pruneAttachments(ids: readonly DraftAttachmentId[]): void;
    submit(mode?: InputSubmitMode): void;
    notify(level: 'info' | 'error', text: string): void;
    readonly state: SnapshotStore<InputState>;
}
/** Session-addressed access to the per-session input facade. */
export interface SessionInputResolver {
    /** Resolve the facade for one session-scope ctx. */
    for(actx: Context): SessionInput;
}
```

### 1.7 `Occurrence` / `InputState`（chip 的运行时观测面）

`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:274-321` —— 逐字要点

```ts
export interface Occurrence {
    readonly occurrenceId: number;
    readonly source: string;          // 序列化路由键
    readonly ref: string;
    readonly offset: number;          // 在 clipboard 投影中的偏移
    readonly length: number;          // clipboard 投影中的长度
    readonly label: string;
    readonly appearance?: ReferenceInsert['appearance'];
    readonly clipboardText: string;
    readonly invalid?: boolean;
}
export interface InputState {
    readonly draft: string;                                 // clipboard 投影（chip 展开为 clipboardText）
    readonly attachmentIds: readonly DraftAttachmentId[];
    readonly draftRev: number;                               // 单调编辑版本号（span CAS 用它比较）
    readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting';
    readonly claim?: { readonly token: string; readonly hint?: string; readonly attachments?: boolean };
    readonly occurrences: readonly Occurrence[];              // 按 offset 排序
    readonly queue: readonly QueuedMessage[];
}
```

### 1.8 `ReferenceChipNode`（chip 节点本体）

`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/editor/chip-node.d.ts:14-36, 56-58, 103-109`

```ts
export type SerializedReferenceChipNode = Spread<{
    source: string;
    ref: string;
    label: string;
    appearance?: ReferenceInsert['appearance'];
    clipboardText: string;
    invalid: boolean;
}, SerializedLexicalNode>;

export declare class ReferenceChipNode extends DecoratorNode<JSX.Element> {
    __source: string; __ref: string; __label: string;
    __appearance: ReferenceInsert['appearance'];
    __clipboardText: string; __invalid: boolean;
    constructor(insert: Omit<ReferenceInsert, 'appearance'> & { appearance?: ReferenceInsert['appearance'] },
                invalid?: boolean, key?: NodeKey);
    getTextContent(): string;   // 返回 clipboardText
    setInvalid(invalid: boolean): void; isInvalid(): boolean;
    getSource(): string; getReference(): string; getLabel(): string;
    getAppearance(): ReferenceInsert['appearance'];
}
export declare function $createReferenceChipNode(insert: ReferenceInsert): ReferenceChipNode;
export declare function $isReferenceChipNode(node: LexicalNode | null | undefined): node is ReferenceChipNode;
```

### 1.9 Host 侧（C 层）契约

`⟦PKG⟧/dsh-file-reference/lib/types/types.d.ts:6-12`
```ts
export interface FileReferenceCandidate {
    path: string;
    kind: 'file' | 'directory';
}
```

`⟦PKG⟧/dsh-file-reference/lib/types/index.d.ts:12-31`
```ts
export declare const FILE_REFERENCE_PROMPT = "Tokens prefixed with @ are workspace paths the user explicitly referenced, relative to the workspace root. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces.";
declare module '@deepseek-ai/cordis' {
    interface Context { fileReferences: FileReferenceService; }
}
/** Host capability for cancellable file-reference discovery. */
export declare abstract class FileReferenceService extends Service {
    constructor(ctx: Context);
    abstract list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>;
}
```

`⟦PKG⟧/dsh-session-reference/lib/types/types.d.ts:44-64`（`SessionReferenceCandidate` / `SessionReferenceMentionCandidate`，含 `mention: string` 即 `@[label](dsh-session:…)`）。

---

## 2. 插件必须注入的 client service

**答案：`ctx.inputTriggers`。**

**接口（逐字）** —— `⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/client/contract.d.ts:10-24`

```ts
/** The `ctx.inputTriggers` service face. */
export interface InputTriggerServiceContract {
    /**
     * Register one trigger source; duplicate trigger/name pairs throw.
     * @param src - source that discovers and resolves slash or reference candidates.
     * @returns effect disposer removing this source.
     */
    registerSource(src: InputTriggerSource): () => void;
    /**
     * Resolve the lazy controller owned by one session scope.
     * @param actx - session-scoped Client context.
     * @returns controller that dies with that scope.
     */
    sessionOf(actx: ClientContext): InputTriggerController;
}
```

**实现类** —— `⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:770-842`
- `var InputTriggerService = class extends Service`（`:770`）
- `super(ctx, "inputTriggers")`（`:780`）→ **服务键就是 `inputTriggers`**
- `static inject = ["sessions"]`（`:771`）
- `registerSource(src)`（`:792-807`）：重复 `(trigger, name)` 抛 `slash source "@<name>" is already registered`（`:794`）；返回 disposer，disposer 会把该 source 从 live 名单移除并通知每个 session controller（`:801-806`）。

**注册 + 释放的规范写法**（两种，均已在发布代码中验证）：

1. `ctx.effect` 包裹（推荐）—— `⟦PKG⟧/dsh-client-ui-reference/lib/client.js:150-151`
   ```js
   const inputTriggers = ctx.get("inputTriggers");
   ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
   ```
   `⟦PKG⟧/dsh-client-ui-skill/lib/client.js:316-322` 是等价变体（`ctx.effect(() => { const unregister = inputTriggers.registerSource(source); return () => { unregister(); clearAll(); }; }, "ui-skill: source")`）——说明 `ctx.effect` 的回调可以返回一个清理函数。

2. `⟦PKG⟧/dsh-client-ui-cordis/lib/client.js:1445`：`ctx.effect(() => slash.registerSource(source), "ui-cordis: @pluginId source")`。

**因此：是的，注册就是一个 `ctx.effect` disposer。**

**注入声明**：在 client 半的 `inject` 数组里写 **服务名**，不是包名：`dsh-client-ui-reference` 的 `inject` 实际值为
`["inputTriggers", "locale", "sessions", "remote", "remote.fileReferences", "remote.sessionReferenceResolver"]`
（`⟦PKG⟧/dsh-client-ui-reference/lib/client.js:85-92`，同一数组也在 `lib/types/client/index.d.ts:3` 导出）。
最小自定义类型只需要 `"inputTriggers"`。

---

## 3. 序列化：谁调、何时调、返回值去哪

**签名**：`ReferenceCodec.serialize(ref: string, signal: AbortSignal): Promise<string>`
（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/types.d.ts:115`）

**路由**（三层，全部可验证）：

1. `InputTriggerController.serializeReference(source, ref, signal)`
   `⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/client/contract/input.d.ts:121-122` 定义；实现在 `⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:531-535`：
   ```js
   serializeReference(source, ref, signal) {
     const owner = this.deps.roster.all().find((s) => s.name === source);
     if (owner?.codec === void 0) return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`));
     return owner.codec.serialize(ref, signal);
   }
   ```
   → 按 **`InputTriggerSource.name`** 查 source；**没有 codec 就 reject**（不会退回 clipboardText）。

2. 调用点：`SessionInputShell.sinkSerialized(attempt, draft, mode)`，注释逐字为 "Prompt serialization before the sink"：
   `⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:13145-13192`，核心在 `:13165-13186`
   ```js
   if (occurrences.length === 0) { this.settleSink(attempt, this.deps.defaultSink(draft.trim(), ...)); return; }
   const inputTriggers = this.deps.inputTriggers?.();
   Promise.all(occurrences.map(async (o) => {
     if (inputTriggers === void 0) throw new Error(`no serializer for reference source "${o.source}"`);
     return { offset: o.offset, length: o.length,
              text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal) };
   })).then((parts) => {
     let out = ""; let cursor = 0;
     for (const part of parts) { out += draft.slice(cursor, part.offset) + part.text; cursor = part.offset + part.length; }
     out += draft.slice(cursor);
     this.settleSink(attempt, this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal));
   }, (error) => { /* settleDetachedFailure → 还原草稿快照 */ });
   ```

3. 终端用途：`defaultSink` → `ConversationController.sink()` → `conversation().sendSession(session, text, attachmentIds, mode, signal)`
   `⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:13430`、`:13502-13504`。`sendSession` 的签名见 `⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/service.d.ts:111`（"serialized prompt text"）。

**结论（精确）**：
- **调用时机**：提交（Enter / 发送按钮）后的 **detached default-sink 路径**，即在草稿被乐观提交之前，对当前编辑器里的**每一个 chip occurrence 各调一次**，按 occurrence 顺序并行（`Promise.all`，顺序无关因为按 offset 拼接）；`signal` 是本次 submit attempt 的 `AbortSignal`（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:330-337`）。
- **返回值的用途**：**替换该 occurrence 在 clipboard 投影中的 `[offset, offset+length)` 区间**，拼接成完整 prompt 文本，`trim()` 后作为**一条 user message 的文本**发给 Host。**不是 attachment，不是 tool result，也不是额外的 context message。**
- **失败语义**：抛错 → `settleDetachedFailure` → 发送失败 + 还原草稿（`:13187-13191`、`:13213-13219`）。契约注释明确："failure blocks the send — never a silent downgrade to the clipboard text"（`types.d.ts:107-109`）。
- **不会在 command 路径调用**：draft 若被 `matchSpace`/`matchEnter` 认领成 `/command`，走 `beginSubmit`（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:395-404` 的 `begin-submit` effect），chip 序列化不参与。

**唯一内置范例**（整个安装树里只有这一个 `codec`）：
`⟦PKG⟧/dsh-client-ui-reference/lib/client.js:145-148`
```js
codec: { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve(ref) }
```
即 file/session 的"模型形式"就是 mention 文本本身。

---

## 4. `@` 如何发现候选

**契约是 `InputTriggerSource.candidates(session, req)`，没有单独的 "provider" 注册表。**

- `⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/types.d.ts:136`
  `candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]>`
- `CandidateRequest`（`:85-93`）：`{ query, quoted?, position: 'leading'|'inline', drilled: boolean, signal: AbortSignal }`
- **返回值**：`readonly InputTriggerCandidate[]`，即 1.4 的菜单行（display-only + opaque `value`）。

**驱动逻辑** —— `⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:662-691`（`fetchCandidates`）：
- 每次 hit 新建 `AbortController`，旧的被 `abort()`（`:663-665`）；`source.candidates(projection, { query, quoted, position, drilled, signal })`（`:668-673`）；
- 命中/失败按 `generation` 归并，旧代结果直接丢弃（`:674-690`）；**source 抛错只静默移除该分组并 console.error**，不弹错（`:682-690`，另见 `:47` 的 `MenuEvent source-failed` 注释）。

**触发检测（`@` 何时算触发）** —— `⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:79-115` + `:20-35`：
- `@` 只在「草稿开头 / 空白之后 / 非词字符之后」才开启 token（`boundaryOk`，`:52-62`）；`user@host` 这类 token 内部的 `@` **不触发**（`activeAtToken` 正则 `(?:^|\s)(@([^\s]*))$`，`:28`）。
- `@"..."` 引号形式支持，`TriggerHit.quoted`（`:22-27`）。
- `guard.tier === 'frozen'` 时完全不检测（`:80`）；`claimed` 只屏蔽 `/`（`:100`）。
- 菜单在**所有 ready 分组都为空**时自动关闭（`client.js:181, 219`）。

**分组呈现**：
- 分组标题行 = `t(group.source)`，`t` 绑定在 locale 命名空间 **`slash.menu`**（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:1095, 1120`，渲染在 `:971-975`）；查不到 key 时回落到 common 命名空间，再回落到 key 本身（`⟦PKG⟧/dsh-client-locale/lib/client.js:1292-1297`）。
- 因此内置 source 名 `command`/`skill`/`subagent` 有翻译（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:1069-1091`），**自定义 source 名会原样显示为分组标题**，且不能再往 `slash.menu` 里填 key（同 ns+locale 二次注册会抛错，`⟦PKG⟧/dsh-client-locale/lib/client.js:1264`）。
- 规避方式（内置 `reference` source 就是这么做的）：`showGroupTitle: false` + 每个候选带 `section`（`⟦PKG⟧/dsh-client-ui-reference/lib/client.js:107, 215, 233`；`MenuView` 一旦发现任何 item 有 `section` 就不渲染 source 标题，`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:971`）。

**其它可选发现/交互钩子**（都在 1.3 已列）：
- `header()` → `InputTriggerCrumb[]`，渲染成分组上方面包屑（`types.d.ts:137-148`）；
- `warm()` / `lexicon()` / `subscribeLexicon()` → 纯文本引用装饰 + 预取（`types.d.ts:164-187`）；
- `matchSpace()` / `matchEnter()` → 空格/回车认领，按注册顺序轮询，取第一个非 `undefined` 结果（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:507-520, 547-555`）。

---

## 5. 能否用公开 API 以编程方式插入 chip（不经 `@` 菜单）？

**能。有三条已验证的公开通道，加一条"纯文本"降级通道。** 不需要 DOM 级别的 hack。

### 5.1 首选：`SessionInput.insertReference(ref, span)`

- 是**公开接口** `InputTarget`/`SessionInput` 的成员（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:169`、`:172`）。
- 取法：`ctx.conversation.input.for(actx)`，`actx` 来自 `ctx.sessions.scope(sessionId)`。
  - `ctx.conversation: IConversation`，其 `readonly input: SessionInputResolver`（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/index.d.ts:28-35`、`lib/types/client/service.d.ts:25-27`）。
  - `ISessions.scope(id): AgentContext | undefined`（`⟦PKG⟧/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:104`）。
- **已发布的真实调用样板**（`QueueDock` 用同一路径调 `notify`）—— `⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:14374-14386`：
  ```js
  inject: (sessionId) => {
    const actx = ctx.sessions.scope(sessionId);
    if (actx === void 0) throw new Error(`queue dock: session "${sessionId}" resolved no scope`);
    const conversation = actx.get("conversation");
    if (conversation === void 0) throw new Error("queue dock: conversation service unavailable");
    return {
      updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
      notify: (level, text) => { conversation.input.for(actx).notify(level, text); },   // ← 同一 facade
      loadImage: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment)
    };
  }
  ```
- 实现体（span CAS + 替换为 chip + 补一个空格）—— `⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:12976-12986`：
  ```js
  insertReference(ref, span) {
    const phase = this.core.state.phase;
    if (phase !== "plain" && phase !== "claimed") return false;
    if (span.draftRev !== this.rev) return false;
    const tail = this.projection.detectText.slice(span.end, span.end + 1);
    let applied = false;
    this.applyEdit(() => { applied = $replaceDetectSpanWithNodes(span,
      tail === " " ? [$createReferenceChipNode(ref)] : [$createReferenceChipNode(ref), Go(" ")]); });
    return applied;
  }
  ```
  返回 `false` 表示被 phase 或 `draftRev` CAS 拒绝。

### 5.2 备选：session 作用域的 cordis 事件 `slash/input-insert-reference`（bail 模式）

- 事件声明（含 `@mode bail`）—— `⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:138-143`：
  ```ts
  'slash/input-insert-reference'(request: InsertReferenceRequest): true | undefined;
  ```
- 监听方就是 shell —— `⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:13449`：
  `actx.on("slash/input-insert-reference", (req) => shell.insertReference(req.reference, req.span) ? true : void 0)`（在 `actx.effect` 内注册，`:13446-13460`）。
- 触发源自身就是这么派发的 —— `⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:611-628`：
  `return actx.bail(actx, "slash/input-insert-reference", { reference: outcome.insert, span }) === true;`
- 即：在 session 作用域 `actx` 上 `actx.bail(actx, 'slash/input-insert-reference', { reference, span })`。

### 5.3 备选：以编程方式打开你那个 source 的菜单

`InputTriggerController.toggleSource(source, hit)` —— `⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:127-128` 声明，实现 `⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:374-395`（注释："Toggle a menu containing exactly one registered source. The supplied hit is a synthetic selection span rather than a typed trigger token"）。取 controller：`ctx.inputTriggers.sessionOf(actx)`（`lib/types/client/contract.d.ts:23`）。之后用户点选候选会走**普通 pick 路径**（onPick → insert），span 也用这个合成 hit 的 span。

### 5.4 零 span 数学的降级：`inputActions.setDraft(text)`

- `InputActions`（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:210-221`）是**公开 slot 标准 prop**（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:241-255` 的 `SessionStandardProps.inputActions`；并在 `lib/client.js:16593-16608` 通过 `ctx.uiSession.provide({ props: ["inputActions"] })` 下发）。
- `setDraft` 会**清空并重建整个草稿为纯文本**（`⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:12758-12774`）。
- **但它不产生 chip**：文本里的 `@path` / `@[label](dsh-session:…)` 只是普通字符，`occurrences` 仍为空，提交时不会走 codec（`:13165`）。对 `dsh-client-ui-reference` 这类 `serialize(ref) === clipboardText` 的 source 而言，模型收到的文本**恰好相同**，所以是一条可行的最小实现路径——代价是没有 chip 视觉、没有 occurrence 语义。

### 5.5 关键限制（不臆测）

- **span 必须用 detect 坐标 + `draftRev`**：detect 投影里 **每个 chip 只算 1 个 `U+FFFC`**（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/editor/projection.d.ts:2-7, 13`；walk 产物 `detectLength` 见 `lib/client.js:12391-12399`），而 `InputState.draft` 是 clipboard 投影（chip 展开成 `clipboardText`）。两者换算函数 `detectOffsetOfClipboardOffset` 存在（`lib/client.js:12410-12419`）但**没有从公开 client 入口导出**（`lib/types/client/index.d.ts` 的导出清单里没有 `input/editor/*`）。
- 追加到末尾的 detect 长度可由 `InputState` 推导：`detectEnd = draft.length − Σ(o.length) + o.occurrences.length`（依据 `Occurrence.length === segment.clipboardLength`，`⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:12454-12464`；chip 在 detect 里恒为 1 字符，`projection.d.ts:13`）。**这条推导未经端到端验证，见 Unknowns。**
- 公开的 `SessionInput` **没有** `caretSpan()`：`caretSpan()` 只存在于包内类 `SessionInputShell`（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:176-185`），不在 `SessionInput` 接口里（对比 `contract/input.d.ts:172-198`）。
- `insertReference` 只在 `phase ∈ {plain, claimed}` 生效（`:12977-12978`），且必须 `span.draftRev === 当前 rev`，否则静默返回 `false`。
- **结论：不需要 DOM 级别的 workaround。** 面板按钮可以用 5.1/5.2/5.3；最省事的正确做法是用 5.3（打开自己 source 的菜单）+ 让既有 pick 路径完成 chip 插入。

**composer 组件持有的数据（供参考）**：
- `SessionInputShell` 持有 `editor: LexicalEditor`（文本+chip 真相）、`state: SnapshotStore<InputState>`、`projection`（三套文本视图）、`actions: InputActions`、`occurrenceIds`（NodeKey→occurrenceId）（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:57-80`）。draft 文本与 chip 都在 Lexical 编辑器里，**不在 React state**，所以绕过这些 facade 直接改 DOM 只会让编辑器状态失配。

---

## 6. 注册在 CLIENT 侧还是 HOST 侧？

**注册本身（`registerSource`）纯粹在 CLIENT（浏览器）侧。** 依据：

- `InputTriggerSource` / `ReferenceCodec` / `ReferenceInsert` 全部定义在 client 子路径：`⟦PKG⟧/dsh-client-ui-input-trigger/package.json` 的 `exports["./client"]`；`⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/index.d.ts:1-8` 明确写 **"Slash trigger plugin, node half. Pure UI plugin: the empty apply exists so the plugin appears in the host cordis.yml / Loader; the browser half ships via exports["./client"]"**。
- `dsh-client-ui-reference` 的 node 半边就是**空函数**：`⟦PKG⟧/dsh-client-ui-reference/lib/index.js:8-9` `function apply() {}`；类型注释同义（`lib/types/index.d.ts:1-8`）。
- 该插件的 `package.json` 有 `"dsh": { "client": { "platform": "web", "inject": [...] } }` 与 `exports["./client"]`（`⟦PKG⟧/dsh-client-ui-reference/package.json`）。
- 运行时挂载点是 Host 侧 cordis 行（`dsh.client` 行即浏览器 roster）——`⟦PKG⟧/dsh-web-app/cordis.patch.yml` 中 `- id: ui-reference  name: '@deepseek-ai/dsh-client-ui-reference'`，同处还有 `- id: reference  name: '@deepseek-ai/dsh-session-reference'` / `- id: file-reference-local  name: '@deepseek-ai/dsh-file-reference-local'` / `- id: session-controller  name: '@deepseek-ai/dsh-api-session-controller'`。

**Host 侧对应包（仅当候选/序列化内容需要 Host 数据时才需要）**：

| 关注点 | 包 | 机制 |
|---|---|---|
| 抽象发现 seam | `dsh-file-reference` | 普通 cordis `Service`，键名 `fileReferences`，**无 typert**：`⟦PKG⟧/dsh-file-reference/lib/index.js`（`super(ctx, "fileReferences")`） |
| 本地实现 | `dsh-file-reference-local` | `LocalFileReferenceService extends FileReferenceService`（`lib/types/index.d.ts:27-31`） |
| 浏览器可见的 Remote | `dsh-api-session-controller` | `SessionFileReferences extends TypertRemoteService`，Remote id `'@deepseek-ai/dsh-api-session-controller#fileReferences/list'`，service `'sessionFileReferences'`，namespace `'fileReferences'`（`lib/types/file-references.d.ts:5, 13-25`；描述符生成处 `lib/typert.host.js:696-698`） |
| session 引用发现 + 上下文准备 | `dsh-session-reference` | `SessionReferenceResolver extends TypertRemoteService` + `@Remote("candidates")`（`⟦PKG⟧/dsh-session-reference/lib/index.js`：`super(ctx, "sessionReferenceResolver")`、`_remoteExportCandidates_decorators = [Remote("candidates")]`） |

### `dsh-typert-protocol` 在 `dsh-file-reference` 里的使用 —— 明确结论

**`dsh-file-reference` 完全不用 typert。** 该包只有 `lib/index.js` + `lib/types/{index,grammar,types}.{js,d.ts}`（无任何 `typert.*` 文件），依赖里也只有 `dsh-agent` + `cordis`（`⟦PKG⟧/dsh-file-reference/package.json` 的 `peerDependencies` / `devDependencies`）。

typert 出现在**两个别的地方**：
1. `dsh-api-session-controller` 为 file-reference seam 单独声明了 Remote 适配器（见上表）；
2. `dsh-session-reference` 自己的 resolver 直接继承 `TypertRemoteService` 并用 `@Remote(...)` 装饰（`⟦PKG⟧/dsh-typert-protocol/lib/types/index.d.ts:60-82`：`abstract class TypertRemoteService<out T = never> extends Service<T>`、`function Remote(...)`）。

**因此：一个"纯客户端"的 reference 类型不需要任何 host 侧 typert 声明。** 只有当候选列表或序列化所需内容必须由 Host 提供时，才需要 `TypertRemoteService` + `@Remote(...)`，或在 Host 侧写一个新的 `Service` 并由某个 `dsh-api-*` 包声明 Remote 命名空间（如 file-reference 的做法）。

---

## 7. 最小可运行插件骨架（每个来源都已验证；不确定处标 `// UNVERIFIED:`）

### 7.1 `package.json`

```jsonc
{
  "name": "@my/dsh-client-ui-myref",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":              { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client":       { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",                                  // 必填；非 "web" 会被扫描直接跳过
      "inject": [                                         // 包名列表：这些包的 client bundle 必须先注册
        "@deepseek-ai/dsh-client-ui-input-trigger",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
}
```

依据：`⟦PKG⟧/dsh-client-modules/lib/index.js:140-154`（`dsh.client.platform` 必须是 string；`inject`/`external` 必须是 string 数组）、`:650-655`（`platform !== "web"` → 不算客户端包；声明了 `dsh.client` 但没有 `exports["./client"]` → 抛错）、`lib/client.js:88-102` 与 `:252-269`（`inject` 语义 = "Register each injected package … before its consumer"）。对照 `⟦PKG⟧/dsh-client-ui-reference/package.json`。

### 7.2 Host 半边 `lib/index.js`（空实现，只为让插件出现在 Loader 里）

```js
// 依据 ⟦PKG⟧/dsh-client-ui-reference/lib/index.js:1-11 —— 纯 UI 插件的 host 半边
export function apply() {}
```

### 7.3 Client 半边 `lib/client.js`（浏览器模块表格式 + 注册一个 `@` source）

```js
// 依据 ⟦PKG⟧/dsh-client-ui-reference/lib/client.js:1-3（__ModuleLoader__ 形状）与 :97-152（apply 形状）
window.__ModuleLoader__.load({
  id: "@my/dsh-client-ui-myref",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const SOURCE_NAME = "myref";                       // 必须全局唯一（同 trigger 下）
    // inject 里写【服务名】，不是包名。依据 ⟦PKG⟧/dsh-client-ui-reference/lib/client.js:85-92
    const inject = ["inputTriggers"];

    /** 插件自己的数据源；纯客户端，所以可以直接闭包持有。 */
    const RECORDS = [
      { id: "widget", title: "Widget 设计稿", subtitle: "materials/widget.md",
        content: "……发送给模型的正文……" },
    ];

    const clipboardOf = (ref) => `@myref:${ref}`;

    function apply(ctx) {
      // ctx.get 而不是解构：与内置写法一致（⟦PKG⟧/dsh-client-ui-reference/lib/client.js:150）
      const inputTriggers = ctx.get("inputTriggers");

      const source = {
        trigger: "@",                                  // TriggerChar，types.d.ts:23
        name: SOURCE_NAME,
        order: 100,                                     // 越小越靠前，types.d.ts:133
        showGroupTitle: false,                          // 见 Q4：分组标题只能来自 slash.menu，会显示成裸 source 名
        async candidates(session, { query, signal }) {  // types.d.ts:136
          const q = query.toLowerCase();
          const rows = RECORDS.filter((r) => r.title.toLowerCase().includes(q));
          if (signal.aborted) return [];                 // 必须尊重 signal（⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:674）
          return rows.map((r) => ({
            name: r.title,                               // types.d.ts:34
            description: r.subtitle,                     // types.d.ts:35
            icon: "file",                                // 闭集 'file'|'folder'|'session'（types.d.ts:31）
            section: "我的引用",                          // types.d.ts:39；配合 showGroupTitle:false 提供可见标题
            value: r.id,                                 // opaque payload（types.d.ts:41）
          }));
        },
        onPick({ candidate }) {                          // types.d.ts:150
          const rec = RECORDS.find((r) => r.id === candidate.value);
          if (rec === undefined) return undefined;       // PickOutcome 允许 undefined（input.d.ts:70）
          return { insert: {                             // input.d.ts:54-61 / :65-66
            source: SOURCE_NAME,                         // 必须是本 source 的 name —— 序列化路由键
            ref: rec.id,
            label: rec.title,
            // appearance 省略 → chip 渲染 trigger 标记（ReferenceChip.d.ts:6-7）；只能取 'session'|'file'|'folder'
            clipboardText: clipboardOf(rec.id),          // 复制/持久化投影
          } };
        },
        codec: {                                         // types.d.ts:111-116；产生 insert 的 source 必需
          clipboardText: (ref) => clipboardOf(ref),
          serialize: async (ref, signal) => {            // 送模型的形式；失败必须抛（会阻断发送）
            if (signal.aborted) throw new Error("myref: aborted");
            const rec = RECORDS.find((r) => r.id === ref);
            if (rec === undefined) throw new Error(`myref: unknown reference ${ref}`);
            return `<my-ref id="${rec.id}" title="${rec.title}">\n${rec.content}\n</my-ref>`;
          },
        },
      };

      // 注册 + 释放：registerSource 返回 disposer，交给 ctx.effect 托管
      // 依据 ⟦PKG⟧/dsh-client-ui-reference/lib/client.js:150-151
      ctx.effect(() => inputTriggers.registerSource(source), "myref: @ source");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

跑起来需要的挂载动作（Host 侧 cordis 行，参照 `⟦PKG⟧/dsh-web-app/cordis.patch.yml` 的 `ui-reference` 行）：

```yaml
- insert:
    - id: ui-myref
      name: '@my/dsh-client-ui-myref'
```

### 7.4 面板按钮插入 chip（Q5 的落地写法）

```js
// 在同一个 client bundle 内；依据 ⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:14374-14386 与 :549-554 的 slot inject 工厂模式
const inject = ["slots", "sessions", "inputTriggers"];   // "slots" 服务由 dsh-client-ui-renderer 注册（renderer/lib/client.js:995）

function apply(ctx) {
  /* ……7.3 的 source 注册…… */

  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",     // slot key，slots.d.ts:187-191
    id: "myref",                          // list 类型必填单元格 key
    order: 100,
  }, function MyRefDock(props) {
    // props.sessionId: SessionId、props.input: InputState（owner props: InputZone，slots.d.ts:283-286）
    // standard props 还含 inputActions / useInput（slots.d.ts:241-248）
    const actx = ctx.sessions.scope(props.sessionId);   // sessions.d.ts:104
    const input = actx.get("conversation").input.for(actx);  // service.d.ts:27 + input.d.ts:202

    const insert = (rec) => {
      const st = input.state.getSnapshot();             // InputState（input.d.ts:303-321）
      // detect 投影里每个 chip 只占 1 个 U+FFFC（projection.d.ts:13），
      // Occurrence.length 是 clipboard 长度（⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:12454-12464）
      const detectEnd = st.draft.length
        - st.occurrences.reduce((n, o) => n + o.length, 0)
        + st.occurrences.length;
      // UNVERIFIED: 该 detect 长度推导无发布代码先例；caretSpan() 只在包内类上（facade.d.ts:176-185），公开接口没有
      input.insertReference(
        { source: SOURCE_NAME, ref: rec.id, label: rec.title, clipboardText: clipboardOf(rec.id) },
        { start: detectEnd, end: detectEnd, draftRev: st.draftRev },
      );
    };

    return React.createElement("button", { type: "button", onClick: () => insert(RECORDS[0]) },
      "发送到对话");
  }));
}
```

（`React` 需通过 `require("react")` 取得——`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:10` 的 bundle 就是这么拿的。）

要点：**先注册 source，再插入 chip**。若 chip 的 `source` 在提交时找不到对应 source 或该 source 没有 `codec`，`serializeReference` 会 reject（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:533`；`⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:13171`），整次发送失败并还原草稿。

---

## 8. 版本相关坑（0.1.5-rc.2 实测）

### 8.1 `exports` 映射 / 深层导入

- `dsh-client-ui-reference`（以及 `ui-input-trigger`、`ui-conversation`、`ui-chat`、`ui-skill`）的 `exports` **只有** `"."`、`"./client"`、`"./src/*"`、`"./package.json"`。
  → **`dsh-client-ui-reference/lib/client.js` 这类深层导入被 `exports` 拒绝**；合法写法是 `@deepseek-ai/dsh-client-ui-reference`（node 半边）或 `@deepseek-ai/dsh-client-ui-reference/client`（类型在 `lib/types/client/index.d.ts`）。
- 更糟的是发布 tarball 的 `files` 只含 `lib/index.js`、`lib/client.js`、`lib/types/**/*.d.ts`（`⟦PKG⟧/dsh-client-ui-reference/package.json` 的 `files`），**`src/` 根本没被发布** —— 所以 `"./src/*"` 这个 subpath 在已安装产物里是死路径。
- **类型要走的入口是 `.../client`，不是包根**：`ui-input-trigger` 的 `exports` 只有 `"."`/`"./client"`/`"./src/*"`；包根 `index.d.ts` 是 **host 空半边**，只声明 `apply(): void`（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/types/index.d.ts:7-8`）。而 `lib/types/client/index.d.ts:9` **已经把全部所需类型从 `../types.ts` 再导出**：
  ```ts
  export type { ArbitrateKey, ArbitrateOutcome, BeginCommandRequest, CandidateRequest, ClientSessionContext, CommandClaim, ConsumeTokenRequest, HeaderRequest, InsertReferenceRequest, PickOutcome, PickVia, ReferenceCodec, ReferenceInsert, InputTriggerCandidate, InputTriggerCrumb, InputTriggerPick, InputTriggerSource, SubmitAttachment, SubmitEnvelope, SubmitOutcome, TokenSpan, TriggerChar, TriggerGuard, TriggerPosition, } from '../types.ts';
  ```
  并且同一文件 `:12-17` 做了 Context 增强：`inputTriggers: import('./contract.ts').InputTriggerServiceContract`。
  → **实践含义：正确类型入口是 `@deepseek-ai/dsh-client-ui-input-trigger/client`（`import type { InputTriggerSource, ReferenceCodec, ReferenceInsert, InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client'`），这条可用。** 包根本身（`.../ui-input-trigger`）只给 host 空 `apply`，不要从那里取类型。
- `dsh-client-ui-input-trigger/client` 另外把 `'slash.menu'` 声明进 `LocaleNamespaceMap`（`:18-23`），说明 locale 命名空间是可增强的（`⟦PKG⟧/dsh-client-ui-slots` 的 `LocaleNamespaceMap`）；但菜单分组标题固定走 `slash.menu` 的 `<sourceName>` key，这个 key 仍无法由第三方填（见 8.5 与 Q4）。
- `ReferenceChipNode` / `$createReferenceChipNode` / `$composerLayout` / `detectOffsetOfClipboardOffset` 这些编辑器级符号**没有**被 `dsh-client-ui-conversation/client` 再导出（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/index.d.ts:1-27` 的清单里没有 `input/editor/*`），只能从包内 `lib/types/client/input/editor/*.d.ts` 读到（该路径不在 `exports` 白名单内）。
- `dsh-client-ui-reference/client` 的公开面极窄：`⟦PKG⟧/dsh-client-ui-reference/lib/types/client/index.d.ts:3-8` 只有 `inject: string[]` 与 `apply(ctx)`；README 也说明 "the `/client` export is the plugin body (`apply`/`inject`) only"（`⟦PKG⟧/dsh-client-ui-reference/README.md:48`）。
- `dsh-file-reference` 的 `exports` 多一个 `"./types"`（`⟦PKG⟧/dsh-file-reference/package.json`），所以 `FileReferenceCandidate` 需要从 `@deepseek-ai/dsh-file-reference/types` 引入（`⟦PKG⟧/dsh-api-session-controller/lib/types/file-references.d.ts:4` 就是这么写的）。

### 8.2 私有 / 内部符号（不可跨插件使用）

- `SessionInputShell` 明确标注 "Package-private; the hub alone constructs it"（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:8-9`），**未从 `lib/types/client/index.d.ts` 导出**（`:26` 只导出 `InputActions`/`InputState`/`SessionInput`/`SessionInputResolver` 等类型）。
- `caretSpan()`、`beginCommand` 之类的实现细节：`caretSpan` 只在 `SessionInputShell` 类上（`facade.d.ts:176-185`），不在公开 `SessionInput` 接口。
- `$composerLayout` / `$projectComposer` / `detectOffsetOfClipboardOffset` / `$createReferenceChipNode` / `$isReferenceChipNode` 都定义在包内（`projection.d.ts`、`chip-node.d.ts`）但**不在 `client/index.d.ts` 的导出清单中**（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/index.d.ts:1-27`）。
- `ReferenceChipNode.setInvalid()` 在**整个已安装树里没有任何调用点**（全树 `setInvalid` 只有声明 + 定义两处）→ chip 目前永远不会进入 `invalid` 态；owner 解析失败只会在提交时以 codec 缺失/抛错的形式暴露。
- `ComposerKeyboard` 的注释明确："Handed to the composer-bar entry through its own inject — package-internal, never across a plugin boundary"（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:228-236`）。

### 8.3 依赖包在安装树里缺失

`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-web` **在本机 `⟦PKG⟧` 下并不存在**（只有各 client bundle 的 `require(...)` 引用），它们被编进 Web shell：`dsh-web-frontend/dist/assets/index-BKQ_L1z6.js` 里能搜到 `dsh-client-ui-slots`。
→ 后果：本机**没有** `PropsRuntime` / `SlotMap` / `InputActions` 的 `.d.ts` 可解析（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:8` 从 `@deepseek-ai/dsh-client-ui-slots` 引），但它们在**运行时**由模块表提供。写类型时要么自备声明，要么不写类型。

### 8.4 是否必须把包加进 `dsh.client.inject`

- **同时存在两个不同的 `inject`，别混**：
  1. **`package.json` → `dsh.client.inject`**：**包名**数组，只影响**浏览器模块表的到达/注册顺序**（`⟦PKG⟧/dsh-client-modules/lib/index.js:145, 660-661`；`lib/client.js:252-269`）。只有当你的 bundle 会 `require()` 那个包的模块时才需要。仅通过 `ctx.get("inputTriggers")` 拿服务时**不强制**，但照抄内置写法（列出提供方包）最稳。
  2. **client 半导出的 `inject`**：**cordis 服务名**数组（`⟦PKG⟧/dsh-client-ui-reference/lib/types/client/index.d.ts:3`），这是**实际决定 `apply` 何时被调用的闸门**。用 `inputTriggers` 就必须在**这里**声明。
- `UiConversation` 的 slot/服务面也依赖同类声明（`⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:16666-16674` 的 `inject` 含 `"slots"`,`"sessions"`,`"locale"` 等）。
- `⟦PKG⟧/dsh-client-ui-workspace/lib/client.js:2706` 有一句重要注脚：**"dsh.client.inject edges are informational"**（针对它自己声明的某条边）——说明这些边不构成强制的加载语义保证，别把它们当运行时依赖声明用。

### 8.5 其它行为坑

- **重复注册会抛**：同 `(trigger, name)` 二次 `registerSource` → `Error`（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:794`）。
- **source 失败静默**：`candidates()` reject → 该分组无声消失，只 `console.error`（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:682-690`）。
- **`drilled` 共享**：`drilled` 是 controller 级别的状态，不是 per-source；非 drill pick 会清零（`⟦PKG⟧/dsh-client-ui-input-trigger/lib/client.js:718-719`）。
- **`lexicon` 必须同步**：`lexicon`/`subscribeLexicon` 的调用方要求"render path must stay synchronous and side-effect free"（`types.d.ts:170-177`）。
- **chip 的 `clipboardText` 会被持久化**：`InputState.draft` 就是 clipboard 投影，草稿镜像也写它（`⟦PKG⟧/dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:78-79`、`lib/client.js:12759`）；`REFERENCE_PLACEHOLDER_RE` 会剥掉进入编辑器的 `U+FFFC` 与 `U+E100–U+E11D`（`lib/client.js:12610`），所以别在 `clipboardText` 里用这些码位。
- **发送后 chip 被整体清掉并切断 undo**：`commit-draft` effect（`⟦PKG⟧/dsh-client-ui-conversation/lib/client.js:13115-13143`）。
- **只有 `@` 会被 shell 解析成 "reference"**：host 侧真正消费引用的是 `dsh-session-reference` 的 `agent/pre-step` 监听器，它按**正则匹配消息正文里的 mention 文本**（`⟦PKG⟧/dsh-session-reference/lib/index.js` 的 `parseSessionReferenceText`），与 chip 无关 —— 也就是说**自定义 source 的 chip 序列化结果如果要在 Host 侧被特殊处理，必须自己写 Host 侧监听器**；否则它就只是普通 prompt 文本。
- **`dsh-client-ui-chat` 不注册任何 reference source**：它只在转写渲染里消费引用（`referenceLabels`、`session-reference` recall 节点），例如 `⟦PKG⟧/dsh-client-ui-chat/lib/client.js:1233, 1279-1281, 4211-4213, 4240-4241, 5152-5182`。所以自定义 chip 在发送前不会出现在 chat 里，发送后也只以序列化文本形式进入历史。

---

## Unknowns / could not verify

1. **detect 坐标推导未经运行验证**：`detectEnd = draft.length − Σ(occurrence.length) + occurrenceCount` 是从 `projection.d.ts:2-7,13` 与 `lib/client.js:12454-12464` 推出的，可解释性上自洽，但**没有任何已发布插件这样用**，也没有跑起来验证。若走 5.1/5.2 路线，建议改用 5.3（`toggleSource` + 普通 pick 路径）以完全避免 span 数学。
2. **`toggleSource` 未在发布代码中被调用**：实现存在（`lib/client.js:374-395`）、类型在 contract 中（`input.d.ts:127-128`），但全树没有调用点，实际行为（尤其是合成 hit 的 `span` 校验）未端到端跑过。
3. **`ctx.conversation` 在 session 作用域的解析**：`actx.get("conversation")` 的写法有 QueueDock 先例（`lib/client.js:14377`），但那是包内（ui-conversation 自己的子插件）。第三方插件跨包名调用（`ctx.get("conversation")` / `input.for(actx)`）未见先例，未验证。
4. **`@deepseek-ai/dsh-client-ui-slots` / `-primitives` / `-store` 的公开类型契约**：包不在本机安装树里，`PropsRuntime`、`SlotMap`、`InjectFace`、`ReferenceIconKind`、`InputActions` 的真实形状只能从使用点的 `.d.ts` 反推，未读到定义文件。
5. **`ReferenceIcon` 支持的 kind 全集**：`ReferenceIconKind` 定义在未安装的 `dsh-client-ui-primitives` 中；本版本 `InputTriggerCandidateIcon`（`types.d.ts:31`）与 `ReferenceInsert['appearance']`（`input.d.ts:59`）都只列 `'file'|'folder'|'session'`，无法确认 primitives 是否还有更多 kind。
6. **`dsh-client-ui-input-trigger` 的 README 与产物不一致**：README 说 "`InputTriggerCandidate.icon` renders as text — `MenuView` drops the string into the icon slot verbatim"（`⟦PKG⟧/dsh-client-ui-input-trigger/README.md:77`），但产物里是 `ReferenceIcon kind={item.icon}`（`lib/client.js:1016-1019`）。以产物为准；README 该条已过时。
7. **插件 bundle 的构建链**：内置包用 `tsdown`（`"bundle": "tsdown"`，见各 `package.json` 的 `scripts`）产出 `window.__ModuleLoader__.load({id, factory})` 形状。我核对了产物形状（`lib/client.js:1-3`）与加载器契约（`⟦PKG⟧/dsh-client-modules/lib/client.js:16-31, 272-293`），但**没有 tsdown 配置文件可读**（未随包发布），因此"用 tsdown 复现该产物"的配置未验证。7.3 的手写形状是与产物一致的替代方案。
8. **`ui-conversation` 的 `immediately` 语义**：`dsh.client.immediately` 字段被解析（`dsh-client-modules/lib/index.js:147`）并进 boot manifest（`lib/client.js:101`），但"immediately"对插件挂载时机的确切影响未在本次调研中追根。
9. **Host 侧自定义引用内容的注入方式**：若计划要"发送后模型额外拿到结构化 context"（像 `dsh-session-reference` 那样追加一条 `additionalContext` user message），需要自己写 Host 侧 `agent/pre-step` 监听器（参考 `⟦PKG⟧/dsh-session-reference/lib/index.js` 的 `prepareDirectMessages`），这条路径本报告未细化验证。
10. **`dsh-client-ui-reference` 未出现在 `@deepseek-ai/dsh` 顶层依赖里**，但通过 `dsh-web-app` 的 dependencies 引入（`⟦PKG⟧/dsh-web-app/package.json`）。若目标是"不改 DSH 发行包、只加自己的插件"，挂载途径（profile 的 `cordis.patch.yml` / `--patch`）本次未调研。
