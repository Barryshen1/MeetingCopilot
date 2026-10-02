/** Public Codex CLI settings and status. Authentication stays inside Codex. */
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexSettings {
  /** Empty uses automatic discovery. */
  binaryPath?: string;
  /** Empty uses the CLI's default model. */
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /**
   * Codex "Fast" mode (the CLI's `priority` service tier: faster answers,
   * higher usage). MeetingCopilot is latency-first, so an omitted value means
   * ON; only an explicit `false` asks Codex for its standard speed.
   */
  fastMode?: boolean;
}

/** Service tier id that Codex CLI's model catalog labels "Fast". */
export const CODEX_FAST_SERVICE_TIER = 'priority';

/** The tier sent with every Codex thread. "default" is the CLI's standard speed. */
export function codexServiceTier(config: CodexSettings = {}): typeof CODEX_FAST_SERVICE_TIER | 'default' {
  return config.fastMode === false ? 'default' : CODEX_FAST_SERVICE_TIER;
}

/**
 * Empty and omitted overrides both mean the CLI default. Fast mode is left out
 * on purpose: it changes speed and usage, not whether the connection works, so
 * toggling it must not discard a passed connection test.
 */
export function codexConfigKey(config: CodexSettings = {}): string {
  return JSON.stringify([config.binaryPath?.trim() ?? '', config.model?.trim() ?? '', config.reasoningEffort ?? '']);
}

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort?: CodexReasoningEffort;
  supportedReasoningEfforts: { reasoningEffort: CodexReasoningEffort; description: string }[];
  /** Speed tiers this model accepts, e.g. { id: 'priority', name: 'Fast', description: '2x speed, increased usage' }. */
  serviceTiers?: CodexServiceTier[];
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
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
