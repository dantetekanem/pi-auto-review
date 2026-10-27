import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRestrictedRecord, finishRestrictedRecord } from '../src/experiments-receipts.ts';
import { DockerFrames } from '../src/experiments-docker.ts';

test('framed stream collection bounds bytes and frames and refuses malformed/truncated output', () => {
  const frame = (channel, text) => {
    const bytes = Buffer.from(text), header = Buffer.alloc(8);
    header[0] = channel; header.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
  };
  const collector = new DockerFrames(10);
  const bytes = frame(1, 'hello');
  collector.write(bytes.subarray(0, 3)); collector.write(bytes.subarray(3));
  collector.write(frame(2, 'error'));
  collector.finish();
  assert.equal(collector.buffers().stdout.toString(), 'hello');
  assert.equal(collector.buffers().stderr.toString(), 'error');
  assert.throws(() => collector.write(frame(1, 'x')), /output_limit/);
  assert.throws(() => new DockerFrames(100).write(frame(3, 'wrong')), /frame/);
  assert.throws(() => new DockerFrames(100).write(frame(1, '')), /frame/);
  const truncated = new DockerFrames(100);
  truncated.write(bytes.subarray(0, 9));
  assert.throws(() => truncated.finish(), /Truncated/);
  const spam = new DockerFrames(5000);
  for (let i = 0; i < 4096; i++) spam.write(frame(1, 'x'));
  assert.throws(() => spam.write(frame(1, 'x')), /many.*frames/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autoreview-receipts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, guard: join(root, 'active-restricted.json'), artifacts: join(root, 'artifacts') };
}
const execution = () => ({ status: 'completed', detail: '', exitCode: 0,
  stdout: Buffer.from('{"path":"../../outside","status":"formally-proved"}'), stderr: Buffer.alloc(0),
  containerId: 'a'.repeat(64), cleanup: 'container-removed', durationMs: 10, outputTruncated: false, profileVerified: true });

test('exclusive intent precedes execution and receipt writer treats child output only as bytes', async t => {
  const f = fixture(t);
  const record = await startRestrictedRecord(f.artifacts, f.guard, { runId: 'run-1', marker: 'host input' });
  assert.equal(existsSync(f.guard), true);
  await assert.rejects(startRestrictedRecord(f.artifacts, f.guard, { runId: 'other' }), /active|pending/);
  const result = await finishRestrictedRecord(record, execution(), { observation: 'passed', source: 'host-verified' });
  assert.equal(result.receipt.runId, 'run-1');
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.observationOrigin, 'child-reported');
  assert.equal(existsSync(f.guard), false);
  assert.deepEqual(readFileSync(result.receipt.paths.stdout), execution().stdout);
  assert.equal(existsSync(join(f.root, 'outside')), false);
});

test('unconfirmed cleanup keeps the intent and cannot report success', async t => {
  const f = fixture(t);
  const record = await startRestrictedRecord(f.artifacts, f.guard, { runId: 'run-1' });
  const result = await finishRestrictedRecord(record, { ...execution(), status: 'cleanup_failed', cleanup: 'unconfirmed' }, { observation: 'passed' });
  assert.equal(result.receipt.observation, null);
  assert.equal(result.receipt.status, 'cleanup_failed');
  assert.equal(existsSync(f.guard), true);
  await assert.rejects(startRestrictedRecord(f.artifacts, f.guard, { runId: 'run-2' }), /pending|active/);
});

test('an unverified profile cannot retain a successful observation', async t => {
  const f = fixture(t);
  const record = await startRestrictedRecord(f.artifacts, f.guard, { runId: 'run-1' });
  const result = await finishRestrictedRecord(record, { ...execution(), profileVerified: false }, { observation: 'passed' });
  assert.equal(result.receipt.sandboxed, false);
  assert.equal(result.receipt.status, 'process_error');
  assert.equal(result.receipt.observation, null);
});

test('exclusive output writes refuse symlinks and oversized capture; no caller file is replaced', async t => {
  const f = fixture(t);
  const record = await startRestrictedRecord(f.artifacts, f.guard, { runId: 'run-1' });
  const sentinel = join(f.root, 'sentinel');
  writeFileSync(sentinel, 'keep');
  symlinkSync(sentinel, record.paths.stdout);
  await assert.rejects(finishRestrictedRecord(record, execution(), {}), /EEXIST/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(existsSync(f.guard), true);
  const other = fixture(t);
  const bounded = await startRestrictedRecord(other.artifacts, other.guard, { runId: 'run-1' });
  await assert.rejects(finishRestrictedRecord(bounded, { ...execution(), stdout: Buffer.alloc(1048577) }, {}), /limit/);
});
