/** Public Codex CLI settings and status. Authentication stays inside Codex. */
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexSettings {
  /** Empty uses automatic discovery. */
  binaryPath?: string;
  /** Empty uses the CLI's default model. */
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

/** Empty and omitted overrides both mean the CLI default. */
export function codexConfigKey(config: CodexSettings = {}): string {
  return JSON.stringify([config.binaryPath?.trim() ?? '', config.model?.trim() ?? '', config.reasoningEffort ?? '']);
}

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort?: CodexReasoningEffort;
  supportedReasoningEfforts: { reasoningEffort: CodexReasoningEffort; description: string }[];
}

export interface CodexStatus {
  installed: boolean;
  authenticated: boolean;
  binaryPath?: string;
  accountType?: string;
  accountEmail?: string;
  accountPlan?: string;
  models: CodexModel[];
  error?: string;
}

export interface CodexTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}
