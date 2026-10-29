import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { preflightReview, runHeadlessReview } from './source/src/runtime.ts';

test('case-contract', async t => {
  const input = JSON.parse(await readFile('/bundle/input.json', 'utf8'));
  const calls = [];
  const pi = { exec: async (command, args) => {
    calls.push({ command, args });
    if (command === 'git') return { code: 0, stdout: args.includes('rev-parse') ? 'e'.repeat(40) : '', stderr: '' };
    if (command === 'pi') return { code: 0, stdout: '', stderr: '' };
    throw new Error('Thinking case attempted an unmodeled command.');
  } };
  const ctx = { cwd: '/scratch', hasUI: false, thinkingLevel: input.thinking,
    model: { provider: 'fixture', id: 'reasoner', reasoning: true,
      thinkingLevelMap: { [input.thinking]: input.supported ? input.thinking : null } },
    modelRegistry: { getAvailable: () => [] } };
  let selected = null, launched = null, blocked = false;
  let preflight;
  try {
    preflight = await preflightReview(pi, ctx, 'local working tree', '/scratch/history');
    selected = preflight.thinking;
  } catch (error) {
    if (!/waiting for a (?:high|xhigh)-capable model selection/.test(String(error))) throw error;
    blocked = true;
  }
  if (preflight) {
    await runHeadlessReview(pi, { name: 'fixture-review', missionPath: '/scratch/mission.md', preflight });
    const launch = calls.filter(call => call.command === 'pi');
    assert.equal(launch.length, 1, 'One inert launch observation is required.');
    launched = launch[0].args[launch[0].args.indexOf('--thinking') + 1];
  }
  t.diagnostic(`AR_OBSERVATION ${JSON.stringify({ selected, launched, blocked })}`);
  const satisfied = input.supported
    ? !blocked && selected === input.thinking && launched === input.thinking
    : blocked && selected === null && launched === null;
  assert.ok(satisfied, 'review must preserve supported caller thinking');
});
