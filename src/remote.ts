import { z } from 'zod';
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import { entriesSchema, materialsSchema } from './materials.js';

const profileSchema = z.object({
  workspaceId: z.string(),
  title: z.string(),
  profile: z.union([z.literal('default'), z.literal('sift')]),
  status: z.union([z.literal('ready'), z.literal('missing'), z.literal('invalid')]),
  message: z.string().optional(),
}).readonly();

export const PACKAGE = '@songyanglin/dsh-sift';

export const descriptors: TypertRemoteContribution['descriptors'][number][] = [{
    id: '@songyanglin/dsh-sift#sift/getWorkspaceProfile',
    service: 'sift',
    namespace: 'sift',
    method: 'getWorkspaceProfile',
    implementation: 'getWorkspaceProfile',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'input',
      wire: 'input',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@songyanglin/dsh-sift#WorkspaceProfileRequest',
        schema: z.object({ workspaceId: z.string() }).readonly(),
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: '@songyanglin/dsh-sift#WorkspaceProfileResult',
      schema: profileSchema,
    },
  }, {
    id: '@songyanglin/dsh-sift#sift/setWorkspaceProfile',
    service: 'sift',
    namespace: 'sift',
    method: 'setWorkspaceProfile',
    implementation: 'setWorkspaceProfile',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'input', wire: 'input', source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@songyanglin/dsh-sift#SetWorkspaceProfileRequest',
        schema: z.object({ workspaceId: z.string(), profile: z.union([z.literal('default'), z.literal('sift')]) }).readonly(),
      },
    }],
    result: { mode: 'strict', typeSymbol: '@songyanglin/dsh-sift#WorkspaceProfileResult', schema: profileSchema },
  }];

for (const [method, input, output] of [
  ['getMaterials', z.object({ workspaceId: z.string() }), materialsSchema],
  ['listMaterialFiles', z.object({ workspaceId: z.string(), path: z.string() }), entriesSchema],
  ['addMaterial', z.object({ workspaceId: z.string(), kind: z.enum(['file', 'url']), target: z.string() }), materialsSchema],
  ['removeMaterial', z.object({ workspaceId: z.string(), id: z.string() }), materialsSchema],
  ['readMaterial', z.object({ workspaceId: z.string(), id: z.string() }), z.object({ base64: z.string() })],
] as const) {
  descriptors.push({ id: `${PACKAGE}#sift/${method}`, service: 'sift', namespace: 'sift', method, implementation: method,
    invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, schema: input } }],
    result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, schema: output },
  });
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors,
};

export default TYPERT_REMOTE;
