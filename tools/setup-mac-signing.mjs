#!/usr/bin/env node
/**
 * One-time macOS setup: create a self-signed code-signing identity
 * ("MeetingCopilot Local Signing") in the login keychain, which
 * `npm run install:mac` then uses to sign the installed app.
 *
 * Why: the build is ad-hoc signed, and an ad-hoc signature is just a hash of
 * the files — every rebuild is a "different app" to macOS. Screen Recording
 * is then refused silently ("Failed to match existing code requirement"),
 * System Audio Recording has to be granted again and the keychain asks for
 * the password again. With one stable certificate the app's identity
 * (bundle id + certificate) stays the same across builds, so each grant is
 * given once.
 *
 * The certificate is self-signed and used only on this Mac. It is not
 * trusted for anything else and never leaves the login keychain. Remove it
 * any time in Keychain Access (login → My Certificates → MeetingCopilot
 * Local Signing); install:mac then falls back to ad-hoc signing.
 *
 *   npm run setup:mac-signing
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGN_IDENTITY = process.env.MC_SIGN_IDENTITY || 'MeetingCopilot Local Signing';

if (process.platform !== 'darwin') {
  console.error('setup:mac-signing only runs on macOS.');
  process.exit(1);
}

const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const hasIdentity = () => {
  try {
    return run('security', ['find-identity', '-p', 'codesigning', keychain]).includes(`"${SIGN_IDENTITY}"`);
  } catch {
    return false;
  }
};

if (hasIdentity()) {
  console.log(`"${SIGN_IDENTITY}" already exists in the login keychain; nothing to do.`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'mc-signing-'));
try {
  const config = join(dir, 'openssl.cnf');
  writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      `CN = ${SIGN_IDENTITY}`,
      '[ext]',
      'basicConstraints = critical, CA:false',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = critical, codeSigning',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  );
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const p12 = join(dir, 'identity.p12');
  // a throwaway password only protects the .p12 for the moment it exists
  const pass = randomBytes(18).toString('base64url');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-config', config]);
  run('openssl', ['pkcs12', '-export', '-out', p12, '-inkey', key, '-in', cert, '-name', SIGN_IDENTITY, '-passout', `pass:${pass}`]);
  // -T: codesign may use the private key without a prompt
  run('security', ['import', p12, '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign']);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (!hasIdentity()) {
  console.error(`The certificate was imported, but "${SIGN_IDENTITY}" is not listed as a code-signing identity.`);
  process.exit(1);
}
console.log(`Created "${SIGN_IDENTITY}" in the login keychain.`);
console.log('Next: npm run install:mac (or `node tools/install-mac.mjs --resign-installed` to sign the app already in /Applications).');
console.log('Then grant Screen Recording / System Audio Recording once more; later builds keep them.');
