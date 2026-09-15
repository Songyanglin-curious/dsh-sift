import type { SiftRepository } from './repository.js';

type JsonObject = Record<string, unknown>;

interface ToolExecution {
  agent?: { id: string };
  signal: AbortSignal;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  output: {
    schema: JsonObject;
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, execution: ToolExecution): Promise<unknown>;
}

interface AgentScope {
  tools: {
    register(tool: ToolDefinition): () => void;
    confine(filter: { allow: readonly string[] }): () => void;
    guard(guard: (execution: { name: string }) => string | undefined): () => void;
  };
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void;
    getSectionOrder(name: string): number;
  };
}

export interface SiftAgent {
  id: string;
  ctx: AgentScope;
}

export interface CapabilityHost {
  agents: { get(sessionId: string): SiftAgent | undefined };
  tools: { schemas(agent: SiftAgent): Array<{ name: string }> };
}

const SAFE_GENERAL_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch']);

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

function objectArgs(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是对象。');
  return value as JsonObject;
}

function integer(args: JsonObject, name: string, minimum: number): number {
  const value = args[name];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} 必须是不小于 ${minimum} 的整数。`);
  return value as number;
}

function string(args: JsonObject, name: string, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new Error(`${name} 必须是${allowEmpty ? '' : '非空'}字符串。`);
  return value;
}

async function projectIdFor(repository: SiftRepository, sessionId: string, execution: ToolExecution): Promise<string> {
  if (execution.signal.aborted) throw execution.signal.reason;
  if (execution.agent?.id !== sessionId) throw new Error('Sift 笔记工具只能由关联的项目会话调用。');
  const project = await repository.projectForSession(sessionId);
  if (!project) throw new Error('当前 DSH 会话未关联 Sift 项目。');
  return project.id;
}

export function createNoteTools(repository: SiftRepository, sessionId: string): ToolDefinition[] {
  return [
    {
      name: 'sift_note_read',
      description: '读取当前 Sift 项目成果笔记并返回带行号内容和版本。目标由当前会话绑定解析，不接受文件路径。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
      },
      output: OUTPUT,
      async execute(raw, execution) {
        const args = objectArgs(raw);
        const start = args.start_line === undefined ? 1 : integer(args, 'start_line', 1);
        const end = args.end_line === undefined ? 1_000_000 : integer(args, 'end_line', 1);
        return repository.dispatch({ type: 'note.read.lines', projectId: await projectIdFor(repository, sessionId, execution), startLine: start, endLine: end });
      },
    },
    {
      name: 'sift_note_insert',
      description: '按版本在当前 Sift 项目成果笔记指定行后插入 Markdown；0 表示文件开头。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          after_line: { type: 'integer', minimum: 0 }, content: { type: 'string' }, expected_version: { type: 'string' },
        },
        required: ['after_line', 'content', 'expected_version'],
      },
      output: OUTPUT,
      async execute(raw, execution) {
        const args = objectArgs(raw);
        return repository.dispatch({
          type: 'note.insert', projectId: await projectIdFor(repository, sessionId, execution),
          afterLine: integer(args, 'after_line', 0), content: string(args, 'content', true), expectedVersion: string(args, 'expected_version'),
        });
      },
    },
    {
      name: 'sift_note_replace_lines',
      description: '按版本替换当前 Sift 项目成果笔记中的闭区间行范围。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 },
          replacement: { type: 'string' }, expected_version: { type: 'string' },
        },
        required: ['start_line', 'end_line', 'replacement', 'expected_version'],
      },
      output: OUTPUT,
      async execute(raw, execution) {
        const args = objectArgs(raw);
        return repository.dispatch({
          type: 'note.replace.lines', projectId: await projectIdFor(repository, sessionId, execution),
          startLine: integer(args, 'start_line', 1), endLine: integer(args, 'end_line', 1),
          replacement: string(args, 'replacement', true), expectedVersion: string(args, 'expected_version'),
        });
      },
    },
    {
      name: 'sift_note_replace_text',
      description: '按版本替换当前 Sift 项目成果笔记中唯一匹配的文本。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { match: { type: 'string' }, replacement: { type: 'string' }, expected_version: { type: 'string' } },
        required: ['match', 'replacement', 'expected_version'],
      },
      output: OUTPUT,
      async execute(raw, execution) {
        const args = objectArgs(raw);
        return repository.dispatch({
          type: 'note.replace.text', projectId: await projectIdFor(repository, sessionId, execution),
          match: string(args, 'match'), replacement: string(args, 'replacement', true), expectedVersion: string(args, 'expected_version'),
        });
      },
    },
  ];
}

export function configureProjectAgent(host: CapabilityHost, repository: SiftRepository, sessionId: string): (() => void) | null {
  const agent = host.agents.get(sessionId);
  if (!agent) return null;
  const inherited = host.tools.schemas(agent).map(tool => tool.name);
  const allowed = inherited.filter(name => SAFE_GENERAL_TOOLS.has(name));
  const noteTools = createNoteTools(repository, sessionId);
  const disposers = noteTools.map(tool => agent.ctx.tools.register(tool));
  const allowedNames = new Set([...allowed, ...noteTools.map(tool => tool.name)]);
  disposers.push(agent.ctx.tools.confine({ allow: [...allowedNames] }));
  disposers.push(agent.ctx.tools.guard(execution => allowedNames.has(execution.name)
    ? undefined
    : '当前 Sift 项目会话不允许使用该工具。'));
  const filesystemOrder = agent.ctx.systemPrompt.getSectionOrder('TOOL_FS');
  disposers.push(agent.ctx.systemPrompt.section({
    name: 'sift:project-note',
    order: Number.isFinite(filesystemOrder) ? filesystemOrder : 500,
    text: '当前会话属于一个 Sift 项目。只在用户明确要求修改成果笔记后调用 sift_note_insert、sift_note_replace_lines 或 sift_note_replace_text；写入前先用 sift_note_read 获取当前版本。不要尝试修改素材、批注、关系数据或其他项目笔记。',
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
