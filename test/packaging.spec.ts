import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// Packing out/** as a whole once put test logs into app.asar; one of them grew
// while the archive was written, every later offset shifted and the app quit
// at launch. Only the three electron-vite outputs may be packed.
describe('electron-builder files', () => {
  it('packs only out/main, out/preload and out/renderer', () => {
    const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    const block = /^files:\n((?:[ \t]+-.*\n)+)/m.exec(yml)?.[1] ?? '';
    const entries = block
      .split('\n')
      .map((line) => line.trim().replace(/^-\s*/, '').replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(entries.filter((entry) => entry.startsWith('out/')).sort()).toEqual([
      'out/main/**',
      'out/preload/**',
      'out/renderer/**',
    ]);
    expect(entries).toContain('package.json');
  });
});
