import Schema from '@deepseek-ai/schemastery';
import type { ConversationAnalysisSettings } from './settings-contract.js';
export { SIFT_SETTINGS_NAMESPACE } from './settings-contract.js';
export type { ConversationAnalysisSettings } from './settings-contract.js';

/** Sift 全局设置：只保存 DSH 模型目录中的稳定标识，不保存连接信息或密钥。 */
export const ConversationAnalysisSettingsSchema: Schema<ConversationAnalysisSettings> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  reasoningEffort: Schema.string(),
});
