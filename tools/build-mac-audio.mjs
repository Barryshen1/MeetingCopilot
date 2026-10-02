#!/usr/bin/env node
/**
 * Compiles the macOS system-audio helper (native/mac-system-audio/main.swift)
 * to resources/bin/mc-system-audio. electron-builder ships it inside the app
 * (mac.extraResources) and signs it with the app. A no-op on other platforms.
 * Needs the Apple Command Line Tools (swiftc), already required for builds.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'native', 'mac-system-audio', 'main.swift');
const output = join(root, 'resources', 'bin', 'mc-system-audio');
const arch = process.env.MC_MAC_ARCH || (process.arch === 'x64' ? 'x86_64' : 'arm64');

// skip when the binary is newer than its source
try {
  if (statSync(output).mtimeMs > statSync(source).mtimeMs) process.exit(0);
} catch { /* not built yet */ }

mkdirSync(dirname(output), { recursive: true });
execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos14.0`, '-o', output, source], { stdio: 'inherit' });
console.log(`[build-mac-audio] built ${output}`);
