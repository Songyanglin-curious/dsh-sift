import { z } from 'zod';

export const PACKAGE = '@songyanglin/dsh-sift';

const id = z.string().min(1).max(200);
const text = z.string().max(200_000);
const nullablePath = z.string().trim().max(4_096).nullable();
const anchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), prefix: z.string().max(500), suffix: z.string().max(500) }),
  z.object({ kind: z.literal('pdf'), page: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('message'), messageId: id, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
]).nullable();

export const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('catalog.get') }),
  z.object({
    type: z.literal('solution.create'),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5_000).default(''),
    workspacePath: nullablePath.default(null),
  }),
  z.object({
    type: z.literal('solution.update'),
    id,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5_000),
    workspacePath: nullablePath,
  }),
  z.object({ type: z.literal('solution.delete'), id }),
  z.object({
    type: z.literal('project.create'),
    solutionId: id,
    title: z.string().trim().min(1).max(200),
    goal: z.string().max(10_000).default(''),
    notePath: nullablePath.default(null),
  }),
  z.object({
    type: z.literal('project.update'),
    id,
    title: z.string().trim().min(1).max(200),
    goal: z.string().max(10_000),
  }),
  z.object({ type: z.literal('project.delete'), id }),
  z.object({ type: z.literal('project.session.bind'), projectId: id, sessionId: id, activate: z.boolean().default(true) }),
  z.object({ type: z.literal('project.session.activate'), projectId: id, sessionId: id }),
  z.object({ type: z.literal('project.session.unbind'), projectId: id, sessionId: id }),
  z.object({
    type: z.literal('source.create'),
    projectId: id,
    kind: z.enum(['file', 'url', 'text']),
    title: z.string().trim().min(1).max(500),
    location: z.string().max(8_192).default(''),
    content: text.optional(),
    mediaType: z.string().max(200).nullable().default(null),
  }),
  z.object({ type: z.literal('source.attach'), projectId: id, id }),
  z.object({ type: z.literal('source.detach'), projectId: id, id }),
  z.object({ type: z.literal('source.remove'), solutionId: id, id, affectedProjectIds: z.array(id) }),
  z.object({ type: z.literal('source.relocate'), id, location: z.string().trim().min(1).max(8_192) }),
  z.object({ type: z.literal('source.preview'), id }),
  z.object({ type: z.literal('source.binary'), id }),
  z.object({
    type: z.literal('annotation.create'),
    projectId: id,
    target: z.enum(['source', 'note', 'message']),
    targetId: id.nullable(),
    snapshot: z.object({
      quote: z.string().min(1).max(50_000),
      title: z.string().max(500),
      location: z.string().max(8_192).nullable(),
      documentVersion: z.string().max(200),
      anchor,
    }),
    comment: z.string().trim().min(1).max(50_000),
  }),
  z.object({ type: z.literal('annotation.comment.update'), id, comment: z.string().trim().min(1).max(50_000) }),
  z.object({ type: z.literal('annotation.delete'), id }),
  z.object({
    type: z.literal('annotation.send.record'), projectId: id, sessionId: id,
    mode: z.enum(['queue', 'steer']),
    annotationVersions: z.array(z.object({ annotationId: id, commentVersion: z.number().int().positive() })),
    messageTextVersion: z.string().max(200),
  }),
  z.object({
    type: z.literal('workstate.update'), projectId: id,
    state: z.object({
      openTabs: z.array(id), activeTab: id,
      readingLocations: z.record(z.string(), z.unknown()),
      noteDraft: text.nullable(), noteDraftBaseVersion: z.string().max(200).nullable(),
      selectedAnnotationIds: z.array(id),
      materialWidth: z.number().min(180).max(1_200), conversationWidth: z.number().min(280).max(1_600),
      materialTreeCollapsed: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('note.read'), projectId: id }),
  z.object({
    type: z.literal('note.write'),
    projectId: id,
    content: text,
    expectedVersion: z.string().max(200).nullable(),
    actor: z.enum(['human', 'ai', 'rollback']).default('human'),
  }),
  z.object({ type: z.literal('note.read.lines'), projectId: id, startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
  z.object({
    type: z.literal('note.replace.lines'), projectId: id, startLine: z.number().int().positive(), endLine: z.number().int().positive(),
    replacement: text, expectedVersion: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('note.replace.text'), projectId: id, match: z.string().min(1).max(100_000), replacement: text,
    expectedVersion: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal('note.rollback'), projectId: id, revisionId: id, expectedVersion: z.string().min(1).max(200) }),
]);

export type SiftRequest = z.infer<typeof requestSchema>;
export const resultSchema = z.json();

export function descriptors() {
  return [{
    id: `${PACKAGE}#sift/dispatch`,
    service: 'sift',
    namespace: 'sift',
    method: 'dispatch',
    implementation: 'remoteDispatch',
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `${PACKAGE}#SiftRequest`, schema: requestSchema },
    }],
    result: { mode: 'strict' as const, typeSymbol: `${PACKAGE}#SiftResult`, schema: resultSchema },
  }];
}

export const SIFT_REMOTE = { package: PACKAGE, descriptors: descriptors() };
