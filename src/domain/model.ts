export type SourceKind = 'file' | 'url' | 'text';
export type SourceStatus = 'available' | 'missing' | 'unreadable';
export type AnnotationTarget = 'source' | 'note' | 'message';

export interface Solution {
  id: string;
  name: string;
  description: string;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  solutionId: string;
  title: string;
  goal: string;
  notePath: string;
  sourceIds: string[];
  sessionIds: string[];
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Source {
  id: string;
  solutionId: string | null;
  kind: SourceKind;
  title: string;
  location: string;
  originalLocation: string;
  mediaType: string | null;
  status: SourceStatus;
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AnnotationAnchor =
  | { kind: 'text'; start: number; end: number; prefix: string; suffix: string }
  | { kind: 'pdf'; page: number; start: number; end: number }
  | { kind: 'message'; messageId: string; start: number; end: number }
  | null;

export interface AnnotationSnapshot {
  quote: string;
  title: string;
  location: string | null;
  documentVersion: string;
  anchor: AnnotationAnchor;
}

export interface AnnotationCommentVersion {
  version: number;
  comment: string;
  createdAt: string;
}

export interface Annotation {
  id: string;
  projectId: string;
  target: AnnotationTarget;
  targetId: string | null;
  snapshot: AnnotationSnapshot;
  comments: AnnotationCommentVersion[];
  currentCommentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationSendRecord {
  id: string;
  projectId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  annotationVersions: Array<{ annotationId: string; commentVersion: number }>;
  messageTextVersion: string;
  acceptedAt: string;
}

export interface ProjectWorkState {
  projectId: string;
  openTabs: string[];
  activeTab: string;
  readingLocations: Record<string, unknown>;
  noteDraft: string | null;
  noteDraftBaseVersion: string | null;
  selectedAnnotationIds: string[];
  materialWidth: number;
  conversationWidth: number;
  materialTreeCollapsed: boolean;
  updatedAt: string;
}

export interface NoteRevision {
  id: string;
  projectId: string;
  beforeVersion: string;
  afterVersion: string;
  beforeContent: string;
  afterContent: string;
  actor: 'human' | 'ai' | 'rollback';
  createdAt: string;
}

export interface Catalog {
  schemaVersion: 2;
  solutions: Solution[];
  projects: Project[];
  sources: Source[];
  annotations: Annotation[];
  annotationSends: AnnotationSendRecord[];
  workStates: ProjectWorkState[];
  noteRevisions: NoteRevision[];
}

export interface TextDocument {
  content: string;
  version: string;
}

export interface SourcePreview extends TextDocument {
  title: string;
  location: string;
  mediaType: string | null;
  status: SourceStatus;
  truncated: boolean;
  encoding: 'utf8';
}

export interface BinaryDocument {
  title: string;
  location: string;
  mediaType: string;
  version: string;
  status: SourceStatus;
  contentBase64: string;
}

export const emptyCatalog = (): Catalog => ({
  schemaVersion: 2,
  solutions: [],
  projects: [],
  sources: [],
  annotations: [],
  annotationSends: [],
  workStates: [],
  noteRevisions: [],
});
