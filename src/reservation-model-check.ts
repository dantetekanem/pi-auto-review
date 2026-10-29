import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from './experiments-oracle.ts';

type Pin = { path: string; sha256: string };
type Input = 'model' | 'config' | 'scope' | 'source';
type Plan = {
  approvedBy: string;
  expiresAt: number;
  maxRuns: number;
  outputDir: string;
  files: Record<Input | 'java' | 'jar' | 'time', Pin>;
  runtime: Pin;
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
  scope: '../formal/ReservationOwnership.scope.json', source: './experiments-reservations.ts',
};
const sealedInputs = Object.fromEntries(Object.entries(inputPaths).map(([key, path]) => [key, digest(readFileSync(new URL(path, import.meta.url)))]));
const adapterPath = fileURLToPath(import.meta.url);
const adapterSha256 = digest(readFileSync(adapterPath));
const oraclePath = fileURLToPath(new URL('./experiments-oracle.ts', import.meta.url));
const oracleSha256 = digest(readFileSync(oraclePath));
const nodeSha256 = digest(readFileSync(process.execPath));
const mutations = ['none', 'allow-active', 'ignore-replay'];

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

/** Hash every regular runtime file; a launcher hash alone does not identify Java. */
export function runtimeIdentity(root: string): string {
  const files: [string, string][] = [];
  let total = 0;
  function visit(directory: string) {
    if (!lstatSync(directory).isDirectory()) throw new Error('Unsupported runtime directory.');
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else {
        total += stat.size;
        if (total > 536870912 || files.length >= 4096) throw new Error('Runtime identity limit exceeded.');
        files.push([relative(root, path), digest(bytes(path, 268435456))]);
      }
    }
  }
  visit(root);
  return canonicalSha256(files);
}
function inspect(plan: Plan) {
  exactKeys(plan, ['approvedBy', 'expiresAt', 'maxRuns', 'outputDir', 'files', 'runtime']);
  exactKeys(plan.files, ['model', 'config', 'scope', 'source', 'java', 'jar', 'time']);
  exactKeys(plan.runtime, ['path', 'sha256']);
  if (typeof plan.approvedBy !== 'string' || !plan.approvedBy.trim() || plan.approvedBy.length > 200
    || !Number.isSafeInteger(plan.expiresAt) || !Number.isInteger(plan.maxRuns) || plan.maxRuns < 1 || plan.maxRuns > 3
    || typeof plan.outputDir !== 'string' || !isAbsolute(plan.outputDir) || process.platform !== 'darwin'
    || plan.files.time.path !== '/usr/bin/time') throw new Error('Invalid host model-check plan.');
  const contents = Object.fromEntries(Object.entries(plan.files).map(([key, pin]) => [key, pinned(pin)]));
  for (const key of Object.keys(inputPaths) as Input[]) {
    if (plan.files[key].sha256 !== sealedInputs[key]) throw new Error(`Unsupported model input or scope: ${key}`);
  }
  if (!isAbsolute(plan.runtime.path) || runtimeIdentity(plan.runtime.path) !== plan.runtime.sha256
    || relative(plan.runtime.path, plan.files.java.path).startsWith('..')) throw new Error('Java runtime identity changed.');
  if (digest(bytes(adapterPath)) !== adapterSha256 || digest(bytes(oraclePath)) !== oracleSha256) throw new Error('Adapter identity changed.');
  const scope: Scope = JSON.parse(contents.scope.toString());
  if (scope.kind !== 'model-only' || scope.property !== 'NoUnjustifiedReacquisition'
    || scope.sourceSha256 !== plan.files.source.sha256) throw new Error('Unsupported model scope.');
  return { contents, scope, bindings: canonicalSha256({ plan, adapterSha256, oracleSha256, nodeSha256,
    policy: 'tlc-1.7.4-macos-bfs-one-worker-128m-60000ms-65536bytes-v1' }) };
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

/** TLC 1.7.4 EC/MP tool frames, not free-form success substrings. */
export function interpretTlc(observation: Observation) {
  const unknown = { status: 'unknown' as const };
  if (observation.status !== 'completed' || observation.stderr.includes('@!@!@')) return unknown;
  const messages = [...observation.stdout.matchAll(/@!@!@STARTMSG (\d+):(\d+) @!@!@\r?\n([\s\S]*?)\r?\n@!@!@ENDMSG \1 @!@!@/g)]
    .map(match => ({ id: Number(match[1]), level: Number(match[2]), body: match[3] }));
  const has = (id: number) => messages.filter(message => message.id === id);
  const starts = observation.stdout.match(/@!@!@STARTMSG/g)?.length ?? 0;
  const ends = observation.stdout.match(/@!@!@ENDMSG/g)?.length ?? 0;
  if (messages.length !== starts || starts !== ends || has(2187).length !== 1 || has(2185).length !== 1 || has(2186).length !== 1
    || [2188, 2271, 2197, 2198, 2204, 2210].some(id => has(id).length)) return unknown;
  const position = (id: number) => messages.findIndex(message => message.id === id);
  if (!/with 1 worker\b/.test(has(2187)[0].body) || has(2190).length !== 1
    || position(2185) >= position(2190) || position(2187) >= position(2190)
    || position(2190) >= position(2199) || position(2199) >= position(2186)) return unknown;
  const initial = has(2190)[0]?.body.match(/initial states: ([\d,]+) distinct state/);
  const stats = has(2199)[0]?.body.match(/^([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue\.$/);
  const count = (value: string) => Number(value.replaceAll(',', ''));
  if (!initial || !Number.isSafeInteger(count(initial[1])) || count(initial[1]) < 1 || !stats || has(2199).length !== 1
    || stats.slice(1).some(value => !Number.isSafeInteger(count(value))) || count(stats[2]) < 1
    || count(stats[1]) < count(stats[2])) return unknown;
  // EC.TLC_ENVIRONMENT_JVM_GC advises a faster collector; it does not change the checked state space.
  const performanceAdvisories = messages.filter(message => message.id === 2401 && message.level === 3
    && message.body === 'Please run the Java VM which executes TLC with a throughput optimized garbage collector by passing the "-XX:+UseParallelGC" property.');
  const advisories = performanceAdvisories.map(message => ({ code: message.id, message: message.body }));
  const errors = messages.filter(message => message.level > 0 && message.level < 4 && !performanceAdvisories.includes(message));
  if (observation.exitCode === 0 && !errors.length && has(2193).length === 1 && count(stats[3]) === 0) {
    return { status: 'bounded-model-checked' as const, generated: count(stats[1]), distinct: count(stats[2]), advisories };
  }
  if (observation.exitCode === 12 && !has(2193).length && has(2110).length === 1 && has(2121).length === 1
    && has(2217).length > 0 && errors.every(message => [2110, 2121].includes(message.id))
    && has(2110)[0].body === 'Invariant NoUnjustifiedReacquisition is violated.') {
    return { status: 'model-counterexample' as const, advisories };
  }
  return unknown;
}
function javaArgs(plan: Plan, directory: string) {
  return ['-Xmx128m', '-XX:MaxDirectMemorySize=32m', `-Djava.io.tmpdir=${directory}`, '-cp', plan.files.jar.path,
    'tlc2.TLC', '-cleanup', '-seed', '1', '-fp', '0', '-fpmem', '0.1',
    '-workers', '1', '-config', 'ReservationOwnership.cfg', '-tool', 'ReservationOwnership'];
}
function execute(plan: Plan, cwd: string, signal?: AbortSignal): Promise<Observation & { durationMs: number; peakRssBytes: number | null }> {
  return new Promise(resolve => {
    const started = performance.now();
    let status = 'completed';
    let remaining = 65536;
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const child = spawn(plan.files.time.path, ['-l', plan.files.java.path, ...javaArgs(plan, cwd)], {
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
function configFor(bytes: Buffer, mutation: string) {
  return bytes.toString().replace('Mutation = "none"', `Mutation = "${mutation}"`);
}

export async function runReservationCheck(grant: object, mutation = 'none', signal?: AbortSignal): Promise<Pin> {
  const authority = authorities.get(grant);
  if (!authority) throw new Error('A host-issued model-check grant is required.');
  if (typeof mutation !== 'string' || !mutations.includes(mutation)) throw new Error('Unsupported model mutation.');
  signal?.throwIfAborted();
  const { plan } = authority;
  if (authority.active || authority.runs >= plan.maxRuns || Date.now() >= plan.expiresAt) throw new Error('Model-check budget, ownership or expiry prevents execution.');
  const snapshot = inspect(plan);
  if (snapshot.bindings !== authority.bindings) throw new Error('Model-check identity changed.');
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
    writeFileSync(join(directory, 'ReservationOwnership.cfg'), configFor(snapshot.contents.config, mutation), { flag: 'wx', mode: 0o400 });
    const observation = await execute(plan, directory, signal);
    try { if (inspect(plan).bindings !== authority.bindings) observation.status = 'stale-input'; }
    catch { observation.status = 'stale-input'; }
    const { stdout, stderr, ...execution } = observation;
    writeFileSync(join(directory, 'stdout.txt'), stdout, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'stderr.txt'), stderr, { flag: 'wx', mode: 0o600 });
    const receipt = { schemaVersion: 1, mutation, bindings: authority.bindings, execution,
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
  const { bindings, scope, contents } = inspect(plan);
  const receipt = JSON.parse(pinned(reference).toString());
  if (!/^model-[A-Za-z0-9]{6}\/receipt\.json$/.test(relative(plan.outputDir, reference.path))
    || receipt.schemaVersion !== 1 || receipt.bindings !== bindings || !mutations.includes(receipt.mutation)) throw new Error('Receipt identity mismatch.');
  const directory = dirname(reference.path);
  const stdout = bytes(join(directory, 'stdout.txt')).toString();
  const stderr = bytes(join(directory, 'stderr.txt')).toString();
  if (digest(stdout) !== receipt.stdoutSha256 || digest(stderr) !== receipt.stderrSha256
    || digest(bytes(join(directory, 'ReservationOwnership.tla'))) !== plan.files.model.sha256
    || digest(bytes(join(directory, 'ReservationOwnership.cfg'))) !== digest(configFor(contents.config, receipt.mutation))) throw new Error('Output or model identity mismatch.');
  return {
    kind: 'model-only' as const,
    ...interpretTlc({ ...receipt.execution, stdout, stderr }),
    mutation: receipt.mutation,
    bounds: scope.bounds,
    assumptions: scope.assumptions,
    exclusions: scope.exclusions,
    execution: receipt.execution,
    codeLinkedProof: false,
    typescriptReplay: 'not-attempted',
    reference,
  };
}
