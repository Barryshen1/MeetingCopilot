/** Opt-in real CLI check. Uses synthetic text/images and never records audio. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCodeClient } from '../electron/llm/claudeCode';
import { CLAUDE_CODE_DEFAULT_EFFORT, CLAUDE_CODE_DEFAULT_MODEL, isClaudeCodeEffort, type ClaudeCodeSettings } from '../shared/claudeCode';

const cwd = mkdtempSync(join(process.env.MC_CLAUDE_SMOKE_DIR || tmpdir(), 'meetingcopilot-claude-'));
const client = new ClaudeCodeClient({ cwd });
const effort = process.env.MC_CLAUDE_EFFORT;
const config: ClaudeCodeSettings = {
  binaryPath: process.env.MC_CLAUDE_BINARY,
  model: process.env.MC_CLAUDE_MODEL || CLAUDE_CODE_DEFAULT_MODEL,
  effort: isClaudeCodeEffort(effort) ? effort : CLAUDE_CODE_DEFAULT_EFFORT,
};
try {
  const status = await client.check(config);
  console.log(JSON.stringify({ installed: status.installed, authenticated: status.authenticated, version: status.version, authMethod: status.authMethod, error: status.error }));
  if (!status.installed || !status.authenticated || status.error) throw new Error(status.error || 'Claude Code is not ready.');
  if (process.argv.includes('--live')) {
    let deltas = 0;
    const started = Date.now();
    const result = await client.chat(config, [
      { role: 'system', content: 'Follow the final request exactly. This is a synthetic integration test.' },
      { role: 'user', content: 'The synthetic test code is CLAUDE_OK.' },
      { role: 'assistant', content: 'I will remember the test code.' },
      { role: 'user', content: 'Reply only with the test code from our earlier conversation.' },
    ], { onDelta: () => { deltas++; } });
    if (result.text.trim() !== 'CLAUDE_OK' || deltas === 0) throw new Error(`Streaming/history check failed: ${JSON.stringify(result.text.slice(0, 200))}`);
    console.log(JSON.stringify({ text: 'passed', streamedDeltas: deltas, model: config.model, effort: config.effort, latencyMs: Date.now() - started }));
    if (process.argv.includes('--image')) {
      const data = readFileSync(resolve('resources/test-image.png')).toString('base64');
      const image = await client.chat(config, [{ role: 'user', content: [
        { type: 'text', text: 'Describe the color of this synthetic test image in a few words.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      ] }], { onDelta: () => {} });
      if (!image.text.trim()) throw new Error('Image check returned an empty answer.');
      console.log(JSON.stringify({ image: 'passed', answer: image.text.trim() }));
    }
  }
} finally {
  await client.dispose();
  rmSync(cwd, { recursive: true, force: true });
}
