import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeRestricted, approveRestricted, reserveRestricted, settleRestricted, revokeRestricted, assertDockerIdentity,
} from '../src/experiments-restricted-contract.ts';

const hash = 'a'.repeat(64);
const request = () => ({
  runId: 'run-1', profile: 'docker-node-v1',
  backend: { socketPath: '/tmp/docker.sock', engineId: 'engine-1', imageId: `sha256:${hash}`, platform: 'linux/arm64', seccompPath: '/tmp/seccomp.json', seccompSha256: hash },
  source: { repository: '/repo', revision: 'b'.repeat(40), paths: ['package.json', 'src/findings.ts'] },
  dependencies: { path: '/tmp/dependencies.json', sha256: hash },
  probe: { path: '/tmp/probe.mjs', sha256: hash },
  input: '{"items":[]}', targetId: 'optional-nonblocking', adapterSha256: hash,
  limits: { timeoutMs: 1000, maxOutputBytes: 1024 },
});
const approval = () => ({ approvedBy: 'host', familySha256: hash, expiresAt: Date.now() + 60000, maxAttempts: 3, maxWallMs: 5000, maxOutputBytes: 4096 });

test('restricted scope snapshots exact requests and reserves one serial attempt before work', () => {
  const r = request();
  const grant = approveRestricted([r], approval());
  r.input = '{"changed":true}';
  const original = request();
  const reservation = reserveRestricted(original, grant);
  assert.equal(reservation.attempt, 1);
  assert.equal(reservation.limits.timeoutMs, 1000);
  assert.equal(reservation.familySha256, hash);
  assert.throws(() => reserveRestricted(original, grant), /active/);
  settleRestricted(grant, { durationMs: 100, capturedBytes: 100, cleanupConfirmed: true });
  assert.throws(() => reserveRestricted(r, grant), /match/);
  assert.equal(reserveRestricted(original, grant).attempt, 2);
  settleRestricted(grant, { durationMs: 100, capturedBytes: 100, cleanupConfirmed: true });
});

test('forged, expired, revoked and changed authorities cannot reserve a workload', () => {
  const r = request();
  assert.throws(() => reserveRestricted(r, { profile: r.profile, approved: true }), /host-issued/);
  assert.throws(() => approveRestricted([r], { ...approval(), expiresAt: Date.now() - 1 }), /expir/);
  const grant = approveRestricted([r], approval());
  for (const changed of [
    { ...r, runId: 'another' },
    { ...r, probe: { ...r.probe, sha256: 'c'.repeat(64) } },
    { ...r, backend: { ...r.backend, imageId: `sha256:${'c'.repeat(64)}` } },
    { ...r, source: { ...r.source, revision: 'c'.repeat(40) } },
  ]) assert.throws(() => reserveRestricted(changed, grant), /match/);
  revokeRestricted(grant);
  assert.throws(() => reserveRestricted(r, grant), /revoked/);
});

test('cumulative budgets include every reserved attempt and fence ambiguous cleanup', () => {
  const r = request();
  const grant = approveRestricted([r], { ...approval(), maxAttempts: 2, maxWallMs: 1100, maxOutputBytes: 1200 });
  reserveRestricted(r, grant);
  settleRestricted(grant, { durationMs: 900, capturedBytes: 1000, cleanupConfirmed: true });
  assert.deepEqual(reserveRestricted(r, grant).limits, { timeoutMs: 200, maxOutputBytes: 200 });
  settleRestricted(grant, { durationMs: 100, capturedBytes: 100, cleanupConfirmed: true });
  assert.throws(() => reserveRestricted(r, grant), /budget/);
  const fenced = approveRestricted([r], approval());
  reserveRestricted(r, fenced);
  settleRestricted(fenced, { durationMs: 1, capturedBytes: 0, cleanupConfirmed: false });
  assert.throws(() => reserveRestricted(r, fenced), /cleanup/);
});

test('backend identity and required controller support fail closed', () => {
  const backend = request().backend;
  const info = { ID: backend.engineId, OSType: 'linux', CgroupVersion: '2', MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsQuota: true, SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'] };
  const image = { Id: backend.imageId, Os: 'linux', Architecture: 'arm64', Config: {} };
  assertDockerIdentity(backend, info, image);
  for (const changed of [undefined, { ...info, ID: 'other' }, { ...info, MemoryLimit: false }, { ...info, SecurityOptions: [] }]) {
    assert.throws(() => assertDockerIdentity(backend, changed, image), /backend/);
  }
  assert.throws(() => assertDockerIdentity(backend, info, { ...image, Id: 'other' }), /image/);
  assert.throws(() => assertDockerIdentity(backend, info, { ...image, Config: { Volumes: { '/output': {} } } }), /image/);
});

test('invalid profiles, remote sockets, extra exports and unsafe source shapes are refused', () => {
  const r = request();
  for (const value of [
    { ...r, profile: 'trusted-program' },
    { ...r, backend: { ...r.backend, socketPath: 'tcp://host:2375' } },
    { ...r, exports: ['../../receipt.json'] },
    { ...r, source: { ...r.source, paths: ['../secret'] } },
    { ...r, source: { ...r.source, paths: ['a', 'a'] } },
    { ...r, source: { ...r.source, paths: ['a'], mutation: { path: 'a', before: 'x', after: 'y' } } },
    { ...r, input: '{invalid' },
    { ...r, limits: { timeoutMs: 30001, maxOutputBytes: 1024 } },
  ]) assert.throws(() => describeRestricted(value));
});
