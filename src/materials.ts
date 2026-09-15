import { z } from 'zod';

export const materialSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(['file', 'url']), target: z.string() });
export type Material = z.infer<typeof materialSchema>;
export const materialsSchema = z.object({ schemaVersion: z.literal(1), items: z.array(materialSchema) });
export type Materials = z.infer<typeof materialsSchema>;
export const entriesSchema = z.array(z.object({ path: z.string(), name: z.string(), directory: z.boolean() }));
export type FileEntry = z.infer<typeof entriesSchema>[number];
export type MaterialFormat = 'md' | 'pdf' | 'docx' | 'doc' | 'url' | 'unsupported';
export function materialFormat(material: Pick<Material, 'kind' | 'target'>): MaterialFormat {
  if (material.kind === 'url') return 'url';
  const extension = material.target.split('.').at(-1)?.toLowerCase();
  if (extension === 'markdown') return 'md';
  return extension === 'md' || extension === 'pdf' || extension === 'docx' || extension === 'doc' ? extension : 'unsupported';
}
export function normalizeMaterialUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不含账号密码的 HTTP 或 HTTPS 网页地址。');
  return url.href;
}
export interface MaterialsApi {
  getMaterials(input: { workspaceId: string }): Promise<Materials>;
  listMaterialFiles(input: { workspaceId: string; path: string }): Promise<FileEntry[]>;
  addMaterial(input: { workspaceId: string; kind: 'file' | 'url'; target: string }): Promise<Materials>;
  removeMaterial(input: { workspaceId: string; id: string }): Promise<Materials>;
  readMaterial(input: { workspaceId: string; id: string }): Promise<{ base64: string }>;
}
