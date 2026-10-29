import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewHost } from './deps/review-host.mjs';
import { registerReview } from './source/src/index.ts';
import { runHeadlessReview } from './source/src/runtime.ts';

test('case-contract', async t => {
  const host = reviewHost(), calls = [];
  host.pi.exec = async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: '', stderr: '' }; };
  registerReview(host.pi, '/scratch/reviews');
  await runHeadlessReview(host.pi, { name: 'fixture-review', missionPath: '/scratch/mission.md',
    preflight: { model: 'fixture/model', thinking: 'medium', checkout: '/scratch' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pi');
  const toolIndex = calls[0].args.indexOf('--tools');
  const launchTools = toolIndex < 0 ? [] : calls[0].args[toolIndex + 1].split(',');
  const registeredTools = [...host.tools.keys()];
  t.diagnostic(`AR_OBSERVATION ${JSON.stringify({ registeredTools, launchTools })}`);
  const configured = ['agentic_code_review', 'agentic_code_review_complete'].every(name => registeredTools.includes(name))
    && launchTools.includes('spawn_swarm_agents') && !registeredTools.includes('agentic_code_review_wave') && !launchTools.includes('agentic_code_review_wave');
  assert.ok(configured, 'review dispatch must use configured teams');
});
