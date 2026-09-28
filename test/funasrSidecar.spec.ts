import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseLocalWsPort,
  mossPythonCandidates,
  pythonCandidates,
  resolvePython,
  resolveConfiguredPython,
  sidecarEnvironment,
  sidecarLaunchArgs,
  sidecarModelArg,
  sidecarStopPlan,
} from '../electron/funasrSidecar';

describe('parseLocalWsPort', () => {
  it('extracts the port from local ws:// urls', () => {
    expect(parseLocalWsPort('ws://127.0.0.1:10097')).toBe(10097);
    expect(parseLocalWsPort('ws://localhost:10097/')).toBe(10097);
    expect(parseLocalWsPort('ws://127.0.0.1:10097/api-ws/v1/inference')).toBe(10097);
    expect(parseLocalWsPort(' ws://127.0.0.1:8080 ')).toBe(8080);
  });

  it('defaults to port 80 when omitted', () => {
    expect(parseLocalWsPort('ws://127.0.0.1')).toBe(80);
    expect(parseLocalWsPort('ws://localhost/')).toBe(80);
  });

  it('returns null for anything non-local (never spawns for remote urls)', () => {
    expect(parseLocalWsPort(undefined)).toBeNull();
    expect(parseLocalWsPort('')).toBeNull();
    expect(
      parseLocalWsPort('wss://llm-x.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'),
    ).toBeNull();
    expect(parseLocalWsPort('ws://192.168.1.5:10097')).toBeNull();
    expect(parseLocalWsPort('wss://127.0.0.1:10097')).toBeNull(); // local sidecar is plain ws
    expect(parseLocalWsPort('https://api.xiaomimimo.com/v1')).toBeNull();
  });
});

describe('macOS sidecar portability', () => {
  it('prefers an explicit Python, then the project venv, then PATH commands', () => {
    const explicit = pythonCandidates('/app', 'darwin', '/custom/python');
    expect(explicit[0]).toBe('/custom/python');
    expect(explicit).toContain('/app/.venv/bin/python');
    expect(explicit.slice(-2)).toEqual(['python3', 'python']);

    const windows = pythonCandidates('C:\\app', 'win32');
    expect(windows).toContain('C:\\ProgramData\\miniconda3\\envs\\funasr\\python.exe');
    expect(windows.at(-1)).toBe('python');
  });

  it('reports missing Python without exposing candidate paths', async () => {
    const result = resolvePython(['/bad/python', 'python3'], async () => false);
    await expect(result).rejects.toThrow('no usable Python found');
    await expect(result).rejects.not.toThrow('/bad/python');
  });

  it('uses a saved absolute interpreter ahead of fallback candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-funasr-python-'));
    const configured = join(dir, 'python');
    writeFileSync(configured, 'placeholder');
    const tried: string[] = [];
    try {
      expect(await resolveConfiguredPython(configured, ['python3'], async (path) => {
        tried.push(path);
        return true;
      })).toBe(configured);
      expect(tried).toEqual([configured]);
      for (const [path, probe, expected] of [
        [configured, async () => false, 'cannot run --version'],
        [join(dir, 'missing'), async () => true, 'does not exist'],
        ['relative/python', async () => true, 'must be absolute'],
      ] as const) {
        await expect(resolveConfiguredPython(path, ['python3'], probe))
          .rejects.toThrow(expected);
        await expect(resolveConfiguredPython(path, ['python3'], probe))
          .rejects.not.toThrow(path);
      }
      expect(await resolveConfiguredPython('', ['python3'], async () => true)).toBe('python3');
      await expect(resolveConfiguredPython(process.execPath, []))
        .rejects.toThrow('cannot run --version');
      await expect(resolvePython([configured], async () => false))
        .rejects.not.toThrow(configured);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads only the selected model', () => {
    expect(sidecarModelArg('fun-asr-nano')).toBe('nano');
    expect(sidecarModelArg('paraformer-zh-streaming')).toBe('paraformer');
    expect(sidecarModelArg('moss-transcribe-diarize')).toBe('moss');
    expect(sidecarModelArg(undefined)).toBe('nano');
  });

  it('keeps MOSS in an isolated Python environment', () => {
    const candidates = mossPythonCandidates('C:\\app', 'win32', undefined);
    expect(candidates).toContain('C:\\app\\.venv-moss\\Scripts\\python.exe');
    expect(candidates).toContain('C:\\ProgramData\\miniconda3\\envs\\moss-asr\\python.exe');
    expect(candidates).not.toContain('C:\\ProgramData\\miniconda3\\envs\\funasr\\python.exe');
  });

  it('uses resumable Hub HTTP only for MOSS downloads', () => {
    const base = { PATH: 'test-path' };
    expect(sidecarEnvironment('moss', base)).toEqual({
      PATH: 'test-path',
      PYTHONDONTWRITEBYTECODE: '1',
      HF_HUB_DISABLE_XET: '1',
    });
    expect(sidecarEnvironment('nano', base)).toEqual({ ...base, PYTHONDONTWRITEBYTECODE: '1' });
    expect(sidecarEnvironment('paraformer', base)).toEqual({ ...base, PYTHONDONTWRITEBYTECODE: '1' });
    expect(sidecarEnvironment('moss', { HF_HUB_DISABLE_XET: '0' }).HF_HUB_DISABLE_XET).toBe('0');
  });

  it('routes FunASR downloads to the supplied durable ModelScope cache', () => {
    const base = { PATH: 'test-path' };
    const cache = '/user-data/models/modelscope';
    expect(sidecarEnvironment('nano', base, cache)).toEqual({ ...base, PYTHONDONTWRITEBYTECODE: '1', MODELSCOPE_CACHE: cache });
    expect(sidecarEnvironment('paraformer', base, cache)).toEqual({ ...base, PYTHONDONTWRITEBYTECODE: '1', MODELSCOPE_CACHE: cache });
    expect(sidecarEnvironment('nano', { ...base, MODELSCOPE_CACHE: '/custom' }, cache).MODELSCOPE_CACHE)
      .toBe('/custom');
    expect(sidecarEnvironment('moss', base, cache).MODELSCOPE_CACHE).toBeUndefined();
  });

  it('prevents Python bytecode writes for every bundled sidecar', () => {
    const base = { PYTHONDONTWRITEBYTECODE: '0' };
    for (const model of ['nano', 'paraformer', 'moss'] as const) {
      expect(sidecarEnvironment(model, base).PYTHONDONTWRITEBYTECODE).toBe('1');
      expect(sidecarLaunchArgs(model, '/signed/Resources/tools/server.py', 10097, 'cpu')[0]).toBe('-B');
    }
    expect(base.PYTHONDONTWRITEBYTECODE).toBe('0');
    expect(sidecarLaunchArgs('moss', '/script.py', 10097, 'cpu'))
      .toEqual(['-B', '/script.py', '--port', '10097', '--device', 'cpu']);
    expect(sidecarLaunchArgs('nano', '/script.py', 10097))
      .toEqual(['-B', '/script.py', '--port', '10097', '--model', 'nano', '--device', 'auto']);
  });

  it('kills the process tree with the platform-native strategy', () => {
    expect(sidecarStopPlan('win32', 42)).toEqual({
      kind: 'command',
      file: 'taskkill',
      args: ['/pid', '42', '/T', '/F'],
    });
    expect(sidecarStopPlan('darwin', 42)).toEqual({
      kind: 'signal',
      pid: -42,
      signal: 'SIGTERM',
    });
  });
});
