import { type ExtensionAPI, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasCode = (error: unknown, code: string) => record(error) && error.code === code;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const requiredTopics = ['structure', 'design', 'framework'];

function existingNotes(path: string): string {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Codebase notes must be a regular file.');
    return readFileSync(path, 'utf8');
  } catch (error) { if (hasCode(error, 'ENOENT')) return ''; throw error; }
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}

export function registerCodebaseLearning(pi: ExtensionAPI, root: string): void {
  root = resolve(root);
  pi.registerTool({
    name: 'agentic_code_review_save_learning', label: 'Save codebase learning',
    description: readFileSync(new URL('../prompts/save-learning.md', import.meta.url), 'utf8'),
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }), runId: Type.String(), repository: Type.String({ maxLength: 500 }),
      notes: Type.Array(Type.Object({
        topic: Type.String({ pattern: '^[a-z][a-z0-9-]{0,39}$' }),
        content: Type.String({ minLength: 1, maxLength: 8000 }),
        sourceIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 50 }),
      }), { minItems: 3, maxItems: 8 }),
    }),
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const { sessionId, runId, repository } = input;
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session ID.');
      if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error('Invalid run ID.');
      if (!text(repository, 500) || !Array.isArray(input.notes) || input.notes.length < 3 || input.notes.length > 8) throw new Error('Invalid codebase notes.');
      const notes = input.notes.map(note => {
        if (!record(note) || typeof note.topic !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(note.topic) || !text(note.content, 8000)
          || !Array.isArray(note.sourceIds) || !note.sourceIds.length || note.sourceIds.length > 50 || !note.sourceIds.every(id => text(id, 200))) throw new Error('Invalid topic or evidence.');
        return { topic: note.topic, content: note.content, sourceIds: note.sourceIds };
      });
      const topics = new Set(notes.map(note => note.topic));
      if (topics.size !== notes.length || requiredTopics.some(topic => !topics.has(topic))) throw new Error('Include structure, design and framework once each.');
      const reviewPath = join(root, sessionId, `${runId}.review.json`);
      const review: unknown = JSON.parse(readFileSync(reviewPath, 'utf8'));
      if (!record(review) || review.schemaVersion !== 1 || review.sessionId !== sessionId || review.runId !== runId) throw new Error('Review does not match invocation.');
      if (!['complete', 'incomplete'].includes(String(review.status)) || typeof review.completedAt !== 'string' || !Number.isFinite(Date.parse(review.completedAt))) throw new Error('Learning requires a finished assessment.');
      const codebase = Array.isArray(review.codebases) ? review.codebases.find(item => record(item) && item.repository === repository) : undefined;
      if (!record(codebase) || !text(codebase.root, 4000) || !isAbsolute(codebase.root) || !text(codebase.revision, 500)) throw new Error('Repository must match a reviewed codebase with an absolute root and revision.');
      const repositoryRoot = realpathSync(codebase.root), folder = basename(repositoryRoot);
      if (!folder || !lstatSync(repositoryRoot).isDirectory()) throw new Error('Invalid codebase root.');
      const codebasesRoot = join(root, 'codebases'), directory = join(codebasesRoot, folder);
      const withinRepository = relative(repositoryRoot, join(realpathSync(root), 'codebases', folder));
      if (withinRepository !== '..' && !withinRepository.startsWith(`..${sep}`) && !isAbsolute(withinRepository)) throw new Error('Codebase learning must stay outside the reviewed tree.');
      return withFileMutationQueue(join(directory, 'structure.md'), async () => {
        signal?.throwIfAborted();
        mkdirSync(codebasesRoot, { recursive: true, mode: 0o700 });
        if (!lstatSync(codebasesRoot).isDirectory()) throw new Error('Codebase storage must be a directory, not a link.');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!lstatSync(directory).isDirectory()) throw new Error('Codebase storage must be a directory, not a link.');
        const lock = join(directory, '.write.lock');
        let fd: number;
        try { fd = openSync(lock, 'wx', 0o600); }
        catch (error) { if (hasCode(error, 'EEXIST')) throw new Error('Codebase learning is locked by another writer; do not remove its lock.'); throw error; }
        try {
          writeFileSync(fd, `${sessionId}/${runId}\n`);
          const identity = `<!-- repository: ${JSON.stringify(repository)} -->\n`;
          const stored = new Map<string, string>();
          for (const name of readdirSync(directory).filter(name => name.endsWith('.md'))) {
            const content = existingNotes(join(directory, name));
            if (content && !content.startsWith(identity)) throw new Error('This folder contains notes for a different repository.');
            stored.set(name, content);
          }
          const marker = `<!-- review: ${sessionId}/${runId} `;
          const updates = notes.map(note => {
            const path = join(directory, `${note.topic}.md`), current = stored.get(`${note.topic}.md`) ?? '';
            const body = `## ${review.completedAt} | ${runId}\n\nRevision: ${codebase.revision}\nReview: ${reviewPath}\nMap: ${join(root, sessionId, `${runId}.map.jsonl`)}\nSources: ${note.sourceIds.join(', ')}\n\n${note.content}\n`;
            const entry = `${marker}${createHash('sha256').update(body).digest('hex')} -->\n${body}`;
            if (current.includes(marker) && !current.includes(entry)) throw new Error('Different learning was already saved for this run; preserve it.');
            return { topic: note.topic, path, content: current.includes(entry) ? current : `${current || `${identity}# ${note.topic}\n`}\n${entry}`, changed: !current.includes(entry) };
          });
          signal?.throwIfAborted();
          for (const update of updates) {
            if (update.changed) atomicWrite(update.path, update.content);
            if (readFileSync(update.path, 'utf8') !== update.content) throw new Error('Codebase learning readback failed.');
          }
          const paths = Object.fromEntries(updates.map(update => [update.topic, update.path]));
          return { content: [{ type: 'text' as const, text: `Saved codebase learning to ${directory}` }], details: { directory, paths } };
        } finally { closeSync(fd); unlinkSync(lock); }
      });
    },
  });
}
