// Child process entry: checks the copied model with the pinned tla-ts and prints exactly one JSON line.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [entry, module] = process.argv.slice(2);
const { check } = await import(pathToFileURL(entry).href);
const result = await check({
  source: readFileSync(`${module}.tla`, 'utf8'),
  config: readFileSync(`${module}.cfg`, 'utf8'),
  workers: 1,
  onPrint: () => {},
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  invariant: result.violation?.name ?? null,
  trace: result.violation?.trace?.length ?? 0,
  generated: result.generatedStates,
  distinct: result.distinctStates,
  queued: result.queuedStates,
})}\n`);
