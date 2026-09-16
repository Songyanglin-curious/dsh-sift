# DSH 0.1.5-rc.2 插件自有 Agent 工具注册 —— 已验证 API 调研报告

调研对象：本机已安装的 DSH `0.1.5-rc.2` 发布包（含 `lib/types/**/*.d.ts` 与编译产物 `lib/index.js`），以及本仓库 `D:\code\dsh-sift` 现有宿主代码。

**路径前缀约定**（下文所有 `path:line` 引用都相对此根）：

```
⟦PKG⟧ = D:\ProgramFiles\code\volta\tools\image\packages\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai
```

所有结论均来自实际读到的文件内容；无法证实的部分集中列在最后的 **Unknowns / could not verify**。

---

## TL;DR（先读这 6 条，否则后面细节会看错重点）

1. 服务名就是 **`tools`**，`ctx.tools.register(definition)` 是唯一注册入口，`register` 的入参是 **`ToolDefinition`**（`⟦PKG⟧/dsh-tools/lib/index.js:2606`、`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:601`）。
2. 参数**不是** raw JSON Schema 直传，也**不是** zod/schemastery，而是 `dsh-tools` 自带的 **JSON-value schema DSL**（`string|number|integer|boolean|null|array|object|json|oneOf`），由 `defineTool` 编译成 raw JSON Schema（`⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:20-88`、`⟦PKG⟧/dsh-tools/lib/index.js:801-810`）。
3. handler 是 **`async execute(args, exec)`**，`exec` 里**没有 logger**，只有 `agent` / `signal` / `callId` / `deferContext()` / `concludeTurn()`（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:119,284-301`）。**返回值不是给模型看的文本**，而是 `output.schema` 声明的规范 JSON 值；给模型的文本由 `output.render(args, value) => ContentBlock[]` 生成（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:96-104`）。
4. 作用域只有两层：**全局**（普通 `ctx`）与**某个 Agent**（`agent.ctx`）。**没有 workspace 层、没有 per-session 独立层**（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:596-600`、`ctx.tools.schemas(scope?: ScopeKey)` 的 scope 只可能是 Agent，`:676`；详见 §4.6）。
5. `register` 返回**精确 disposer**，且**自动**随所属 Cordis context 卸载（`agent.ctx` → Agent 销毁时自动回收），**不需要**自己再包 `ctx.effect`（`⟦PKG⟧/dsh-tools/lib/index.js:2781`、`⟦PKG⟧/dsh-scope/lib/types/store.d.ts:134-144`）。
6. **本仓库已有一份实现了这件事的代码却从未接线**：`src/host/capabilities.ts`。它里面有两处与 0.1.5-rc.2 真实 API 不符的硬错误（`confine` 不存在、`'TOOL_FS'` 不是合法 section order 名），详见 §9。

---

## 1. 服务名、注册接口、ToolDefinition 的逐字类型

### 1.1 服务名与类型增强

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:24-27
declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: ToolRuntime;
    }
```

服务名来自构造参数，不是类名：

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:2605-2608
constructor(ctx, config = {}) {
    super(ctx, "tools");
    this.defaultMode = config.mode ?? "native";
```

- `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:494` — `export declare class ToolRuntime extends Service {`
- `⟦PKG⟧/dsh-tools/lib/index.js:2567` — `var ToolRuntime = class extends Service {`
- 依赖声明：`⟦PKG⟧/dsh-tools/lib/index.js:2568` — `static inject = ["systemPrompt"];`

### 1.2 `register` 的逐字签名（含 JSDoc）

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:595-601
    /**
     * Register globally or in the calling agent scope. Scoped tools shadow
     * globals; duplicates within one layer and the reserved `run_code` name fail.
     * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
     * @returns the exact disposer that unregisters the tool.
     */
    register(definition: ToolDefinition): () => void;
```

同层级其它公开方法（用于交叉确认没有其它注册入口）：`presentAs`（`:574`）、`restrict`（`:609`）、`guard`（`:620`）、`get`（`:655`）、`schemas`（`:676`）、`executionMode`（`:688`）、`execute`（`:730`）。**没有** `confine`、`add`、`tool()` 等别名。

### 1.3 `ToolDefinition` 的逐字类型

核心部分（`:105-119`）：

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:105-119
/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
    /** Mandatory canonical output declaration. */
    readonly output: ToolOutputDefinition;
    /**
     * Run one accepted call and return only its canonical lossless-JSON value.
     * ...
     * @param args - losslessly snapshotted, frozen model arguments.
     * @param exec - execution identity, cancellation signal, and context deferral.
     * @returns the canonical value declared by `output.schema`.
     */
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
```

`ToolDefinition extends ToolSchema`，`ToolSchema` 定义在 `dsh-llm`（因为它是 `GenerateOptions` 的一部分）：

```ts
// ⟦PKG⟧/dsh-llm/lib/types/types.d.ts:397-402
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
```

`ToolOutputDefinition`（`:96-104`）：

```ts
/** Tool-owned canonical output contract used after the body returns a JSON value. */
export interface ToolOutputDefinition {
    /** Raw supported JSON Schema enforced against every successful canonical value. */
    readonly schema: JsonSchemaNode;
    /** Pure projection from validated arguments and value to Native/model content. */
    render(args: unknown, value: JsonValue): ContentBlock[];
    /** Pure replayable presentation projection, computed only for top-level calls. */
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
```

可选成员（全部可省略）：`finalizeContent?`（`:131`）、`timeoutMs?`（`:139`）、`isConcurrencySafe?`（`:153`）、`presentCall?`（`:163`）、`presentResult?`（`:171`）。

### 1.4 registry 对定义做的**运行时**校验（写「手搓定义对象」时必须满足）

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:2773-2782
register(definition) {
    const name = definition.name;
    const output = definition.output;
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
    assertSupportedJsonSchema(output.schema);
    const timeoutMs = definition.timeoutMs;
    if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
    if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
}
```

关键点：**没有任何 `instanceof` 检查**，只做结构检查 + `output.schema` 的 JSON Schema 子集断言。所以「手搓一个满足 `ToolDefinition` 形状的普通对象」在运行期是**合法**的（`parameters` 甚至不在注册时校验，只有 `schemaOf` 投影时要求它是 lossless JSON：`⟦PKG⟧/dsh-tools/lib/index.js:2934-2943`，失败信息在 `:2937`）。

### 1.5 官方推荐入口 `defineTool`

```ts
// ⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:232-239
/**
 * Define a first-party tool with inferred arguments and strict execution
 * validation. Replay-only presenters validate softly and fall back to generic
 * rendering for obsolete logged arguments.
 * @param options - typed definition and optional finalizer and presenters.
 * @returns A registry-ready definition.
 */
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

`DefineToolOptions` 全文：`⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:178-231`。运行时实现：`⟦PKG⟧/dsh-tools/lib/index.js:837-880`。它额外提供的能力是**参数校验包装**（校验失败抛 `ToolArgsError`，code `INVALID_ARGS`）：

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:863-867
async execute(args, exec) {
    const violations = validate(args);
    if (violations.length > 0) throw new ToolArgsError(violations);
    return userExecute(args, exec);
}
```

包级 README 的官方最小示例：`⟦PKG⟧/dsh-tools/README.md:34-58`。

---

## 2. 工具参数如何声明

### 2.1 结论：既不是 zod/schemastery，也不是「直接写 raw JSON Schema」

| 位置 | 用什么 schema |
|---|---|
| 插件 `Config`（YAML 配置） | `@deepseek-ai/schemastery` 的 `z`（`⟦PKG⟧/dsh-tool-todo/lib/index.js:20`） |
| **工具的 `parameters` / `output.schema`** | **`dsh-tools` 自有的 JSON-value schema DSL**（`ValueSchemaSpec` / `ParameterSchemaSpec`） |
| 模型实际收到的 `parameters` | 上者编译出的 raw JSON Schema（`JsonSchemaNode` / `ParameterJsonSchema`） |
| 内部校验 | `validateJsonSchemaValue`，实现于 `dsh-tools/lib/types/json-schema.ts` |

官方示例里的 zod 只用于 session projection 的 wire schema，与工具参数无关（`⟦PKG⟧/dsh-tool-todo/lib/index.js:2,64-71`）。

### 2.2 DSL 的逐字类型

```ts
// ⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:19-24
/** String value schema with type-correct literal constraints. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string';
    enum?: readonly string[];
    const?: string;
}
```

全部 9 个根节点：`StringValueSchemaSpec`(`:20`)、`NumberValueSchemaSpec`(`:26`)、`IntegerValueSchemaSpec`(`:32`)、`BooleanValueSchemaSpec`(`:38`)、`NullValueSchemaSpec`(`:44`)、`ArrayValueSchemaSpec`(`:50`)、`ObjectValueSchemaSpec`(`:58`)、`JsonValueSchemaSpec`(`:64`)、`OneOfValueSchemaSpec`(`:68`)，并集见 `:72`。

**参数根是「隐式开放对象」，必填是「每个属性上的 `required: true`」**：

```ts
// ⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:73-84
/** One implicit parameter-root property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & {
    required?: true;
};
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec;
    [key: symbol]: never;
};
```

**必填一律是「属性级 `required: true`」，`parameters` 与 `output.schema` 都一样。** `ObjectValueSchemaSpec.properties` 的类型就是 `ParameterSchemaSpec`（`⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:58-62`），所以嵌套对象里也是 `required: true`：

```ts
// ⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:54-62
/**
 * Explicit object value schema. Openness is mandatory so a nested or output
 * object never acquires an accidental JSON Schema default.
 */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object';
    properties?: ParameterSchemaSpec;   // ← 复用隐式参数映射，因此仍是 required: true
    additionalProperties: boolean;      // ← 必须显式声明开放性，没有默认值
}
```

**不要把 DSL 的写法与 raw JSON Schema 的写法混用**：

| 你写的是 | `required` 形式 | 依据 |
|---|---|---|
| `defineTool({ parameters, output })`（DSL） | 每个属性上 `required: true` | `⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:73-76` |
| 手搓 `ToolDefinition` 对象（raw） | 标准 `required: string[]` | `⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:32` |

手搓路径**必须**用字符串数组形式，因为 `register` 会对手搓的 `output.schema` 直接跑 `assertSupportedJsonSchema`（`⟦PKG⟧/dsh-tools/lib/index.js:2777`），而 enforced subset 里**没有**属性级 `required`（`⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:24-49`）。反之，DSL 的编译器会把 `required: true` 提升为根的 `required: string[]`（`⟦PKG⟧/dsh-tools/lib/index.js:801-810`）。

编译函数：

- `valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode` — `⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:157`
- `parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema` — `⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:163`，实现见 `⟦PKG⟧/dsh-tools/lib/index.js:801-810`
- `validateArgs(spec, args): string[]` — `⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:176`
- 类型推断 `InferValue<S>` / `InferArgs<S>`（16 层容器后退化为 `JsonValue`）— `⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:148,150`，边界见 `:124`。

### 2.3 被强制执行的 raw JSON Schema 子集

```ts
// ⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:16-49（节选，完整 24-49 行）
export type JsonSchemaScalar = string | number | boolean | null;
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
export interface JsonSchemaNode {
    type?: JsonSchemaType;
    oneOf?: JsonSchemaNode[];
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    enum?: JsonSchemaScalar[];
    const?: JsonSchemaScalar;
    description?: string;
    title?: string;
    default?: JsonValue;
    examples?: JsonValue;
}
```

「不支持或错位的关键字会**拒绝**而不是静默接受」— `⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:8-10`。断言函数：`assertSupportedJsonSchema`（`:89`）、`assertObjectJsonSchema`（`:96`）、`validateJsonSchemaValue`（`:105`）。

### 2.4 一个真实内置工具定义，端到端

`todo_write`（`⟦PKG⟧/dsh-tool-todo/lib/index.js:95-193`）——`name` / `description` / `parameters` / `output` / `execute` / `presentCall` 六段俱全：

```js
// ⟦PKG⟧/dsh-tool-todo/lib/index.js:95-193（节选，保留结构与关键行号）
ctx.tools.register(defineTool({
    name: "todo_write",                                    // :96
    description: describe(allowParallel),                  // :97  → :31-33 拼接
    parameters: { todos: {                                 // :98  隐式开放对象根
        type: "array",
        required: true,                                    // :100 属性级 required: true
        description: "The COMPLETE task list, replacing any previous list.",
        items: {
            type: "object",
            additionalProperties: false,                   // :104 嵌套对象必须显式声明开放性
            properties: {
                content: { type: "string", required: true, description: "..." },
                status: { type: "string", required: true, enum: [...STATUSES], description: "..." }
            }
        }
    } },
    output: {
        schema: {                                          // :121 规范返回值 schema
            type: "object",
            additionalProperties: false,
            properties: {
                todos: { type: "array", required: true, items: { /* ... */ } },
                counts: { type: "object", additionalProperties: false, required: true, properties: {
                    pending: { type: "integer", required: true },
                    inProgress: { type: "integer", required: true },
                    completed: { type: "integer", required: true }
                } }
            }
        },
        render: (_args, value) => [{                       // :165-168 唯一给模型看的文本来源
            type: "text",
            text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`
        }]
    },
    execute(args, exec) {                                  // :170 非 async 但返回 Promise
        const todos = toTodoList(args.todos, allowParallel);
        if (!exec.agent) throw new Error("todo_write requires an owning agent session");  // :172
        exec.agent.session.append("todo/write", { todos });                                // :173
        const count = (status) => todos.filter((t) => t.status === status).length;
        return Promise.resolve({                           // :175 返回「规范值」，不是文本
            todos: todos.map((todo) => ({ content: todo.content, status: todo.status })),
            counts: { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") }
        });
    },
    presentCall: (args) => ({ card: "generic", title: "Update todo list", kind: "other", rawInput: args.todos })  // :187-192
}));
```

注意 `output.schema` 里用的同样是**属性级 `required: true`**（`:127,134,138,147,151,155,159`），因为它走的是同一套 DSL（`ObjectValueSchemaSpec.properties: ParameterSchemaSpec`，`⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:60`）。这一点极易搞错：`⟦PKG⟧/dsh-tool-goal/lib/index.js:125-144` 的 `GOAL_VALUE_SCHEMA` 也是属性级 `required: true`，可作第二处交叉验证。只有**手搓 raw 定义**时才改用 `required: string[]`（本仓库 `src/host/capabilities.ts:103,123,141` 即如此）。

另一个带宿主 I/O + 复杂 output 的例子：`read` 工具 `⟦PKG⟧/dsh-tool-fs/lib/index.js:331-471`（`:414` `isConcurrencySafe: () => true`、`:415-435` `async execute`、`:418` 用 `exec.signal`、`:400-412` `presentationMeta`）。`present` 工具：`⟦PKG⟧/dsh-tool-present/lib/index.js:23-109`（`:76` `async execute`、`:85` `signal: exec.signal`、`:90` 把 `exec.signal` 传给 `ctx.fs.lstat`）。

---

## 3. handler 签名、是否 async、拿到什么、怎么回内容给模型

### 3.1 签名与 async

```ts
execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
```
（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:119`）

**返回 `Promise` 是硬要求**（类型层面），但实现上可以是 `return Promise.resolve(...)`（`⟦PKG⟧/dsh-tool-todo/lib/index.js:175`）或 `async`（`⟦PKG⟧/dsh-tool-fs/lib/index.js:415`、`⟦PKG⟧/dsh-tool-present/lib/index.js:76`）。

### 3.2 `exec` 的完整字段

`ToolRunContext extends ToolExecution extends ToolExecutionInput`：

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:197-221
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;
    /** Required caller-owned cancellation for this invocation. */
    readonly signal: AbortSignal;
}
```

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:261-266
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;
    readonly token: ToolExecutionToken;
}
```

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:284-301
export interface ToolRunContext extends ToolExecution {
    /**
     * Defer one context — typically a nested-dispatch context ferried by a
     * composite tool, or a fresh plugin-sourced instruction — until this tool's
     * final result reaches the agent loop. ...
     */
    deferContext(context: UserMessage): void;
    /**
     * Mark a successful final result as terminal for the current agent turn.
     * ...
     */
    concludeTurn(): void;
}
```

**逐条回答提问**：

| 想要的东西 | 在 `exec` 里有吗 | 怎么拿 |
|---|---|---|
| 原始输入（未经校验） | ✅ `exec.arguments: unknown` | 即 handler 第 1 参 `args` 的同一对象（`defineTool` 已校验后再传） |
| 已校验输入 | ✅ handler 第 1 参 `args` | `defineTool` 保证通过 `parameters` 校验（`⟦PKG⟧/dsh-tools/lib/index.js:864-866`） |
| 调用上下文 | ✅ `exec.agent`（`Agent`）、`exec.callId`、`exec.name`、`exec.token` | — |
| session id | ✅ 间接：`exec.agent.id`（`Agent.id: SessionId`，`⟦PKG⟧/dsh-agent/lib/types/types.d.ts:11-14`）；**没有**独立的 `sessionId` 字段 | — |
| session 对象 | ✅ 间接：`exec.agent.session`（`⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:143`） | 仓库内置工具就是这么用的（`⟦PKG⟧/dsh-tool-todo/lib/index.js:173`） |
| workspace / cwd | ✅ 间接：`exec.agent.session.header.cwd` | `⟦PKG⟧/dsh-session/lib/types/types.d.ts:69`；内置 `present` 即此法（`⟦PKG⟧/dsh-tool-present/lib/index.js:81`） |
| abort signal | ✅ `exec.signal: AbortSignal` | 必须转发给 I/O（`⟦PKG⟧/dsh-tool-present/lib/index.js:85,90`） |
| logger | ❌ **`exec` 上没有** | 用插件自己的 `ctx.logger`（`⟦PKG⟧/cordis/lib/types/context.d.ts:26-27`；本仓库 `src/host/index.ts:90` 已在用） |

取消语义（官方 README）：`⟦PKG⟧/dsh-tools/README.md:121`——body 调用前取消 → `ABORTED_BEFORE_DISPATCH`；调用后取消 → 只把「成功」结果替换成 `ABORTED`；tool body 必须自己 observe/forward `exec.signal` 并达到 quiescence（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:109-118`）。

### 3.3 怎么把内容给模型

**两段式，必须分清**：

1. `execute` 只返回**规范 JSON 值**（canonical value），由 `output.schema` 校验（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:117-119`）。
2. 模型看到的**内容块**由 `output.render(args, value): ContentBlock[]` 纯函数投影（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:100-101`）。

最终落地的结构：

```ts
// ⟦PKG⟧/dsh-tools/lib/types/index.d.ts:389-412
export interface ToolExecutionSuccess {
    readonly isError: false;
    /** Execution-local canonical value; deliberately omitted from durable events. */
    readonly value: JsonValue;
    readonly content: ContentBlock[];
    readonly error?: never;
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    readonly concludesTurn?: true;
}
export interface ToolExecutionFailure {
    readonly isError: true;
    readonly error: ToolFailure;
    readonly value?: never;
    readonly content: ContentBlock[];
    ...
}
```

`ContentBlock` 是从 `ContentBlockMap` 派生的已知块并集：

```ts
// ⟦PKG⟧/dsh-llm/lib/types/types.d.ts:91-102
export interface ContentBlockMap {
    'text': TextBlock;
    'reasoning': ReasoningBlock;
    'image': ImageBlock;
    'file': FileBlock;
    'tool-call': ToolCallBlock;
    'tool-result': ToolResultBlock;
}
export type ContentBlockType = keyof ContentBlockMap;
export type ContentBlock = ContentBlockMap[ContentBlockType];
```

```ts
// ⟦PKG⟧/dsh-llm/lib/types/types.d.ts:39-42
export interface TextBlock {
    type: 'text';
    text: string;
}
```

所以「返回纯字符串」是**不行的**——必须包成 `{ type: 'text', text }`。README 原话：「The loop retains model-emitted arguments and the registry's final content. Any thrown or denied call becomes exactly `Error: <message>`.」（`⟦PKG⟧/dsh-tools/README.md:206`）

**失败怎么报**：直接 `throw` 普通 `Error` 即可，会被规范化为 `ToolExecutionFailure`（`content` 为错误文本、`isError: true`），不会终止本轮对话（`⟦PKG⟧/dsh-tools/README.md:121`）。若想保留结构化 code，抛 `HarnessError`（`⟦PKG⟧/dsh-llm/lib/index.js:121-129`；`ToolFailure.info` 定义见 `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:356-367`）。

**注意 `output.schema` 是强制的**：`output` 缺失或 `render` 不是函数直接 `TypeError`（`⟦PKG⟧/dsh-tools/lib/index.js:2776`），且成功值会按 `output.schema` 校验，不符则抛 `ToolOutputError`（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:383-388`）。

---

## 4. 作用域：全局 / 每 Agent / 每 workspace？命名前缀约定？

### 4.1 只有两层：全局 与「调用方 Agent」

`register` 的 JSDoc 就是权威描述：

> Register globally or in the calling agent scope. Scoped tools shadow globals; duplicates within one layer and the reserved `run_code` name fail.
> — `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:596-600`

层结构：

```ts
// ⟦PKG⟧/dsh-scope/lib/types/store.d.ts:96-108
/**
 * Own the global and exact-scope layers for one registry.
 *
 * Reads never create scoped layers. Registrations derive both visibility and
 * effect ownership from the supplied Cordis context, collect undo before
 * notification, and reclaim only a completely empty aggregate layer.
 */
export declare class ScopedLayers<L extends ScopeLayer> {
    ...
    constructor(createLayer: (scope: ScopeKey | undefined) => L, onChange: () => void);
```

```ts
// ⟦PKG⟧/dsh-scope/lib/types/store.d.ts:134-144
    /**
     * Attach one synchronous layer mutation to its registration context.
     * @param ctx - context that determines both scope visibility and effect ownership.
     * @param action - atomic mutation returning its synchronous undo.
     * @param options - Cordis effect label and optional change notification.
     * @returns the exact disposer returned by `ctx.effect()`.
     */
    effect(ctx: Context, action: (layer: L) => () => void, options: {
        label: string;
        notify?: boolean;
    }): () => void;
```

### 4.2 「调用方 Agent」是怎么被识别出来的（关键机制，必须理解）

`register` 传的是 `this.ctx`（服务自身视角的 context），而 `this.ctx` 在 Cordis 里是**访问者 context**：

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:2781
return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
```

Cordis 的 traceable proxy 会把 `.ctx` 解析成**当前读取者的 context**：

```js
// ⟦PKG⟧/cordis/lib/index.js:125-128
const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
        if (prop === symbols.original) return target;
        if (prop === tracker.property) return ctx;
```

```js
// ⟦PKG⟧/cordis/lib/index.js:1773-1780
const tracker = {
    associate: name,
    property: "ctx"
};
...
self.ctx = ctx;
self.name = name;
defineProperty(self, symbols.tracker, tracker);
```

**结论**：`agent.ctx.tools.register(def)` 里的 `this.ctx` 就等于 `agent.ctx`，因此注册落进该 Agent 的 scope 层。这也解释了 `restrict()` / `presentAs()` 为什么能靠 `scopeOf(this.ctx)` 判断「是否 scoped」：

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:2791-2792
const scope = scopeOf(this.ctx);
if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
```

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:2706-2707
presentAs(mode) {
    if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): ...");
```

### 4.3 scope key 就是 Agent 对象本身

```js
// ⟦PKG⟧/dsh-agent-loop/lib/index.js:761-762
this.scope = createScope(loopCtx, this);
this.ctx = this.scope.ctx;
```

```ts
// ⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:148-149
        /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
        readonly ctx: Context;
```

所以 `ctx.tools.get(name, agent)` / `ctx.tools.schemas(agent)` 里传 **Agent 对象本身**就是正确的 `ScopeKey`（`ScopeKey = object`，`⟦PKG⟧/dsh-scope/lib/types/index.d.ts:11`），因为 scope key 与 `ctx.agents.get(id)` 返回的 Agent 是同一对象（`⟦PKG⟧/dsh-agent/lib/index.js:563-564`：`get(id) { return this.store.get(id)?.agent; }`）。

### 4.4 重名与保留名

- 同层重名 → 抛错，且错误信息**明确指引**用 `agent.ctx`：
  ```js
  // ⟦PKG⟧/dsh-tools/lib/index.js:2538
  this.tools = new NamedEntries((name) => new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
  ```
- **唯一的保留名是 `run_code`**（PTC 传输）：`⟦PKG⟧/dsh-tools/lib/index.js:2780`、`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:597`。

### 4.5 有没有「每插件命名空间 / 名字前缀」约定？——**没有强制约定**

- 注册路径上**没有任何名字格式校验**（`register` 全文见 §1.4；`NamedEntries.insert` 只查重，`⟦PKG⟧/dsh-scope/lib/types/store.d.ts:29-35`）。
- 名字正则只出现在 PTC 模式 SDK 生成时（`isBareIdentifier`，`⟦PKG⟧/dsh-tools/lib/index.js:1754-1756`），用于决定能否直接以标识符形式渲染，**不是注册门槛**。
- 实测内置工具命名（前缀是风格选择，不是规则）：
  - 无前缀、单词：`read`/`write`/`edit`/`read_image`（`⟦PKG⟧/dsh-tool-fs/lib/index.js:332,597,742,1042`）、`present`（`⟦PKG⟧/dsh-tool-present/lib/index.js:24`）、`skill`（`⟦PKG⟧/dsh-tool-skill/lib/index.js:60`）
  - 领域后缀式：`get_goal`/`update_goal`/`create_goal`（`⟦PKG⟧/dsh-tool-goal/lib/index.js:265,275,301`）、`job_list`/`job_output`/`job_kill`（`⟦PKG⟧/dsh-tool-jobs`）
- **实践建议**：全局注册必须避免与内置名冲突（同层重名直接抛错）；若要做「`sift_` 前缀」，那是本项目自己的防撞策略，不是 DSH 要求。若走 **per-agent scoped 注册**，则连撞名风险都没有——scoped 层会 shadow 全局（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:596-597`）。

### 4.6 workspace 级作用域：**不存在**

- `ToolRuntime` 的解析入口签名是 `view(scope: ScopeKey | undefined)` / `schemas(scope?: ScopeKey)` / `get(name, scope?: ScopeKey)`（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:642-645,676,655`），scope 只有 Agent。
- 没有 `ctx.tools.registerForWorkspace`、没有 workspace key 参与 `ScopedLayers`。
- **正确做法是在 `execute` 内按调用时刻解析 workspace**，例如：
  - `exec.agent.session.header.cwd`（绝对路径，`⟦PKG⟧/dsh-session/lib/types/types.d.ts:69`）；
  - `ctx.workspaceRegistry.resolveByPath(path): Promise<Workspace | undefined>`（`⟦PKG⟧/dsh-workspace/lib/types/index.d.ts:139`；`get(id)` 在同文件 `:85`，`list()` 在 `:92`）；
  - `Workspace` 实体含 `id` / `path` / `title` / `sessionIds`（`⟦PKG⟧/dsh-workspace/lib/types/types.d.ts:28-51`），`WorkspaceId` 是 **branded string 且是生成的 uuid，不是路径**（`:9-13`）。
- 这条对本项目「工具参数里带一个只在一个 workspace 内有效的 `sourceId`」是决定性的：**不要试图把工具本身按 workspace 隔离**；按 Agent 隔离 + 运行时解析 workspace 才是受支持的路径。

### 4.7 另有一个模式层次的坑

若部署把 `dsh-tools` 配成 `mode: 'ptc'` 或 `'both'`（默认 `native`，`⟦PKG⟧/dsh-tools/lib/index.js:2569-2576`），模型直呼工具名会被折叠：

```js
// ⟦PKG⟧/dsh-tools/lib/index.js:2735-2738
if (mode === "ptc") return {
    schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
    knownNames: [RUN_CODE_NAME]
};
```

且「per-agent 而非 per-tool」，无法让某一个工具单独 native（`⟦PKG⟧/dsh-tools/README.md:227`）。默认 web profile 未配置 `mode`（`⟦PKG⟧/dsh-base/cordis.patch.yml:458-461`），即 `native`。

---

## 5. 注册的销毁

- **`register` 返回精确 disposer**（类型 `() => void`）：
  `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:601`；实现 `⟦PKG⟧/dsh-tools/lib/index.js:2781`。
- 它返回的就是 **`ctx.effect()` 的 disposer**（`ScopedLayers.effect` 的 JSDoc：`⟦PKG⟧/dsh-scope/lib/types/store.d.ts:139`），而 `ctx.effect` 的返回类型是**可调用的 `Disposable<Promise<void>>`**：
  ```ts
  // ⟦PKG⟧/cordis/lib/types/fiber.d.ts:8
  interface Context extends Pick<Fiber, 'effect'> {
  ```
  ```ts
  // ⟦PKG⟧/cordis/lib/types/fiber.d.ts:145-157
      /**
       * Register a cleanup-aware effect on this fiber.
       *
       * `execute` runs immediately; the disposers it produces are collected and
       * run (in reverse order) either when the returned disposer is called or
       * when the fiber unloads, whichever comes first. ...
       * @returns a disposer that tears the effect down and settles once done.
       */
      effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
  ```
  **类型上有微小出入**：`register` 声明 `() => void`，实现实际返回 `Disposable<Promise<void>>`（可调用、返回值可 await）。按 `() => void` 使用是安全的；想 await 完成需要窄化。
- **绑定插件生命周期**：因为注册是挂在「注册时用的那个 context」上，**插件卸载 / Agent 销毁会自动回收**，不需要额外 `ctx.effect` 包裹：
  - `⟦PKG⟧/dsh-scope/lib/types/store.d.ts:96-100`「Registrations derive both visibility and effect ownership from the supplied Cordis context」
  - Agent scope 的回收：`⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:148-149`「unwind on disposal, and reject registration afterward」；`⟦PKG⟧/dsh-agent/lib/types/index.d.ts:136-137`（dispose 流程最后 unwind scoped world）。
- **内置工具都没自己包 `ctx.effect`**，直接 `ctx.tools.register(...)`：`⟦PKG⟧/dsh-tool-todo/lib/index.js:95`、`⟦PKG⟧/dsh-tool-present/lib/index.js:23`、`⟦PKG⟧/dsh-tool-skill/lib/index.js:167`。
- **但可以显式 dispose**：本仓库 `src/host/capabilities.ts:173` 就是收集 disposer 后倒序调用，写法正确。

---

## 6. 插件 package.json 需要什么

### 6.1 `dsh` 字段的权威类型

```ts
// ⟦PKG⟧/dsh-package-manifest/lib/types/types.d.ts:6-28
/** The `dsh` property of an npm manifest; a package may declare several roles. */
export interface DshManifest {
    /** Bundle metadata consumed by the profile launcher. */
    bundle?: DshBundleManifest;
    /** Profile metadata consumed by the profile launcher. */
    profile?: DshProfileManifest;
    /** Client module loading and build metadata. */
    client?: DshClientManifest;
    /** Config directories consumed by the experimental deployment-image packer. */
    configTrees?: DshConfigTreeDeclaration[];
    ...
}
/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
    /** Patch file path relative to the declaring package root. */
    patch: string;
}
```

### 6.2 profile launcher 的实际行为

```
A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
`package.json` (out-of-tree plugin dependencies plus the profile manifest
`dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
(the user's own patch layer, applied after every bundle layer). Bundles are
npm packages whose manifest declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; ...
```
— `⟦PKG⟧/dsh-app-boot/lib/index.js:291-299`

```js
// ⟦PKG⟧/dsh-app-boot/lib/index.js:849-853
const layers = bundles.map((packageName) => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
    const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
    if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
    const patchPath = join(packageDir, declared);
```

即：**`dsh.bundle.patch` 是「作为 bundle 被 `dsh.profile.bundles` 列出」时才必需的**，并且路径是相对包根的**文件系统路径**（`join(packageDir, declared)`），**不经过 exports 解析**。

### 6.3 真正的工具插件（`dsh-tool-*`）里**没有** `dsh` 字段，也没有 `cordis.patch.yml`

实测：`dsh-tool-todo/package.json` 全文（`⟦PKG⟧/dsh-tool-todo/package.json:1-66`）**不含 `dsh` 字段**；`dsh-tool-present/package.json:1-64`、`dsh-tool-fs`、`dsh-tool-goal`、`dsh-tool-skill` 同样没有。

整个安装目录里只有 **6 个包**有 `cordis.patch.yml`：

```
⟦PKG⟧/dsh-acp-app/cordis.patch.yml
⟦PKG⟧/dsh-base/cordis.patch.yml
⟦PKG⟧/dsh-headless/cordis.patch.yml
⟦PKG⟧/dsh-sdk-app/cordis.patch.yml
⟦PKG⟧/dsh-sdk-minimal/cordis.patch.yml
⟦PKG⟧/dsh-web-app/cordis.patch.yml
```

工具插件是被**这些 bundle 的 patch 行**按包名挂载的：

```yaml
# ⟦PKG⟧/dsh-base/cordis.patch.yml:401-404
    - id: tool-todo
      name: '@deepseek-ai/dsh-tool-todo'
      config:
        allowParallelInProgress: true
```

```yaml
# ⟦PKG⟧/dsh-base/cordis.patch.yml:408-409
    - id: tool-goal
      name: '@deepseek-ai/dsh-tool-goal'
```

```yaml
# ⟦PKG⟧/dsh-base/cordis.patch.yml:458-461
    # The tool registry. Presentation mode is a deployment choice; omitting it here
    # keeps the schema default (native).
    - id: tools
      name: '@deepseek-ai/dsh-tools'
```

### 6.4 「模块 → 插件」的加载链路（逐行）

```js
// ⟦PKG⟧/cordis-plugin-loader/src/config/entry.ts:280
plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, this.getOuterStack))
```
```js
// ⟦PKG⟧/cordis-plugin-loader/src/config/entry.ts:291-297
private async _start(plugin: any) {
    let fiber: Fiber | undefined
    try {
        await this._patchContext([])
        this.loader.showLog(this, 'apply')
        fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
        await fiber.await()
```

```ts
// ⟦PKG⟧/cordis-plugin-loader/src/index.ts:191-199
  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
```

即：`unwrapExports` **优先取 `default` 导出**（并对 esbuild 的 CJS interop 再做一次解包），没有 `default` 才用整个 module namespace。这解释了两条并存的写法：

| 写法 | 适用 | 例子 |
|---|---|---|
| `export default class X extends Service` + `static inject` | 服务型插件 | 本仓库 `src/host/index.ts:113` |
| `export const name/inject/Config` + `export function apply` | 功能型插件 | `⟦PKG⟧/dsh-tool-todo/lib/types/index.d.ts:10-11,24,31` |

> ⚠️ 副作用：功能型插件导出 `default` 会被优先采用——工具插件都不导出 `default`，只导出命名成员（`⟦PKG⟧/dsh-tool-todo/lib/index.js:196`：`export { Config, apply, inject, name };`）。

### 6.5 本仓库当前的 package.json（已满足 bundle 约定）

```jsonc
// D:\code\dsh-sift\package.json:9-20
  "type": "module",
  "main": "dist/host/index.js",
  "types": "dist/types/host/index.d.ts",
  "exports": {
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./client": "./dist/client/index.js",
    "./package.json": "./package.json",
    "./typert": "./dist/host/typert.js",
    ".": {
      "types": "./dist/types/host/index.d.ts",
      "default": "./dist/host/index.js"
    }
  },
```

```jsonc
// D:\code\dsh-sift\package.json:44-62
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "immediately": true,
      "inject": [ ... ],
      "platform": "web"
    }
  },
```

```jsonc
// D:\code\dsh-sift\package.json:63-66
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/dsh-typert-protocol": "0.1.5-rc.2"
  },
```

```yaml
# D:\code\dsh-sift\cordis.patch.yml:1-3
- insert:
    - id: sift
      name: '@songyanglin/dsh-sift'
```

开发 Home 里的 profile 也把它列为 bundle：

```jsonc
// D:\code\dsh-sift\.debug\development\profiles\web\package.json
  "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@songyanglin/dsh-sift"
  ], "patchReload": "live" } }
```

工具插件（`⟦PKG⟧/dsh-tool-todo/package.json:39-50`）的依赖面参考：

```jsonc
  "dependencies": { "zod": "^4.4.3", "@deepseek-ai/schemastery": "^3.18.2" },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-invariants": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session-projection": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/cordis": "^4.0.2"
  },
```

**工具包必然 `peerDependencies` 声明 `@deepseek-ai/dsh-tools`**（`⟦PKG⟧/dsh-tool-todo/package.json:48`、`⟦PKG⟧/dsh-tool-present/package.json` 同、`⟦PKG⟧/dsh-tool-cordis/package.json` 的 `peerDependencies` 亦含）。

### 6.6 本仓库当前**缺少** `@deepseek-ai/dsh-tools`（实测）

- `D:\code\dsh-sift\node_modules\@deepseek-ai\` 只有 `cordis`、`dsh-typert-protocol` 两个 junction。
- `D:\code\dsh-sift\pnpm-lock.yaml` 全文无 `dsh-tools`（只有 `:39,42,242,257,2126,2133` 处的 cordis / dsh-typert-protocol）。
- 运行时解析实测（在仓库根执行）：

  ```
  import('@deepseek-ai/dsh-tools')  →  FAIL ERR_MODULE_NOT_FOUND
  import('@deepseek-ai/cordis')     →  cordis OK
  ```

- 注册表可达（`pnpm view @deepseek-ai/dsh-tools@0.1.5-rc.2 version` → `0.1.5-rc.2`）。
- 构建侧：`scripts/build.mjs:19` 使用 `packages: 'external'`，所以新 import 会**保留为裸导入**，必须在运行时能解析。见 §9.4 的两条可选路径。

---

## 7. `inject` 从哪来 + 一个完整最小宿主插件

### 7.1 `inject` 的读取点

```js
// ⟦PKG⟧/cordis/lib/index.js:1634
const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
```

```ts
// ⟦PKG⟧/cordis/lib/types/registry.d.ts:13-15
export type Inject<M = Dict> = (keyof M)[] | {
    [K in keyof M]?: M[K];
};
```

```ts
// ⟦PKG⟧/cordis/lib/types/registry.d.ts:52-63
    interface Base<T = any> {
        /** Display name used for fiber diagnostics and logger names. */
        name?: string;
        /** Standard-schema validator applied to config before the plugin starts. */
        Config?: StandardSchemaV1<any, T>;
        /** Services the plugin requires; it only loads while all are available. */
        inject?: Inject;
        /** Service name(s) the plugin provides (read by `Service` and by loaders). */
        provide?: string | string[];
        ...
```

- 数组形式 `['tools']` → `{ tools: null }`（`⟦PKG⟧/cordis/lib/index.js:1490-1498`）。
- **类插件**：`Plugin.Constructor` 契约是 `new (ctx, config)`（`⟦PKG⟧/cordis/lib/types/registry.d.ts:74-77`），实例化点：
  ```js
  // ⟦PKG⟧/cordis/lib/index.js:1066-1070
  if (isConstructor(runtime.callback)) {
      const instance = new runtime.callback(this.ctx, this.config);
      for (const hook of instance?.[symbols.initHooks] ?? []) hook();
      return instance?.[symbols.init]?.();
  } else return runtime.callback(this.ctx, this.config);
  ```
  `static inject` 因此是**类上的静态字段**，`Inject.resolve(plugin.inject)` 直接读它。
- **函数插件**：`export const inject = ['tools', 'fs', ...]`（`⟦PKG⟧/dsh-tool-present/lib/index.js:10-14`、`⟦PKG⟧/dsh-tool-fs/lib/index.js:1242-1246`、`⟦PKG⟧/dsh-tool-goal/lib/index.js:107-113`）。
- 条件依赖用 `ctx.inject(deps, cb)`（见 §8.1）。

### 7.2 最小宿主插件（功能型，注册 `sift_probe_echo`）

```ts
// sift-probe-plugin.ts —— 功能型 Cordis 插件，注册一个模型可调用的工具
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

// Loader 诊断用的 fiber 显示名（Plugin.Base.name）。
// 依据：⟦PKG⟧/cordis/lib/types/registry.d.ts:53-54；内置写法 ⟦PKG⟧/dsh-tool-todo/lib/index.js:11
export const name = 'sift-probe';

// 依赖声明（数组形式 → { tools: null }）。依据：registry.d.ts:13-15 + cordis/lib/index.js:1490-1498
export const inject = ['tools'];

// 可选：YAML 配置校验。本项目目前不需要，故省略 Config
// （依据：registry.d.ts:56；内置例子 ⟦PKG⟧/dsh-tool-todo/lib/index.js:20）

// Loader 以 (ctx, config) 调用模块的 apply。
// 依据：registry.d.ts:70-73 + cordis/lib/index.js:1070
export function apply(ctx: Context): void {
  // ctx.tools.register 返回该注册的精确 disposer，且已挂在当前 ctx 的 effect 上，
  // 插件卸载时自动回收 —— 无需再包 ctx.effect。
  // 依据：⟦PKG⟧/dsh-tools/lib/index.js:2781、⟦PKG⟧/dsh-scope/lib/types/store.d.ts:134-144
  ctx.tools.register(defineTool({
    name: 'sift_probe_echo',
    description: 'Echo back the provided text. Diagnostic tool for verifying Sift tool registration.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to echo back.' },
    },
    output: {
      // 规范返回值 schema：必须是 ⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:18-49 的子集
      schema: { type: 'object', additionalProperties: false, properties: {
        text: { type: 'string', required: true },
      } },
      // 唯一给模型看的内容来源；必须是 ContentBlock[]（⟦PKG⟧/dsh-llm/lib/types/types.d.ts:39-42）
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // async：类型要求 Promise（index.d.ts:119）；args 由 defineTool 校验后传入（index.js:864-866）
    async execute(args, exec) {
      exec.signal.throwIfAborted();     // 必须观察/转发取消信号（README.md:121）
      return { text: args.text };       // 只返回规范值，不返回文本
    },
  }));
}
```

**逐行 API 依据**：见每行注释；`exec.signal.throwIfAborted()` 的用法在内置工具中一致出现（`⟦PKG⟧/dsh-tool-present/lib/index.js:98`）。

### 7.3 同一件事的**类插件**写法（本仓库现有形态）

```ts
// 依据：⟦PKG⟧/cordis/lib/types/registry.d.ts:74-77 + cordis/lib/index.js:1066-1070
export class SiftService extends SomeService {
  static inject = ['workspaceRegistry', 'tools'];   // 数组形式
  constructor(ctx: Context) {
    super(ctx, 'sift');                             // 注册服务名
    ctx.tools.register(/* ToolDefinition */);       // 全局层注册
  }
}
export default SiftService;
```

本仓库 `src/host/index.ts:67-68,87-92,113` 就是这一形态（详见 §9）。

---

## 8. 能否运行时 / 按当前 session / 按当前 workspace 条件注册

### 8.1 运行时条件注册：**可以**，官方有 `ctx.inject`

```ts
// ⟦PKG⟧/cordis/lib/types/registry.d.ts:99-111
declare module './context.ts' {
    interface Context {
        /**
         * Run a callback once the requested services are available.
         *
         * Shorthand for `ctx.plugin({ inject, apply: callback })`: the callback
         * is unloaded and re-run whenever a required service changes.
         * ...
         */
        inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;
```

内置实证（只有在 `attachments` 服务挂载时才注册 `read_image`）：

```js
// ⟦PKG⟧/dsh-tool-fs/lib/index.js:1270-1272
ctx.inject(["attachments"], (imageCtx) => {
    applyReadImageTool(imageCtx);
});
```

### 8.2 只给「当前 session / 当前 Agent」注册：**可以，这就是 `agent.ctx` 路径**

推荐两种触发点：

**A. `agent/created` 事件（拿到 `agent` 与 `agent.ctx`）**

```ts
// ⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:223-226
        'agent/created'(this: Scoped<Agent>, payload: {
            agent: Agent;
        }): void;
```

其文档明确「A fully configured agent and live session were published. Setup is composition-only」（`:214-220`），且「`agent/disposed`」在「scoped-registration unwind 之后」发出（`:227-237`）。

**B. 已有 sessionId，用 `ctx.agents.get(id)` 取回同一 Agent**（服务名 `agents`）：

```ts
// ⟦PKG⟧/dsh-agent/lib/types/index.d.ts:19-20
    interface Context {
        agents: AgentRegistry;
```
```js
// ⟦PKG⟧/dsh-agent/lib/index.js:563-564
get(id) {
    return this.store.get(id)?.agent;
}
```

本仓库 `src/host/capabilities.ts:156` 走的就是 B。

**回收**：Agent 销毁自动 unwind（`⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:148-149`）。

### 8.3 只给「当前 workspace」注册：**不支持**

见 §4.6。scope 只有 Agent，没有 workspace 维度。**结论：不要按 workspace 隔离工具注册**；把 workspace 解析放进 `execute`：

- 从 `exec.agent.session.header.cwd`（`⟦PKG⟧/dsh-session/lib/types/types.d.ts:69`）拿绝对 cwd，再用 `ctx.workspaceRegistry.resolveByPath(cwd)` 或本仓库已有的 `SiftRepository.projectForSession(sessionId)`（`src/host/repository.ts:113-116`）把会话映射到项目；
- `sourceId` 一类的参数只在 `execute` 里校验归属（`src/host/repository.ts:253-261` 的 `source.attach` 已是这个模式：素材必须属于当前项目的 solution，否则抛错）。

### 8.4 变更成本提醒

工具集合变化会改变请求前缀，进而影响 KV cache（`⟦PKG⟧/dsh-tools/README.md:167`、`:200`），并且 agent-loop 会在 header 变化时追加 `request/header` 事件（`⟦PKG⟧/dsh-agent-loop/lib/index.js:1182-1186`）。因此**在 Agent 创建时一次性注册**，不要每轮 churn。另有 `tools/change` 事件可用于观察变更（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:84-93`）。

---

## 9. 接入本仓库：现状核对与具体建议

### 9.1 现有宿主服务

```ts
// D:\code\dsh-sift\src\host\index.ts:67-92（节选）
export class SiftService extends TypertRemoteService {
  static inject = ['workspaceRegistry'];                       // :68
  private readonly registry: WorkspaceRegistry;
  private workspacePath(id: string): string { ... }            // :70-74
  ...
  constructor(ctx: SiftContext) {                              // :87
    super(ctx, 'sift');                                        // :88
    this.registry = ctx.workspaceRegistry;                     // :89
    ctx.logger.info('Sift 插件已加载11。');                     // :90
    ctx.effect(() => () => ctx.logger.info('Sift 插件已卸载。'));  // :91
  }
}
export default SiftService;                                    // :113
```

- 形态：**类插件**（default export 一个 `Service` 子类）+ `static inject`。与 `⟦PKG⟧/cordis/lib/types/registry.d.ts:74-77`、`⟦PKG⟧/cordis/lib/index.js:1066-1070` 完全一致；`static inject` 被 `Inject.resolve` 读取（`⟦PKG⟧/cordis/lib/index.js:1634`）。
- `src/host/typert.ts:1-11`：Typert（Host↔Client RPC）面，只暴露 `remote.ts` 的 descriptors。**注册工具与 Typert 无关**，`typert.ts` **不需要改动**。
- `ctx.logger` 可用（`⟦PKG⟧/cordis/lib/types/context.d.ts:26-27`），而 `exec` 上没有 logger（§3.2）。

> **小观察（已验证，只影响诊断）**：因为 `src/host/index.ts:113` 有 `export default SiftService`，`unwrapExports` 会取到那个 class，所以 `src/host/index.ts:7` 的 `export const name = 'sift'` **不会**成为 `plugin.name`。`registry` 读的是 `plugin.name`（`⟦PKG⟧/cordis/lib/index.js:1624-1627`），对 class 插件而言即类名 `"SiftService"`，而 fiber 的显示名与 logger 名都来自它（`⟦PKG⟧/cordis/lib/index.js:1116-1122`、`:628-632`）。功能不受影响，但日志里看到的名字是 `SiftService` 而不是 `sift`。

### 9.2 ⚠️ 仓库里已有一份「要做这件事」的代码，且**从未被引用**

`src/host/capabilities.ts`（已 commit，`git ls-files` 显示 tracked）：

```ts
// D:\code\dsh-sift\src\host\capabilities.ts:21-41
interface AgentScope {
  tools: {
    register(tool: ToolDefinition): () => void;
    confine(filter: { allow: readonly string[] }): () => void;      // :24  ❌ 不存在
    guard(guard: (execution: { name: string }) => string | undefined): () => void;
  };
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void;
    getSectionOrder(name: string): number;                          // :29  放宽成 string 掩盖了错误
  };
}
```

```ts
// D:\code\dsh-sift\src\host\capabilities.ts:155-173（节选）
export function configureProjectAgent(host: CapabilityHost, repository: SiftRepository, sessionId: string): (() => void) | null {
  const agent = host.agents.get(sessionId);
  if (!agent) return null;
  const inherited = host.tools.schemas(agent).map(tool => tool.name);        // :158  ✅
  const allowed = inherited.filter(name => SAFE_GENERAL_TOOLS.has(name));
  const noteTools = createNoteTools(repository, sessionId);
  const disposers = noteTools.map(tool => agent.ctx.tools.register(tool));   // :161  ✅
  const allowedNames = new Set([...allowed, ...noteTools.map(tool => tool.name)]);
  disposers.push(agent.ctx.tools.confine({ allow: [...allowedNames] }));     // :163  ❌
  disposers.push(agent.ctx.tools.guard(execution => allowedNames.has(execution.name)
    ? undefined
    : '当前 Sift 项目会话不允许使用该工具。'));                                 // :164-166  ✅
  const filesystemOrder = agent.ctx.systemPrompt.getSectionOrder('TOOL_FS');  // :167  ❌
  disposers.push(agent.ctx.systemPrompt.section({
    name: 'sift:project-note',
    order: Number.isFinite(filesystemOrder) ? filesystemOrder : 500,         // :170
    text: '...'
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };     // :173  ✅
}
```

**唯一引用方是它自己**——全仓库 grep `capabilities|configureProjectAgent|createNoteTools|SiftAgent|CapabilityHost` 的 7 处命中全部在 `src/host/capabilities.ts` 内部。`src/host/index.ts` 没有 import 它，`SiftRepository` 也**从未被实例化**（全仓库只有 `repository.ts` 的定义与 `capabilities.ts` 的类型引用）。

#### 逐项核对结果

| 行 | 现状 | 判定 | 依据 |
|---|---|---|---|
| `:158` `host.tools.schemas(agent)` | 把 Agent 当 `ScopeKey` | ✅ **正确** — scope key 就是 Agent 对象 | `⟦PKG⟧/dsh-agent-loop/lib/index.js:761-762`、`⟦PKG⟧/dsh-scope/lib/types/index.d.ts:11` |
| `:161` `agent.ctx.tools.register(tool)` | per-Agent 注册 | ✅ **正确** — 且自动随 Agent 回收 | `⟦PKG⟧/dsh-tools/lib/index.js:2781`、`⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:148-149` |
| `:24,163` `tools.confine({allow})` | 方法名不存在 | ❌ **会 TypeError**。真实 API 是 **`restrict(filter: ToolRestriction)`**，`ToolRestriction = { allow?: readonly string[]; deny?: readonly string[] }` | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:609`、`:475-480`；`grep confine` 在 `dsh-tools/lib/index.js` **零命中** |
| `:167` `getSectionOrder('TOOL_FS')` | `'TOOL_FS'` 不是合法 key | ❌ **静默错位**。`SECTION_ORDERS` 无 `TOOL_FS`（只有 `TOOL_READ`/`TOOL_WRITE`/`TOOL_EDIT`/`TOOL_GLOB`/`TOOL_GREP`/`TOOL_JOBS`/...）；实现是 `return SECTION_ORDERS[name]` → 返回 `undefined` → `Number.isFinite(undefined)` 为假 → 落到 `order: 500`，与 `PLAN_POLICY` 的 500 撞号 | `⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:109-141`；实现 `⟦PKG⟧/dsh-system-prompt/lib/index.js:247-248`；`PLAN_POLICY: 500` 见 `:112` |
| `:29` `getSectionOrder(name: string)` | 手搓结构类型把 key 放宽成 `string` | ⚠️ 这是上面那个错误**逃过 `tsc`** 的原因；真实签名是 `getSectionOrder(name: PromptSectionOrderName): number` | `⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:239` |
| `:164-166` `guard(execution => ...)` | 返回 `string \| undefined` 即拒 | ✅ **正确**，且 `guard` 可在 scoped ctx 上注册 | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:481-489,620` |
| `:170` `order: 500` 兜底 | 与 `PLAN_POLICY` 同号 | ⚠️ 不报错但位置不确定；同号时按 name 的 code-unit 顺序排 | `⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:50-54` |
| `:45-48` `OUTPUT.schema = {type:'object', additionalProperties:true}` | 合法子集 | ✅ 但**没有约束**：任何 JSON object 都通过；`render` 直接 `JSON.stringify(value)`，若返回 `undefined` 会在 `snapshotJsonValue` 处失败 | `⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:33`；`:2937` |
| `:5-8` 本地 `ToolExecution {agent?, signal}` | 结构子集 | ✅ 够用（只读 `agent?.id` 与 `signal`） | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:197-221` |
| `:79-152` 工具定义手搓（不经过 `defineTool`） | 只满足 §1.4 的结构校验 | ✅ **运行期合法**，但**没有参数校验**（`defineTool` 的 `validateArgs`） | `⟦PKG⟧/dsh-tools/lib/index.js:2776-2781`、`:863-867` |
| `:92,109,129,147` `repository.dispatch({...})` | 请求形状 | ✅ 全部存在且字段名匹配（`note.read.lines`/`note.insert`/`note.replace.lines`/`note.replace.text`） | `src/host/repository.ts:89`、`:374-381`、`:382-389`、`:390-398` |

### 9.3 需要加的 `inject` 条目

`static inject` 当前是 `['workspaceRegistry']`（`src/host/index.ts:68`）。要落地「本插件注册自己的 Agent 工具」，按最小必要性排列：

| 条目 | 为什么需要 | 依据 |
|---|---|---|
| **`'tools'`** | 访问 `ctx.tools`；注册全局工具、调用 `ctx.tools.schemas(scope)` | `⟦PKG⟧/dsh-tools/lib/index.js:2606`、`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:24-27` |
| **`'agents'`** | 用 `ctx.agents.get(sessionId)` 取回 live Agent 才能拿到 `agent.ctx`；或订阅 `agent/created` | `⟦PKG⟧/dsh-agent/lib/types/index.d.ts:19-20`、`⟦PKG⟧/dsh-agent/lib/index.js:563-564` |
| `'systemPrompt'` | 仅在**确实要**注册 prompt section 时才需要（`capabilities.ts:168` 有）。注意 `ctx.tools` **自身已** `static inject = ["systemPrompt"]`（`⟦PKG⟧/dsh-tools/lib/index.js:2568`），所以只要注入 `tools`，systemPrompt 必然已挂载 | `⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:233,239,267` |
| `'workspaceRegistry'` | 保留（现有 Typert 方法在用）；若工具要按 cwd 反查 workspace，**工具侧应直接用同一个 `ctx.workspaceRegistry`** | `src/host/index.ts:68,89`；`⟦PKG⟧/dsh-workspace/lib/types/index.d.ts:19-21` |

> 注意：`agent.ctx.tools` / `agent.ctx.systemPrompt` 的**读取不需要本插件 inject**（服务在根 ctx 上全局可见，scope ctx 只是继承）；inject 的作用是 (a) 保证服务存在后才加载，(b) 让 `ctx.tools` 在本插件 ctx 上可类型化访问，(c) 用于**全局**注册。

### 9.4 关于 `@deepseek-ai/dsh-tools` 依赖（两条可选路径）

实测：仓库当前**解析不到**它（§6.6）。构建用 `packages: 'external'`（`scripts/build.mjs:19`），新 import 会成为裸导入。

- **路径 A（推荐，零新依赖）**：**不 import `defineTool`**，像 `capabilities.ts` 那样手搓 `ToolDefinition` 形状的普通对象。依据：`register` 只做结构检查（`⟦PKG⟧/dsh-tools/lib/index.js:2776-2781`），`parameters` 只需是 lossless JSON（`⟦PKG⟧/dsh-tools/lib/index.js:2934-2943`）。代价：失去 `validateArgs` 自动校验（需在 `execute` 内手写参数校验，`capabilities.ts:50-65` 已有雏形），并且需要自己维护 `ToolDefinition` 的结构类型。
- **路径 B（若要 `defineTool` 的类型与校验）**：`pnpm add -D @deepseek-ai/dsh-tools@0.1.5-rc.2` 并加入 `peerDependencies`（照 `⟦PKG⟧/dsh-tool-todo/package.json:48` 的做法）。已实测该版本在注册表可得（`pnpm view` → `0.1.5-rc.2`）。
  - ⚠️ **要注意的事实**：本仓库已经在用一份**独立的** cordis 副本（`node_modules/@deepseek-ai/cordis` 是 pnpm junction 到 `.pnpm/@deepseek-ai+cordis@4.0.2/...`，而 DSH 安装在 `⟦PKG⟧/cordis`；dev Home 的 `profiles/node_modules/@deepseek-ai/cordis` 又 junction 到后者）。再引入一份 `dsh-tools` 会带来**第二个 `dsh-llm` 副本**，而 `HarnessError` 是**普通 `class extends Error`、没有跨副本 brand**（`⟦PKG⟧/dsh-llm/lib/index.js:121-129`），registry 的 `errorInfo()` 用自己那份做 `instanceof`（`⟦PKG⟧/dsh-tools/lib/index.js:2516-2525`）→ 由 `defineTool` 产生的 `INVALID_ARGS` 错误会**丢失结构化 `info`**（只影响诊断/路由，不影响功能）。这是**推断**，未实机验证，列入 §10。

### 9.5 具体接线建议（按顺序）

1. **修 `src/host/capabilities.ts` 的两个硬错误**（否则一调用即崩）：
   - `:24` 与 `:163`：`confine` → **`restrict`**，签名 `restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void`（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:475-480,609`）。
   - `:167`：`'TOOL_FS'` → 换成真实存在的 key。若目的是「跟文件系统工具挨着」，最合适的是 `'TOOL_READ'`（`⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:118`，内置 `read` 用的就是它：`⟦PKG⟧/dsh-tool-fs/lib/index.js:328`）。同时把 `AgentScope.getSectionOrder` 的参数类型从 `string` 收紧，让 `tsc` 能拦住同类错误（`⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:143,239`）。
2. **把 `capabilities.ts` 接上**：在 `src/host/index.ts` 的 `SiftService` 里
   - `static inject = ['workspaceRegistry', 'tools', 'agents']`（§9.3）；
   - 构造 `this.repository = new SiftRepository(<root>)`（`SiftRepository` 目前**从未实例化**，`src/host/repository.ts:67-78`）；
   - 订阅 `agent/created`（`⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:223-226`）时调用 `configureProjectAgent({ agents: ctx.agents, tools: ctx.tools }, this.repository, agent.id)`，并保存返回的 disposer；`agent/disposed` 时清理（虽然 scoped 注册会自动 unwind，显式清理无害且便于观测）。
   - 注意 `capabilities.ts` 现在是**全局** `CapabilityHost` 形状（`host.tools.schemas(agent)`、`host.agents.get(...)`），与 `SiftService` 的 ctx 适配只需传 `{ agents: ctx.agents, tools: ctx.tools }`。
3. **`sourceId` 的 workspace 归属**：不要为每个 workspace 注册一套工具。在 `execute` 内用 `exec.agent.id` → `repository.projectForSession(sessionId)`（`src/host/repository.ts:113-116`）→ 校验 `sourceId` 属于该 project 的 solution（模式参考 `src/host/repository.ts:253-261`）。这也正是 `capabilities.ts:67-73` `projectIdFor()` 已经写好的做法。
4. **不要**在 `handler` 里找 logger（`exec` 上没有）；用 `ctx.logger`（`⟦PKG⟧/cordis/lib/types/context.d.ts:26-27`）。
5. **不要**忘了 `output.schema`——它比 `parameters` 更硬：缺失即 `TypeError`（`⟦PKG⟧/dsh-tools/lib/index.js:2776`），成功值不符则 `ToolOutputError`（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:383-388`）。
6. `typert.ts` / `remote.ts` / `cordis.patch.yml` / `package.json` 的 `dsh.bundle.patch` **都不需要为「注册工具」而改动**（工具注册不是 Remote，是进程内 Cordis 服务调用）。
7. Web UI 呈现：内置 Web Client **不消费** `presentCall`/`presentResult`，它按 `tool.call.toolview` 选择渲染器并从原始参数/结果派生卡片；新工具会走通用卡片（`⟦PKG⟧/dsh-tools/README.md:87-89`）。所以**首版不必写 presenter**。

---

## Unknowns / could not verify

1. **`pnpm add @deepseek-ai/dsh-tools` 之后，第二份 `dsh-llm` / `dsh-tools` 副本对 `HarnessError instanceof` 的实际影响**——`HarnessError` 无跨副本 brand（`⟦PKG⟧/dsh-llm/lib/index.js:121-129`），registry 的 `errorInfo()` 用自己的副本判断（`⟦PKG⟧/dsh-tools/lib/index.js:2516-2525`），因此**推断** `defineTool` 抛出的 `INVALID_ARGS` 会丢失 `info`。未实机跑过。**建议**：为避免该不确定性，走 §9.4 的路径 A（不 import `defineTool`）。
2. **`register` 返回值的静态类型与运行时类型的差异**：`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:601` 声明 `() => void`，实现返回 `ctx.effect()` 的 `Disposable<Promise<void>>`（`⟦PKG⟧/cordis/lib/types/fiber.d.ts:157`）。二者可调用性一致；`Promise` 是否可靠被 await 到最终卸载完成，未实测。
3. **`agent/created` 触发时 `agent.ctx` 是否已可注册**：类型文档称「A fully configured agent and live session were published」（`⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:214-220`），且「Setup is composition-only」；但**没有实测**在该事件里注册工具。相对保守的替代是 `ctx.agents.get(sessionId)`（`capabilities.ts:156` 的现有写法），它在 Agent 已入 store 后一定可用。
4. **`tools/restrict` 与 scoped 注册的交互在本仓库场景下的实际可见集合**：类型文档称「A restriction filters what a scope inherits … and never what its OWN layer registers」（`⟦PKG⟧/dsh-tools/lib/types/index.d.ts:630-641`），所以 `restrict({ allow: [...] })` 不会砍掉本 Agent 自己注册的 `sift_note_*`。逻辑上正确，未实测。
5. **`dsh-tool-*` 包为何不需要 `dsh` 字段的完整机制**：已验证它们被 `⟦PKG⟧/dsh-base/cordis.patch.yml` 的行挂载（`:401-404` 等），且 `dsh.bundle.patch` 只对 `dsh.profile.bundles` 里列出的包必需（`⟦PKG⟧/dsh-app-boot/lib/index.js:849-853`）。但**未**验证「一个不在任何 bundle 的 patch 里、也不是 bundle 的包」是否有其它被加载路径。
6. **`package.json` 的 `"./cordis.patch.yml"` 子路径导出是否真的被谁读取**：`dsh-app-boot` 用的是 `join(packageDir, declared)` 的文件系统路径（`⟦PKG⟧/dsh-app-boot/lib/index.js:853`），**不经过 exports**。本仓库 `package.json:12` 声明了它，但未找到消费者；可能是为镜像打包器或人工使用准备的。
7. **PTC 模式（`mode: 'ptc'|'both'`）下 scoped 注册工具的行为**：默认 web profile 未开启（`⟦PKG⟧/dsh-base/cordis.patch.yml:458-461`），本报告未实测；已知约束是「model-direct 调用只允许 `run_code`」（`⟦PKG⟧/dsh-tools/lib/index.js:2735-2738`、`⟦PKG⟧/dsh-tools/README.md:227`）。
8. **未找到 DSH 源码仓库里的 `docs/cookbook/adding-a-tool.md`**（`⟦PKG⟧/dsh-tools/README.md:146` 引用了它）——发布包不含该文档，未能作为交叉验证来源。

---

## 附：本报告用到的关键 `path:line` 速查

| 主题 | 引用 |
|---|---|
| 服务名 `tools` | `⟦PKG⟧/dsh-tools/lib/index.js:2606` |
| `ctx.tools` 类型增强 | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:24-27` |
| `register` 签名 | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:601` |
| `register` 实现（disposer 来源） | `⟦PKG⟧/dsh-tools/lib/index.js:2773-2782` |
| `ToolDefinition` | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:105-172` |
| `ToolSchema` | `⟦PKG⟧/dsh-llm/lib/types/types.d.ts:397-402` |
| `ToolOutputDefinition` | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:96-104` |
| `ToolRunContext` | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:284-301` |
| `ToolExecutionInput` | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:197-221` |
| 结果类型 | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:389-412` |
| `ContentBlock` | `⟦PKG⟧/dsh-llm/lib/types/types.d.ts:39-42,91-102` |
| schema DSL | `⟦PKG⟧/dsh-tools/lib/types/schema.d.ts:20-88,157-163,239` |
| raw JSON Schema 子集 | `⟦PKG⟧/dsh-tools/lib/types/json-schema.d.ts:16-49` |
| 完整内置工具示例 | `⟦PKG⟧/dsh-tool-todo/lib/index.js:95-193` |
| `ToolRestriction` | `⟦PKG⟧/dsh-tools/lib/types/index.d.ts:475-480` |
| `restrict` 必须 scoped | `⟦PKG⟧/dsh-tools/lib/index.js:2791-2792` |
| scope key = Agent | `⟦PKG⟧/dsh-agent-loop/lib/index.js:761-762` |
| `Agent.ctx` 文档 | `⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:148-149` |
| traceable `.ctx` 机制 | `⟦PKG⟧/cordis/lib/index.js:125-128,1773-1780` |
| `ScopedLayers.effect` | `⟦PKG⟧/dsh-scope/lib/types/store.d.ts:96-108,134-144` |
| `ctx.effect` | `⟦PKG⟧/cordis/lib/types/fiber.d.ts:8,145-159` |
| `ctx.inject` | `⟦PKG⟧/cordis/lib/types/registry.d.ts:99-111` |
| `inject` 读取点 | `⟦PKG⟧/cordis/lib/index.js:1634` |
| 类插件实例化 | `⟦PKG⟧/cordis/lib/index.js:1066-1070` |
| `dsh` 字段类型 | `⟦PKG⟧/dsh-package-manifest/lib/types/types.d.ts:6-28` |
| bundle patch 解析 | `⟦PKG⟧/dsh-app-boot/lib/index.js:291-299,843-859` |
| loader 模块→插件 | `⟦PKG⟧/cordis-plugin-loader/src/config/entry.ts:280,291-297`；`src/index.ts:191-198` |
| SECTION_ORDERS | `⟦PKG⟧/dsh-system-prompt/lib/types/index.d.ts:109-141` |
| `agent/created` | `⟦PKG⟧/dsh-agent/lib/types/runtime-types.d.ts:212-226` |
| `ctx.agents` | `⟦PKG⟧/dsh-agent/lib/types/index.d.ts:19-20` |
| session cwd | `⟦PKG⟧/dsh-session/lib/types/types.d.ts:69` |
| `Workspace` 实体 | `⟦PKG⟧/dsh-workspace/lib/types/types.d.ts:9-13,28-51` |
