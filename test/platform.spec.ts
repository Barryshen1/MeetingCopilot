import { describe, expect, it } from 'vitest';
import {
  captureKindForPlatform,
  defaultHotkeysForPlatform,
  themSourceFor,
  whisperExecutionProvidersForPlatform,
} from '../shared/platform';

describe('platform defaults', () => {
  it('uses familiar Command shortcuts on macOS without changing Windows defaults', () => {
    expect(defaultHotkeysForPlatform('darwin')).toEqual({
      toggle: 'Command+B',
      shot: 'Command+Shift+S',
    });
    expect(defaultHotkeysForPlatform('win32')).toEqual({
      toggle: 'Control+B',
      shot: 'Control+Shift+S',
    });
  });

  it('uses Electron loopback only on Windows', () => {
    expect(captureKindForPlatform('win32')).toBe('loopback');
    expect(captureKindForPlatform('darwin')).toBe('input');
    expect(captureKindForPlatform('linux')).toBe('input');
  });

  it('records what the Mac plays for 对方 unless a specific input was chosen', () => {
    expect(themSourceFor('darwin')).toBe('system');
    expect(themSourceFor('darwin', '')).toBe('system');
    expect(themSourceFor('darwin', 'default')).toBe('system'); // the built-in mic
    expect(themSourceFor('darwin', 'blackhole-device-id')).toBe('input');
    expect(themSourceFor('win32', 'anything')).toBe('loopback');
    expect(themSourceFor('linux')).toBe('input');
  });

  it('never attempts the Windows DirectML provider on macOS', () => {
    expect(whisperExecutionProvidersForPlatform('win32')).toEqual(['dml', 'cpu']);
    expect(whisperExecutionProvidersForPlatform('darwin')).toEqual(['cpu']);
  });
});
