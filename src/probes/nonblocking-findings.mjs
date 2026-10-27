import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const sessionId = 'session-1';
const runId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const path = `/scratch/reviews/${sessionId}/${runId}.bugs.json`;
let tool, input;
try {
  const { registerFindings } = await import('/bundle/source/src/findings.ts');
  registerFindings({ registerTool(value) { tool = value; } }, '/scratch/reviews');
  input = JSON.parse(await readFile('/bundle/input.json', 'utf8'));
  if (!Array.isArray(input.items) || input.items.length > 8) throw new Error('Invalid finite finding input.');
  await mkdir(`/scratch/reviews/${sessionId}`, { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, presentationVersion: 1, runId, sessionId,
    status: 'prepared', bugs: [], cwd: '/private/project', context: 'request', createdAt: '2026-01-01T00:00:00.000Z' }));
} catch (error) {
  console.log('AR_SETUP ' + String(error));
  throw error;
}

// The fixed passing core keeps an empty removable-atom set a real, non-vacuous check.
const core = { kind: 'fix', sourceIds: ['source-1'], requirementIds: ['requirement-1'], unitIds: ['unit-1'],
  repository: 'owner/repo', revision: 'fixture-only', location: { path: 'src/a.ts', symbol: 'work', startLine: 3, endLine: 4 },
  title: 'Core suggestion', impact: 'A nonblocking suggestion.', suggestedFix: 'Consider the suggestion.',
  humanReadable: 'This suggestion does not block the review.', rating: 'B', blocks: true };

test('optional-nonblocking', async t => {
  for (const finding of [core, ...input.items]) {
    await tool.execute('probe', { sessionId, runId, finding }, undefined, undefined, { model: undefined });
  }
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const records = envelope.findings.map(({ id, reviewer, ...finding }) => finding);
  t.diagnostic('AR_RUNTIME ' + process.version);
  t.diagnostic('AR_OBSERVATION ' + JSON.stringify({ records, bugs: envelope.bugs.length }));
  assert.ok(records.length === input.items.length + 1 && envelope.bugs.length === 0
    && records.every(record => ['nit', 'fix'].includes(record.kind) && record.blocks === false),
  'optional findings must be nonblocking');
});
