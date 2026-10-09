/**
 * SDD contract: ASR worker protocol (main thread <-> worker_threads).
 * Frozen interface so the engine is swappable (turbo now, faster-whisper /
 * WebGPU later). Do not add engine-specific fields here.
 */

export interface WorkerInit {
  type: 'init';
  /** 'local' = Whisper turbo on-device; 'cloud' = OpenAI-compatible ASR API; 'cloud-realtime' = WebSocket streaming ASR */
  backend: 'local' | 'cloud' | 'cloud-realtime';
  modelsDir: string;
  modelId: string;
  /** ONNX Runtime execution providers, in preference order */
  ep: ('dml' | 'cpu')[];
  language: 'auto' | string;
  /** cloud ASR provider (required when backend === 'cloud' | 'cloud-realtime') */
  cloud?: { baseUrl: string; model: string; apiKey: string };
  /**
   * live translation for the 对方 channel (Model Studio LiveTranslate); absent
   * when not configured. `enabled` can be flipped later with a config message.
   */
  liveTranslate?: { url: string; apiKey: string; target: string; enabled: boolean };
}

export interface WorkerPcm {
  type: 'pcm';
  /** 16 kHz mono float32 PCM frame (transferred) */
  pcm: Float32Array;
  /** Date.now() at capture of the frame's last sample */
  captureTs: number;
  /** which channel this audio belongs to */
  channel: 'them' | 'me';
}

export interface WorkerConfig {
  type: 'config';
  language?: 'auto' | string;
  /** turn 对方 live translation on/off without rebuilding the engine */
  liveTranslate?: boolean;
}

/** Force-close any open speech segment (capture stop / user request). */
export interface WorkerFlush {
  type: 'flush';
}

export interface WorkerShutdown {
  type: 'shutdown';
}

export type WorkerInMessage = WorkerInit | WorkerPcm | WorkerConfig | WorkerFlush | WorkerShutdown;

// ---- worker -> main ----

export interface WorkerReady {
  type: 'ready';
  loadMs: number;
  warmMs: number;
  ep: string;
  gpuSuspect: boolean;
}

export interface WorkerSegment {
  type: 'segment';
  id: number;
  text: string;
  lang?: string;
  speaker: 'them' | 'me';
  /** live translation of `text` (LiveTranslate engine only) */
  translation?: string;
  audioMs: number;
  speechStartTs: number;
  speechEndTs: number;
  vadCloseTs: number;
  inferStartTs: number;
  inferEndTs: number;
}

export interface WorkerPartial {
  type: 'partial';
  speaker: 'them' | 'me';
  text: string;
  /** translation so far (LiveTranslate engine only) */
  translation?: string;
}

export interface WorkerStatus {
  type: 'status';
  state: 'listening' | 'speech' | 'transcribing';
  queuedSegments: number;
}

export interface WorkerError {
  type: 'error';
  message: string;
  fatal: boolean;
}

export type WorkerOutMessage =
  | WorkerReady
  | WorkerSegment
  | WorkerPartial
  | WorkerStatus
  | WorkerError;
