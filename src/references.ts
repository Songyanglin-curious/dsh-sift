import { z } from 'zod';

/**
 * Reference 的共享模型（阶段性实施方案 §1、§3、§4）。
 *
 * 核心原则：
 * - Reference 是文件级实体，不保存 id、不保存自身路径——相对路径就是定位符；
 * - cards[] 的数组顺序就是卡片顺序，不保存 order；
 * - 来源属于 Card；没有来源时直接缺省，不写 unknown 占位数据；
 * - Card 的 id 只用于 Reference 文件内部的稳定定位（DOM key、删除、排序），
 *   不承担跨文件实体定位职责；
 * - Document → Reference 关联独立存在 relations.json，Reference 文件不感知。
 *
 * client 侧只允许 import type（类型擦除，zod 不进浏览器 bundle）。
 */

export const REFERENCE_DEFAULT_NAME = '未命名参考';

/** `.sift` 下的 Reference 文件目录名。 */
export const REFERENCES_DIRECTORY = 'references';

/** `.sift` 下的关系文件名。 */
export const RELATIONS_FILE = 'relations.json';

/** `.sift` 相对路径的形状：references/<basename>.json。 */
export const REFERENCE_PATH_PATTERN = /^references\/[A-Za-z0-9_-]+\.json$/;

export const referenceSourceSchema = z.object({
  type: z.enum(['web', 'file', 'manual', 'clipboard']),
  uri: z.string().optional(),
  title: z.string().optional(),
});
export type ReferenceCardSource = z.infer<typeof referenceSourceSchema>;

export const referenceCardSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: referenceSourceSchema.optional(),
});
export type ReferenceCard = z.infer<typeof referenceCardSchema>;

export const referenceDocumentSchema = z.object({
  name: z.string(),
  description: z.string(),
  cards: z.array(referenceCardSchema),
});
export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;

export function emptyReferenceDocument(name: string = REFERENCE_DEFAULT_NAME): ReferenceDocument {
  return { name, description: '', cards: [] };
}

/** 面板列表用的一行摘要；path 是 `.sift` 相对路径，如 references/6f4a81c2.json。 */
export const referenceSummarySchema = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string(),
});
export type ReferenceSummary = z.infer<typeof referenceSummarySchema>;

/** relations.json 的一条：某个稳定 Document id 使用了哪些 Reference。 */
export const relationEntrySchema = z.object({
  target: z.string(),
  references: z.array(z.string()),
});

/** 查询结果必须区分“尚未初始化”和“用户明确清空”。 */
export const relationLookupSchema = z.object({
  exists: z.boolean(),
  references: z.array(z.string()),
});
export type RelationLookup = z.infer<typeof relationLookupSchema>;

export const relationFileSchema = z.object({
  relations: z.array(relationEntrySchema),
});
export type RelationFile = z.infer<typeof relationFileSchema>;

export function emptyRelationFile(): RelationFile {
  return { relations: [] };
}
