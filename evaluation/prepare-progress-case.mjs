import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { digestBytes } from '../src/experiments-contract.ts';
import { nodeAdapterIdentity } from '../src/experiments-node.ts';
import { describeRestricted } from '../src/experiments-restricted-contract.ts';
import { prepareNodeExperiment } from '../test/experiments-helpers.mjs';

// Historical source is pinned here but runs only in the restricted worker.
export async function prepareProgressCase(directory, repository, revisions) {
  await mkdir(directory, { mode: 0o700 });
  const root = await realpath(directory);
  const { template } = await prepareNodeExperiment(null, root);
  repository = await realpath(repository);
  const from = createRequire(join(repository, 'package.json'));
  const tuiRoot = dirname(dirname(from.resolve('@mariozechner/pi-tui')));
  const widthRoot = dirname(createRequire(join(tuiRoot, 'package.json')).resolve('get-east-asian-width'));
  const pin = async path => ({ path: await realpath(path), sha256: digestBytes(await readFile(path)) });
  const files = [];
  const add = async (path, destination) => files.push({ ...await pin(path), destination });
  for (const file of ['package.json', 'dist/utils.js', 'dist/components/text.js']) {
    await add(join(tuiRoot, file), 'tui/' + file.replace(/^dist\//, ''));
  }
  for (const entry of await readdir(widthRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) {
      await add(join(widthRoot, entry.name), 'tui/node_modules/get-east-asian-width/' + entry.name);
    }
  }
  const bridge = join(root, 'tui-index.js');
  await writeFile(bridge, "export { truncateToWidth, visibleWidth } from './utils.js';\nexport { Text } from './components/text.js';\n");
  await add(bridge, 'tui/index.js');
  await add(resolve('evaluation/fixtures/progress-host.mjs'), 'progress-host.mjs');
  const manifest = join(root, 'progress-dependencies.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, files }));
  const dependencies = await pin(manifest), probe = await pin(resolve('evaluation/fixtures/progress.mjs'));
  const sourcePaths = ['extensions/index.ts', 'extensions/ui/status-widget.ts', 'extensions/ui/renderers.ts',
    'extensions/ui/theme.ts', 'extensions/ui/ansi.ts', 'extensions/ui/read-agent-status.ts', 'extensions/ui/activity-colors.ts'];
  const requests = revisions.map(revision => {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A complete historical commit ID is required.');
    const paths = execFileSync('/usr/bin/git', ['-C', repository, 'ls-tree', '-rz', '--name-only', revision, '--', ...sourcePaths],
      { env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' } })
      .toString('utf8').split('\0').filter(Boolean);
    return describeRestricted({ ...template, caseId: 'team-progress-v1', adapterSha256: nodeAdapterIdentity(),
      source: { repository, revision, paths }, dependencies, probe, input: JSON.stringify({ progress: 'Sending exact report' }),
      targetId: 'case-contract' }).request;
  });
  const tui = JSON.parse(await readFile(join(tuiRoot, 'package.json'), 'utf8'));
  const record = { caseId: 'team-progress-v1', requests, tui: { version: tui.version, root: await realpath(tuiRoot) },
    mocks: ['Inert host registration, tool dispatch, lifecycle and roster; single seeded active run and matching persistence_closed fence',
      'Fake Date and timers, plain theme, empty inbox, zero context usage, no session/idle transition',
      'SDK keyText unused/denied; TUI exports project to actual pinned utilities/Text and width dependency; no real terminal'] };
  await writeFile(join(root, 'prepared.json'), JSON.stringify(record, null, 2));
  return { root, ...record };
}
