import { z } from 'zod';
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import { entriesSchema, materialsSchema } from './materials.js';
import { documentIndexSchema, siftDocumentSchema } from './documents.js';
import { sourceIndexSchema, sourceSchema } from './sources.js';
import { referenceDocumentSchema, relationLookupSchema, referenceSummarySchema } from './references.js';

export const PACKAGE = '@songyanglin/dsh-sift';

export const descriptors: TypertRemoteContribution['descriptors'][number][] = [];

for (const [method, input, output] of [
  ['getMaterials', z.object({ workspaceId: z.string() }), materialsSchema],
  ['listMaterialFiles', z.object({ workspaceId: z.string(), path: z.string() }), entriesSchema],
  ['addMaterial', z.object({ workspaceId: z.string(), kind: z.enum(['file', 'url']), target: z.string() }), materialsSchema],
  ['removeMaterial', z.object({ workspaceId: z.string(), id: z.string() }), materialsSchema],
  ['readMaterial', z.object({ workspaceId: z.string(), id: z.string() }), z.object({ base64: z.string() })],
] as const) {
  descriptors.push({ id: `${PACKAGE}#sift/${method}`, service: 'sift', namespace: 'sift', method, implementation: method,
    invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, create: () => input } }],
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, create: () => output },
  });
}

for (const [method, input, output] of [
  ['listDocuments', z.object({ workspaceId: z.string() }), documentIndexSchema],
  ['saveDocument', z.object({ workspaceId: z.string(), documentId: z.string(), title: z.string().optional(), content: z.string(), targetDirectory: z.string().optional() }),
    z.object({ index: documentIndexSchema, document: siftDocumentSchema, created: z.boolean() })],
  ['readDocumentContent', z.object({ workspaceId: z.string(), documentId: z.string() }), z.object({ content: z.string(), path: z.string() })],
  ['addExistingDocument', z.object({ workspaceId: z.string(), documentId: z.string(), path: z.string() }), z.object({ index: documentIndexSchema, document: siftDocumentSchema, added: z.boolean() })],
  ['detachDocument', z.object({ workspaceId: z.string(), documentId: z.string() }), documentIndexSchema],
  ['removeDocument', z.object({ workspaceId: z.string(), documentId: z.string() }), documentIndexSchema],
] as const) {
  descriptors.push({ id: `${PACKAGE}#sift/${method}`, service: 'sift', namespace: 'sift', method, implementation: method,
    invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, create: () => input } }],
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, create: () => output },
  });
}

const sourceMutationSchema = z.object({ index: sourceIndexSchema, source: sourceSchema }).readonly();

/** Windows 原生剪贴板快照（Host 端 koffi 读取）；字段缺省表示剪贴板没有该格式。 */
const clipboardSnapshotSchema = z.object({
  text: z.string().optional(),
  files: z.array(z.string()).optional(),
  html: z.object({
    fragment: z.string().optional(),
    sourceUrl: z.string().optional(),
  }).optional(),
  url: z.string().optional(),
}).readonly();

for (const [method, input, output] of [
  ['listSources', z.object({ workspaceId: z.string() }), sourceIndexSchema],
  ['addSource', z.object({ workspaceId: z.string(), type: z.enum(['file', 'url']), location: z.enum(['workspace', 'external']).optional(), target: z.string(), title: z.string().optional() }), sourceMutationSchema],
  ['removeSource', z.object({ workspaceId: z.string(), id: z.string() }), sourceIndexSchema],
  ['addExternalFiles', z.object({ workspaceId: z.string(), paths: z.array(z.string()) }),
    z.object({ index: sourceIndexSchema, added: z.array(sourceSchema), failed: z.array(z.object({ target: z.string(), message: z.string() })) }).readonly()],
  ['pickSourceFiles', z.object({}).readonly(), z.object({ paths: z.array(z.string()), cancelled: z.boolean(), message: z.string().optional() }).readonly()],
  ['createSourceFile', z.object({ workspaceId: z.string(), name: z.string(), content: z.string() }), sourceMutationSchema],
  ['browseWorkspace', z.object({ workspaceId: z.string(), path: z.string() }), entriesSchema],
  ['browseExternal', z.object({ path: z.string() }), entriesSchema],
] as const) {
  descriptors.push({ id: `${PACKAGE}#sift/${method}`, service: 'sift', namespace: 'sift', method, implementation: method,
    invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, create: () => input } }],
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, create: () => output },
  });
}

descriptors.push({ id: `${PACKAGE}#sift/readClipboard`, service: 'sift', namespace: 'sift', method: 'readClipboard', implementation: 'readClipboard',
  invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#readClipboardRequest`, create: () => z.object({}).readonly() } }],
  result: { mode: 'strict', typeSymbol: `${PACKAGE}#readClipboardResult`, create: () => clipboardSnapshotSchema },
});

const referenceSummaryArraySchema = z.array(referenceSummarySchema).readonly();

for (const [method, input, output] of [
  ['listReferences', z.object({ workspaceId: z.string() }), referenceSummaryArraySchema],
  ['loadReference', z.object({ workspaceId: z.string(), path: z.string() }), referenceDocumentSchema],
  ['createReference', z.object({ workspaceId: z.string(), name: z.string().optional() }), z.object({ path: z.string() })],
  ['importConversationReference', z.object({ workspaceId: z.string(), sourcePath: z.string() }), z.object({ path: z.string() })],
  ['saveReference', z.object({ workspaceId: z.string(), path: z.string(), reference: referenceDocumentSchema }), z.object({})],
  ['analyzeConversation', z.object({ workspaceId: z.string(), path: z.string(), anchorGroupId: z.string() }), referenceDocumentSchema],
  ['analyzeConversationTopic', z.object({ workspaceId: z.string(), path: z.string(), topic: z.string() }), referenceDocumentSchema],
  ['removeReference', z.object({ workspaceId: z.string(), path: z.string() }), z.object({})],
  ['getArticleRelations', z.object({ workspaceId: z.string(), target: z.string() }), relationLookupSchema],
  ['setArticleRelations', z.object({ workspaceId: z.string(), target: z.string(), references: z.array(z.string()) }), z.object({})],
  ['openSourcePath', z.object({ path: z.string() }), z.object({})],
] as const) {
  descriptors.push({ id: `${PACKAGE}#sift/${method}`, service: 'sift', namespace: 'sift', method, implementation: method,
    invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, create: () => input } }],
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, create: () => output },
    ...((method === 'analyzeConversation' || method === 'analyzeConversationTopic') ? { cancellation: { parameter: 'signal' } } : {}),
  });
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors,
};

export default TYPERT_REMOTE;
