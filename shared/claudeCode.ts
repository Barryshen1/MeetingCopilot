/** Public Claude Code CLI settings and status. Authentication stays inside Claude Code. */
export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every value `claude --effort` accepts, lowest first. */
export const CLAUDE_CODE_EFFORTS: readonly ClaudeCodeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ClaudeCodeSettings {
  /** Empty uses automatic discovery. */
  binaryPath?: string;
  /** Full model id or CLI alias. Empty uses the CLI's default model. */
  model?: string;
  /** Empty uses the CLI's default effort. */
  effort?: ClaudeCodeEffort;
}

/** New profiles (and profiles that never chose an answer backend) start here. */
export const CLAUDE_CODE_DEFAULT_MODEL = 'claude-opus-5-5';
export const CLAUDE_CODE_DEFAULT_EFFORT: ClaudeCodeEffort = 'low';

export interface ClaudeCodeModel {
  id: string;
  displayName: string;
}

/**
 * Claude Code has no model-list API, so Settings offers a fixed list plus a
 * custom id field. The CLI validates the id when a request is made.
 */
export const CLAUDE_CODE_MODELS: readonly ClaudeCodeModel[] = [
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
];

export function isClaudeCodeEffort(value: unknown): value is ClaudeCodeEffort {
  return typeof value === 'string' && (CLAUDE_CODE_EFFORTS as readonly string[]).includes(value);
}

/** Empty and omitted overrides both mean the CLI default. */
export function claudeCodeConfigKey(config: ClaudeCodeSettings = {}): string {
  return JSON.stringify([config.binaryPath?.trim() ?? '', config.model?.trim() ?? '', config.effort ?? '']);
}

export interface ClaudeCodeStatus {
  installed: boolean;
  authenticated: boolean;
  binaryPath?: string;
  /** e.g. "2.1.291" from `claude --version` */
  version?: string;
  /** `claude auth status` display fields only; never tokens or account ids */
  authMethod?: string;
  apiProvider?: string;
  accountEmail?: string;
  subscriptionType?: string;
  error?: string;
}

export interface ClaudeCodeTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}
