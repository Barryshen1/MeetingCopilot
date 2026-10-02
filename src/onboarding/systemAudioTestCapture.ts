/**
 * Setup-wizard level check for the macOS 对方 channel: frames come from the
 * same system-audio helper the meeting capture uses (what the Mac plays),
 * relayed by the main process. No microphone is opened.
 */
export class SystemAudioTestCapture {
  private off: (() => void) | null = null;

  get running(): boolean {
    return this.off !== null;
  }

  async start(onPcm: (pcm: ArrayBuffer, captureTs: number) => void): Promise<void> {
    if (this.off) return;
    this.off = window.mcSetup.onSystemAudioTestFrame((frame) => onPcm(frame, Date.now()));
    try {
      await window.mcSetup.systemAudioTestStart();
    } catch (e) {
      this.off();
      this.off = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.off) return;
    this.off();
    this.off = null;
    await window.mcSetup.systemAudioTestStop();
  }
}
