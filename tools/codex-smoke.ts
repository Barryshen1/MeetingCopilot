/** Opt-in real CLI check. Uses synthetic text/images and never records audio. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexClient } from '../electron/llm/codex';
import type { CodexSettings } from '../shared/codex';

const cwd = mkdtempSync(join(process.env.MC_CODEX_SMOKE_DIR || tmpdir(), 'meetingcopilot-codex-'));
const client = new CodexClient({ cwd });
try {
  const status = await client.check({ binaryPath: process.env.MC_CODEX_BINARY });
  console.log(JSON.stringify({ installed: status.installed, authenticated: status.authenticated, models: status.models.map(m => m.id), error: status.error }));
  if (!status.installed || !status.authenticated || status.error) throw new Error(status.error || 'Codex is not ready.');
  if (process.argv.includes('--live')) {
    const selected = status.models.find(m => m.id === process.env.MC_CODEX_MODEL) || status.models.find(m => m.isDefault);
    const config: CodexSettings = {
      binaryPath: process.env.MC_CODEX_BINARY,
      model: process.env.MC_CODEX_MODEL || selected?.id,
      reasoningEffort: selected?.supportedReasoningEfforts.some(e => e.reasoningEffort === 'low') ? 'low' : undefined,
    };
    let deltas = 0;
    const result = await client.chat(config, [
      { role: 'system', content: 'Follow the final request exactly. This is a synthetic integration test.' },
      { role: 'user', content: 'The synthetic test code is CODEX_OK.' },
      { role: 'assistant', content: 'I will remember the test code.' },
      { role: 'user', content: 'Reply only with the test code from our earlier conversation.' },
    ], { onDelta: () => { deltas++; } });
    if (result.text.trim() !== 'CODEX_OK' || deltas === 0) throw new Error('Streaming/history check failed.');
    console.log(JSON.stringify({ text: 'passed', streamedDeltas: deltas, model: config.model || 'default' }));
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
