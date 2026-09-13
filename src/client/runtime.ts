import type { Catalog, Project, Annotation } from '../domain/model.js';
import { dispatch, type SiftRemote } from './transport.js';

export type SubmissionMode = 'queue' | 'steer';
export type SubmitOutcome = { kind: 'success' | 'error'; text?: string };

export class SiftClientRuntime {
  private catalog: Catalog | null = null;
  private activeProjectId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly invalidators = new Set<(sessionId: string) => void>();
  private draftSaver: { projectId: string; save(): Promise<void> } | null = null;
  private readonly pendingSubmissions = new Map<string, Array<{
    projectId: string;
    annotationVersions: Array<{ annotationId: string; commentVersion: number }>;
    messageTextVersion: string;
  }>>();
  private viewSnapshot: { catalog: Catalog | null; activeProjectId: string | null } = { catalog: null, activeProjectId: null };

  constructor(readonly remote: SiftRemote) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): { catalog: Catalog | null; activeProjectId: string | null } => this.viewSnapshot;

  async refresh(): Promise<Catalog> {
    this.catalog = await dispatch<Catalog>(this.remote, { type: 'catalog.get' });
    this.emit();
    return this.catalog;
  }

  setActiveProject(projectId: string | null): void {
    const previous = this.activeProject();
    this.activeProjectId = projectId;
    this.emit();
    if (previous?.activeSessionId) this.invalidate(previous.activeSessionId);
    const next = this.activeProject();
    if (next?.activeSessionId) this.invalidate(next.activeSessionId);
  }

  onInvalidate(listener: (sessionId: string) => void): () => void {
    this.invalidators.add(listener);
    return () => this.invalidators.delete(listener);
  }

  invalidate(sessionId: string): void {
    for (const listener of this.invalidators) listener(sessionId);
    this.emit();
  }

  registerDraftSaver(projectId: string, save: () => Promise<void>): () => void {
    const value = { projectId, save };
    this.draftSaver = value;
    return () => { if (this.draftSaver === value) this.draftSaver = null; };
  }

  preview(sessionId: string, text: string, mode: SubmissionMode): string {
    return this.transform({ sessionId, text, mode });
  }

  transform(input: { sessionId: string; text: string; mode: SubmissionMode }): string {
    const project = this.projectForSession(input.sessionId);
    if (!project || project.id !== this.activeProjectId || !this.catalog) return input.text;
    const state = this.catalog.workStates.find(item => item.projectId === project.id);
    const selected = new Set(state?.selectedAnnotationIds ?? []);
    const annotations = this.catalog.annotations.filter(item => item.projectId === project.id && selected.has(item.id));
    if (annotations.length === 0) return input.text;
    const appendix = annotations.map((annotation, index) => this.formatAnnotation(annotation, index + 1)).join('\n\n');
    return [input.text.trim(), `---\nSift 批注（${annotations.length}）\n\n${appendix}`].filter(Boolean).join('\n\n');
  }

  async beforeSubmit(input: { sessionId: string; text: string; mode: SubmissionMode; signal: AbortSignal }): Promise<void> {
    const project = this.projectForSession(input.sessionId);
    if (!project || project.id !== this.activeProjectId) return;
    if (input.signal.aborted) throw input.signal.reason;
    if (this.draftSaver?.projectId === project.id) await this.draftSaver.save();
    if (!this.catalog) return;
    const state = this.catalog.workStates.find(item => item.projectId === project.id);
    const selected = new Set(state?.selectedAnnotationIds ?? []);
    const annotationVersions = this.catalog.annotations
      .filter(item => item.projectId === project.id && selected.has(item.id))
      .map(item => ({ annotationId: item.id, commentVersion: item.currentCommentVersion }));
    const key = this.submissionKey(input.sessionId, input.mode, input.text);
    const pending = this.pendingSubmissions.get(key) ?? [];
    pending.push({ projectId: project.id, annotationVersions, messageTextVersion: this.hashText(input.text) });
    this.pendingSubmissions.set(key, pending);
  }

  async settled(input: { sessionId: string; text: string; mode: SubmissionMode; outcome: SubmitOutcome }): Promise<void> {
    const key = this.submissionKey(input.sessionId, input.mode, input.text);
    const pending = this.pendingSubmissions.get(key);
    const frozen = pending?.shift();
    if (pending?.length === 0) this.pendingSubmissions.delete(key);
    if (input.outcome.kind !== 'success' || !frozen || frozen.annotationVersions.length === 0) return;
    await dispatch(this.remote, {
      type: 'annotation.send.record', projectId: frozen.projectId, sessionId: input.sessionId,
      mode: input.mode, annotationVersions: frozen.annotationVersions, messageTextVersion: frozen.messageTextVersion,
    });
    await this.refresh();
    this.invalidate(input.sessionId);
  }

  private activeProject(): Project | undefined {
    return this.catalog?.projects.find(item => item.id === this.activeProjectId);
  }

  private projectForSession(sessionId: string): Project | undefined {
    return this.catalog?.projects.find(project => project.activeSessionId === sessionId);
  }

  private formatAnnotation(annotation: Annotation, index: number): string {
    const comment = annotation.comments.find(item => item.version === annotation.currentCommentVersion)?.comment ?? '';
    const position = annotation.snapshot.anchor?.kind === 'pdf'
      ? `第 ${annotation.snapshot.anchor.page} 页`
      : annotation.snapshot.anchor?.kind === 'message'
        ? `消息 ${annotation.snapshot.anchor.messageId}`
        : annotation.snapshot.location ?? '位置不可用';
    return [
      `[${index}] ${annotation.snapshot.title} · ${position}`,
      `> ${annotation.snapshot.quote.replace(/\n/g, '\n> ')}`,
      `批注：${comment}`,
    ].join('\n');
  }

  private hashText(text: string): string {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  private submissionKey(sessionId: string, mode: SubmissionMode, text: string): string {
    return `${sessionId}\u0000${mode}\u0000${this.hashText(text)}`;
  }

  private emit(): void {
    this.viewSnapshot = { catalog: this.catalog, activeProjectId: this.activeProjectId };
    for (const listener of this.listeners) listener();
  }
}
