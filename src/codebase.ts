import { type ExtensionAPI, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const requiredTopics = ['structure', 'design', 'framework'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const hasCode = (error: unknown, code: string) => isRecord(error) && error.code === code;
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max;

type ReviewIdentity = {
  sessionId: string;
  runId: string;
  repository: string;
};

function validateNotes(input: unknown[]) {
  const notes = input.map(note => {
    if (
      !isRecord(note)
      || typeof note.topic !== 'string'
      || !/^[a-z][a-z0-9-]{0,39}$/.test(note.topic)
      || !isText(note.content, 8000)
      || !Array.isArray(note.sourceIds)
      || !note.sourceIds.length
      || note.sourceIds.length > 50
      || !note.sourceIds.every(id => isText(id, 200))
    ) {
      throw new Error('Invalid topic or evidence.');
    }
    return {
      topic: note.topic,
      content: note.content,
      sourceIds: note.sourceIds,
    };
  });

  const topics = new Set(notes.map(note => note.topic));
  if (topics.size !== notes.length || requiredTopics.some(topic => !topics.has(topic))) {
    throw new Error('Include structure, design and framework once each.');
  }
  return notes;
}

function readReviewedCodebase(reviewPath: string, identity: ReviewIdentity) {
  const review: unknown = JSON.parse(readFileSync(reviewPath, 'utf8'));
  if (
    !isRecord(review)
    || review.schemaVersion !== 1
    || review.sessionId !== identity.sessionId
    || review.runId !== identity.runId
  ) {
    throw new Error('Review does not match invocation.');
  }
  if (
    !['complete', 'incomplete'].includes(String(review.status))
    || typeof review.completedAt !== 'string'
    || !Number.isFinite(Date.parse(review.completedAt))
  ) {
    throw new Error('Learning requires a finished assessment.');
  }

  const codebase = Array.isArray(review.codebases)
    ? review.codebases.find(item => isRecord(item) && item.repository === identity.repository)
    : undefined;
  if (
    !isRecord(codebase)
    || !isText(codebase.root, 4000)
    || !isAbsolute(codebase.root)
    || !isText(codebase.revision, 500)
  ) {
    throw new Error('Repository must match a reviewed codebase with an absolute root and revision.');
  }

  return {
    root: codebase.root,
    revision: codebase.revision,
    completedAt: review.completedAt,
  };
}

function existingNotes(path: string): string {
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error('Codebase notes must be a regular file.');
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return '';
    throw error;
  }
}

function readStoredTopics(directory: string, identity: string): Map<string, string> {
  const stored = new Map<string, string>();
  const names = readdirSync(directory).filter(name => name.endsWith('.md'));

  for (const name of names) {
    const content = existingNotes(join(directory, name));
    if (content && !content.startsWith(identity)) {
      throw new Error('This folder contains notes for a different repository.');
    }
    stored.set(name, content);
  }
  return stored;
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);

  try {
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
}

export function registerCodebaseLearning(pi: ExtensionAPI, root: string): void {
  root = resolve(root);
  pi.registerTool({
    name: 'agentic_code_review_save_learning',
    label: 'Save codebase learning',
    description: readFileSync(new URL('../prompts/save-learning.md', import.meta.url), 'utf8'),
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }),
      runId: Type.String(),
      repository: Type.String({ maxLength: 500 }),
      notes: Type.Array(Type.Object({
        topic: Type.String({ pattern: '^[a-z][a-z0-9-]{0,39}$' }),
        content: Type.String({ minLength: 1, maxLength: 8000 }),
        sourceIds: Type.Array(
          Type.String({ minLength: 1, maxLength: 200 }),
          { minItems: 1, maxItems: 50 },
        ),
      }), { minItems: 3, maxItems: 8 }),
    }),
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const { sessionId, runId, repository } = input;
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        throw new Error('Invalid session ID.');
      }
      if (
        typeof runId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
      ) {
        throw new Error('Invalid run ID.');
      }
      if (
        !isText(repository, 500)
        || !Array.isArray(input.notes)
        || input.notes.length < 3
        || input.notes.length > 8
      ) {
        throw new Error('Invalid codebase notes.');
      }

      const notes = validateNotes(input.notes);
      const reviewPath = join(root, sessionId, `${runId}.review.json`);
      const codebase = readReviewedCodebase(reviewPath, { sessionId, runId, repository });
      const repositoryRoot = realpathSync(codebase.root);
      const folder = basename(repositoryRoot);
      if (!folder || !lstatSync(repositoryRoot).isDirectory()) {
        throw new Error('Invalid codebase root.');
      }

      const codebasesRoot = join(root, 'codebases');
      const directory = join(codebasesRoot, folder);
      const withinRepository = relative(repositoryRoot, join(realpathSync(root), 'codebases', folder));
      if (
        withinRepository !== '..'
        && !withinRepository.startsWith(`..${sep}`)
        && !isAbsolute(withinRepository)
      ) {
        throw new Error('Codebase learning must stay outside the reviewed tree.');
      }

      return withFileMutationQueue(join(directory, 'structure.md'), async () => {
        signal?.throwIfAborted();
        mkdirSync(codebasesRoot, { recursive: true, mode: 0o700 });
        if (!lstatSync(codebasesRoot).isDirectory()) {
          throw new Error('Codebase storage must be a directory, not a link.');
        }
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory()) {
          throw new Error('Codebase storage must be a directory, not a link.');
        }

        const lock = join(directory, '.write.lock');
        let fd: number;
        try {
          fd = openSync(lock, 'wx', 0o600);
        } catch (error) {
          if (hasCode(error, 'EEXIST')) {
            throw new Error('Codebase learning is locked by another writer; do not remove its lock.');
          }
          throw error;
        }

        try {
          writeFileSync(fd, `${sessionId}/${runId}\n`);
          const identity = `<!-- repository: ${JSON.stringify(repository)} -->\n`;
          const stored = readStoredTopics(directory, identity);
          const marker = `<!-- review: ${sessionId}/${runId} `;
          const updates = notes.map(note => {
            const path = join(directory, `${note.topic}.md`);
            const current = stored.get(`${note.topic}.md`) ?? '';
            const body = `## ${codebase.completedAt} | ${runId}

Revision: ${codebase.revision}
Review: ${reviewPath}
Map: ${join(root, sessionId, `${runId}.map.jsonl`)}
Sources: ${note.sourceIds.join(', ')}

${note.content}
`;
            const entry = `${marker}${createHash('sha256').update(body).digest('hex')} -->\n${body}`;
            const alreadySaved = current.includes(entry);
            if (current.includes(marker) && !alreadySaved) {
              throw new Error('Different learning was already saved for this run; preserve it.');
            }

            const topicContent = current || `${identity}# ${note.topic}\n`;
            return {
              topic: note.topic,
              path,
              content: alreadySaved ? current : `${topicContent}\n${entry}`,
              changed: !alreadySaved,
            };
          });

          signal?.throwIfAborted();
          for (const update of updates) {
            if (update.changed) atomicWrite(update.path, update.content);
            if (readFileSync(update.path, 'utf8') !== update.content) {
              throw new Error('Codebase learning readback failed.');
            }
          }
          const paths = Object.fromEntries(updates.map(update => [update.topic, update.path]));

          return {
            content: [{
              type: 'text' as const,
              text: `Saved codebase learning to ${directory}`,
            }],
            details: { directory, paths },
          };
        } finally {
          closeSync(fd);
          unlinkSync(lock);
        }
      });
    },
  });
}
