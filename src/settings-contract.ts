export const SIFT_SETTINGS_NAMESPACE = 'sift';

export interface ConversationAnalysisSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

