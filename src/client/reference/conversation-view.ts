import type { ConversationReferenceDocument } from '../../references.js';
import { mountMarkdownView } from '../markdown-view.js';

function firstMeaningfulLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? '（空问题）';
}

/** Conversation Reference 的机械浏览视图：问题优先，回答按组展开。 */
export function mountConversationView(
  host: HTMLElement,
  reference: ConversationReferenceDocument,
  onChange: (next: ConversationReferenceDocument) => void,
  onAnalyze: (groupId: string) => Promise<void>,
  onAnalyzeTopic: (topic: string) => Promise<void>,
  analyzing = false,
  analysisTarget?: { readonly type: 'group'; readonly groupId: string } | { readonly type: 'topic'; readonly topic: string },
  topicDraft?: string,
  onTopicDraftChange?: (value: string) => void,
): () => void {
  const markdownDisposers: Array<() => void> = [];
  const root = document.createElement('div');
  root.dataset.siftConversation = '';

  const topicBar = document.createElement('form');
  topicBar.className = 'sift-conversation-topic-bar';
  const topicInput = document.createElement('input');
  topicInput.type = 'text';
  topicInput.placeholder = '输入主题，例如：人的认知带宽';
  topicInput.setAttribute('aria-label', '会话分析主题');
  topicInput.value = topicDraft ?? reference.analysis?.topic ?? '';
  topicInput.addEventListener('input', () => onTopicDraftChange?.(topicInput.value));
  const clearTopic = document.createElement('button');
  clearTopic.type = 'button';
  clearTopic.className = 'sift-conversation-topic-clear';
  clearTopic.setAttribute('aria-label', '清除分析主题');
  clearTopic.title = '清除分析主题';
  clearTopic.textContent = '×';
  clearTopic.hidden = topicInput.value === '';
  topicInput.addEventListener('input', () => { clearTopic.hidden = topicInput.value === ''; });
  clearTopic.addEventListener('click', () => {
    topicInput.value = '';
    clearTopic.hidden = true;
    onTopicDraftChange?.('');
    topicInput.focus();
  });
  const topicField = document.createElement('div');
  topicField.className = 'sift-conversation-topic-field';
  topicField.append(topicInput, clearTopic);
  const topicButton = document.createElement('button');
  topicButton.type = 'submit';
  topicButton.textContent = analyzing && analysisTarget?.type === 'topic' ? '分析中…' : '分析主题';
  topicButton.disabled = analyzing;
  topicBar.append(topicField, topicButton);
  topicBar.addEventListener('submit', event => {
    event.preventDefault();
    const topic = topicInput.value.trim();
    if (!topic) return;
    topicButton.disabled = true;
    topicButton.textContent = '分析中…';
    void onAnalyzeTopic(topic).catch(error => {
      topicButton.disabled = false;
      topicButton.textContent = '重试分析';
      topicButton.title = error instanceof Error ? error.message : '会话主题分析失败。';
    });
  });
  root.appendChild(topicBar);

  if (reference.warnings.length > 0) {
    const warning = document.createElement('div');
    warning.dataset.siftConversationWarnings = '';
    warning.textContent = reference.warnings.join(' ');
    root.appendChild(warning);
  }

  const content = document.createElement('div');
  content.dataset.siftConversationContent = '';
  const navigation = document.createElement('nav');
  navigation.dataset.siftConversationNav = '';
  navigation.setAttribute('aria-label', '会话关联分布');
  const list = document.createElement('div');
  list.dataset.siftConversationGroups = '';
  const locateGroup = (article: HTMLElement, marker: HTMLElement) => {
    root.querySelectorAll('[data-located], [data-active]').forEach(element => {
      element.removeAttribute('data-located');
      element.removeAttribute('data-active');
    });
    article.dataset.located = '';
    marker.dataset.active = '';
    article.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'smooth' });
    window.setTimeout(() => {
      article.removeAttribute('data-located');
      marker.removeAttribute('data-active');
    }, 1900);
  };
  reference.groups.forEach((group, index) => {
    const article = document.createElement('article');
    article.dataset.siftConversationGroup = group.id;
    const isAnalyzingGroup = analyzing && analysisTarget?.type === 'group' && analysisTarget.groupId === group.id;
    if (isAnalyzingGroup) article.dataset.analyzing = '';
    if (!group.collapsed) article.dataset.expanded = '';
    const result = reference.analysis?.items.find(item => item.groupId === group.id);
    if (result) {
      article.dataset.relevance = result.relevance;
      article.dataset.continuity = result.continuity;
    }

    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'sift-conversation-nav-marker';
    marker.dataset.groupId = group.id;
    marker.title = result ? `${group.id}：${result.reason}` : group.id;
    marker.setAttribute('aria-label', `跳转到 ${group.id}`);
    if (result) marker.dataset.relevance = result.relevance;
    marker.addEventListener('click', () => {
      if (!group.collapsed) {
        locateGroup(article, marker);
        return;
      }
      onChange({
        ...reference,
        groups: reference.groups.map(item => item.id === group.id ? { ...item, collapsed: false } : item),
      });
      queueMicrotask(() => {
        const nextArticle = host.querySelector<HTMLElement>(`[data-sift-conversation-group="${group.id}"]`);
        const nextMarker = Array.from(host.querySelectorAll<HTMLElement>('.sift-conversation-nav-marker'))
          .find(item => item.dataset.groupId === group.id);
        if (nextArticle && nextMarker) locateGroup(nextArticle, nextMarker);
      });
    });
    navigation.appendChild(marker);

    const header = document.createElement('div');
    header.className = 'sift-conversation-group-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sift-conversation-group-toggle';
    toggle.setAttribute('aria-expanded', String(!group.collapsed));
    const number = document.createElement('span');
    number.className = 'sift-conversation-group-number';
    number.textContent = `Q${index + 1}`;
    const title = document.createElement('span');
    title.className = 'sift-conversation-group-title';
    title.textContent = firstMeaningfulLine(group.user.content);
    const analyze = document.createElement('button');
    analyze.type = 'button';
    analyze.className = 'sift-conversation-analyze';
    analyze.textContent = isAnalyzingGroup ? '分析中…' : reference.analysis?.anchorGroupId === group.id ? '已分析' : '分析关联';
    analyze.disabled = analyzing;
    analyze.title = '以此问答为锚点分析整场会话';
    analyze.addEventListener('click', event => {
      event.stopPropagation();
      analyze.disabled = true;
      analyze.textContent = '分析中…';
      void onAnalyze(group.id).catch(error => {
        analyze.disabled = false;
        analyze.textContent = '重试分析';
        analyze.title = error instanceof Error ? error.message : '会话关联分析失败。';
      });
    });
    const contextDependency = result?.contextDependency ?? group.contextDependency;
    if (contextDependency === 'needs_previous') {
      const context = document.createElement('span');
      context.className = 'sift-conversation-context-badge';
      context.textContent = '↳';
      context.title = '需要结合前文理解';
      toggle.append(number, context, title);
    } else {
      toggle.append(number, title);
    }
    toggle.addEventListener('click', () => {
      onChange({
        ...reference,
        groups: reference.groups.map(item => item.id === group.id ? { ...item, collapsed: !item.collapsed } : item),
      });
    });
    header.append(toggle, analyze);
    article.appendChild(header);

    if (!group.collapsed) {
      const body = document.createElement('div');
      body.className = 'sift-conversation-group-body';
      const userLabel = document.createElement('div');
      userLabel.className = 'sift-conversation-turn-label';
      userLabel.textContent = group.user.messageTime ? `你 · ${group.user.messageTime}` : '你';
      const userContent = document.createElement('div');
      userContent.className = 'sift-conversation-turn-content';
      const assistantLabel = document.createElement('div');
      assistantLabel.className = 'sift-conversation-turn-label';
      assistantLabel.textContent = group.assistant.name;
      const assistantContent = document.createElement('div');
      assistantContent.className = 'sift-conversation-turn-content';
      body.append(userLabel, userContent, assistantLabel, assistantContent);
      article.appendChild(body);
      markdownDisposers.push(mountMarkdownView(userContent, group.user.content));
      markdownDisposers.push(mountMarkdownView(assistantContent, group.assistant.content));
    }
    list.appendChild(article);
  });
  content.append(list, navigation);
  root.appendChild(content);
  host.replaceChildren(root);
  return () => {
    markdownDisposers.forEach(dispose => dispose());
    root.remove();
  };
}
