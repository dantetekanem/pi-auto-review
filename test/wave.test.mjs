import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const piRoot = process.env.PI_PACKAGE_ROOT
  || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(piRoot, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(piRoot, 'package.json'));
const alias = Object.fromEntries(
  ['@earendil-works/pi-coding-agent', 'typebox']
    .map(name => [name, fileURLToPath(host.esmResolve(name))]),
);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
const { registerReviewWave } = await jiti.import('../src/wave.ts');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-wave-'));
  const bin = join(root, 'bin');
  const outputDir = join(root, 'artifacts');
  mkdirSync(bin);
  const fake = join(bin, 'pi');
  writeFileSync(fake, `#!/usr/bin/env node
const prompt = process.argv.at(-1) || '';
const text = prompt.includes('slow') ? 'partial evidence before timeout' : 'reviewed ' + prompt + '\\nargs ' + process.argv.slice(2, -1).join(' ');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, cost: { total: 0.01 } } } }));
if (prompt.includes('slow')) setInterval(() => {}, 1000);
if (prompt.includes('fail')) process.exit(2);
`);
  chmodSync(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map();
  registerReviewWave({ registerTool: definition => tools.set(definition.name, definition) });
  const updates = [];
  const ctx = { cwd: root, model: { provider: 'openai', id: 'gpt-test', reasoning: true } };
  const execute = input => tools.get('agentic_code_review_wave').execute('wave', input, undefined, update => updates.push(update), ctx);
  return { root, outputDir, tools, updates, ctx, execute };
}

test('returns one bounded parallel result with completed and timed-out medium workers', async t => {
  const harness = fixture(t);
  const started = Date.now();
  const result = await harness.execute({
    workers: [
      { name: 'review-one', kind: 'read-review', prompt: 'fast one', items: ['unit-one'] },
      { name: 'review-two', kind: 'read-review', prompt: 'slow two', items: ['unit-two', 'gap-two'] },
      { name: 'collect-gap', kind: 'read-collect', prompt: 'fast gap', items: ['gap-one'] },
    ],
    output_dir: harness.outputDir,
    timeout_seconds: 1,
  });

  assert.ok(Date.now() - started < 3000, 'one worker cannot hold the wave after its deadline');
  assert.equal(result.details.model, 'openai/gpt-test');
  assert.equal(result.details.thinking, 'medium');
  assert.deepEqual(result.details.results.map(item => item.status), ['completed', 'timed_out', 'completed']);
  assert.match(result.details.results[1].output, /partial evidence before timeout/);
  assert.match(result.details.results[1].error, /Process safety fuse fired after 1 seconds/);
  assert.deepEqual(result.details.results[1].unfinished, ['unit-two', 'gap-two']);
  assert.deepEqual(result.details.results[0].unfinished, []);
  assert.match(result.content[0].text, /review-two \[read-review, timed_out/);
  assert.match(result.content[0].text, /Top-level review must finish directly: unit-two; gap-two/);
  assert.match(result.content[0].text, /reviewed fast gap/);
  assert.match(result.details.results[0].output, /--thinking medium/);
  assert.match(result.details.results[0].output, /--no-skills --no-prompt-templates --no-context-files/);
  assert.match(result.details.results[0].output, /--tools read,bash,agentic_code_review_append_finding/);
  assert.equal(harness.updates.at(-1).details.finished, 3);

  for (const item of result.details.results) {
    assert.equal(statSync(item.artifact).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(item.artifact, 'utf8')).status, item.status);
  }
});

test('rejects waves that exceed the fixed review shape or model contract', async t => {
  const harness = fixture(t);
  const base = { output_dir: harness.outputDir, timeout_seconds: 1 };
  await assert.rejects(harness.execute({ ...base, workers: [
    { name: 'a', kind: 'read-review', prompt: 'a', items: ['a'] },
    { name: 'b', kind: 'read-review', prompt: 'b', items: ['b'] },
    { name: 'c', kind: 'read-review', prompt: 'c', items: ['c'] },
  ] }), /at most two/);
  await assert.rejects(harness.execute({ ...base, workers: [
    { name: 'a', kind: 'read-collect', prompt: 'a', items: ['a'] },
    { name: 'b', kind: 'read-collect', prompt: 'b', items: ['b'] },
  ] }), /one read-collect/);
  await assert.rejects(harness.execute({ ...base, workers: [
    { name: 'same', kind: 'read-review', prompt: 'a', items: ['a'] },
    { name: 'same', kind: 'read-collect', prompt: 'b', items: ['b'] },
  ] }), /unique/);
  await assert.rejects(harness.execute({ workers: [{ name: 'a', kind: 'read-review', prompt: 'a', items: ['a'] }], output_dir: 'relative' }), /absolute/);
  harness.ctx.model.reasoning = false;
  await assert.rejects(harness.execute({ ...base, workers: [{ name: 'a', kind: 'read-review', prompt: 'a', items: ['a'] }] }), /supports medium/);
});
