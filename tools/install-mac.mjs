#!/usr/bin/env node
/**
 * Install the packaged macOS app in ONE place and keep LaunchServices pointing
 * at it:  npm run dist:mac:dir && npm run install:mac
 *
 * Why this exists: every MeetingCopilot.app on any mounted disk is registered
 * under the same bundle id and version. Spotlight / Launchpad then list each
 * copy, and "open the app" can resolve to an old backup or build output
 * instead of the installed one. So this script
 *   1. copies release/mac-arm64/MeetingCopilot.app to the install folder
 *      (MC_INSTALL_DIR, default /Applications -- keep it on the internal SSD:
 *      launching this Electron app from a busy USB hard disk took 40-75 s),
 *   2. verifies the signature and registers that copy with LaunchServices,
 *   3. unregisters and removes the release/ build output (the ZIP from
 *      `npm run dist:mac` is kept), and
 *   4. lists any other registered copy so it can be removed by hand.
 * The previous install is replaced, not kept as a second .app; back it up as a
 * ZIP (`ditto -c -k --keepParent`) beforehand if you need a rollback.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_ID = 'io.github.barryshen1.meetingcopilot';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

if (process.platform !== 'darwin') {
  console.error('install:mac only runs on macOS.');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'release', 'mac-arm64', 'MeetingCopilot.app');
const installDir = resolve(process.env.MC_INSTALL_DIR || '/Applications');
const target = join(installDir, 'MeetingCopilot.app');
// Not ending in ".app", so neither copy is a bundle while the swap is in flight.
const staging = `${target}.installing`;
const previous = `${target}.replaced`;

// lsregister -dump prints the whole LaunchServices database (tens of MB).
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
const running = (path) => {
  try { return run('pgrep', ['-f', `${path}/Contents/MacOS/MeetingCopilot$`]).trim() !== ''; } catch { return false; }
};

if (!existsSync(source)) {
  console.error(`No build at ${source}. Run "npm run dist:mac:dir" first.`);
  process.exit(1);
}
for (const path of [target, source]) {
  if (running(path)) {
    console.error(`MeetingCopilot is running from ${path}. Quit it (tray -> 退出 / Quit), then retry.`);
    process.exit(1);
  }
}

rmSync(staging, { recursive: true, force: true });
rmSync(previous, { recursive: true, force: true });
console.log(`Copying to ${target} ...`);
run('ditto', [source, staging]);
run('codesign', ['--verify', '--deep', '--strict', staging]);

if (existsSync(target)) renameSync(target, previous);
try {
  renameSync(staging, target);
} catch (error) {
  if (existsSync(previous)) renameSync(previous, target);
  throw error;
}
rmSync(previous, { recursive: true, force: true });

run(LSREGISTER, ['-f', target]);
try { run(LSREGISTER, ['-u', source]); } catch { /* it may never have been registered */ }
rmSync(source, { recursive: true, force: true });
console.log(`Installed ${target}; removed the build copy ${source}.`);

// LaunchServices keeps entries for bundles that no longer exist (deleted
// copies, and the helper apps it saw inside the staging folder during the
// copy). Forget every MeetingCopilot path that is gone.
try {
  const gone = run(LSREGISTER, ['-dump'])
    .split('\n')
    .map((line) => /^path:\s+(.*MeetingCopilot.*?)\s+\(0x[0-9a-f]+\)$/.exec(line)?.[1])
    .filter((path) => path && !existsSync(path));
  for (const path of new Set(gone)) {
    try { run(LSREGISTER, ['-u', path]); } catch { /* already gone */ }
  }
  if (gone.length) console.log(`Forgot ${gone.length} stale LaunchServices entr${gone.length === 1 ? 'y' : 'ies'}.`);
} catch { /* the dump is best-effort housekeeping */ }

let others = [];
try {
  others = run('mdfind', [`kMDItemCFBundleIdentifier == "${BUNDLE_ID}"`])
    .split('\n').map((line) => line.trim()).filter((path) => path && path !== target && existsSync(path));
} catch { /* Spotlight disabled: nothing to report */ }
if (others.length) {
  console.warn('Other MeetingCopilot copies are still registered and may appear in Spotlight / Launchpad:');
  for (const path of others) console.warn(`  ${path}`);
  console.warn(`Delete them, or unregister one with: "${LSREGISTER}" -u <path>`);
}
