import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestBytes } from '../src/experiments-contract.ts';
import { nodeAdapterIdentity, targetSignature } from '../src/experiments-node.ts';
import { execFileSync } from 'node:child_process';
import { freezeOracle } from '../src/experiments-oracle.ts';

export const baseRevision = '87bc85e61121be57051b8b341cb3653eb0d26270';
export const headRevision = 'c3bca5ff8623dedb11d956cc8f2199f2aac7b766';
export const finding = (kind = 'nit', blocks = true, title = 'Optional suggestion') => ({
  kind, sourceIds: ['source-1'], requirementIds: ['requirement-1'], unitIds: ['unit-1'],
  repository: 'owner/repo', revision: 'fixture-only', location: { path: 'src/a.ts', symbol: 'work', startLine: 3, endLine: 4 },
  title, impact: 'A nonblocking suggestion.', suggestedFix: 'Consider the suggestion.',
  humanReadable: 'This suggestion does not block the review.', rating: 'B', blocks,
});

export function prepareOracle() {
  const contract = execFileSync('/usr/bin/git', ['show', `${baseRevision}:prompts/finding.md`]);
  return freezeOracle({
    requirement: { id: 'optional-nonblocking', statement: 'Optional fix and nit findings remain nonblocking.',
      authority: { kind: 'repository-contract', ref: `${baseRevision}:prompts/finding.md`, sha256: digestBytes(contract) },
      entryId: 'registerFindings/agentic_code_review_append_finding', revisions: [baseRevision, headRevision],
      inputClasses: ['optional-findings'], exceptions: [] },
    oracle: { targetCheckId: 'optional-nonblocking', targetSignature,
      normalizerVersion: 'node-findings-v1', normalizerSha256: nodeAdapterIdentity() },
  });
}

let syntheticSequence = 0;
export function syntheticAttempt({ predicate = 'PASS', status = 'completed', request = {}, normalized = {} } = {}) {
  const sha = 'a'.repeat(64);
  const completeRequest = {
    runId: 'unit-run', profile: 'docker-node-v1',
    backend: { socketPath: '/tmp/unit.sock', engineId: 'unit-engine', imageId: `sha256:${sha}`, platform: 'linux/arm64', seccompPath: '/tmp/seccomp.json', seccompSha256: sha },
    source: { repository: '/unit-repository', revision: headRevision, paths: ['src/findings.ts'] },
    dependencies: { path: '/tmp/dependencies.json', sha256: sha }, probe: { path: '/tmp/probe.mjs', sha256: sha },
    adapterSha256: nodeAdapterIdentity(), input: JSON.stringify({ items: [finding()] }),
    targetId: 'optional-nonblocking', limits: { timeoutMs: 1000, maxOutputBytes: 4096 }, ...request,
  };
  return { request: completeRequest, predicate, status, normalized,
    requestDigest: digestBytes(JSON.stringify(completeRequest)), attemptId: `synthetic-${++syntheticSequence}`,
    reference: { path: `/synthetic/receipt-${syntheticSequence}.json`, sha256: sha }, outputs: { stdout: '', stderr: '' } };
}

export function syntheticControls() {
  const pass = syntheticAttempt();
  const failure = syntheticAttempt({ predicate: 'FAIL', request: { source: { ...pass.request.source,
    mutation: { label: 'sensitivity-control', path: 'src/findings.ts', before: 'false', after: 'true' } } } });
  const infrastructure = syntheticAttempt({ predicate: 'UNRESOLVED', status: 'setup_error' });
  return { pass, failure, infrastructure };
}

export async function prepareNodeExperiment(t, artifactDirectory) {
  const saved = JSON.parse(await readFile(process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND, 'utf8'));
  const root = artifactDirectory ?? await mkdtemp(join(await realpath(tmpdir()), 'autoreview-node-'));
  if (t && !artifactDirectory) t.after(() => rm(root, { recursive: true, force: true }));
  const pin = async path => ({ path: await realpath(path), sha256: digestBytes(await readFile(path)) });
  const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const piRoot = dirname(dirname(piEntry));
  const require = createRequire(piEntry);
  const typeboxRoot = dirname(dirname(require.resolve('typebox')));
  const files = [];
  async function add(path, destination) { files.push({ ...await pin(path), destination }); }
  await add(join(piRoot, 'package.json'), 'pi/package.json');
  await add(join(piRoot, 'dist/core/tools/file-mutation-queue.js'), 'pi/dist/core/tools/file-mutation-queue.js');
  await add(join(typeboxRoot, 'package.json'), 'typebox/package.json');
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && item.name.endsWith('.mjs')) await add(path, 'typebox/' + relative(typeboxRoot, path));
    }
  }
  await walk(join(typeboxRoot, 'build'));
  const manifest = join(root, 'dependencies.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, files }));
  const empty = join(root, 'missing-dependencies.json');
  await writeFile(empty, JSON.stringify({ schemaVersion: 1, files: [] }));
  const seccomp = await pin(resolve('src/experiments-seccomp.json'));
  const template = {
    runId: '11111111-1111-4111-8111-111111111111', profile: 'docker-node-v1',
    backend: { socketPath: saved.endpoint.replace(/^unix:\/\//, ''), engineId: saved.engine.ID,
      imageId: saved.imageId, platform: saved.platform, seccompPath: seccomp.path, seccompSha256: seccomp.sha256 },
    source: { repository: await realpath('.'), revision: headRevision, paths: ['package.json', 'src/findings.ts', 'prompts/finding.md'] },
    dependencies: await pin(manifest), probe: await pin(resolve('src/probes/nonblocking-findings.mjs')),
    adapterSha256: nodeAdapterIdentity(), input: JSON.stringify({ items: [finding()] }), targetId: 'optional-nonblocking',
    limits: { timeoutMs: 10000, maxOutputBytes: 65536 },
  };
  const missingDependencies = await pin(empty);
  const request = (variant, input = template.input) => ({ ...structuredClone(template), input,
    source: { ...template.source, revision: variant === 'base' ? baseRevision : headRevision,
      ...(variant === 'mutant' ? { mutation: { label: 'sensitivity-control', path: 'src/findings.ts', before: 'return { ...base, blocks: false };', after: "return { ...base, blocks: kind === 'nit' };" } } : {}) },
    dependencies: variant === 'setup' ? missingDependencies : template.dependencies,
  });
  return { root, template, request, artifacts: join(root, 'artifacts'), guard: join(root, 'active-restricted.json'),
    approval: { approvedBy: 'authorized-local-acceptance', familySha256: digestBytes('optional-nonblocking-v1'), expiresAt: Date.now() + 600000,
      maxAttempts: 64, maxWallMs: 300000, maxOutputBytes: 4194304 } };
}
