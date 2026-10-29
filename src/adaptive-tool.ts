import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { digestBytes } from './experiments-contract.ts';
import { canonicalSha256 } from './experiments-oracle.ts';
import { readExecutionReceipts } from './experiments-tool.ts';
import { normalizeMissingFact, selectNextAction, type ActionBudget, type FactQuestion, type MissingFact, type RetrievalAction, type Selection } from './adaptive.ts';

type SourceReference = { kind: 'scan' | 'collect' | 'search' | 'execution'; sha256: string; path?: string };
type Observation = {
  id: string;
  contextId: string;
  question: Omit<FactQuestion, 'contextId'>;
  source: SourceReference;
  actionKey?: string;
};
type Pending = { key: string; contextId: string; sourceSha256: string; action: RetrievalAction };
type State = {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  owner: string;
  contextId: string;
  limits: ActionBudget;
  budget: ActionBudget;
  usedKeys: string[];
  facts: MissingFact[];
  pending: Pending | null;
  events: { id: string; digest: string; disposition: string; contextId: string; source: SourceReference; factId: string }[];
};
export type AvailableFamilies = (ctx: ExtensionContext, sessionId: string, runId: string) => string[];
const maximumBytes = 4_194_304;
const hashSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
const budgetSchema = Type.Object({
  total: Type.Integer({ minimum: 0, maximum: 128 }),
  collect: Type.Integer({ minimum: 0, maximum: 128 }),
  search: Type.Integer({ minimum: 0, maximum: 128 }),
  family: Type.Integer({ minimum: 0, maximum: 128 }),
}, { additionalProperties: false });
const actionSchema = Type.Union([
  Type.Object({ factId: hashSchema, kind: Type.Literal('collect'), target: Type.String() }, { additionalProperties: false }),
  Type.Object({ factId: hashSchema, kind: Type.Literal('search'), query: Type.String(), path: Type.String() }, { additionalProperties: false }),
  Type.Object({ factId: hashSchema, kind: Type.Literal('family'), familyId: Type.String() }, { additionalProperties: false }),
]);
const eventSchema = Type.Object({
  id: Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' }),
  contextId: hashSchema,
  question: Type.Object({
    criterionId: Type.String(),
    scope: Type.String(),
    question: Type.String(),
    material: Type.Boolean(),
  }, { additionalProperties: false }),
  source: Type.Object({
    kind: Type.Union(['scan', 'collect', 'search', 'execution'].map(kind => Type.Literal(kind))),
    sha256: hashSchema,
    path: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  actionKey: Type.Optional(hashSchema),
}, { additionalProperties: false });

function readBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Adaptive input must be a bounded regular file.');
    const bytes = readFileSync(fd);
    if (bytes.length > maximumBytes) throw new Error('Adaptive input exceeded its size limit.');
    return bytes;
  } finally { closeSync(fd); }
}
function saveState(path: string, state: State): void {
  const bytes = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(bytes) > maximumBytes) throw new Error('Adaptive journal exceeded its size limit.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function loadState(path: string, sessionId: string, runId: string): State | undefined {
  if (!existsSync(path)) return undefined;
  const state: State = JSON.parse(readBytes(path).toString('utf8'));
  if (state.schemaVersion !== 1 || state.sessionId !== sessionId || state.runId !== runId || typeof state.owner !== 'string'
    || !Array.isArray(state.events) || state.events.length > 128 || !Array.isArray(state.facts) || state.facts.length > 32) {
    throw new Error('Invalid adaptive journal identity.');
  }
  selectNextAction({ ...state, actions: [], availableFamilies: [] });
  return state;
}
function readSource(root: string, directory: string, sessionId: string, runId: string, source: SourceReference): unknown {
  let path: string;
  if (source.kind === 'execution') {
    if (source.path !== undefined) throw new Error('Execution sources use indexed hashes, not supplied paths.');
    const reference = readExecutionReceipts(root, sessionId, runId).find(item => item.sha256 === source.sha256);
    if (!reference) throw new Error('Execution source is not indexed for this run.');
    path = reference.path;
  } else {
    if (typeof source.path !== 'string' || !source.path.startsWith(`${runId}.`) || /[\\\x00-\x1f]/.test(source.path)
      || source.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Source must be a run-local structured artifact.');
    path = resolve(directory, source.path);
    const actual = relative(realpathSync(directory), realpathSync(path));
    if (!actual.startsWith(`${runId}.`) || actual.split('/').includes('..')) throw new Error('Source escaped the run artifacts.');
  }
  const bytes = readBytes(path);
  if (digestBytes(bytes) !== source.sha256) throw new Error('Adaptive source bytes changed.');
  const value = JSON.parse(bytes.toString('utf8'));
  return source.kind !== 'execution' && value?.details !== undefined ? value.details : value;
}
function observe(state: State, event: Observation, details: unknown, contextId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(event.id) || !/^[a-f0-9]{64}$/.test(event.contextId)
    || (event.actionKey !== undefined && !/^[a-f0-9]{64}$/.test(event.actionKey))) throw new Error('Invalid observation identity.');
  const digest = canonicalSha256(event);
  const prior = state.events.find(item => item.id === event.id);
  if (prior) {
    if (prior.digest !== digest) throw new Error('Conflicting observation event.');
    return 'duplicate';
  }
  if (state.events.length === 128) throw new Error('Adaptive event budget exhausted.');
  const fact = normalizeMissingFact({ ...event.question, contextId: event.contextId }, { ...event.source, details });
  const pending = state.pending;
  const matching = event.actionKey !== undefined && pending?.key === event.actionKey;
  if (matching && pending) {
    const kind = pending.action.kind === 'family' ? 'execution' : pending.action.kind;
    if (fact.id !== pending.action.factId || event.contextId !== pending.contextId || event.source.kind !== kind) {
      throw new Error('Observation does not match the pending question, context and action kind.');
    }
    if (pending.action.kind === 'family' && (!details || typeof details !== 'object'
      || !('profile' in details) || details.profile !== 'experiment-family-v1'
      || !('familyId' in details) || details.familyId !== pending.action.familyId)) {
      throw new Error('Expected the selected family summary.');
    }
  }
  const superseded = matching && state.facts.find(item => item.id === fact.id)?.source.sha256 !== pending?.sourceSha256;
  const disposition = event.contextId !== contextId ? 'stale' : event.actionKey && (!matching || superseded) ? 'late' : 'accepted';
  if (disposition === 'accepted') {
    const index = state.facts.findIndex(item => item.id === fact.id);
    if (index < 0) {
      if (state.facts.length === 32) throw new Error('Adaptive fact budget exhausted.');
      state.facts.push(fact);
    } else state.facts[index] = fact;
  }
  if (matching) state.pending = null;
  state.events.push({ id: event.id, digest, disposition, contextId: event.contextId, source: event.source, factId: fact.id });
  return disposition;
}

export function registerAdaptive(pi: ExtensionAPI, root: string, availableFamilies: AvailableFamilies = () => []): void {
  pi.registerTool({
    name: 'agentic_code_review_next_action', label: 'Reconcile review evidence',
    description: readFileSync(new URL('../prompts/next-action.md', import.meta.url), 'utf8'),
    executionMode: 'sequential',
    parameters: Type.Object({
      sessionId: Type.String({ maxLength: 128 }),
      runId: Type.String(),
      operation: Type.Union(['status', 'observe', 'select'].map(operation => Type.Literal(operation))),
      budget: Type.Optional(budgetSchema),
      event: Type.Optional(eventSchema),
      actions: Type.Optional(Type.Array(actionSchema, { maxItems: 64 })),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const { sessionId, runId } = input;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error('Invalid adaptive review identity.');
      if (Object.keys(input).some(key => !['sessionId', 'runId', 'operation', 'budget', 'event', 'actions'].includes(key))) throw new Error('Unexpected adaptive argument.');
      const directory = join(root, sessionId);
      const path = join(directory, `${runId}.adaptive.json`);
      return withFileMutationQueue(path, async () => {
        signal?.throwIfAborted();
        const review = JSON.parse(readBytes(join(directory, `${runId}.review.json`)).toString('utf8'));
        if (review.runId !== runId || review.sessionId !== sessionId || !['prepared', 'running'].includes(review.status)
          || resolve(ctx.cwd) !== resolve(review.preflight?.checkout ?? review.cwd)) throw new Error('Adaptive work needs this active review checkout.');
        const records: Record<string, unknown>[] = readBytes(join(directory, `${runId}.map.jsonl`)).toString('utf8')
          .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        const criteria = records.filter(record => record.runId === runId && ['requirement', 'criterion'].includes(String(record.kind)));
        const contextId = canonicalSha256({ sessionId, runId, preflight: review.preflight ?? null, evidenceContext: review.evidenceContext ?? null, criteria });
        let state = loadState(path, sessionId, runId);
        if (state && state.owner !== ctx.sessionManager.getSessionId()) throw new Error('Adaptive journal belongs to another coordinator.');
        let disposition: string | undefined;
        let selection: Selection | { kind: 'wait-unknown'; key: string } | undefined;
        if (input.operation !== 'status') {
          if (!state) {
            if (!input.budget) throw new Error('Declare a bounded budget before adaptive work.');
            state = {
              schemaVersion: 1,
              sessionId,
              runId,
              owner: ctx.sessionManager.getSessionId(),
              contextId,
              limits: { ...input.budget },
              budget: { ...input.budget },
              usedKeys: [],
              facts: [],
              pending: null,
              events: [],
            };
          }
          if (input.budget && canonicalSha256(input.budget) !== canonicalSha256(state.limits)) throw new Error('Adaptive budget cannot be refreshed.');
          state.contextId = contextId;
          selectNextAction({ ...state, actions: [], availableFamilies: [] });
          if (input.operation === 'observe') {
            if (!input.event || input.actions !== undefined) throw new Error('Observe requires one coarse event only.');
            if (!criteria.some(record => record.id === input.event?.question.criterionId)) throw new Error('Missing criterion map link.');
            const details = readSource(root, directory, sessionId, runId, input.event.source);
            disposition = observe(state, input.event, details, contextId);
          } else if (input.operation === 'select') {
            if (input.event !== undefined) throw new Error('Selection cannot also supply an observation.');
            if (state.pending) selection = { kind: 'wait-unknown', key: state.pending.key };
            else {
              selection = selectNextAction({ ...state, actions: input.actions ?? [], availableFamilies: availableFamilies(ctx, sessionId, runId) });
              state.budget = selection.budget;
              state.usedKeys = selection.usedKeys;
              if (selection.kind === 'action') {
                const chosen = selection;
                const fact = state.facts.find(item => item.id === chosen.action.factId);
                if (!fact) throw new Error('Selected fact disappeared.');
                state.pending = { key: chosen.key, contextId, sourceSha256: fact.source.sha256, action: chosen.action };
              }
            }
          } else throw new Error('Unknown adaptive operation.');
          signal?.throwIfAborted();
          saveState(path, state);
        } else if (input.event !== undefined || input.actions !== undefined || input.budget !== undefined) throw new Error('Status does not mutate adaptive work.');
        const details = {
          path,
          contextId,
          budget: state?.budget ?? null,
          facts: state?.facts ?? [],
          pending: state?.pending ?? null,
          ...(disposition ? { disposition } : {}),
          ...(selection ? { selection } : {}),
        };
        const compact = { ...details, facts: details.facts.map(({ edges: _edges, ...fact }) => fact) };
        let text = JSON.stringify(compact);
        if (text.length > 16000) {
          text = JSON.stringify({ path, contextId, budget: details.budget, disposition, selection,
            note: 'Read the saved journal for all missing facts.' });
        }
        return { content: [{ type: 'text' as const, text }], details };
      });
    },
  });
}
