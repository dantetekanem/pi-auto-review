import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digestBytes } from './experiments-contract.ts';
import { canonicalJson, canonicalSha256 } from './experiments-oracle.ts';
import { readPinnedFile } from './experiments-materialize.ts';
import { readRestrictedAttempt } from './experiments-comparison.ts';
import { describeReplay, observationFrom } from './experiments-replay.ts';
import { emptyExecution, streamNames } from './experiments-process.ts';

type Reference = { path: string; sha256: string };
type Assessment = { nodes?: { id: string; kind: string; status: string; reasons: string[] }[] };
type MachineClaim = { claimId: string; kind: 'execution' | 'target-replay'; requestDigest: string; receipts: string[] };
type Attempt = { attemptId: string; requestDigest: string; profile: string; predicate: string; normalized: unknown };

async function readAttempt(reference: Reference, runId: string): Promise<Attempt> {
  const receipt = JSON.parse((await readPinnedFile(reference, 1_048_576)).toString('utf8'));
  if (receipt.runId !== runId || typeof receipt.attemptId !== 'string' || !receipt.attemptId) throw new Error('Machine receipt run or attempt identity changed.');
  if (receipt.profile === 'docker-node-v1') {
    return { ...await readRestrictedAttempt(reference), profile: receipt.profile };
  }
  if (receipt.profile !== 'trusted-program') throw new Error('Machine claims require an individual supported attempt, not a family summary.');
  const directory = dirname(reference.path);
  const path = join(directory, 'request.json');
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > 65_536) throw new Error('Unsupported recorded request.');
  const bytes = readFileSync(path);
  if (bytes.length > 65_536) throw new Error('Recorded request grew beyond its limit.');
  const { request } = describeReplay(JSON.parse(bytes.toString('utf8')));
  if (request.runId !== runId || digestBytes(JSON.stringify({ request, supervisor: receipt.supervisor })) !== receipt.requestDigest) {
    throw new Error('Machine receipt request identity changed.');
  }
  const execution = emptyExecution('completed');
  execution.exitCode = receipt.exitCode;
  execution.signal = receipt.signal;
  let totalBytes = 0;
  let truncated = false;
  for (const name of streamNames) {
    const output = receipt.outputs?.[name];
    const captured = await readPinnedFile({ path: join(directory, `${name}.bin`), sha256: output?.sha256 }, 1_048_576);
    totalBytes += captured.length;
    if (captured.length !== output.bytes || totalBytes > request.limits.maxOutputBytes) throw new Error('Machine output size changed.');
    execution.streams[name].chunks = [captured];
    truncated ||= output.truncated !== false;
  }
  const observation = observationFrom(execution, request);
  const completed = receipt.status === 'completed' && receipt.cleanup === 'workspace-removed' && !truncated;
  if (completed && (observation.status !== 'completed' || observation.observation !== receipt.observation)) {
    throw new Error('Machine transcript disagrees with its recorded observation.');
  }
  let predicate = 'UNRESOLVED';
  if (completed && observation.observation === 'passed') predicate = 'PASS';
  if (completed && observation.observation === 'target_failure') predicate = 'FAIL';
  return {
    attemptId: receipt.attemptId,
    requestDigest: receipt.requestDigest,
    profile: receipt.profile,
    predicate,
    normalized: Buffer.concat(execution.streams.stdout.chunks).toString('utf8')
      .split(/\r?\n/).filter(line => /^(PASS|FAIL) /.test(line)),
  };
}

function parseMachineClaim(value: unknown): MachineClaim {
  const fields = ['claimId', 'kind', 'requestDigest', 'receipts'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid machine claim fields.');
  const { claimId, kind, requestDigest, receipts } = value as Record<string, unknown>;
  if (typeof claimId !== 'string' || !claimId || (kind !== 'execution' && kind !== 'target-replay')
    || typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(requestDigest)
    || !Array.isArray(receipts) || receipts.length !== (kind === 'execution' ? 1 : 2)
    || !receipts.every((hash): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid machine claim identity.');
  }
  return { claimId, kind, requestDigest, receipts };
}

/** Receipt-linked observations, not a claim that the requirement or interpretation is true. */
export async function readMachineEvidence(input: unknown, references: Reference[], runId: string, assessment?: Assessment) {
  if (input === undefined) return undefined;
  const claims: unknown = JSON.parse(canonicalJson(input));
  if (!Array.isArray(claims) || claims.length > 32) throw new Error('Invalid bounded machine claims.');
  const indexed = new Map(references.map(reference => [reference.sha256, reference]));
  const seen = new Set<string>();
  const attempts = new Map<string, Promise<Attempt>>();
  const results = [];
  for (const value of claims) {
    const claim = parseMachineClaim(value);
    const node = assessment?.nodes?.find(item => item.id === claim.claimId && item.kind === 'claim');
    if (!node || seen.has(claim.claimId)) throw new Error('Machine evidence requires a unique evidence-graph claim.');
    seen.add(claim.claimId);
    const verified: Attempt[] = [];
    for (const hash of claim.receipts) {
      const reference = indexed.get(hash);
      if (!reference) throw new Error('Machine claim receipt is not indexed for this run.');
      const pending = attempts.get(hash) ?? readAttempt(reference, runId);
      attempts.set(hash, pending);
      verified.push(await pending);
    }
    if (verified.some(attempt => attempt.requestDigest !== claim.requestDigest)) throw new Error('Machine claim request does not match the receipt.');
    if (new Set(verified.map(attempt => attempt.attemptId)).size !== verified.length) throw new Error('A replay requires distinct attempts.');
    let status = 'unknown';
    let reason = `Evidence support is ${node.status}; see its graph reasons.`;
    if (node.status === 'fresh') {
      if (claim.kind === 'execution' && verified[0].predicate !== 'UNRESOLVED') {
        status = verified[0].predicate === 'PASS' ? 'observed-pass' : 'observed-target-failure';
        reason = 'The recorded target outcome was reparsed from pinned outputs.';
      } else if (claim.kind === 'target-replay' && verified.every(attempt => attempt.predicate === 'FAIL')
        && canonicalSha256(verified[0].normalized) === canonicalSha256(verified[1].normalized)) {
        status = 'target-replayed';
        reason = 'Distinct attempts reproduced the same target failure for the same request.';
      } else reason = 'The receipts do not establish the requested target outcome or failing replay.';
    }
    results.push({
      ...claim,
      status,
      reason,
      attemptIds: verified.map(attempt => attempt.attemptId),
      profiles: verified.map(attempt => attempt.profile),
      requirementTruthEstablished: false,
      formalProof: false,
    });
  }
  return results;
}
