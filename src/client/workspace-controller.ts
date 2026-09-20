import type { RelationLookup } from '../references.js';

export interface WorkspaceRelationApi {
  getDocumentRelations(input: { target: string }): Promise<RelationLookup>;
  setDocumentRelations(input: { target: string; references: string[] }): Promise<void>;
}

export interface WorkspaceSnapshot {
  readonly activeOutput?: string;
  readonly activeReference?: string;
  readonly outputTabs: readonly string[];
  readonly freeReferenceTabs: readonly string[];
  readonly visibleReferences: readonly string[];
}

/** Reference 与 Output 之间唯一的工作区状态协调器。 */
export class WorkspaceController {
  private activeOutput?: string;
  private activeReference?: string;
  private freeReferenceTabs: string[] = [];
  private outputTabs: string[] = [];
  private readonly relations = new Map<string, RelationLookup>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly api: WorkspaceRelationApi) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): WorkspaceSnapshot {
    return {
      ...(this.activeOutput === undefined ? {} : { activeOutput: this.activeOutput }),
      ...(this.activeReference === undefined ? {} : { activeReference: this.activeReference }),
      outputTabs: [...this.outputTabs],
      freeReferenceTabs: [...this.freeReferenceTabs],
      visibleReferences: this.visibleReferences(),
    };
  }

  setOutputTabs(ids: readonly string[]): void {
    this.outputTabs = [...new Set(ids)];
    this.emit();
  }

  visibleReferences(): string[] {
    if (this.activeOutput === undefined) return [...this.freeReferenceTabs];
    return [...(this.relations.get(this.activeOutput)?.references ?? [])];
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private reconcileActiveReference(): void {
    const visible = this.visibleReferences();
    if (this.activeReference === undefined || !visible.includes(this.activeReference)) {
      this.activeReference = visible[0];
    }
  }

  setActiveReference(path?: string): void {
    if (path !== undefined && !this.visibleReferences().includes(path)) return;
    this.activeReference = path;
    this.emit();
  }

  async setActiveOutput(id?: string): Promise<void> {
    const request = ++this.generation;
    if (id !== undefined && !this.relations.has(id)) {
      const relation = await this.api.getDocumentRelations({ target: id });
      if (request !== this.generation) return;
      this.relations.set(id, relation);
    }
    if (request !== this.generation) return;
    this.activeOutput = id;
    this.reconcileActiveReference();
    this.emit();
  }

  async initializeOutput(id: string, references: readonly string[], onlyIfMissing: boolean): Promise<void> {
    let relation = await this.api.getDocumentRelations({ target: id });
    if (!onlyIfMissing || !relation.exists) {
      const normalized = [...new Set(references)];
      await this.api.setDocumentRelations({ target: id, references: normalized });
      relation = { exists: true, references: normalized };
    }
    this.relations.set(id, relation);
  }

  async addReferences(paths: readonly string[]): Promise<void> {
    const additions = [...new Set(paths)];
    if (additions.length === 0) return;
    if (this.activeOutput === undefined) {
      this.freeReferenceTabs = [...new Set([...this.freeReferenceTabs, ...additions])];
    } else {
      const current = this.relations.get(this.activeOutput)
        ?? await this.api.getDocumentRelations({ target: this.activeOutput });
      const references = [...new Set([...current.references, ...additions])];
      await this.api.setDocumentRelations({ target: this.activeOutput, references });
      this.relations.set(this.activeOutput, { exists: true, references });
    }
    this.activeReference = additions.at(-1);
    this.emit();
  }

  async replaceActiveRelations(references: readonly string[]): Promise<void> {
    if (this.activeOutput === undefined) return;
    const normalized = [...new Set(references)];
    await this.api.setDocumentRelations({ target: this.activeOutput, references: normalized });
    this.relations.set(this.activeOutput, { exists: true, references: normalized });
    this.reconcileActiveReference();
    this.emit();
  }

  closeFreeReference(path: string): void {
    if (this.activeOutput !== undefined) return;
    this.freeReferenceTabs = this.freeReferenceTabs.filter(item => item !== path);
    this.reconcileActiveReference();
    this.emit();
  }

  forgetReference(path: string): void {
    this.freeReferenceTabs = this.freeReferenceTabs.filter(item => item !== path);
    for (const [target, relation] of this.relations) {
      this.relations.set(target, { ...relation, references: relation.references.filter(item => item !== path) });
    }
    this.reconcileActiveReference();
    this.emit();
  }
}
