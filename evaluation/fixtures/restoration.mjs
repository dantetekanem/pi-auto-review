import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { reviewHost } from './deps/review-host.mjs';
import { registerReview } from './source/src/index.ts';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-ai') return { url: new URL('./deps/pi-ai/dist/utils/uuid.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { SessionManager } = await import('./deps/pi/dist/core/session-manager.js');

test('case-contract', async t => {
  const sessionManager = SessionManager.inMemory('/scratch');
  const runId = '11111111-1111-4111-8111-111111111111';
  sessionManager.appendCustomMessageEntry('agentic-code-review-complete', 'Previously delivered', true, { runId });
  const priorCompletions = sessionManager.getEntries().filter(entry => entry.type === 'custom_message').length;
  const root = '/scratch/reviews', directory = join(root, sessionManager.getSessionId());
  mkdirSync(directory, { recursive: true });
  const paths = {
    complete: join(directory, `${runId}.complete.json`), mission: join(directory, `${runId}.mission.md`),
    review: join(directory, `${runId}.review.json`), bugs: join(directory, `${runId}.bugs.json`), map: join(directory, `${runId}.map.jsonl`),
  };
  writeFileSync(paths.mission, 'Already completed; no review or provider should start.');
  writeFileSync(paths.complete, JSON.stringify({ runId, status: 'complete', summary: 'Completed' }));
  writeFileSync(paths.review, JSON.stringify({ runId, sessionId: sessionManager.getSessionId(), status: 'complete', paths,
    reviewSession: { name: 'restored-review', mode: 'pane' }, preflight: { model: 'fixture/model', thinking: 'medium' } }));
  const host = reviewHost();
  const ctx = { cwd: '/scratch', hasUI: false, sessionManager };
  registerReview(host.pi, root);
  try {
    await host.emit('session_start', ctx);
    const restored = host.events.has('session_start');
    const notices = host.messages.filter(message => message.customType === 'agentic-code-review-complete').length;
    t.diagnostic(`AR_OBSERVATION ${JSON.stringify({ restored, priorCompletions, notices })}`);
    assert.ok(restored, 'Restoration is unavailable on this revision; no comparable pass.');
    assert.equal(notices, 0, 'completed reviews must hand back once');
  } finally {
    await host.emit('session_shutdown', ctx);
  }
});
