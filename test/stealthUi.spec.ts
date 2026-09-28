import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function mainWindowViews(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'onboarding' ? [] : mainWindowViews(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('protected main-window UI', () => {
  it('keeps menus inside the renderer instead of opening native select popups', () => {
    const views = mainWindowViews(join(process.cwd(), 'src'));
    const nativeSelects = views.filter((path) => /<select\b/i.test(readFileSync(path, 'utf8')));
    expect(nativeSelects).toEqual([]);
  });
});
