import { describe, expect, it, vi } from 'vitest';
import { TextProvider, type TextProviderConfig } from '../electron/llm/textProvider';
import type { ChatMessage } from '../electron/llm/adapter';

const messages: ChatMessage[] = [{ role: 'user', content: 'Summarize this meeting.' }];

function setup(config: TextProviderConfig) {
  const codex = { chat: vi.fn(async () => ({ text: 'Codex reply' })) };
  const api = {
    chatOnce: vi.fn(async () => ({ text: 'API reply' })),
    chatStream: vi.fn(async () => ({ text: 'API reply' })),
  };
  return { provider: new TextProvider(() => config, codex, api), codex, api };
}

describe('text provider routing', () => {
  it('routes Codex answers and memo updates without requiring an API key', async () => {
    const config: TextProviderConfig = { backend: 'codex-cli', codex: { model: 'chosen-model' }, baseUrl: 'https://unused.test', model: 'api-model' };
    const { provider, codex, api } = setup(config);
    const onDelta = vi.fn();
    const signal = new AbortController().signal;
    expect(provider.configured).toBe(true);
    await provider.stream(messages, { onDelta }, signal);
    await provider.once(messages, { maxTokens: 700, signal });
    expect(codex.chat).toHaveBeenNthCalledWith(1, config.codex, messages, { onDelta }, signal);
    expect(codex.chat).toHaveBeenCalledTimes(2);
    expect(api.chatStream).not.toHaveBeenCalled();
    expect(api.chatOnce).not.toHaveBeenCalled();
  });

  it('keeps existing profiles on the API transport and retains one-shot options', async () => {
    const config = { baseUrl: 'https://api.example.test', model: 'api-model', apiKey: 'test-only' };
    const { provider, codex, api } = setup(config);
    const options = { maxTokens: 700, temperature: 0.2 };
    await provider.once(messages, options);
    expect(api.chatOnce).toHaveBeenCalledWith(config, messages, options);
    expect(codex.chat).not.toHaveBeenCalled();
  });

  it('does not route an unconfigured API profile through the signed-in CLI', async () => {
    const { provider, codex, api } = setup({ baseUrl: 'https://api.example.test', model: 'api-model' });
    expect(provider.configured).toBe(false);
    await expect(provider.stream(messages, { onDelta: () => {} })).rejects.toThrow('API key');
    expect(codex.chat).not.toHaveBeenCalled();
    expect(api.chatStream).not.toHaveBeenCalled();
  });

  it('preserves image inputs and cancellation for Codex screenshot questions', async () => {
    const { provider, codex } = setup({ backend: 'codex-cli', baseUrl: '', model: '' });
    const imageMessages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Explain this slide.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } },
    ] }];
    const signal = new AbortController().signal;
    const callbacks = { onDelta: vi.fn() };
    await provider.stream(imageMessages, callbacks, signal);
    expect(codex.chat).toHaveBeenCalledWith({}, imageMessages, callbacks, signal);
  });
});
