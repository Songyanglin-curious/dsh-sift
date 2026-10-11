/**
 * Sift 对独立 Annotations 插件的可选适配。
 *
 * 这里故意只复制极小的结构契约，并通过 DOM 事件与全局 Symbol 双通道发现服务：
 * - 未安装 Annotations 时 Sift 其余功能正常；
 * - Annotations 不依赖或认识 Sift；
 * - 两个浏览器 bundle 不需要共享运行时模块实例。
 */

const SERVICE_SYMBOL = Symbol.for('@songyanglin/dsh-annotations/service');
const READY_EVENT = 'dsh-annotations:ready';
const REQUEST_EVENT = 'dsh-annotations:request';

interface AnnotationSource {
  readonly kind: string;
  readonly uri: string;
  readonly title: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface SurfaceMatch { readonly root: HTMLElement; readonly source: AnnotationSource }
interface SurfaceAdapter { readonly id: string; match(target: Node): SurfaceMatch | undefined }
interface AnnotationService { registerSurface(adapter: SurfaceAdapter): () => void }

type AnnotationWindow = Window & { [SERVICE_SYMBOL]?: AnnotationService };

function elementOf(target: Node): Element | null {
  return target instanceof Element ? target : target.parentElement;
}

function siftSurface(): SurfaceAdapter {
  return {
    id: 'sift-content',
    match(target) {
      const element = elementOf(target);
      if (!element) return undefined;

      const referencePanel = element.closest<HTMLElement>('[data-sift-ref-panel]');
      if (referencePanel) {
        const referencePath = referencePanel.dataset.annotationUri;
        const referenceName = referencePanel.dataset.annotationTitle;
        if (!referencePath || !referenceName) return undefined;
        const card = element.closest<HTMLElement>('[data-sift-card]');
        const group = element.closest<HTMLElement>('[data-sift-conversation-group]');
        const root = card?.querySelector<HTMLElement>('[data-sift-card-body]') ?? group;
        if (!root || !referencePanel.contains(root)) return undefined;
        const fragment = card ? `card:${card.dataset.cardId ?? 'unknown'}` : `group:${group?.dataset.siftConversationGroup ?? 'unknown'}`;
        return {
          root,
          source: {
            kind: card ? 'sift-reference-card' : 'sift-conversation-group',
            uri: `sift-reference://${encodeURIComponent(referencePath)}#${fragment}`,
            title: referenceName,
            metadata: { referencePath, fragment },
          },
        };
      }

      const documentRoot = element.closest<HTMLElement>('[data-sift-editor]');
      const documentPath = documentRoot?.dataset.annotationUri;
      if (documentRoot && documentPath) {
        return {
          root: documentRoot,
          source: {
            kind: 'workspace-file',
            uri: documentPath,
            title: documentRoot.dataset.annotationTitle ?? documentPath.split(/[\\/]/).at(-1) ?? '当前文件',
          },
        };
      }
      return undefined;
    },
  };
}

export function installAnnotationAdapter(): () => void {
  if (typeof window === 'undefined') return () => {};
  let disposeSurface: (() => void) | undefined;
  let connectedService: AnnotationService | undefined;
  const connect = (service?: AnnotationService) => {
    const next = service ?? (window as AnnotationWindow)[SERVICE_SYMBOL];
    if (!next || next === connectedService) return;
    disposeSurface?.();
    connectedService = next;
    disposeSurface = next.registerSurface(siftSurface());
  };
  const onReady = (event: Event) => connect((event as CustomEvent<AnnotationService>).detail);
  document.addEventListener(READY_EVENT, onReady);
  connect();
  document.dispatchEvent(new CustomEvent(REQUEST_EVENT));
  return () => { document.removeEventListener(READY_EVENT, onReady); disposeSurface?.(); connectedService = undefined; };
}
