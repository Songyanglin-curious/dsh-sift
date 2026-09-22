import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationAnalysisSettings } from '../../settings-contract.js';
import { injectStyle, SIFT_PLUGIN_ID } from '../renderer/inject-style.js';
import settingsCss from './section.css?inline';

interface SettingsSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly value?: T;
  readonly writable: boolean;
}

export interface SettingsScope<T> {
  getSnapshot(): SettingsSnapshot<T>;
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly ({ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] })[]): Promise<void>;
}

interface ReasoningEffort { readonly id: string; readonly name: string; readonly description?: string }
interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: { readonly efforts: readonly ReasoningEffort[]; readonly defaultEffort?: string };
}
interface ProviderGroup { readonly id: string; readonly name: string; readonly models: readonly CatalogModel[] }
export interface ModelCatalog {
  readonly default: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string };
  readonly groups: readonly ProviderGroup[];
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[];
}

export interface SiftSettingsSectionProps {
  readonly settings: SettingsScope<ConversationAnalysisSettings>;
  readonly loadModelCatalog: () => Promise<ModelCatalog>;
}

const MODEL_SEPARATOR = '\u0000';
const EMPTY_SETTINGS: SettingsSnapshot<ConversationAnalysisSettings> = { status: 'loading', writable: false };

function modelKey(provider: string, model: string) {
  return `${provider}${MODEL_SEPARATOR}${model}`;
}

export function SiftSettingsSection({ settings, loadModelCatalog }: SiftSettingsSectionProps) {
  injectStyle(SIFT_PLUGIN_ID, 'settings-section.css', settingsCss);
  const snapshot = useSyncExternalStore(
    listener => settings.subscribe(listener),
    () => settings.getSnapshot(),
    () => EMPTY_SETTINGS,
  );
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const initializingDefault = useRef(false);

  useEffect(() => {
    let active = true;
    setLoadingCatalog(true);
    loadModelCatalog().then(value => {
      if (!active) return;
      setCatalog(value);
      setError(value.failures.length > 0 ? '部分模型提供方暂时无法读取，已显示其余可用模型。' : undefined);
    }, reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoadingCatalog(false);
    });
    return () => { active = false; };
  }, [loadModelCatalog]);

  const effective = snapshot.value ?? {};
  const selectedProvider = effective.provider ?? catalog?.default.provider;
  const selectedModelId = effective.model ?? catalog?.default.model;
  const selectedGroup = catalog?.groups.find(group => group.id === selectedProvider);
  const selectedModel = selectedGroup?.models.find(model => model.id === selectedModelId);
  const selectedReasoning = effective.reasoningEffort
    ?? (effective.provider === undefined ? catalog?.default.reasoningEffort : undefined)
    ?? selectedModel?.reasoning?.defaultEffort
    ?? '';
  const selectedKey = selectedProvider && selectedModelId ? modelKey(selectedProvider, selectedModelId) : '';
  const modelOptions = useMemo(() => catalog?.groups.flatMap(group => group.models.map(model => ({
    key: modelKey(group.id, model.id),
    provider: group.id,
    model: model.id,
    label: `${model.name} · ${group.name}`,
    value: model,
  }))) ?? [], [catalog]);

  useEffect(() => {
    if (snapshot.status !== 'ready' || !snapshot.writable || !catalog
      || (effective.provider !== undefined && effective.model !== undefined)
      || initializingDefault.current) return;
    initializingDefault.current = true;
    const defaultModel = catalog.groups
      .find(group => group.id === catalog.default.provider)?.models
      .find(model => model.id === catalog.default.model);
    const effort = catalog.default.reasoningEffort ?? defaultModel?.reasoning?.defaultEffort;
    void settings.mutate([
      { op: 'set', path: ['provider'], value: catalog.default.provider },
      { op: 'set', path: ['model'], value: catalog.default.model },
      ...(effort === undefined ? [] : [{ op: 'set' as const, path: ['reasoningEffort'], value: effort }]),
    ]).catch(reason => {
      initializingDefault.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [catalog, effective.model, effective.provider, settings, snapshot.status, snapshot.writable]);

  const write = async (ops: Parameters<typeof settings.mutate>[0]) => {
    setSaving(true);
    setError(undefined);
    try {
      await settings.mutate(ops);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const selectModel = (key: string) => {
    const option = modelOptions.find(item => item.key === key);
    if (!option) return;
    const effort = option.value.reasoning?.defaultEffort;
    void write([
      { op: 'set', path: ['provider'], value: option.provider },
      { op: 'set', path: ['model'], value: option.model },
      effort === undefined
        ? { op: 'unset', path: ['reasoningEffort'] }
        : { op: 'set', path: ['reasoningEffort'], value: effort },
    ]);
  };

  const selectEffort = (effort: string) => {
    void write(effort === ''
      ? [{ op: 'unset', path: ['reasoningEffort'] }]
      : [{ op: 'set', path: ['reasoningEffort'], value: effort }]);
  };

  const disabled = snapshot.status !== 'ready' || !snapshot.writable || loadingCatalog || saving;
  return <section data-sift-settings>
    <header data-sift-settings-header>
      <h2>会话解析</h2>
      <p>选择 Sift 分析长会话关联关系时使用的 DSH 模型。连接信息和密钥继续由 DSH 管理。</p>
    </header>
    <div data-sift-settings-row>
      <div data-sift-settings-label>
        <strong>模型</strong>
        <span>来自 DSH 当前已经配置并可调用的模型</span>
      </div>
      <select data-sift-settings-select aria-label="会话解析模型" value={selectedKey} disabled={disabled} onChange={event => selectModel(event.target.value)}>
        {loadingCatalog && <option value="">正在读取模型…</option>}
        {!loadingCatalog && modelOptions.length === 0 && <option value="">没有可用模型</option>}
        {modelOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
    </div>
    <div data-sift-settings-row>
      <div data-sift-settings-label>
        <strong>思考强度</strong>
        <span>只显示当前模型实际支持的等级</span>
      </div>
      <select data-sift-settings-select aria-label="会话解析思考强度" value={selectedReasoning} disabled={disabled || !selectedModel?.reasoning} onChange={event => selectEffort(event.target.value)}>
        {!selectedModel?.reasoning && <option value="">当前模型不提供思考强度</option>}
        {selectedModel?.reasoning?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
      </select>
    </div>
    <p data-sift-settings-note>设置即时保存，仅用于 Sift 的会话解析任务，不会改变当前聊天使用的模型。</p>
    {snapshot.status === 'unavailable' && <p data-sift-settings-status="error">当前 DSH 设置服务不可用。</p>}
    {error && <p data-sift-settings-status="error">{error}</p>}
    {saving && <p data-sift-settings-status>正在保存…</p>}
  </section>;
}
