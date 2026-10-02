import { describe, expect, it } from 'vitest';
import { PcmFramer, SYSTEM_AUDIO_FRAME_SAMPLES, systemAudioHelperPath } from '../electron/macSystemAudio';
import { join } from 'path';

describe('macOS system-audio PCM framing', () => {
  it('cuts the helper byte stream into 100 ms Float32 frames across chunk boundaries', () => {
    const frames: Float32Array[] = [];
    const framer = new PcmFramer((frame) => frames.push(new Float32Array(frame)));
    const samples = new Float32Array(SYSTEM_AUDIO_FRAME_SAMPLES * 2 + 10).map((_, i) => i / 10_000);
    const bytes = Buffer.from(samples.buffer);
    // odd split points, including one inside a float
    framer.push(bytes.subarray(0, 1001));
    framer.push(bytes.subarray(1001, 7003));
    framer.push(bytes.subarray(7003));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(SYSTEM_AUDIO_FRAME_SAMPLES);
    expect(frames[1][0]).toBeCloseTo(samples[SYSTEM_AUDIO_FRAME_SAMPLES], 6);
    expect(frames[1][SYSTEM_AUDIO_FRAME_SAMPLES - 1]).toBeCloseTo(samples[2 * SYSTEM_AUDIO_FRAME_SAMPLES - 1], 6);
  });

  it('drops a partial frame on reset', () => {
    const frames: ArrayBuffer[] = [];
    const framer = new PcmFramer((frame) => frames.push(frame));
    framer.push(Buffer.alloc(SYSTEM_AUDIO_FRAME_SAMPLES * 4 - 4));
    framer.reset();
    framer.push(Buffer.alloc(8));
    expect(frames).toHaveLength(0);
  });

  it('finds the helper next to the other packaged resources', () => {
    expect(systemAudioHelperPath('/App/Contents/Resources')).toBe(join('/App/Contents/Resources', 'resources', 'bin', 'mc-system-audio'));
  });
});
