import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react';
import type {
  Annotation, AnnotationAnchor, BinaryDocument, Catalog, Project, ProjectWorkState,
  Solution, Source, SourcePreview, TextDocument,
} from '../domain/model.js';
import { dispatch } from './transport.js';
import { type ReaderSelection, DocxReader, MarkdownEditor, PdfReader, WebReader } from './readers.js';
import type { SiftClientRuntime, SubmissionMode } from './runtime.js';

interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

interface SessionsState {
  current?: string;
  byId: Record<string, { id: string; displayTitle: string; running: boolean }>;
}

export interface SiftSessions {
  list: Observable<SessionsState>;
  create(options: { cwd: string }): Promise<string>;
  open(sessionId: string): void;
}

export interface SiftSurfaceProps {
  activeSurface: string | null;
  conversation: ReactNode;
  runtime: SiftClientRuntime;
  sessions: SiftSessions;
  layout: { closeSurface(id?: string): void };
}

export interface SiftNavigationProps {
  layout: { openSurface(id: string): void };
}

export function SiftNavigationButton({ layout }: SiftNavigationProps) {
  return <button className="sift-nav-button" type="button" onClick={() => layout.openSurface('sift')} title="打开 Sift 知识工作台">
    <span aria-hidden>⌘</span><span>Sift</span>
  </button>;
}

function useRuntime(runtime: SiftClientRuntime) {
  return useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
}

function useSessions(sessions: SiftSessions) {
  return useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot);
}

export function SiftSurface(props: SiftSurfaceProps) {
  const { runtime } = props;
  const snapshot = useRuntime(runtime);
  const [route, setRoute] = useState<{ solutionId: string | null; projectId: string | null }>({ solutionId: null, projectId: null });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void runtime.refresh().catch(reason => setError(messageOf(reason))); }, [runtime]);
  useEffect(() => {
    runtime.setActiveProject(route.projectId);
    return () => runtime.setActiveProject(null);
  }, [runtime, route.projectId]);
  if (props.activeSurface !== 'sift') return null;
  const catalog = snapshot.catalog;
  return <div className="sift-surface">
    <style>{styles}</style>
    <header className="sift-topbar">
      <div className="sift-breadcrumbs">
        <button onClick={() => setRoute({ solutionId: null, projectId: null })}>Sift</button>
        {route.solutionId && <><span>›</span><button onClick={() => setRoute({ solutionId: route.solutionId, projectId: null })}>{catalog?.solutions.find(item => item.id === route.solutionId)?.name ?? '解决方案'}</button></>}
        {route.projectId && <><span>›</span><strong>{catalog?.projects.find(item => item.id === route.projectId)?.title ?? '项目'}</strong></>}
      </div>
      <button onClick={() => props.layout.closeSurface('sift')}>返回 DSH</button>
    </header>
    {error && <div className="sift-error">{error}<button onClick={() => setError(null)}>关闭</button></div>}
    {!catalog ? <div className="sift-loading">正在加载 Sift…</div>
      : route.projectId ? <ProjectWorkbench {...props} catalog={catalog} projectId={route.projectId} reportError={setError} />
        : route.solutionId ? <SolutionPage catalog={catalog} solutionId={route.solutionId} runtime={runtime} openProject={projectId => setRoute({ solutionId: route.solutionId, projectId })} reportError={setError} />
          : <SiftHome catalog={catalog} runtime={runtime} openSolution={solutionId => setRoute({ solutionId, projectId: null })} reportError={setError} />}
  </div>;
}

function SiftHome({ catalog, runtime, openSolution, reportError }: {
  catalog: Catalog; runtime: SiftClientRuntime; openSolution(id: string): void; reportError(message: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const create = async () => {
    try {
      const solution = await dispatch<Solution>(runtime.remote, {
        type: 'solution.create', name, description, workspacePath: workspacePath.trim() || null,
      });
      await runtime.refresh();
      setCreating(false);
      openSolution(solution.id);
    } catch (error) { reportError(messageOf(error)); }
  };
  return <main className="sift-page">
    <section className="sift-hero"><div><p className="sift-eyebrow">知识工作台</p><h1>从素材阅读到可追溯的成果笔记</h1><p>在解决方案中共享素材，在项目里结合原生 DSH 对话持续整理一篇 Markdown。</p></div><button className="primary" onClick={() => setCreating(value => !value)}>新建解决方案</button></section>
    {creating && <OperationForm title="新建解决方案" onCancel={() => setCreating(false)} onSubmit={() => void create()}>
      <label>名称<input value={name} onChange={event => setName(event.target.value)} autoFocus /></label>
      <label>说明<textarea value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>DSH 工作区路径<input value={workspacePath} onChange={event => setWorkspacePath(event.target.value)} placeholder="例如 D:\\mycode\\topic" /></label>
    </OperationForm>}
    <div className="sift-card-grid">{catalog.solutions.map(solution => <button className="sift-card" key={solution.id} onClick={() => openSolution(solution.id)}>
      <strong>{solution.name}</strong><span>{solution.description || '暂无说明'}</span><small>{solution.workspacePath ?? '首次进入后选择工作区'}</small>
    </button>)}</div>
    {catalog.solutions.length === 0 && !creating && <EmptyState text="还没有解决方案。先建立一个长期主题。" />}
  </main>;
}

function SolutionPage({ catalog, solutionId, runtime, openProject, reportError }: {
  catalog: Catalog; solutionId: string; runtime: SiftClientRuntime; openProject(id: string): void; reportError(message: string): void;
}) {
  const solution = catalog.solutions.find(item => item.id === solutionId)!;
  const projects = catalog.projects.filter(item => item.solutionId === solutionId);
  const sources = catalog.sources.filter(item => item.solutionId === solutionId);
  const [operation, setOperation] = useState<'project' | 'source' | 'workspace' | null>(solution.workspacePath ? null : 'workspace');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [notePath, setNotePath] = useState('');
  const [workspacePath, setWorkspacePath] = useState(solution.workspacePath ?? '');
  const [sourceDraft, setSourceDraft] = useState({ kind: 'file' as 'file' | 'url' | 'text', title: '', location: '', content: '' });
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); await runtime.refresh(); setOperation(null); } catch (error) { reportError(messageOf(error)); }
  };
  const createProject = async () => {
    const project = await dispatch<Project>(runtime.remote, { type: 'project.create', solutionId, title, goal, notePath: notePath.trim() || null });
    await runtime.refresh(); setOperation(null); openProject(project.id);
  };
  return <main className="sift-page">
    <section className="sift-solution-head"><div><p className="sift-eyebrow">解决方案</p><h1>{solution.name}</h1><p>{solution.description || '暂无说明'}</p><code>{solution.workspacePath ?? '尚未选择 DSH 工作区'}</code></div><div className="sift-actions"><button onClick={() => setOperation('workspace')}>工作区</button><button className="primary" disabled={!solution.workspacePath} onClick={() => setOperation('project')}>新建项目</button></div></section>
    {operation === 'workspace' && <OperationForm title="设置解决方案工作区" onCancel={() => setOperation(null)} onSubmit={() => void run(() => dispatch(runtime.remote, { type: 'solution.update', id: solution.id, name: solution.name, description: solution.description, workspacePath }))}>
      <label>绝对路径<input value={workspacePath} onChange={event => setWorkspacePath(event.target.value)} autoFocus /></label>
      {!solution.workspacePath && <p>旧解决方案不会自动绑定当前工作区，请明确选择。</p>}
    </OperationForm>}
    {operation === 'project' && <OperationForm title="新建项目" onCancel={() => setOperation(null)} onSubmit={() => void createProject()}>
      <label>标题<input value={title} onChange={event => setTitle(event.target.value)} autoFocus /></label>
      <label>目标<textarea value={goal} onChange={event => setGoal(event.target.value)} /></label>
      <label>已有 Markdown（可选）<input value={notePath} onChange={event => setNotePath(event.target.value)} placeholder="留空则在工作区生成默认笔记" /></label>
    </OperationForm>}
    <section><div className="sift-section-title"><h2>项目</h2></div><div className="sift-card-grid">{projects.map(project => <button className="sift-card" key={project.id} onClick={() => openProject(project.id)}><strong>{project.title}</strong><span>{project.goal || '暂无目标'}</span><small>{project.sessionIds.length} 个讨论 · {project.sourceIds.length} 份素材</small></button>)}</div>{projects.length === 0 && <EmptyState text="暂无项目。每个项目围绕一篇 Markdown 成果笔记。" />}</section>
    <section><div className="sift-section-title"><h2>共享素材</h2><button onClick={() => setOperation('source')}>添加素材</button></div>
      {operation === 'source' && <SourceForm value={sourceDraft} onChange={setSourceDraft} onCancel={() => setOperation(null)} onSubmit={() => reportError('请先进入一个项目添加素材；素材会同时进入该解决方案共享库。')} />}
      <div className="sift-source-list">{sources.map(source => <div key={source.id}><span>{source.title}</span><small>{source.kind} · {source.status}</small><code>{source.location}</code></div>)}</div>{sources.length === 0 && <EmptyState text="共享素材库为空。进入项目后添加的素材会出现在这里。" />}</section>
  </main>;
}

function ProjectWorkbench(props: SiftSurfaceProps & { catalog: Catalog; projectId: string; reportError(message: string): void }) {
  const { catalog, projectId, runtime, sessions, conversation, reportError } = props;
  const project = catalog.projects.find(item => item.id === projectId)!;
  const solution = catalog.solutions.find(item => item.id === project.solutionId)!;
  const sessionsState = useSessions(sessions);
  const state = catalog.workStates.find(item => item.projectId === project.id) ?? defaultState(project.id);
  const [activeTab, setActiveTab] = useState(state.activeTab);
  const [openTabs, setOpenTabs] = useState(state.openTabs);
  const [mobilePane, setMobilePane] = useState<'content' | 'conversation'>('content');
  const [addingSource, setAddingSource] = useState(false);
  const [sourceDraft, setSourceDraft] = useState({ kind: 'file' as 'file' | 'url' | 'text', title: '', location: '', content: '' });
  const [selection, setSelection] = useState<(ReaderSelection & { target: 'source' | 'note'; targetId: string | null; title: string; location: string | null; version: string }) | null>(null);

  useEffect(() => {
    if (!solution.workspacePath) return;
    let active = true;
    void (async () => {
      try {
        let sessionId = project.activeSessionId;
        if (!sessionId) {
          sessionId = await sessions.create({ cwd: solution.workspacePath! });
          await dispatch(runtime.remote, { type: 'project.session.bind', projectId: project.id, sessionId, activate: true });
          await runtime.refresh();
        }
        if (active) sessions.open(sessionId);
      } catch (error) { if (active) reportError(messageOf(error)); }
    })();
    return () => { active = false; };
  }, [project.id, project.activeSessionId, solution.workspacePath]);

  useEffect(() => {
    if (project.activeSessionId && sessionsState.current !== project.activeSessionId) sessions.open(project.activeSessionId);
  }, [project.activeSessionId, sessionsState.current]);

  const updateWorkState = useCallback(async (patch: Partial<ProjectWorkState>) => {
    const next = { ...state, ...patch };
    await dispatch(runtime.remote, {
      type: 'workstate.update', projectId: project.id,
      state: {
        openTabs: next.openTabs, activeTab: next.activeTab, readingLocations: next.readingLocations,
        noteDraft: next.noteDraft, noteDraftBaseVersion: next.noteDraftBaseVersion,
        selectedAnnotationIds: next.selectedAnnotationIds, materialWidth: next.materialWidth,
        conversationWidth: next.conversationWidth, materialTreeCollapsed: next.materialTreeCollapsed,
      },
    });
    await runtime.refresh();
  }, [runtime, project.id, state]);

  const openSource = (sourceId: string) => {
    const tabs = openTabs.includes(sourceId) ? openTabs : [...openTabs, sourceId];
    setOpenTabs(tabs); setActiveTab(sourceId); void updateWorkState({ openTabs: tabs, activeTab: sourceId });
  };
  const createDiscussion = async () => {
    if (!solution.workspacePath) return;
    try {
      const sessionId = await sessions.create({ cwd: solution.workspacePath });
      await dispatch(runtime.remote, { type: 'project.session.bind', projectId: project.id, sessionId, activate: true });
      await runtime.refresh(); sessions.open(sessionId);
    } catch (error) { reportError(messageOf(error)); }
  };
  const createSource = async () => {
    try {
      await dispatch(runtime.remote, {
        type: 'source.create', projectId: project.id, kind: sourceDraft.kind, title: sourceDraft.title,
        location: sourceDraft.location, content: sourceDraft.kind === 'text' ? sourceDraft.content : undefined,
        mediaType: mediaTypeOf(sourceDraft.location, sourceDraft.kind),
      });
      setAddingSource(false); setSourceDraft({ kind: 'file', title: '', location: '', content: '' }); await runtime.refresh();
    } catch (error) { reportError(messageOf(error)); }
  };
  const source = catalog.sources.find(item => item.id === activeTab);
  const activeRunning = project.activeSessionId ? sessionsState.byId[project.activeSessionId]?.running === true : false;
  return <main className={`sift-project mobile-${mobilePane}`}>
    <aside className={`sift-materials ${state.materialTreeCollapsed ? 'collapsed' : ''}`} style={{ width: state.materialTreeCollapsed ? 48 : state.materialWidth }}>
      <div className="sift-pane-title"><button onClick={() => void updateWorkState({ materialTreeCollapsed: !state.materialTreeCollapsed })}>{state.materialTreeCollapsed ? '›' : '‹'}</button>{!state.materialTreeCollapsed && <><strong>素材目录</strong><button onClick={() => setAddingSource(true)}>＋</button></>}</div>
      {!state.materialTreeCollapsed && <><button className={activeTab === 'note' ? 'active' : ''} onClick={() => { setActiveTab('note'); void updateWorkState({ activeTab: 'note' }); }}>📌 成果笔记</button>{project.sourceIds.map(id => { const item = catalog.sources.find(source => source.id === id); return item && <button className={activeTab === id ? 'active' : ''} key={id} onClick={() => openSource(id)}><span>{iconOf(item)} {item.title}</span><small>{item.status === 'available' ? '' : '失效'}</small></button>; })}</>}
    </aside>
    <section className="sift-content-pane">
      <div className="sift-project-toolbar"><div><strong>{project.title}</strong><span>{project.goal}</span></div><div className="sift-mobile-toggle"><button className={mobilePane === 'content' ? 'active' : ''} onClick={() => setMobilePane('content')}>内容</button><button className={mobilePane === 'conversation' ? 'active' : ''} onClick={() => setMobilePane('conversation')}>对话</button></div></div>
      <div className="sift-tabs">{openTabs.map(id => { const item = id === 'note' ? { title: '成果笔记' } : catalog.sources.find(source => source.id === id); if (!item) return null; return <button className={activeTab === id ? 'active' : ''} key={id} onClick={() => { setActiveTab(id); void updateWorkState({ activeTab: id }); }}>{id === 'note' && '📌 '}{item.title}</button>; })}</div>
      <div className="sift-document"><DocumentPanel project={project} source={source} runtime={runtime} workState={state} readonly={activeRunning} onSelect={value => setSelection({ ...value, target: source ? 'source' : 'note', targetId: source?.id ?? null, title: source?.title ?? project.title, location: source?.location ?? project.notePath, version: source?.updatedAt ?? project.updatedAt })} reportError={reportError} /></div>
      {selection && <AnnotationComposer selection={selection} project={project} runtime={runtime} onClose={() => setSelection(null)} reportError={reportError} />}
      {addingSource && <SourceForm value={sourceDraft} onChange={setSourceDraft} onCancel={() => setAddingSource(false)} onSubmit={() => void createSource()} />}
    </section>
    <section className="sift-conversation-pane" style={{ width: state.conversationWidth }}>
      <div className="sift-pane-title"><div><strong>DSH 原生对话</strong><select value={project.activeSessionId ?? ''} onChange={event => void (async () => { await dispatch(runtime.remote, { type: 'project.session.activate', projectId: project.id, sessionId: event.target.value }); await runtime.refresh(); sessions.open(event.target.value); })()}>{project.sessionIds.map(id => <option key={id} value={id}>{sessionsState.byId[id]?.displayTitle ?? id}</option>)}</select></div><button onClick={() => void createDiscussion()}>新建讨论</button></div>
      <div className="sift-native-conversation">{conversation}</div>
    </section>
  </main>;
}

function DocumentPanel({ project, source, runtime, workState, readonly, onSelect, reportError }: {
  project: Project; source?: Source; runtime: SiftClientRuntime; workState: ProjectWorkState; readonly: boolean;
  onSelect(value: ReaderSelection): void; reportError(message: string): void;
}) {
  const [document, setDocument] = useState<TextDocument | SourcePreview | BinaryDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [baseVersion, setBaseVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [conflict, setConflict] = useState<TextDocument | null>(null);
  const key = source?.id ?? `note:${project.id}`;
  const load = useCallback(async () => {
    if (source) {
      const binary = isBinary(source);
      const value = await dispatch<SourcePreview | BinaryDocument>(runtime.remote, { type: binary ? 'source.binary' : 'source.preview', id: source.id });
      setDocument(value);
      return;
    }
    const value = await dispatch<TextDocument>(runtime.remote, { type: 'note.read', projectId: project.id });
    setDocument(value); setBaseVersion(value.version);
    const restored = workState.noteDraft !== null && workState.noteDraftBaseVersion === value.version ? workState.noteDraft : value.content;
    setDraft(restored); setDirty(restored !== value.content);
  }, [key]);
  useEffect(() => { setDocument(null); setConflict(null); void load().catch(error => reportError(messageOf(error))); }, [load]);

  const save = useCallback(async () => {
    if (source || !dirty) return;
    if (!baseVersion) throw new Error('笔记基准版本尚未加载。');
    const value = await dispatch<TextDocument>(runtime.remote, { type: 'note.write', projectId: project.id, content: draft, expectedVersion: baseVersion, actor: 'human' });
    setDocument(value); setBaseVersion(value.version); setDirty(false); setConflict(null); await runtime.refresh();
  }, [source?.id, dirty, baseVersion, draft, project.id, runtime]);
  useEffect(() => source ? undefined : runtime.registerDraftSaver(project.id, save), [runtime, project.id, source?.id, save]);
  useEffect(() => {
    if (source) return;
    const timer = window.setInterval(() => {
      void dispatch<TextDocument>(runtime.remote, { type: 'note.read', projectId: project.id }).then(value => {
        if (value.version === baseVersion) return;
        if (dirty) setConflict(value);
        else { setDocument(value); setDraft(value.content); setBaseVersion(value.version); }
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [source?.id, project.id, baseVersion, dirty]);
  useEffect(() => {
    if (source || !dirty) return;
    const timer = window.setTimeout(() => void dispatch(runtime.remote, {
      type: 'workstate.update', projectId: project.id,
      state: { ...workState, noteDraft: draft, noteDraftBaseVersion: baseVersion },
    }).catch(() => undefined), 500);
    return () => window.clearTimeout(timer);
  }, [source?.id, dirty, draft, baseVersion]);

  if (!document) return <div className="sift-loading">正在读取…</div>;
  if (!source) return <>
    <div className="sift-reader-toolbar"><button onClick={() => setSourceMode(value => !value)}>{sourceMode ? '所见即所得' : '源码模式'}</button><button disabled={!dirty || readonly} onClick={() => void save().catch(error => reportError(messageOf(error)))}>保存</button>{readonly && <span>AI 正在处理：笔记暂时只读</span>}{dirty && <span>有未保存修改</span>}</div>
    {conflict && <div className="sift-conflict"><strong>检测到外部修改</strong><p>草稿和磁盘版本都已保留，选择后再继续。</p><button onClick={() => { setDraft(conflict.content); setBaseVersion(conflict.version); setDirty(false); setConflict(null); }}>使用磁盘版本</button><button onClick={() => { setBaseVersion(conflict.version); setConflict(null); }}>保留草稿并以新版本为基准</button></div>}
    <MarkdownEditor value={draft} version={baseVersion ?? project.updatedAt} readonly={readonly} sourceMode={sourceMode} onChange={value => { setDraft(value); setDirty(true); }} onSelect={onSelect} />
  </>;
  if ('contentBase64' in document) {
    if (source.mediaType === 'application/pdf' || source.location.toLowerCase().endsWith('.pdf')) return <PdfReader document={document} onSelect={onSelect} />;
    if (source.location.toLowerCase().endsWith('.docx')) return <DocxReader document={document} onSelect={onSelect} />;
    return <UnsupportedSource source={source} />;
  }
  if (source.kind === 'url') return <WebReader document={document} onSelect={onSelect} />;
  if (source.location.toLowerCase().endsWith('.md') || source.mediaType?.includes('markdown')) return <MarkdownEditor value={document.content} version={document.version} readonly sourceMode={sourceMode} onSelect={onSelect} />;
  return <pre className="sift-text-reader" onMouseUp={event => { const selected = selectionFromElement(event.currentTarget, document.content); if (selected) onSelect(selected); }}>{document.content}</pre>;
}

function AnnotationComposer({ selection, project, runtime, onClose, reportError }: {
  selection: ReaderSelection & { target: 'source' | 'note'; targetId: string | null; title: string; location: string | null; version: string };
  project: Project; runtime: SiftClientRuntime; onClose(): void; reportError(message: string): void;
}) {
  const [comment, setComment] = useState('');
  const save = async () => {
    try {
      await dispatch(runtime.remote, {
        type: 'annotation.create', projectId: project.id, target: selection.target, targetId: selection.targetId,
        snapshot: { quote: selection.quote, title: selection.title, location: selection.location, documentVersion: selection.version, anchor: selection.anchor }, comment,
      });
      await runtime.refresh();
      if (project.activeSessionId) runtime.invalidate(project.activeSessionId);
      onClose();
    } catch (error) { reportError(messageOf(error)); }
  };
  return <div className="sift-annotation-popover"><blockquote>{selection.quote}</blockquote><textarea value={comment} onChange={event => setComment(event.target.value)} placeholder="写下你的批注…" autoFocus /><div><button onClick={onClose}>取消</button><button className="primary" disabled={!comment.trim()} onClick={() => void save()}>保存批注</button></div></div>;
}

export interface AnnotationDockProps {
  sessionId: string;
  runtime: SiftClientRuntime;
  inputState: Observable<{ draft: string }>;
}

export function AnnotationDock({ sessionId, runtime, inputState }: AnnotationDockProps) {
  const { catalog, activeProjectId } = useRuntime(runtime);
  const input = useSyncExternalStore(inputState.subscribe, inputState.getSnapshot, inputState.getSnapshot);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'list' | 'preview'>('list');
  const project = catalog?.projects.find(item => item.id === activeProjectId && item.activeSessionId === sessionId);
  if (!catalog || !project) return null;
  const annotations = catalog.annotations.filter(item => item.projectId === project.id);
  if (annotations.length === 0) return null;
  const state = catalog.workStates.find(item => item.projectId === project.id) ?? defaultState(project.id);
  const selected = new Set(state.selectedAnnotationIds);
  const updateSelection = async (annotationId: string, checked: boolean) => {
    const ids = checked ? [...selected, annotationId] : state.selectedAnnotationIds.filter(id => id !== annotationId);
    await dispatch(runtime.remote, { type: 'workstate.update', projectId: project.id, state: { ...state, selectedAnnotationIds: [...new Set(ids)] } });
    await runtime.refresh(); runtime.invalidate(sessionId);
  };
  return <div className="sift-annotation-dock">
    <style>{styles}</style>
    <button className="sift-annotation-trigger" onClick={() => setOpen(value => !value)}>批注 · {annotations.length}</button>
    {open && <div className="sift-annotation-panel"><div className="sift-tabs"><button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>批注列表</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>发送预览</button></div>
      {tab === 'list' ? <div className="sift-annotation-list">{annotations.map(annotation => <AnnotationRow key={annotation.id} annotation={annotation} checked={selected.has(annotation.id)} onCheck={checked => void updateSelection(annotation.id, checked)} runtime={runtime} sessionId={sessionId} />)}</div>
        : <pre className="sift-send-preview">{runtime.preview(sessionId, input.draft, 'queue')}</pre>}
    </div>}
  </div>;
}

function AnnotationRow({ annotation, checked, onCheck, runtime, sessionId }: {
  annotation: Annotation; checked: boolean; onCheck(value: boolean): void; runtime: SiftClientRuntime; sessionId: string;
}) {
  const current = annotation.comments.find(item => item.version === annotation.currentCommentVersion)!;
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState(current.comment);
  const update = async () => {
    await dispatch(runtime.remote, { type: 'annotation.comment.update', id: annotation.id, comment });
    await runtime.refresh(); runtime.invalidate(sessionId); setEditing(false);
  };
  const remove = async () => {
    await dispatch(runtime.remote, { type: 'annotation.delete', id: annotation.id });
    await runtime.refresh(); runtime.invalidate(sessionId);
  };
  return <div className="sift-annotation-row"><label><input type="checkbox" checked={checked} onChange={event => onCheck(event.target.checked)} /><span><strong>{annotation.snapshot.title}</strong><blockquote>{annotation.snapshot.quote}</blockquote>{editing ? <textarea value={comment} onChange={event => setComment(event.target.value)} /> : <p>{current.comment}</p>}</span></label><div>{editing ? <button onClick={() => void update()}>保存</button> : <button onClick={() => setEditing(true)}>编辑评论</button>}<button onClick={() => void remove()}>删除</button></div></div>;
}

function OperationForm({ title, children, onCancel, onSubmit }: { title: string; children: ReactNode; onCancel(): void; onSubmit(): void }) {
  return <section className="sift-operation"><h3>{title}</h3>{children}<div><button onClick={onCancel}>取消</button><button className="primary" onClick={onSubmit}>确认</button></div></section>;
}

interface SourceDraft { kind: 'file' | 'url' | 'text'; title: string; location: string; content: string }
function SourceForm({ value, onChange, onCancel, onSubmit }: { value: SourceDraft; onChange(value: SourceDraft): void; onCancel(): void; onSubmit(): void }) {
  return <OperationForm title="添加素材" onCancel={onCancel} onSubmit={onSubmit}><label>类型<select value={value.kind} onChange={event => onChange({ ...value, kind: event.target.value as SourceDraft['kind'] })}><option value="file">本地文件</option><option value="url">网页 URL</option><option value="text">粘贴文本</option></select></label><label>标题<input value={value.title} onChange={event => onChange({ ...value, title: event.target.value })} /></label>{value.kind === 'text' ? <label>文本<textarea value={value.content} onChange={event => onChange({ ...value, content: event.target.value })} /></label> : <label>{value.kind === 'url' ? 'URL' : '文件绝对路径'}<input value={value.location} onChange={event => onChange({ ...value, location: event.target.value })} /></label>}</OperationForm>;
}

function EmptyState({ text }: { text: string }) { return <div className="sift-empty">{text}</div>; }
function UnsupportedSource({ source }: { source: Source }) { return <div className="sift-empty"><p>该内容无法在初版中提取。</p><code>{source.location}</code><p>.doc、扫描 PDF OCR、登录网页抓取和 Office 高保真编辑不在初版范围内。</p></div>; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isBinary(source: Source): boolean { return /\.(pdf|docx)$/i.test(source.location) || source.mediaType === 'application/pdf' || source.mediaType?.includes('officedocument') === true; }
function iconOf(source: Source): string { return source.kind === 'url' ? '🌐' : /\.pdf$/i.test(source.location) ? 'PDF' : /\.docx$/i.test(source.location) ? 'W' : '▤'; }
function mediaTypeOf(location: string, kind: SourceDraft['kind']): string | null { if (kind === 'text') return 'text/markdown'; if (/\.pdf$/i.test(location)) return 'application/pdf'; if (/\.docx$/i.test(location)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; if (/\.md$/i.test(location)) return 'text/markdown'; return kind === 'url' ? 'text/html' : null; }
function defaultState(projectId: string): ProjectWorkState { return { projectId, openTabs: ['note'], activeTab: 'note', readingLocations: {}, noteDraft: null, noteDraftBaseVersion: null, selectedAnnotationIds: [], materialWidth: 280, conversationWidth: 480, materialTreeCollapsed: false, updatedAt: '' }; }
function selectionFromElement(element: HTMLElement, content: string): ReaderSelection | null { const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) return null; const quote = selection.toString(); const start = content.indexOf(quote); return !quote.trim() ? null : { quote, anchor: start < 0 ? null : { kind: 'text', start, end: start + quote.length, prefix: content.slice(Math.max(0, start - 80), start), suffix: content.slice(start + quote.length, start + quote.length + 80) } }; }

export function buildPrompt(project: Project, annotations: Annotation[], note: string, selectedSource: Source | null): string {
  return [`请协助整理项目“${project.title}”。`, `目标：${project.goal}`, selectedSource ? `当前素材：${selectedSource.title}` : '', `当前成果笔记：\n${note}`, ...annotations.map(item => `引文：${item.snapshot.quote}\n批注：${item.comments.find(comment => comment.version === item.currentCommentVersion)?.comment ?? ''}`)].filter(Boolean).join('\n\n');
}

export function applySuggestion(value: string, start: number, end: number, replacement: string): string { return `${value.slice(0, start)}${replacement}${value.slice(end)}`; }

const styles = `
.sift-surface{height:100%;min-width:0;display:flex;flex-direction:column;background:var(--ds-color-bg-base,#f7f7f5);color:var(--ds-color-text-primary,#20201e);font:14px/1.5 system-ui,sans-serif}.sift-surface button,.sift-surface input,.sift-surface textarea,.sift-surface select,.sift-annotation-dock button,.sift-annotation-dock textarea{font:inherit}.sift-surface button,.sift-annotation-dock button{border:1px solid #d9d7d0;background:#fff;border-radius:8px;padding:7px 11px;cursor:pointer}.sift-surface button.primary,.sift-annotation-dock button.primary{background:#181816;color:#fff;border-color:#181816}.sift-topbar{height:52px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid #deddd7;background:#fff}.sift-breadcrumbs{display:flex;align-items:center;gap:8px}.sift-breadcrumbs button{border:0;padding:4px;background:transparent}.sift-page{overflow:auto;padding:28px clamp(18px,4vw,56px);display:flex;flex-direction:column;gap:30px}.sift-hero,.sift-solution-head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.sift-hero h1,.sift-solution-head h1{font-size:28px;margin:2px 0 8px}.sift-eyebrow{color:#777;margin:0;text-transform:uppercase;letter-spacing:.08em;font-size:12px}.sift-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.sift-card{text-align:left!important;display:flex;flex-direction:column;gap:8px;padding:18px!important;min-height:128px}.sift-card strong{font-size:17px}.sift-card span{color:#555}.sift-card small,.sift-source-list small{color:#89877f}.sift-operation{border:1px solid #d8d6cf;background:#fff;border-radius:12px;padding:18px;display:grid;gap:12px;max-width:720px}.sift-operation label{display:grid;gap:5px}.sift-operation input,.sift-operation textarea,.sift-operation select,.sift-annotation-popover textarea{border:1px solid #cfcdc5;border-radius:7px;padding:8px;background:#fff}.sift-operation textarea{min-height:90px}.sift-operation>div:last-child{display:flex;justify-content:flex-end;gap:8px}.sift-actions,.sift-section-title{display:flex;gap:8px;align-items:center;justify-content:space-between}.sift-source-list{display:grid;gap:8px}.sift-source-list>div{display:grid;grid-template-columns:180px 120px 1fr;gap:12px;padding:10px;border-bottom:1px solid #e1dfd9}.sift-source-list code{overflow:hidden;text-overflow:ellipsis}.sift-empty,.sift-loading{padding:28px;color:#76746d;border:1px dashed #cbc8be;border-radius:10px}.sift-error{background:#fee9e7;color:#8d251c;padding:9px 14px;display:flex;justify-content:space-between}.sift-project{flex:1;min-height:0;display:flex}.sift-materials{flex:none;border-right:1px solid #deddd7;background:#f2f1ed;overflow:auto;padding:8px;transition:width .15s}.sift-materials>button{display:flex;width:100%;border:0;background:transparent;justify-content:space-between;text-align:left;margin:2px 0}.sift-materials>button.active{background:#deddd6}.sift-materials.collapsed>button{display:none}.sift-content-pane{min-width:320px;flex:1;display:flex;flex-direction:column;position:relative;background:#fff}.sift-conversation-pane{min-width:320px;max-width:55vw;display:flex;flex-direction:column;border-left:1px solid #deddd7;background:#fff}.sift-pane-title,.sift-project-toolbar{height:52px;flex:none;padding:0 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e0ded8}.sift-pane-title>div,.sift-project-toolbar>div:first-child{display:flex;gap:8px;align-items:center}.sift-project-toolbar span{color:#777;margin-left:10px}.sift-native-conversation{min-height:0;flex:1}.sift-native-conversation>*{height:100%}.sift-tabs{display:flex;gap:2px;border-bottom:1px solid #deddd7;padding:6px 8px 0;overflow:auto}.sift-tabs button{border-radius:7px 7px 0 0;border-bottom:0;white-space:nowrap}.sift-tabs button.active{background:#f1efe9}.sift-document{flex:1;min-height:0;overflow:auto;padding:0 18px}.sift-reader-toolbar{position:sticky;top:0;z-index:4;background:#fff;border-bottom:1px solid #e1dfd9;padding:8px;display:flex;align-items:center;gap:8px}.sift-milkdown{max-width:850px;margin:0 auto;padding:24px;min-height:70vh}.sift-milkdown .milkdown .ProseMirror{outline:none}.sift-codemirror{height:100%}.sift-codemirror .cm-editor{height:100%;font-size:14px}.sift-text-reader,.sift-send-preview{white-space:pre-wrap;word-break:break-word}.sift-text-reader{max-width:900px;margin:auto;padding:24px}.sift-pdf-reader{display:flex;flex-direction:column;align-items:center}.sift-pdf-page{position:relative;box-shadow:0 2px 12px #0002;margin:16px}.sift-pdf-page canvas{display:block}.sift-pdf-page .textLayer{position:absolute;inset:0;overflow:hidden;opacity:1;line-height:1;text-size-adjust:none;transform-origin:0 0}.sift-pdf-page .textLayer span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;cursor:text}.sift-pdf-page .textLayer ::selection{background:#65a9ff66}.sift-docx{padding:20px;background:#ddd}.sift-web-reader{max-width:780px;margin:auto;padding:24px;font-size:16px;line-height:1.75}.sift-web-reader img{max-width:100%}.sift-annotation-popover{position:absolute;right:20px;bottom:20px;z-index:8;width:min(420px,calc(100% - 40px));background:#fff;border:1px solid #ccc9bf;box-shadow:0 10px 36px #0002;border-radius:12px;padding:14px}.sift-annotation-popover blockquote{max-height:120px;overflow:auto;margin:0 0 10px;border-left:3px solid #bbb;padding-left:10px}.sift-annotation-popover textarea{width:100%;box-sizing:border-box;min-height:80px}.sift-annotation-popover>div{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}.sift-conflict{background:#fff5d8;border:1px solid #e6ca72;padding:12px;margin:10px;border-radius:8px}.sift-mobile-toggle{display:none!important}.sift-nav-button{display:flex;align-items:center;gap:8px;width:100%}.sift-annotation-dock{position:relative}.sift-annotation-trigger{border:0!important;background:transparent!important;padding:4px 8px!important}.sift-annotation-panel{position:absolute;bottom:32px;right:0;width:min(560px,calc(100vw - 40px));max-height:55vh;overflow:auto;background:#fff;border:1px solid #d6d3ca;border-radius:12px;box-shadow:0 12px 44px #0003;z-index:40}.sift-annotation-list{padding:8px}.sift-annotation-row{padding:10px;border-bottom:1px solid #ebe9e3}.sift-annotation-row>label{display:flex;gap:8px}.sift-annotation-row>label>span{min-width:0;flex:1}.sift-annotation-row blockquote{margin:5px 0;color:#666;border-left:2px solid #ccc;padding-left:8px}.sift-annotation-row>div{display:flex;justify-content:flex-end;gap:6px}.sift-send-preview{padding:14px;max-height:42vh;overflow:auto}.sift-conversation-pane{resize:horizontal;overflow:auto;direction:rtl}.sift-conversation-pane>*{direction:ltr}
@media(max-width:900px){.sift-materials{width:48px!important}.sift-materials:not(.collapsed)>button{font-size:0}.sift-materials:not(.collapsed)>button span:first-letter{font-size:14px}.sift-mobile-toggle{display:flex!important}.sift-project.mobile-content .sift-conversation-pane{display:none}.sift-project.mobile-conversation .sift-content-pane{display:none}.sift-project.mobile-conversation .sift-conversation-pane{display:flex;width:auto!important;max-width:none;flex:1;border:0}.sift-hero,.sift-solution-head{flex-direction:column}.sift-source-list>div{grid-template-columns:1fr}.sift-project-toolbar span{display:none}}
`;
