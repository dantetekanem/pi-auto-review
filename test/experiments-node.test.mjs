import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digestBytes } from '../src/experiments-contract.ts';
import { parseNodeObservation, runRestrictedNode } from '../src/experiments-node.ts';
import { approveRestricted } from '../src/experiments-restricted-contract.ts';
import { prepareNodeExperiment } from './experiments-helpers.mjs';

const target = 'optional-nonblocking';
const signature = 'optional findings must be nonblocking';
const input = JSON.stringify({ items: [{ kind: 'nit', blocks: true }] });
const output = records => Buffer.from(records.map(r => JSON.stringify(r)).join('\n'));
const observed = { type: 'test:diagnostic', message: 'AR_OBSERVATION ' + JSON.stringify({ records: [{ kind: 'fix', blocks: false }, { kind: 'nit', blocks: false }], bugs: 0 }) };

test('node adapter distinguishes target assertions, setup, missing/skipped and unrelated failures', () => {
  const execution = records => ({ status: 'completed', exitCode: 0, stdout: output(records), stderr: Buffer.alloc(0) });
  assert.equal(parseNodeObservation(execution([observed, { type: 'test:pass', name: target }]), target, input).observation, 'passed');
  const failure = { type: 'test:fail', name: target, code: 'ERR_ASSERTION', message: signature };
  const violated = { ...observed, message: observed.message.replace('"nit","blocks":false', '"nit","blocks":true') };
  assert.equal(parseNodeObservation({ ...execution([violated, failure]), exitCode: 1 }, target, input).observation, 'target_failure');
  assert.equal(parseNodeObservation({ ...execution([{ type: 'test:fail', name: target, code: 'OTHER', message: signature }]), exitCode: 1 }, target, input).observation, 'probe_error');
  assert.equal(parseNodeObservation(execution([{ type: 'test:pass', name: target, skip: true }]), target, input).observation, 'not_observed');
  assert.equal(parseNodeObservation(execution([]), target, input).observation, 'not_observed');
  assert.equal(parseNodeObservation({ ...execution([]), exitCode: 1 }, target, input).status, 'setup_error');
  assert.equal(parseNodeObservation(execution([{ type: 'test:pass', name: target }, { type: 'test:diagnostic', message: 42 }]), target, input).status, 'process_error');
});

test('real registered finding handler runs from committed bytes; labeled mutant replays in fresh containers', { skip: !process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND, timeout: 120000 }, async t => {
  const f = await prepareNodeExperiment(t);
  const requests = [f.request('base'), f.request('head'), f.request('mutant'), f.request('setup')];
  const extra = [
    ["import{test}from'node:test';test('optional-nonblocking',{skip:true},()=>{});", 'not_observed'],
    ['export {};', 'not_observed'],
    ["import{test}from'node:test';test('optional-nonblocking',()=>{throw new Error('unrelated')});", 'probe_error'],
  ].map(([code, expected], index) => {
    const path = join(f.root, `control-${index}.mjs`); writeFileSync(path, code);
    return { request: { ...f.request('head'), probe: { path, sha256: digestBytes(code) } }, expected };
  });
  const setupDeadline = { ...f.request('head'), limits: { ...f.template.limits, timeoutMs: 1 } };
  const grant = approveRestricted([...requests, setupDeadline, ...extra.map(item => item.request)], f.approval);
  const results = [];
  for (const index of [0, 1, 2, 2, 3]) results.push(await runRestrictedNode(requests[index], grant, f.artifacts, f.guard));
  assert.deepEqual(results.map(r => [r.receipt.status, r.receipt.observation, r.receipt.exitCode]), [
    ['completed', 'passed', 0], ['completed', 'passed', 0], ['completed', 'target_failure', 1], ['completed', 'target_failure', 1], ['setup_error', null, 1],
  ], JSON.stringify(results.map(r => ({ detail: r.receipt.detail, stdout: readFileSync(r.receipt.paths.stdout, 'utf8'), stderr: readFileSync(r.receipt.paths.stderr, 'utf8') }))));
  for (const control of extra) {
    const result = await runRestrictedNode(control.request, grant, f.artifacts, f.guard);
    assert.equal(result.receipt.observation, control.expected, result.receipt.detail);
  }
  const timedOutSetup = await runRestrictedNode(setupDeadline, grant, f.artifacts, f.guard);
  assert.equal(timedOutSetup.receipt.status, 'timeout');
  assert.equal(timedOutSetup.receipt.observation, null);
  assert.notEqual(results[2].receipt.attemptId, results[3].receipt.attemptId);
  assert.equal(results[2].receipt.requestDigest, results[3].receipt.requestDigest);
  for (const result of results) {
    assert.equal(result.receipt.cleanup, 'container-removed');
    assert.equal(result.receipt.sandboxed, true);
    assert.equal(existsSync(f.guard), false);
  }
});
