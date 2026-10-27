import { dirname, join } from 'node:path';
import { digestBytes } from './experiments-contract.ts';
import { describeRestricted, type RestrictedRequest } from './experiments-restricted-contract.ts';
import { readPinnedFile } from './experiments-materialize.ts';
import { parseNodeObservation, normalizerVersion, targetSignature } from './experiments-node.ts';
import { assessClaim, canonicalSha256, freezeOracle, type OracleBinding } from './experiments-oracle.ts';

export type ReceiptReference = { path: string; sha256: string };
export type AttemptEvidence = {
  reference: ReceiptReference; attemptId: string; request: RestrictedRequest; requestDigest: string;
  status: string; predicate: 'PASS' | 'FAIL' | 'UNRESOLVED'; normalized: unknown;
  outputs: { stdout: string; stderr: string };
};

/** Recheck host records and captured bytes; this does not authenticate a hostile same-user host. */
export async function readRestrictedAttempt(reference: ReceiptReference): Promise<AttemptEvidence> {
  const receipt = JSON.parse((await readPinnedFile(reference, 1048576)).toString('utf8'));
  if (receipt.profile !== 'docker-node-v1' || typeof receipt.attemptId !== 'string') throw new Error('Unsupported attempt receipt.');
  const directory = dirname(reference.path);
  const requestBytes = await readPinnedFile({ path: join(directory, 'request.json'), sha256: receipt.requestRecordSha256 }, 65536);
  const prepared = describeRestricted(JSON.parse(requestBytes.toString('utf8')));
  if (receipt.runId !== prepared.request.runId || receipt.requestDigest !== prepared.digest
    || receipt.adapterSha256 !== prepared.request.adapterSha256 || receipt.probeSha256 !== prepared.request.probe.sha256
    || receipt.inputSha256 !== digestBytes(prepared.request.input)
    || receipt.targetId !== prepared.request.targetId || receipt.targetSignature !== targetSignature
    || receipt.normalizerVersion !== normalizerVersion) throw new Error('Attempt request identity changed.');
  const outputs = { stdout: join(directory, 'stdout.bin'), stderr: join(directory, 'stderr.bin') };
  const stdout = await readPinnedFile({ path: outputs.stdout, sha256: receipt.outputs?.stdout?.sha256 }, 1048576);
  const stderr = await readPinnedFile({ path: outputs.stderr, sha256: receipt.outputs?.stderr?.sha256 }, 1048576);
  if (stdout.length !== receipt.outputs.stdout.bytes || stderr.length !== receipt.outputs.stderr.bytes
    || stdout.length + stderr.length > prepared.request.limits.maxOutputBytes) throw new Error('Attempt output size changed.');
  const observation = parseNodeObservation({ status: receipt.status, exitCode: receipt.exitCode, stdout, stderr }, prepared.request.targetId, prepared.request.input);
  const completed = receipt.status === 'completed' && receipt.sandboxed === true
    && receipt.cleanup === 'container-removed' && receipt.outputTruncated === false;
  if (completed && (observation.observation !== receipt.observation
    || canonicalSha256(observation.normalized) !== canonicalSha256(receipt.normalized))) throw new Error('Attempt observation changed.');
  return {
    reference: { ...reference }, attemptId: receipt.attemptId, request: prepared.request, requestDigest: prepared.digest,
    status: receipt.status, normalized: observation.normalized, outputs,
    predicate: completed && observation.observation === 'passed' ? 'PASS'
      : completed && observation.observation === 'target_failure' ? 'FAIL' : 'UNRESOLVED',
  };
}

/** Equality excludes only revision/mutation; changing the input or environment invalidates comparison. */
export function comparisonContext(request: RestrictedRequest) {
  const { source, runId: _run, ...context } = request;
  return canonicalSha256({ ...context, source: { repository: source.repository, paths: source.paths } });
}

export function compareAttempts(binding: OracleBinding, base: AttemptEvidence, head: AttemptEvidence, inputClass: string) {
  const frozen = freezeOracle({ requirement: binding.requirement, oracle: binding.oracle });
  const result = (status: string, reason: string) => ({ status, reason, oracleIdentity: frozen.identity,
    base: base.reference, head: head.reference, formalProof: false });
  if (binding.identity !== frozen.identity || binding.oracle.targetSignature !== targetSignature
    || binding.oracle.normalizerVersion !== normalizerVersion
    || comparisonContext(base.request) !== comparisonContext(head.request)
    || [base, head].some(attempt => attempt.request.targetId !== binding.oracle.targetCheckId
      || attempt.request.adapterSha256 !== binding.oracle.normalizerSha256)) {
    return result('incompatible', 'Probe, inputs, dependencies, profile or frozen oracle differ.');
  }
  const scopes = [base, head].map(attempt => assessClaim(frozen, { revision: attempt.request.source.revision,
    inputClass, claimKind: 'requirement-violation', verifiedTargetFailure: true }));
  if (scopes.some(scope => ['inapplicable', 'exceptioned'].includes(scope.status))) return result('inapplicable', 'Requirement scope or intentional-change exception excludes this comparison.');
  if ([base, head].some(attempt => attempt.predicate === 'UNRESOLVED')) return result('unknown', 'Both target outcomes are required; setup, skips and crashes are not failures of the requirement.');
  if (base.request.source.mutation || head.request.source.mutation) return result('sensitivity-control', 'Controlled source mutation, not a historical regression. Calibration must establish sensitivity separately.');
  if (base.predicate === 'PASS' && head.predicate === 'PASS') return result('compatible', 'Both revisions passed this probe and input; this is not sensitivity evidence.');
  if (scopes.some(scope => !scope.eligible)) return result('provisional-inference', 'The requirement has no independent authority.');
  const status = base.predicate === 'PASS' ? 'introduced-violation' : head.predicate === 'PASS' ? 'fixed-violation' : 'persistent-violation';
  return result(status, 'Observed target outcomes under one requirement; calibration, applicability and reviewer judgment are still required.');
}
