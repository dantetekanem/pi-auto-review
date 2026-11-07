import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from './experiments-oracle.ts';
import { gradeCheck, planModelChecks } from './model-check-contract.ts';

type Pin = { path: string; sha256: string };
type Input = 'model' | 'config' | 'checks' | 'scope' | 'source';
type Plan = {
  approvedBy: string;
  expiresAt: number;
  maxRuns: number;
  outputDir: string;
  files: Record<Input | 'node' | 'time', Pin>;
  checker: Pin;
};
type Observation = { status: string; exitCode: number | null; stdout: string; stderr: string };
type Scope = { kind: string; property: string; sourceSha256: string; bounds: object; assumptions: string[]; exclusions: string[] };
type Authority = {
  plan: Plan;
  bindings: string;
  runs: number;
  active: boolean;
  claimed: boolean;
};
const authorities = new WeakMap<object, Authority>();
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const inputPaths = {
  model: '../formal/ReservationOwnership.tla', config: '../formal/ReservationOwnership.cfg',
  checks: '../formal/ReservationOwnership.checks',
  scope: '../formal/ReservationOwnership.scope.json', source: './experiments-reservations.ts',
};
const sealedInputs = Object.fromEntries(Object.entries(inputPaths).map(([key, path]) => [key, digest(readFileSync(new URL(path, import.meta.url)))]));
const runnerPath = fileURLToPath(new URL('./model-check-runner.mjs', import.meta.url));
const adapterPaths = ['./reservation-model-check.ts', './experiments-oracle.ts', './model-check-contract.ts']
  .map(path => fileURLToPath(new URL(path, import.meta.url))).concat(runnerPath);
const adapterSha256 = adapterPaths.map(path => digest(readFileSync(path)));
const nodeSha256 = digest(readFileSync(process.execPath));

function bytes(path: string, limit = 1048576): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported pinned file.');
  const result = readFileSync(path);
  if (result.length > limit) throw new Error('Pinned file grew beyond its limit.');
  return result;
}
function exactKeys(value: object, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error('Unsupported model-check fields.');
}
function pinned(pin: Pin): Buffer {
  exactKeys(pin, ['path', 'sha256']);
  if (typeof pin.path !== 'string' || !isAbsolute(pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Invalid file pin.');
  const result = bytes(pin.path, 268435456);
  if (digest(result) !== pin.sha256) throw new Error(`Pinned identity changed: ${pin.path}`);
  return result;
}

/** Hash every regular file of the checker package; its entry imports the files next to it. */
export function directoryIdentity(root: string): string {
  const files: [string, string][] = [];
  let total = 0;
  function visit(directory: string) {
    if (!lstatSync(directory).isDirectory()) throw new Error('Unsupported checker directory.');
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else {
        total += stat.size;
        if (total > 536870912 || files.length >= 4096) throw new Error('Directory identity limit exceeded.');
        files.push([relative(root, path), digest(bytes(path, 268435456))]);
      }
    }
  }
  visit(root);
  return canonicalSha256(files);
}
function inspect(plan: Plan) {
  exactKeys(plan, ['approvedBy', 'expiresAt', 'maxRuns', 'outputDir', 'files', 'checker']);
  exactKeys(plan.files, ['model', 'config', 'checks', 'scope', 'source', 'node', 'time']);
  exactKeys(plan.checker, ['path', 'sha256']);
  if (typeof plan.approvedBy !== 'string' || !plan.approvedBy.trim() || plan.approvedBy.length > 200
    || !Number.isSafeInteger(plan.expiresAt) || !Number.isInteger(plan.maxRuns) || plan.maxRuns < 1
    || typeof plan.outputDir !== 'string' || !isAbsolute(plan.outputDir) || process.platform !== 'darwin'
    || plan.files.time.path !== '/usr/bin/time' || plan.files.node.path !== process.execPath) throw new Error('Invalid host model-check plan.');
  const contents = Object.fromEntries(Object.entries(plan.files).map(([key, pin]) => [key, pinned(pin)]));
  for (const key of Object.keys(inputPaths) as Input[]) {
    if (plan.files[key].sha256 !== sealedInputs[key]) throw new Error(`Unsupported model input or scope: ${key}`);
  }
  if (!isAbsolute(plan.checker.path) || directoryIdentity(plan.checker.path) !== plan.checker.sha256) throw new Error('Checker identity changed.');
  const manifest = JSON.parse(bytes(join(plan.checker.path, 'package.json')).toString());
  if (manifest.name !== 'tla-ts' || manifest.version !== '0.0.3' || !lstatSync(checkerEntry(plan)).isFile()) throw new Error('Unsupported model checker.');
  if (adapterPaths.some((path, index) => digest(bytes(path)) !== adapterSha256[index])) throw new Error('Adapter identity changed.');
  const scope: Scope = JSON.parse(contents.scope.toString());
  if (scope.kind !== 'model-only' || scope.property !== 'NoUnjustifiedReacquisition'
    || scope.sourceSha256 !== plan.files.source.sha256) throw new Error('Unsupported model scope.');
  const checks = planModelChecks(contents.checks.toString(), contents.config.toString(), contents.model.toString());
  if (plan.maxRuns > checks.length) throw new Error('Invalid host model-check plan.');
  return { contents, scope, checks, bindings: canonicalSha256({ plan, adapterSha256, nodeSha256,
    policy: 'tla-ts-0.0.3-macos-one-worker-128m-60000ms-65536bytes-checks-v3' }) };
}

/** Host API only: pins are approved provenance, not proof of an upstream tool's authenticity. */
export function prepareReservationCheck(plan: Plan): object {
  const snapshot = structuredClone(plan);
  const { bindings } = inspect(snapshot);
  if (Date.now() >= snapshot.expiresAt) throw new Error('Model-check approval expired.');
  const grant = Object.freeze({});
  authorities.set(grant, { plan: snapshot, bindings, runs: 0, active: false, claimed: false });
  return grant;
}

/** The runner's single JSON line for a tla-ts 0.0.3 `check` result; anything else stays unknown. */
export function interpretCheck(observation: Observation) {
  const unknown = { status: 'unknown' as const };
  if (observation.status !== 'completed' || observation.exitCode !== 0 || !/^\{[^\n]*\}\n$/.test(observation.stdout)) return unknown;
  let line;
  try { line = JSON.parse(observation.stdout); } catch { return unknown; }
  if (Object.keys(line).sort().join() !== 'distinct,generated,invariant,queued,status,trace') return unknown;
  const { status, invariant, trace, generated, distinct, queued } = line;
  if (![trace, generated, distinct, queued].every(count => Number.isSafeInteger(count) && count >= 0)
    || distinct < 1 || generated < distinct) return unknown;
  if (status === 'success' && invariant === null && trace === 0 && queued === 0) {
    return { status: 'bounded-model-checked' as const, generated, distinct };
  }
  if (status === 'invariant-violation' && typeof invariant === 'string' && /^[A-Za-z]\w*$/.test(invariant) && trace > 0) {
    return { status: 'model-counterexample' as const, invariant };
  }
  return unknown;
}
function checkerEntry(plan: Plan) {
  return join(plan.checker.path, 'dist', 'index.js');
}
function execute(plan: Plan, cwd: string, signal?: AbortSignal): Promise<Observation & { durationMs: number; peakRssBytes: number | null }> {
  return new Promise(resolve => {
    const started = performance.now();
    let status = 'completed';
    let remaining = 65536;
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const child = spawn(plan.files.time.path, ['-l', plan.files.node.path, '--max-old-space-size=128', runnerPath, checkerEntry(plan), 'ReservationOwnership'], {
      cwd, env: { LANG: 'C', LC_ALL: 'C', HOME: cwd, TMPDIR: cwd }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = (reason: string) => {
      if (status !== 'completed') return;
      status = reason;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* A settled group may already be gone. */ }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop('timeout'), Math.max(1, Math.min(60000, plan.expiresAt - Date.now())));
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const name of ['stdout', 'stderr'] as const) child[name].on('data', (chunk: Buffer) => {
      const kept = Math.min(remaining, chunk.length);
      output[name].push(Buffer.from(chunk.subarray(0, kept)));
      remaining -= kept;
      if (kept !== chunk.length) stop('output_limit');
    });
    child.once('error', () => stop('process_error'));
    child.once('close', exitCode => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const stdout = Buffer.concat(output.stdout).toString();
      const stderr = Buffer.concat(output.stderr).toString();
      const rss = stderr.match(/(\d+)\s+maximum resident set size/);
      resolve({
        status, exitCode, stdout, stderr,
        durationMs: Math.ceil(performance.now() - started),
        peakRssBytes: rss ? Number(rss[1]) : null,
      });
    });
  });
}
/** Runs one planned check by its index; check 0 is the unchanged config. */
export async function runReservationCheck(grant: object, check = 0, signal?: AbortSignal): Promise<Pin> {
  const authority = authorities.get(grant);
  if (!authority) throw new Error('A host-issued model-check grant is required.');
  signal?.throwIfAborted();
  const { plan } = authority;
  if (authority.active || authority.runs >= plan.maxRuns || Date.now() >= plan.expiresAt) throw new Error('Model-check budget, ownership or expiry prevents execution.');
  const snapshot = inspect(plan);
  if (snapshot.bindings !== authority.bindings) throw new Error('Model-check identity changed.');
  const planned = snapshot.checks[check];
  if (!Number.isInteger(check) || !planned) throw new Error('Unsupported model check.');
  mkdirSync(plan.outputDir, { recursive: true, mode: 0o700 });
  if (!authority.claimed) {
    try { writeFileSync(join(plan.outputDir, 'model.claimed'), authority.bindings, { flag: 'wx', mode: 0o600 }); }
    catch { throw new Error('Model-check authority already consumed; do not retry ambiguously.'); }
    authority.claimed = true;
  }
  authority.active = true;
  authority.runs++;
  try {
    const directory = mkdtempSync(join(plan.outputDir, 'model-'));
    writeFileSync(join(directory, 'ReservationOwnership.tla'), snapshot.contents.model, { flag: 'wx', mode: 0o400 });
    writeFileSync(join(directory, 'ReservationOwnership.cfg'), planned.config, { flag: 'wx', mode: 0o400 });
    const observation = await execute(plan, directory, signal);
    try { if (inspect(plan).bindings !== authority.bindings) observation.status = 'stale-input'; }
    catch { observation.status = 'stale-input'; }
    const { stdout, stderr, ...execution } = observation;
    writeFileSync(join(directory, 'stdout.txt'), stdout, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'stderr.txt'), stderr, { flag: 'wx', mode: 0o600 });
    const receipt = { schemaVersion: 2, check, bindings: authority.bindings, execution,
      stdoutSha256: digest(stdout), stderrSha256: digest(stderr) };
    const encoded = JSON.stringify(receipt, null, 2) + '\n';
    const path = join(directory, 'receipt.json');
    writeFileSync(path, encoded, { flag: 'wx', mode: 0o600 });
    return { path, sha256: digest(encoded) };
  } finally {
    authority.active = false;
  }
}

/** Reference and plan must come from the trusted host; hashes do not authenticate a malicious same-user author. */
export function readReservationCheck(reference: Pin, plan: Plan) {
  const { bindings, scope, checks } = inspect(plan);
  const receipt = JSON.parse(pinned(reference).toString());
  const planned = Number.isInteger(receipt.check) ? checks[receipt.check] : undefined;
  if (!/^model-[A-Za-z0-9]{6}\/receipt\.json$/.test(relative(plan.outputDir, reference.path))
    || receipt.schemaVersion !== 2 || receipt.bindings !== bindings || !planned) throw new Error('Receipt identity mismatch.');
  const directory = dirname(reference.path);
  const stdout = bytes(join(directory, 'stdout.txt')).toString();
  const stderr = bytes(join(directory, 'stderr.txt')).toString();
  if (digest(stdout) !== receipt.stdoutSha256 || digest(stderr) !== receipt.stderrSha256
    || digest(bytes(join(directory, 'ReservationOwnership.tla'))) !== plan.files.model.sha256
    || digest(bytes(join(directory, 'ReservationOwnership.cfg'))) !== digest(planned.config)) throw new Error('Output or model identity mismatch.');
  const result = interpretCheck({ ...receipt.execution, stdout, stderr });
  return {
    kind: 'model-only' as const,
    ...result,
    check: planned,
    grade: gradeCheck(planned, result),
    bounds: scope.bounds,
    assumptions: scope.assumptions,
    exclusions: scope.exclusions,
    execution: receipt.execution,
    codeLinkedProof: false,
    typescriptReplay: 'not-attempted',
    reference,
  };
}

/** Runs every planned check once. The model meets its check contract only when every check passes. */
export async function verifyReservationModel(grant: object, signal?: AbortSignal) {
  const authority = authorities.get(grant);
  if (!authority) throw new Error('A host-issued model-check grant is required.');
  const { checks } = inspect(authority.plan);
  if (authority.plan.maxRuns - authority.runs < checks.length) throw new Error('Model-check budget does not cover every planned check.');
  const results: ReturnType<typeof readReservationCheck>[] = [];
  for (const index of checks.keys()) {
    results.push(readReservationCheck(await runReservationCheck(grant, index, signal), authority.plan));
  }
  const grades = results.map(result => result.grade);
  const status = grades.every(grade => grade === 'pass') ? 'contract-verified' as const
    : grades.includes('fail') ? 'contract-failed' as const : 'unknown' as const;
  return { status, results };
}
