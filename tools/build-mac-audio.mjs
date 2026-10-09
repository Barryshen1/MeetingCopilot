#!/usr/bin/env node
/**
 * Compiles the macOS native helpers to resources/bin/, where electron-builder
 * ships them inside the app (mac.extraResources) and signs them with it:
 *   - mc-system-audio  (native/mac-system-audio)  对方 = what the Mac plays
 *   - mc-window-shot   (native/mac-window-shot)   📷 = the window you work in
 * A no-op on other platforms. Needs the Apple Command Line Tools (swiftc),
 * already required for builds.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.env.MC_MAC_ARCH || (process.arch === 'x64' ? 'x86_64' : 'arm64');
const helpers = [
  { name: 'mc-system-audio', source: join(root, 'native', 'mac-system-audio', 'main.swift') },
  { name: 'mc-window-shot', source: join(root, 'native', 'mac-window-shot', 'main.swift') },
];

for (const { name, source } of helpers) {
  const output = join(root, 'resources', 'bin', name);
  // skip when the binary is newer than its source
  try {
    if (statSync(output).mtimeMs > statSync(source).mtimeMs) continue;
  } catch { /* not built yet */ }
  mkdirSync(dirname(output), { recursive: true });
  execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos14.0`, '-o', output, source], { stdio: 'inherit' });
  console.log(`[build-mac-helpers] built ${output}`);
}
