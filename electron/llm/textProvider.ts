import type { ClaudeCodeSettings } from '../../shared/claudeCode';
import type { CodexSettings } from '../../shared/codex';
import { isCliBackend, type LlmBackend } from '../../shared/protocol';
import { chatOnce, chatStream, type ChatMessage, type ChatResult, type ChatStreamCallbacks } from './adapter';

export interface TextProviderConfig {
  backend?: LlmBackend;
  codex?: CodexSettings;
  claudeCode?: ClaudeCodeSettings;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface CodexChat {
  chat(config: CodexSettings, messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult>;
}

export interface ClaudeCodeChat {
  chat(config: ClaudeCodeSettings, messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult>;
}

/** One routing point for answers, translations, and rolling meeting notes. */
export class TextProvider {
  constructor(
    private readonly config: () => TextProviderConfig,
    private readonly codex: CodexChat,
    private readonly claudeCode: ClaudeCodeChat,
    private readonly api = { chatOnce, chatStream },
  ) {}

  /** A signed-in CLI answers text and screenshots; no API key or vision provider is involved. */
  get usesCli(): boolean { return isCliBackend(this.config().backend); }
  get configured(): boolean { return this.usesCli || !!this.config().apiKey; }

  stream(messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    const config = this.config();
    if (config.backend === 'claude-code-cli') return this.claudeCode.chat(config.claudeCode ?? {}, messages, callbacks, signal);
    if (config.backend === 'codex-cli') return this.codex.chat(config.codex ?? {}, messages, callbacks, signal);
    if (!config.apiKey) return Promise.reject(new Error('Configure an API key or select Claude Code CLI or Codex CLI in Settings.'));
    return this.api.chatStream({ ...config, apiKey: config.apiKey }, messages, callbacks, signal);
  }

  once(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<ChatResult> {
    const config = this.config();
    if (config.backend === 'claude-code-cli') return this.claudeCode.chat(config.claudeCode ?? {}, messages, { onDelta: () => {} }, opts?.signal);
    if (config.backend === 'codex-cli') return this.codex.chat(config.codex ?? {}, messages, { onDelta: () => {} }, opts?.signal);
    if (!config.apiKey) return Promise.reject(new Error('Configure an API key or select Claude Code CLI or Codex CLI in Settings.'));
    return this.api.chatOnce({ ...config, apiKey: config.apiKey }, messages, opts);
  }
}
