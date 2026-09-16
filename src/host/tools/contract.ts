/**
 * Sift 注册 Agent 工具所需的最小契约复刻。
 *
 * 与 `dsh-adapter/input-trigger.ts` 同理：`@deepseek-ai/dsh-tools` 没有安装在本仓库，
 * 这里按 0.1.5-rc.2 复刻注册所需的形状。依据见
 * docs/dsh-tool-registration-api-research.md §1、§2、§3。
 *
 * 有两条容易写错的硬约束（已直接核对编译产物 dsh-tools/lib/index.js）：
 * 1. `register` 只对手搓定义的 `output.schema` 跑 `assertSupportedJsonSchema`，
 *    不接受 DSL 的属性级 `required: true`；手搓定义**必须**用标准 `required: string[]`。
 * 2. `parameters` 在注册时完全不校验，但下游（`jsonSchemaToTs`、`renderType`）
 *    直接消费 raw JSON Schema —— `defineTool` 在 lib/index.js:846 才把 DSL 编译成 raw，
 *    所以手搓定义这里也必须是 raw JSON Schema。
 */

/** 给模型看的内容块；Sift 目前只用文本块。 */
export interface TextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/** 被强制执行的 JSON Schema 子集（json-schema.d.ts:16-49）。只使用这些关键字。 */
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  oneOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  description?: string;
  title?: string;
}

/** 执行上下文；只有 signal 与 agent 是 Sift 需要的部分。 */
export interface ToolRunContext {
  readonly signal: AbortSignal;
  readonly agent?: { readonly id: string };
}

export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;
  /** 唯一给模型看的文本来源；execute 的返回值不是文本。 */
  render(args: unknown, value: never): TextContentBlock[];
  presentationMeta?(args: unknown, value: never): unknown;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** raw JSON Schema（不是 DSL）。 */
  readonly parameters: Record<string, unknown>;
  readonly output: ToolOutputDefinition;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

/** `ctx.tools` 的注册面。 */
export interface ToolRuntimeContract {
  register(definition: ToolDefinition): () => void;
}
