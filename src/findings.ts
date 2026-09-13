import { type ExtensionAPI, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const readPrompt = () => readFileSync(new URL('../prompts/finding.md', import.meta.url), 'utf8');
const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/;
const runPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Finding = Record<string, unknown> & { kind: 'bug' | 'fix' | 'nit' };

function requireText(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value as Record<string, unknown>;
}

function requireLinks(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) {
    throw new Error(`Invalid ${name}.`);
  }
  return value.map(item => requireText(item, name, 200));
}

function requireIdentifier(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function validateFinding(value: unknown): Finding {
  const finding = requireObject(value, 'finding');
  const kind = finding.kind;
  if (kind !== 'bug' && kind !== 'fix' && kind !== 'nit') {
    throw new Error('Invalid finding kind.');
  }

  const location = requireObject(finding.location, 'location');
  requireText(location.path, 'location path', 500);
  requireText(location.symbol, 'location symbol', 500);
  if (
    !Number.isInteger(location.startLine)
    || !Number.isInteger(location.endLine)
    || Number(location.startLine) < 1
    || Number(location.endLine) < Number(location.startLine)
  ) {
    throw new Error('Invalid location line range.');
  }

  const base: Finding = {
    kind,
    sourceIds: requireLinks(finding.sourceIds, 'source links'),
    requirementIds: requireLinks(finding.requirementIds, 'requirement links'),
    unitIds: requireLinks(finding.unitIds, 'unit links'),
    repository: requireText(finding.repository, 'repository', 500),
    revision: requireText(finding.revision, 'revision', 500),
    location: {
      path: location.path,
      symbol: location.symbol,
      startLine: location.startLine,
      endLine: location.endLine,
    },
    title: requireText(finding.title, 'title', 240),
    impact: requireText(finding.impact, 'impact'),
    suggestedFix: requireText(finding.suggestedFix, 'suggested fix'),
  };
  if (finding.humanReadable !== undefined || finding.rating !== undefined) {
    base.humanReadable = requireText(finding.humanReadable, 'human-readable summary', 400);
    base.rating = requireIdentifier(finding.rating, 'rating (A–F)', /^[A-F]$/);
  }
  if (kind !== 'bug') {
    return { ...base, blocks: false };
  }

  const evidence = finding.evidence;
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 50) {
    throw new Error('Invalid evidence.');
  }
  const expected = requireText(finding.expected, 'expected behavior');
  const actual = requireText(finding.actual, 'actual behavior');
  if (!['introduced', 'expanded', 'pre-existing'].includes(String(finding.origin))) {
    throw new Error('Invalid origin.');
  }
  const origin = finding.origin;
  if (typeof finding.blocks !== 'boolean') {
    throw new Error('Invalid blocks flag.');
  }

  return {
    ...base,
    status: 'open',
    expected,
    actual,
    origin,
    blocks: finding.blocks,
    verification: requireText(finding.verification, 'verification'),
    evidence: evidence.map(item => {
      const source = requireObject(item, 'evidence');
      return {
        source: requireText(source.source, 'evidence source', 1000),
        detail: requireText(source.detail, 'evidence detail'),
      };
    }),
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  let ownsTemp = false;

  try {
    const handle = await open(temp, 'wx', 0o600);
    ownsTemp = true;
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    if (ownsTemp) await unlink(temp).catch(() => {});
  }
}

const schema = Type.Object({
  sessionId: Type.String({ description: 'Prepared review session ID.', maxLength: 128 }),
  runId: Type.String({ description: 'Prepared review run UUID.' }),
  finding: Type.Object({
    kind: Type.String({ enum: ['bug', 'fix', 'nit'] }),
    sourceIds: Type.Array(Type.String()),
    requirementIds: Type.Array(Type.String()),
    unitIds: Type.Array(Type.String()),
    repository: Type.String(),
    revision: Type.String(),
    location: Type.Object({
      path: Type.String(),
      symbol: Type.String(),
      startLine: Type.Integer(),
      endLine: Type.Integer(),
    }),
    title: Type.String(),
    impact: Type.String(),
    suggestedFix: Type.String(),
    humanReadable: Type.Optional(Type.String({
      maxLength: 400,
      description: 'Required for new runs. About 25–40 plain-language words: what happens, why it matters, and the supported next step.',
    })),
    rating: Type.Optional(Type.String({
      enum: ['A', 'B', 'C', 'D', 'E', 'F'],
      description: 'Required for new runs. A safest, F worst; justify with impact/evidence, never infer confirmation or blocking from the letter.',
    })),
    expected: Type.Optional(Type.String()),
    actual: Type.Optional(Type.String()),
    origin: Type.Optional(Type.String()),
    blocks: Type.Optional(Type.Boolean()),
    verification: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Type.Object({
      source: Type.String(),
      detail: Type.String(),
    }))),
  }),
});

export function registerFindings(pi: ExtensionAPI, root: string): void {
  pi.registerTool({
    name: 'agentic_code_review_append_finding',
    label: 'Append review finding',
    description: readPrompt(),
    parameters: schema,
    async execute(_callId, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const sessionId = requireIdentifier(input.sessionId, 'session ID', sessionPattern);
      const runId = requireIdentifier(input.runId, 'run ID', runPattern);
      const finding = validateFinding(input.finding);
      const artifactPath = join(root, sessionId, `${runId}.bugs.json`);

      return withFileMutationQueue(artifactPath, async () => {
        signal?.throwIfAborted();
        const envelope = requireObject(
          JSON.parse(await readFile(artifactPath, 'utf8')),
          'prepared bugs envelope',
        );
        if (
          envelope.schemaVersion !== 1
          || envelope.runId !== runId
          || envelope.sessionId !== sessionId
          || !Array.isArray(envelope.bugs)
        ) {
          throw new Error('Prepared bugs envelope does not match invocation.');
        }
        if (!['prepared', 'running', 'queued'].includes(String(envelope.status))) {
          throw new Error('Prepared bugs envelope is sealed.');
        }
        if (envelope.findings !== undefined && !Array.isArray(envelope.findings)) {
          throw new Error('Invalid findings envelope.');
        }
        if (envelope.presentationVersion !== undefined && envelope.presentationVersion !== 1) {
          throw new Error('Unsupported presentation version.');
        }
        if (envelope.presentationVersion === 1 && finding.humanReadable === undefined) {
          throw new Error('This run requires humanReadable and rating.');
        }

        signal?.throwIfAborted();
        const reviewer = {
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
          thinkingLevel: ctx.thinkingLevel ?? null,
        };
        const saved = {
          ...finding,
          reviewer,
          id: `finding-${randomUUID()}`,
        };
        if (finding.kind === 'bug') {
          envelope.bugs.push(saved);
        } else {
          const findings = Array.isArray(envelope.findings) ? envelope.findings : [];
          findings.push(saved);
          envelope.findings = findings;
        }
        await atomicWrite(artifactPath, `${JSON.stringify(envelope)}\n`);

        return {
          content: [{
            type: 'text' as const,
            text: `Saved ${saved.id} to ${artifactPath}`,
          }],
          details: { id: saved.id, artifactPath, reviewer },
        };
      });
    },
  });
}
