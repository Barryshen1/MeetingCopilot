/**
 * Live translation of the 对方 channel (Alibaba Cloud Model Studio
 * "LiveTranslate" realtime models). One WebSocket stream returns BOTH the
 * original-language transcript and the translation, so while it is on it
 * replaces the plain streaming ASR for 对方; 我 keeps the normal engine.
 *
 * It reuses the 云端流式 (asr.realtime) workspace URL and API key: the same
 * Model Studio workspace serves both, only the path differs
 *   ASR:       wss://{ws}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference
 *   translate: wss://{ws}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=…
 * Pure (no electron / fs) so it is unit-tested and shared with the renderer.
 */

export const DEFAULT_LIVE_TRANSLATE_MODEL = 'qwen3.8-livetranslate-flash-realtime';

/** target languages offered in the UI (the model supports many more) */
export type LiveTranslateTarget = 'zh' | 'en';
export const LIVE_TRANSLATE_TARGETS: readonly LiveTranslateTarget[] = ['zh', 'en'];

export interface LiveTranslateSettings {
  /** translate 对方 live (default off: it costs per audio second) */
  enabled: boolean;
  model: string;
  target: LiveTranslateTarget;
}

export const DEFAULT_LIVE_TRANSLATE: LiveTranslateSettings = {
  enabled: false,
  model: DEFAULT_LIVE_TRANSLATE_MODEL,
  target: 'zh',
};

/** fill missing / invalid fields from the defaults (stored files may be partial) */
export function normalizeLiveTranslate(raw?: Partial<LiveTranslateSettings> | null): LiveTranslateSettings {
  const model = typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_LIVE_TRANSLATE_MODEL;
  const target = LIVE_TRANSLATE_TARGETS.includes(raw?.target as LiveTranslateTarget)
    ? (raw!.target as LiveTranslateTarget)
    : DEFAULT_LIVE_TRANSLATE.target;
  return { enabled: raw?.enabled === true, model, target };
}

/**
 * Realtime (translate) endpoint derived from the streaming-ASR endpoint, or
 * null when that endpoint is not an Alibaba Cloud Model Studio WebSocket
 * (e.g. the local FunASR sidecar) — live translation then is unavailable.
 */
export function liveTranslateUrl(realtimeBaseUrl: string | undefined, model: string): string | null {
  if (!realtimeBaseUrl || !model) return null;
  let url: URL;
  try {
    url = new URL(realtimeBaseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:') return null;
  if (!/(^|\.)aliyuncs\.com$/i.test(url.hostname)) return null;
  url.pathname = '/api-ws/v1/realtime';
  url.search = '';
  url.hash = '';
  url.searchParams.set('model', model);
  return url.toString();
}
