import { contextBridge, ipcRenderer } from 'electron';
import type { CodexSettings, CodexStatus, CodexTestResult } from '../shared/codex';
import {
  IPC,
  type AppInfo,
  type AsrEvent,
  type KbSlot,
  type LlmAskPayload,
  type LlmEvent,
  type OnboardingProgressPatch,
  type OnboardingState,
  type PickedDocument,
  type ProviderTestRequest,
  type ProviderTestResult,
  type PublicSettings,
  type ScreenshotMode,
  type SessionAttachment,
  type SessionsFile,
  type SettingsPatch,
  type TrayCommandPayload,
  type TranscriptExportResult,
} from '../shared/protocol';

export interface McApi {
  readonly platform: NodeJS.Platform;
  getSettings(): Promise<PublicSettings>;
  setSettings(patch: SettingsPatch): Promise<PublicSettings>;
  codexStatus(config?: CodexSettings): Promise<CodexStatus>;
  codexTest(config?: CodexSettings): Promise<CodexTestResult>;
  /** first-run wizard state (the main window only reads it / dismisses the
   * upgrade notice — completing onboarding belongs to the setup window) */
  getOnboarding(): Promise<OnboardingState>;
  saveOnboardingProgress(patch: OnboardingProgressPatch): Promise<OnboardingState>;
  /** reopen the setup wizard without closing the app (settings / upgrade notice) */
  rerunOnboarding(): Promise<boolean>;
  importKnowledge(): Promise<{ chars: number }>;
  clearKnowledge(): Promise<{ chars: number }>;
  /** pick a resume or JD for the current session */
  pickKnowledge(slot: KbSlot): Promise<PickedDocument | null>;
  /** pick several additional reference files for the current session */
  pickKnowledgeFiles(): Promise<PickedDocument[] | null>;
  loadSessions(): Promise<SessionsFile>;
  saveSessions(data: SessionsFile): void;
  setStealth(on: boolean): Promise<boolean>;
  sendPcm(buf: ArrayBuffer, captureTs: number, channel: 'them' | 'me'): void;
  captureStarted(): void;
  captureStopped(): void;
  /** macOS: start the 对方 channel from what the Mac plays (no microphone) */
  systemAudioStart(): Promise<void>;
  systemAudioStop(): Promise<void>;
  /** the system-audio helper stopped on its own during a capture */
  onSystemAudioFailed(cb: (message: string) => void): () => void;
  /** write the current (or given) session's meeting record now */
  exportTranscript(sessionId?: string): Promise<TranscriptExportResult>;
  /** choose the meeting-record folder; null when cancelled */
  pickExportFolder(): Promise<PublicSettings | null>;
  /** reveal a written record, or open the records folder */
  revealExport(path?: string): void;
  /** fires after ■ 停止 wrote the meeting record automatically */
  onTranscriptExported(cb: (result: TranscriptExportResult) => void): () => void;
  translate(text: string): Promise<string>;
  onAsrEvent(cb: (ev: AsrEvent) => void): () => void;
  /** pull the last ready/status events (call AFTER onAsrEvent subscription) */
  asrReplay(): Promise<{ ready: AsrEvent | null; status: AsrEvent | null }>;
  llmAsk(payload: LlmAskPayload): void;
  shotAsk(payload: {
    requestId: string;
    question: string;
    background?: string;
    attachments?: SessionAttachment[];
    imageDataUrl?: string;
    screenshotMode?: ScreenshotMode;
  }): void;
  /** capture full screen, drag a stealth region overlay; returns cropped dataURL or null */
  pickRegion(): Promise<string | null>;
  /** overlay-only: fetch the captured background image */
  regionImage(): Promise<string | null>;
  /** overlay-only: report chosen rect */
  regionRect(r: { x: number; y: number; width: number; height: number }): void;
  /** overlay-only: cancel */
  regionCancel(): void;
  llmCancel(requestId: string): void;
  /** P1-6: warm the DeepSeek prefix cache with the session's material;
   * immediate=true warms even when not capturing (▶ start / material import) */
  prewarm(payload: { resume?: string; jd?: string; attachments?: SessionAttachment[]; oeaiMode?: boolean; immediate?: boolean }): void;
  /** P1-5: fold a finished Q&A into the rolling memo ('' = keep the old one) */
  memoUpdate(p: { memo: string; question: string; answer: string }): Promise<string>;
  onLlmEvent(cb: (ev: LlmEvent) => void): () => void;
  onShotHotkey(cb: () => void): () => void;
  /** tray menu entries only the renderer can service (capture / session /
   * panels). Main has already made the window visible when this fires. */
  onTrayCommand(cb: (payload: TrayCommandPayload) => void): () => void;
  /** open an allowlisted https documentation link in the OS browser;
   * false = refused by the main-process allowlist */
  openExternal(url: string): Promise<boolean>;
  /** read the clipboard — call ONLY from an explicit paste-button click */
  readClipboardText(): Promise<string>;
  getAppInfo(): Promise<AppInfo>;
  /** run ONE real provider connection test; explicit user action only (it
   * costs the user a minimal billable request). Main maps every failure to a
   * ProviderTestCode + zh/en message, so nothing raw reaches the UI. */
  providerTest(req: ProviderTestRequest): Promise<ProviderTestResult>;
  /** plaintext support report, built locally on request. Contains no keys, no
   * transcripts and no knowledge-base text — safe to paste into an issue. */
  getDiagnostics(): Promise<string>;
  /** reveal %APPDATA%/MeetingCopilot (settings, sessions, knowledge) */
  openLogsFolder(): Promise<boolean>;
  hide(): void;
  quit(): void;
}

const api: McApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  codexStatus: (config) => ipcRenderer.invoke(IPC.codexStatus, config),
  codexTest: (config) => ipcRenderer.invoke(IPC.codexTest, config),
  getOnboarding: () => ipcRenderer.invoke(IPC.onboardingGet),
  saveOnboardingProgress: (patch) => ipcRenderer.invoke(IPC.onboardingSaveProgress, patch),
  rerunOnboarding: () => ipcRenderer.invoke(IPC.onboardingRerun),
  importKnowledge: () => ipcRenderer.invoke(IPC.knowledgeImport),
  clearKnowledge: () => ipcRenderer.invoke(IPC.knowledgeClear),
  pickKnowledge: (slot) => ipcRenderer.invoke(IPC.knowledgePick, slot),
  pickKnowledgeFiles: () => ipcRenderer.invoke(IPC.knowledgePickFiles),
  loadSessions: () => ipcRenderer.invoke(IPC.sessionsLoad),
  saveSessions: (data) => ipcRenderer.send(IPC.sessionsSave, data),
  setStealth: (on) => ipcRenderer.invoke(IPC.stealthSet, on),
  sendPcm: (buf, captureTs, channel) => ipcRenderer.send(IPC.capturePcm, buf, captureTs, channel),
  captureStarted: () => ipcRenderer.send(IPC.captureStarted),
  captureStopped: () => ipcRenderer.send(IPC.captureStopped),
  systemAudioStart: () => ipcRenderer.invoke(IPC.systemAudioStart),
  systemAudioStop: () => ipcRenderer.invoke(IPC.systemAudioStop),
  onSystemAudioFailed: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on(IPC.systemAudioFailed, listener);
    return () => ipcRenderer.removeListener(IPC.systemAudioFailed, listener);
  },
  exportTranscript: (sessionId) => ipcRenderer.invoke(IPC.transcriptExport, sessionId),
  pickExportFolder: () => ipcRenderer.invoke(IPC.transcriptPickFolder),
  revealExport: (path) => ipcRenderer.send(IPC.transcriptReveal, path),
  onTranscriptExported: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, result: TranscriptExportResult) => cb(result);
    ipcRenderer.on(IPC.transcriptExported, listener);
    return () => ipcRenderer.removeListener(IPC.transcriptExported, listener);
  },
  translate: (text) => ipcRenderer.invoke(IPC.translateText, text),
  onAsrEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: AsrEvent) => cb(ev);
    ipcRenderer.on(IPC.asrEvent, listener);
    return () => ipcRenderer.removeListener(IPC.asrEvent, listener);
  },
  asrReplay: () => ipcRenderer.invoke(IPC.asrReplay),
  llmAsk: (payload) => ipcRenderer.send(IPC.llmAsk, payload),
  shotAsk: (payload) => ipcRenderer.send(IPC.shotAsk, payload),
  pickRegion: () => ipcRenderer.invoke(IPC.regionPick),
  regionImage: () => ipcRenderer.invoke(IPC.regionImage),
  regionRect: (r) => ipcRenderer.send(IPC.regionRect, r),
  regionCancel: () => ipcRenderer.send(IPC.regionCancel),
  llmCancel: (requestId) => ipcRenderer.send(IPC.llmCancel, requestId),
  prewarm: (payload) => ipcRenderer.send(IPC.llmPrewarm, payload),
  memoUpdate: (p) => ipcRenderer.invoke(IPC.memoUpdate, p),
  onLlmEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: LlmEvent) => cb(ev);
    ipcRenderer.on(IPC.llmEvent, listener);
    return () => ipcRenderer.removeListener(IPC.llmEvent, listener);
  },
  onShotHotkey: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.shotHotkey, listener);
    return () => ipcRenderer.removeListener(IPC.shotHotkey, listener);
  },
  onTrayCommand: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: TrayCommandPayload) => cb(payload);
    ipcRenderer.on(IPC.trayCommand, listener);
    return () => ipcRenderer.removeListener(IPC.trayCommand, listener);
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url),
  readClipboardText: () => ipcRenderer.invoke(IPC.clipboardReadText),
  getAppInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
  providerTest: (req) => ipcRenderer.invoke(IPC.providerTest, req),
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsGet),
  openLogsFolder: () => ipcRenderer.invoke(IPC.logsOpenFolder),
  hide: () => ipcRenderer.send(IPC.winHide),
  quit: () => ipcRenderer.send(IPC.appQuit),
};

contextBridge.exposeInMainWorld('mc', api);
