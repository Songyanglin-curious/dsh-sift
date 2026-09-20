import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  REFERENCES_DIRECTORY,
  REFERENCE_DEFAULT_NAME,
  REFERENCE_PATH_PATTERN,
  RELATIONS_FILE,
  emptyRelationFile,
  referenceDocumentSchema,
  relationFileSchema,
  type ReferenceDocument,
  type ReferenceSummary,
} from '../../references.js';
import { isMissingFile, serialize, writeTextAtomic } from '../storage/workspace-files.js';

/**
 * Reference / Relation 的宿主侧存储（阶段性实施方案 §8）。
 *
 * 刻意做薄：不是数据库式 Repository，只是 JSON 文件读写 + 路径守卫。
 * - Reference 的 `.sift` 相对路径就是定位符，文件名随机且永不重命名；
 * - Relation 独立存 relations.json，Reference 文件不感知被谁使用；
 * - 所有写入按工作区串行 + 临时文件原子替换。
 */

function siftDirectory(root: string): string {
  return resolve(root, '.sift');
}

async function ensureReferencesDirectory(root: string): Promise<string> {
  const directory = resolve(siftDirectory(root), REFERENCES_DIRECTORY);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * 把 `.sift` 相对路径解析成绝对路径。
 * 只接受 `references/<basename>.json` 形状，从根上拒绝目录穿越。
 */
function resolveReferencePath(root: string, path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!REFERENCE_PATH_PATTERN.test(normalized)) {
    throw new Error(`非法的 Reference 路径：${path}`);
  }
  const target = resolve(siftDirectory(root), normalized);
  const rel = relative(siftDirectory(root), target);
  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new Error(`非法的 Reference 路径：${path}`);
  }
  return target;
}

/** relations 的 target 是工作区相对路径；只做形状守卫，不要求文件已存在。 */
function assertSafeRelationTarget(target: string): void {
  if (target.trim() === '' || isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
    throw new Error(`非法的 Document 路径：${target}`);
  }
}

function relationsFile(root: string): string {
  return resolve(siftDirectory(root), RELATIONS_FILE);
}

async function readRelationFile(root: string): Promise<ReturnType<typeof relationFileSchema.parse>> {
  try {
    return relationFileSchema.parse(JSON.parse(await readFile(relationsFile(root), 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) return emptyRelationFile();
    throw new Error(`relations.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── ReferenceStore ────────────────────────────────────

/** 扫描 references/*.json 形成 Summary；损坏的文件跳过，不阻断整个面板。 */
export async function listReferences(root: string): Promise<ReferenceSummary[]> {
  const directory = await ensureReferencesDirectory(root);
  const entries = await readdir(directory);
  const summaries: ReferenceSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const document = referenceDocumentSchema.parse(
        JSON.parse(await readFile(resolve(directory, entry), 'utf8')),
      );
      summaries.push({ path: `${REFERENCES_DIRECTORY}/${entry}`, name: document.name, description: document.description });
    } catch {
      // 单个损坏文件不阻断列表（本阶段不做 index；未来规模大了再加缓存）。
    }
  }
  return summaries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadReference(root: string, path: string): Promise<ReferenceDocument> {
  const file = resolveReferencePath(root, path);
  try {
    return referenceDocumentSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) throw new Error(`参考文件不存在：${path}`);
    throw new Error(`参考文件无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 随机 8 位十六进制文件名；文件名与用户名称完全解耦，永不重命名。 */
async function unusedReferenceFileName(directory: string): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const name = `${randomBytes(4).toString('hex')}.json`;
    try {
      await readFile(resolve(directory, name));
    } catch (error) {
      if (isMissingFile(error)) return name;
      throw error;
    }
  }
  throw new Error('无法生成不冲突的参考文件名。');
}

export async function createReference(root: string, name?: string): Promise<string> {
  return serialize(root, async () => {
    const directory = await ensureReferencesDirectory(root);
    const fileName = await unusedReferenceFileName(directory);
    const document = referenceDocumentSchema.parse({
      name: name ?? REFERENCE_DEFAULT_NAME,
      description: '',
      cards: [],
    });
    const filePath = resolve(directory, fileName);
    await writeTextAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`);
    return `${REFERENCES_DIRECTORY}/${fileName}`;
  });
}

export async function saveReference(root: string, path: string, document: ReferenceDocument): Promise<void> {
  const file = resolveReferencePath(root, path);
  const validated = referenceDocumentSchema.parse(document);
  await serialize(root, () => writeTextAtomic(file, `${JSON.stringify(validated, null, 2)}\n`));
}

/** 删除 Reference 文件，并从全部 Document 关系中移除该路径。 */
export async function removeReference(root: string, path: string): Promise<void> {
  const file = resolveReferencePath(root, path);
  await serialize(root, async () => {
    const relations = await readRelationFile(root);
    const next = relations.relations
      .map(entry => ({ ...entry, references: entry.references.filter(reference => reference !== path) }))
      .filter(entry => entry.references.length > 0);
    if (JSON.stringify(next) !== JSON.stringify(relations.relations)) {
      // 先清关系再删文件：即使文件删除失败，也不会产生悬挂关系。
      await writeTextAtomic(relationsFile(root), `${JSON.stringify({ relations: next }, null, 2)}\n`);
    }
    await rm(file, { force: true });
  });
}

// ── RelationStore（独立于 ReferenceStore） ────────────

export async function getDocumentRelations(root: string, target: string): Promise<string[]> {
  assertSafeRelationTarget(target);
  const file = await readRelationFile(root);
  return file.relations.find(entry => entry.target === target)?.references ?? [];
}

export async function setDocumentRelations(root: string, target: string, references: string[]): Promise<void> {
  assertSafeRelationTarget(target);
  for (const reference of references) {
    // 只做形状校验；引用的文件此刻可能刚被并发删除，读取方负责容错。
    resolveReferencePath(root, reference);
  }
  await serialize(root, async () => {
    const file = await readRelationFile(root);
    const others = file.relations.filter(entry => entry.target !== target);
    const next = references.length === 0
      ? others
      : [...others, { target, references: [...references] }];
    await writeTextAtomic(relationsFile(root), `${JSON.stringify({ relations: next }, null, 2)}\n`);
  });
}

/** 删除 Document 后清除以 id 或历史路径为 target 的关系记录。 */
export async function removeDocumentRelations(root: string, targets: readonly string[]): Promise<void> {
  const targetSet = new Set(targets.filter(Boolean));
  if (targetSet.size === 0) return;
  await serialize(root, async () => {
    const file = await readRelationFile(root);
    const next = file.relations.filter(entry => !targetSet.has(entry.target));
    if (next.length !== file.relations.length) {
      await writeTextAtomic(relationsFile(root), `${JSON.stringify({ relations: next }, null, 2)}\n`);
    }
  });
}
