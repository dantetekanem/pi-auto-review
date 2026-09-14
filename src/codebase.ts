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
const CURRENT_MAX = 6000;
const CURRENT_CLOSE = '\n<!-- /current -->\n';
const CURRENT_OPEN = /^\n?<!-- current: (\S+) (\S+) ([0-9a-f]{64}) -->\n/;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
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

type Note = { topic: string; current?: string; delta: string; sourceIds: string[] };

function validateNotes(input: unknown[]): Note[] {
  const notes = input.map(note => {
    const delta = isRecord(note) ? note.delta ?? note.content : undefined;
    if (
      !isRecord(note)
      || typeof note.topic !== 'string'
      || !/^[a-z][a-z0-9-]{0,39}$/.test(note.topic)
      || !isText(delta, 8000)
      || !Array.isArray(note.sourceIds)
      || !note.sourceIds.length
      || note.sourceIds.length > 50
      || !note.sourceIds.every(id => isText(id, 200))
    ) {
      throw new Error('Invalid topic or evidence.');
    }
    if (note.current !== undefined && !isText(note.current, CURRENT_MAX)) {
      throw new Error(`The current block must be 1 to ${CURRENT_MAX} characters.`);
    }
    return {
      topic: note.topic,
      current: typeof note.current === 'string' ? note.current : undefined,
      delta,
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

type CurrentBlock = { owner: string; revision: string; hash: string; body: string };
type TopicFile = { header: string; current?: CurrentBlock; history: string };

function splitTopic(content: string, identity: string, topic: string): TopicFile {
  const header = `${identity}# ${topic}\n`;
  if (!content) return { header, history: '' };
  const rest = content.startsWith(header) ? content.slice(header.length) : content.slice(identity.length).replace(/^# [^\n]*\n/, '');
  const open = rest.match(CURRENT_OPEN);
  if (open) {
    const end = rest.indexOf(CURRENT_CLOSE, open[0].length);
    if (end !== -1) {
      return {
        header,
        current: { owner: open[1]!, revision: open[2]!, hash: open[3]!, body: rest.slice(open[0].length, end) },
        history: rest.slice(end + CURRENT_CLOSE.length),
      };
    }
  }
  return { header, history: rest };
}

function renderCurrent(block: CurrentBlock | undefined): string {
  if (!block) return '';
  return `\n<!-- current: ${block.owner} ${block.revision} ${block.hash} -->\n${block.body}${CURRENT_CLOSE}`;
}

function historyEntries(history: string): Array<{ run: string; completedAt: string; revision: string }> {
  const entries: Array<{ run: string; completedAt: string; revision: string }> = [];
  const pattern = /^## (\S+) \| (\S+)\n\nRevision: (\S+)/gm;
  for (const match of history.matchAll(pattern)) {
    entries.push({ completedAt: match[1]!, run: match[2]!, revision: match[3]! });
  }
  return entries;
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
        current: Type.Optional(Type.String({
          minLength: 1,
          maxLength: CURRENT_MAX,
          description: 'The consolidated block for this topic after this run: what the next review should read first. Rewrite the previous current block with this run\'s revalidations, corrections and additions folded in. Omit to keep the existing block.',
        })),
        delta: Type.String({
          minLength: 1,
          maxLength: 8000,
          description: 'What this run learned, changed or refuted for this topic, with map source IDs. Appended to the topic history with the run and revision.',
        }),
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
          const owner = `${sessionId}/${runId}`;
          const updates = notes.map(note => {
            const path = join(directory, `${note.topic}.md`);
            const existing = stored.get(`${note.topic}.md`) ?? '';
            const file = splitTopic(existing, identity, note.topic);
            const body = `## ${codebase.completedAt} | ${runId}

Revision: ${codebase.revision}
Review: ${reviewPath}
Map: ${join(root, sessionId, `${runId}.map.jsonl`)}
Sources: ${note.sourceIds.join(', ')}

${note.delta}
`;
            const entry = `${marker}${sha256(body)} -->\n${body}`;
            const alreadySaved = file.history.includes(entry);
            if (file.history.includes(marker) && !alreadySaved) {
              throw new Error('Different learning was already saved for this run; preserve it.');
            }
            if (alreadySaved && file.current?.owner === owner && note.current !== undefined && file.current.hash !== sha256(note.current)) {
              throw new Error('Different learning was already saved for this run; preserve it.');
            }

            const current = note.current !== undefined && !alreadySaved
              ? { owner, revision: codebase.revision, hash: sha256(note.current), body: note.current.trimEnd() }
              : file.current;
            const content = `${file.header}${renderCurrent(current)}${file.history}${alreadySaved ? '' : `\n${entry}`}`;
            return {
              topic: note.topic,
              path,
              content,
              changed: content !== existing,
              current: current ? { owner: current.owner, bytes: Buffer.byteLength(current.body) } : null,
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
          const current = Object.fromEntries(updates.map(update => [update.topic, update.current]));

          return {
            content: [{
              type: 'text' as const,
              text: `Saved codebase learning to ${directory}`,
            }],
            details: { directory, paths, current },
          };
        } finally {
          closeSync(fd);
          unlinkSync(lock);
        }
      });
    },
  });

  pi.registerTool({
    name: 'agentic_code_review_read_learning',
    label: 'Read codebase learning',
    description: readFileSync(new URL('../prompts/read-learning.md', import.meta.url), 'utf8'),
    parameters: Type.Object({
      root: Type.String({ maxLength: 4000, description: 'Absolute path of the reviewed checkout root.' }),
      repository: Type.String({ maxLength: 500, description: 'Stable, credential-free repository identity, as recorded in review codebases entries.' }),
    }),
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const { root: checkout, repository } = input;
      if (!isText(checkout, 4000) || !isAbsolute(checkout) || !isText(repository, 500)) {
        throw new Error('Reading learning needs an absolute checkout root and a repository identity.');
      }
      const folder = basename(realpathSync(checkout));
      const directory = join(root, 'codebases', folder);
      const identity = `<!-- repository: ${JSON.stringify(repository)} -->\n`;
      let stored: Map<string, string>;
      try {
        stored = readStoredTopics(directory, identity);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) stored = new Map();
        else if (error instanceof Error && /different repository/.test(error.message)) {
          return {
            content: [{ type: 'text' as const, text: `No codebase notes for ${repository}: ${directory} holds notes for another repository.` }],
            details: { directory, topics: [] },
          };
        } else throw error;
      }

      const topics = [...stored.entries()]
        .filter(([, content]) => content)
        .map(([name, content]) => {
          const topic = name.replace(/\.md$/, '');
          const file = splitTopic(content, identity, topic);
          const runs = historyEntries(file.history);
          return {
            topic,
            path: join(directory, name),
            current: file.current ? { owner: file.current.owner, revision: file.current.revision, body: file.current.body } : null,
            runs: runs.length,
            latestRun: runs.at(-1) ?? null,
          };
        })
        .sort((left, right) => left.topic.localeCompare(right.topic));

      const text = topics.length
        ? topics.map(item => item.current
          ? `## ${item.topic} (current from ${item.current.owner} at ${item.current.revision}; ${item.runs} runs in history)\n\n${item.current.body}\n`
          : `## ${item.topic} (no current block yet; ${item.runs} runs in history at ${item.path})\n`).join('\n')
        : `No codebase notes for ${repository} under ${directory}.`;

      return {
        content: [{ type: 'text' as const, text }],
        details: { directory, topics: topics.map(({ topic, path, runs, latestRun, current }) => ({ topic, path, runs, latestRun, current: current ? { owner: current.owner, revision: current.revision, bytes: Buffer.byteLength(current.body) } : null })) },
      };
    },
  });
}
