import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../electron/sessions';
import type { SessionsFile } from '../shared/protocol';

describe('SessionStore reference material compatibility', () => {
  it('round-trips additional files and preserves named resume and JD fields', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mc-sessions-')), 'sessions.json');
    const store = new SessionStore(file);
    const data: SessionsFile = {
      currentId: 'current',
      sessions: [{
        id: 'current', name: 'Interview', createdAt: 1, turns: [],
        resumeName: 'resume.pdf', resumeText: 'work history',
        jdName: 'role.pdf', jdText: 'role requirements',
        attachments: [
          { id: 'a1', name: 'portfolio.md', text: 'project details' },
          { id: 'a2', name: 'rubric.csv', text: 'criterion,score' },
        ],
      }],
    };
    store.save(data);
    expect(store.load()).toEqual(data);
  });

  it('loads an older session with no attachments unchanged', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mc-legacy-')), 'sessions.json');
    const store = new SessionStore(file);
    const legacy: SessionsFile = {
      currentId: 'old',
      sessions: [{ id: 'old', name: 'Earlier', createdAt: 1, turns: [], kbText: 'legacy notes' }],
    };
    store.save(legacy);
    expect(store.load()).toEqual(legacy);
  });
});
