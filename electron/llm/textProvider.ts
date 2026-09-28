import type { CodexSettings } from '../../shared/codex';
import { chatOnce, chatStream, type ChatMessage, type ChatResult, type ChatStreamCallbacks } from './adapter';

export interface TextProviderConfig {
  backend?: 'openai-compatible' | 'codex-cli';
  codex?: CodexSettings;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface CodexChat {
  chat(config: CodexSettings, messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult>;
}

/** One routing point for answers, translations, and rolling meeting notes. */
export class TextProvider {
  constructor(
    private readonly config: () => TextProviderConfig,
    private readonly codex: CodexChat,
    private readonly api = { chatOnce, chatStream },
  ) {}

  get usesCodex(): boolean { return this.config().backend === 'codex-cli'; }
  get configured(): boolean { return this.usesCodex || !!this.config().apiKey; }

  stream(messages: ChatMessage[], callbacks: ChatStreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    const config = this.config();
    if (config.backend === 'codex-cli') return this.codex.chat(config.codex ?? {}, messages, callbacks, signal);
    if (!config.apiKey) return Promise.reject(new Error('Configure an API key or select Codex CLI in Settings.'));
    return this.api.chatStream({ ...config, apiKey: config.apiKey }, messages, callbacks, signal);
  }

  once(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<ChatResult> {
    const config = this.config();
    if (config.backend === 'codex-cli') return this.codex.chat(config.codex ?? {}, messages, { onDelta: () => {} }, opts?.signal);
    if (!config.apiKey) return Promise.reject(new Error('Configure an API key or select Codex CLI in Settings.'));
    return this.api.chatOnce({ ...config, apiKey: config.apiKey }, messages, opts);
  }
}
