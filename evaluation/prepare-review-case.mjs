import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestBytes } from '../src/experiments-contract.ts';
import { nodeAdapterIdentity } from '../src/experiments-node.ts';
import { describeRestricted } from '../src/experiments-restricted-contract.ts';
import { prepareNodeExperiment } from '../test/experiments-helpers.mjs';

const pin = async path => ({ path: await realpath(path), sha256: digestBytes(await readFile(path)) });
const sdkFiles = ['dist/config.js', 'dist/core/session-manager.js', 'dist/core/session-manager.d.ts', 'dist/core/messages.js',
  'dist/utils/paths.js', 'dist/utils/child-process.js', 'dist/utils/text.js'];
const processPackages = new Set(['cross-spawn', 'path-key', 'shebang-command', 'shebang-regex', 'which', 'isexe']);

// Author-side preparation only. This creates pins; it neither executes historical source nor grants authority.
export async function prepareReviewCase(directory, { caseId, revisions, probe, input = {} }) {
  if (!['review-restoration-v1', 'review-dispatch-v1', 'review-thinking-v1'].includes(caseId)) throw new Error('Unsupported review case.');
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  if (await realpath('.') !== repository) throw new Error('Prepare cases from the AutoReview checkout.');
  await mkdir(directory, { mode: 0o700 });
  const root = await realpath(directory);
  const prepared = await prepareNodeExperiment(null, root);
  const manifest = JSON.parse(await readFile(prepared.template.dependencies.path, 'utf8'));
  const destinations = new Set(manifest.files.map(file => file.destination));
  async function add(path, destination) {
    if (destinations.has(destination)) return;
    manifest.files.push({ ...await pin(path), destination });
    destinations.add(destination);
  }
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
  for (const path of sdkFiles) await add(join(piRoot, path), `pi/${path}`);
  await add(join(piRoot, '..', 'pi-ai', 'dist/utils/uuid.js'), 'pi-ai/dist/utils/uuid.js');
  await add(join(piRoot, '..', 'pi-ai', 'package.json'), 'pi-ai/package.json');
  const packages = new Set();
  async function addProcessPackage(name, from) {
    if (!processPackages.has(name)) throw new Error(`Unmodeled SDK process dependency: ${name}`);
    if (packages.has(name)) return;
    packages.add(name);
    const packagePath = from.resolve(`${name}/package.json`);
    const packageRoot = dirname(packagePath), metadata = JSON.parse(await readFile(packagePath, 'utf8'));
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) await add(child, `pi/node_modules/${name}/${relative(packageRoot, child)}`);
      }
    }
    await walk(packageRoot);
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await addProcessPackage(dependency, createRequire(packagePath));
  }
  await addProcessPackage('cross-spawn', createRequire(join(piRoot, 'package.json')));
  const bridge = join(root, 'review-api.mjs');
  await writeFile(bridge, "export { getAgentDir } from './pi/dist/config.js';\nexport { withFileMutationQueue } from './pi/dist/core/tools/file-mutation-queue.js';\n");
  await add(bridge, 'review-api.mjs');
  await add(resolve('evaluation/fixtures/review-host.mjs'), 'review-host.mjs');
  const dependencies = join(root, 'case-dependencies.json');
  await writeFile(dependencies, JSON.stringify(manifest));
  const dependencyPin = await pin(dependencies), probePin = await pin(resolve(probe));
  const requests = [];
  for (const revision of revisions) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A complete historical commit ID is required.');
    const paths = execFileSync('/usr/bin/git', ['-C', repository, 'ls-tree', '-rz', '--name-only', revision, '--', 'src', 'prompts', 'package.json'],
      { env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' } }).toString('utf8').split('\0').filter(Boolean);
    requests.push(describeRestricted({ ...prepared.template, caseId, adapterSha256: nodeAdapterIdentity(),
      source: { repository, revision, paths }, dependencies: dependencyPin, probe: probePin,
      input: JSON.stringify(input), targetId: 'case-contract' }).request);
  }
  const sdk = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
  const record = { caseId, sdk: { version: sdk.version, root: await realpath(piRoot) }, requests,
    setupRequest: { ...requests[0], dependencies: await pin(join(root, 'missing-dependencies.json')) },
    mocks: ['Pi registration/delivery facade; process/provider launch denied', 'SDK package export projection; actual SessionManager, config, file-mutation queue and UUID bytes'] };
  await writeFile(join(root, 'prepared.json'), JSON.stringify(record, null, 2));
  return { root, ...record };
}
