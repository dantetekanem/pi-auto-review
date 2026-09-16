import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { lstatSync, readFileSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { completionFileName } from './runtime.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARTIFACT_BYTES = 200_000;
const PROBE_CHANNEL = 'agentic-code-review:wait-probe';

type ArtifactPaths = { directory: string; review: string; bugs: string; map: string; complete: string };
type WaitingStatus = 'waiting' | 'delivered' | 'ended';
type Subscription = {
  key: string;
  sessionFile: string;
  reviewSessionId: string;
  runId: string;
  deadline: number;
  expectedTarget: string;
  expectedHead: string;
  paths: ArtifactPaths;
  status: WaitingStatus;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
};

type PreparedReview = {
  schemaVersion: unknown;
  sessionId: unknown;
  runId: unknown;
  status: string;
  completedAt?: unknown;
  preflight?: { target?: unknown; head?: unknown };
};

type CompleteMarker = {
  sessionId?: unknown;
  runId?: unknown;
  status?: unknown;
  completedAt?: unknown;
  summary?: unknown;
};

function artifactPaths(root: string, sessionId: string, runId: string): ArtifactPaths {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid review session ID.');
  if (!RUN_ID.test(runId)) throw new Error('Invalid review run ID.');
  const resolvedRoot = resolve(root);
  const directory = resolve(resolvedRoot, sessionId);
  if (!directory.startsWith(`${resolvedRoot}/`)) throw new Error('Review artifact path escapes the configured root.');
  return {
    directory,
    review: join(directory, `${runId}.review.json`),
    bugs: join(directory, `${runId}.bugs.json`),
    map: join(directory, `${runId}.map.jsonl`),
    complete: join(directory, completionFileName(runId)),
  };
}

function requireDirectory(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error('The review artifact directory is not readable.');
  }
  if (!stat.isDirectory()) throw new Error('The review artifact directory is not a regular directory.');
}

function readJson(path: string): unknown {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error('The review artifact is not readable.');
  }
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES)
    throw new Error('The review artifact is not a bounded regular file.');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('The review artifact contains malformed JSON.');
  }
}

function completionMarker(path: string): CompleteMarker | undefined {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('The completion marker is not readable.');
  }
  const marker = readJson(path);
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error('The completion marker must be a JSON object.');
  }
  return marker as CompleteMarker;
}

function preparedReview(
  paths: ArtifactPaths,
  sessionId: string,
  runId: string,
  target: string,
  head: string,
): PreparedReview {
  requireDirectory(paths.directory);
  const review = readJson(paths.review);
  if (!review || typeof review !== 'object' || Array.isArray(review))
    throw new Error('The review artifact has an invalid schema.');
  const value = review as PreparedReview;
  if (value.schemaVersion !== 1 || value.sessionId !== sessionId || value.runId !== runId)
    throw new Error('The review artifact identity or schema version does not match.');
  if (!value.preflight || value.preflight.target !== target)
    throw new Error('The review target does not match this subscription.');
  if (value.preflight.head !== head) throw new Error('The review head does not match this subscription.');
  // Current reviews stay prepared until complete; findings also accepts legacy running.
  if (
    typeof value.status !== 'string' ||
    !['prepared', 'running', 'complete', 'failed', 'cancelled', 'aborted', 'incomplete'].includes(value.status)
  ) {
    throw new Error('The review artifact has an invalid status.');
  }
  return value;
}

function close(subscription: Subscription): void {
  subscription.watcher?.close();
  subscription.watcher = undefined;
  if (subscription.timer) clearTimeout(subscription.timer);
  subscription.timer = undefined;
}

function handoffPrompt(name: 'ended' | 'complete', values: Record<string, string>): string {
  return readFileSync(new URL(`../prompts/review-subscription-${name}.md`, import.meta.url), 'utf8').replace(
    /\{\{(\w+)\}\}/g,
    (_match, key: string) => values[key] ?? '',
  );
}

function notice(pi: ExtensionAPI, subscription: Subscription, text: string): void {
  pi.sendMessage(
    {
      customType: 'agentic-code-review-subscription',
      content: text,
      details: {
        runId: subscription.runId,
        reviewSessionId: subscription.reviewSessionId,
        paths: subscription.paths,
        deadline: subscription.deadline,
      },
      display: true,
    },
    { triggerTurn: true, deliverAs: 'followUp' },
  );
}

function terminal(pi: ExtensionAPI, subscription: Subscription, reason: string): void {
  if (subscription.status !== 'waiting') return;
  subscription.status = 'ended';
  close(subscription);
  notice(pi, subscription, handoffPrompt('ended', { runId: subscription.runId, reason }));
}

function deliver(pi: ExtensionAPI, subscription: Subscription, marker: CompleteMarker): void {
  if (subscription.status !== 'waiting') return;
  subscription.status = 'delivered';
  close(subscription);
  const summary = typeof marker.summary === 'string' ? marker.summary.slice(0, 5000) : '';
  notice(pi, subscription, handoffPrompt('complete', { runId: subscription.runId, ...subscription.paths, summary }));
}

function reconcile(pi: ExtensionAPI, subscription: Subscription, expectedTarget: string, expectedHead: string): void {
  if (subscription.status !== 'waiting') return;
  if (!Number.isFinite(subscription.deadline) || Date.now() >= subscription.deadline) {
    terminal(pi, subscription, 'the subscription timed out before a completed marker arrived');
    return;
  }
  let review: PreparedReview;
  try {
    review = preparedReview(
      subscription.paths,
      subscription.reviewSessionId,
      subscription.runId,
      expectedTarget,
      expectedHead,
    );
  } catch (error) {
    terminal(pi, subscription, error instanceof Error ? error.message : 'the review artifact could not be revalidated');
    return;
  }
  if (review.status !== 'complete') {
    if (['failed', 'cancelled', 'aborted', 'incomplete'].includes(review.status))
      terminal(pi, subscription, `the review reported terminal status ${review.status}`);
    return;
  }
  if (typeof review.completedAt !== 'string') {
    terminal(pi, subscription, 'the completed review is missing its completedAt timestamp');
    return;
  }
  let marker: CompleteMarker | undefined;
  try {
    marker = completionMarker(subscription.paths.complete);
  } catch (error) {
    terminal(pi, subscription, error instanceof Error ? error.message : 'the completion marker could not be read');
    return;
  }
  if (!marker) return;
  if (
    marker.sessionId !== subscription.reviewSessionId ||
    marker.runId !== subscription.runId ||
    marker.status !== 'complete' ||
    marker.completedAt !== review.completedAt
  ) {
    terminal(pi, subscription, 'the completion marker does not match the completed review identity');
    return;
  }
  deliver(pi, subscription, marker);
}

function probeReply(subscription: Subscription): {
  version: 1;
  runId: string;
  sessionFile: string;
  status: WaitingStatus;
  deadline: number;
  reason?: string;
} {
  return {
    version: 1,
    runId: subscription.runId,
    sessionFile: subscription.sessionFile,
    status: subscription.status,
    deadline: subscription.deadline,
    ...(subscription.status === 'ended' ? { reason: 'The subscribed review ended without a completed handoff.' } : {}),
  };
}

export function registerReviewSubscription(
  pi: ExtensionAPI,
  root: string,
  description = readFileSync(new URL('../prompts/review-subscribe.md', import.meta.url), 'utf8'),
): void {
  const subscriptions = new Map<string, Subscription>();
  const clearAll = () => {
    for (const subscription of subscriptions.values()) close(subscription);
    subscriptions.clear();
  };
  const unsubscribe =
    pi.events?.on(PROBE_CHANNEL, (request) => {
      if (!request || typeof request !== 'object') return;
      const value = request as { version?: unknown; sessionFile?: unknown; runId?: unknown; reply?: unknown };
      if (
        value.version !== 1 ||
        typeof value.sessionFile !== 'string' ||
        typeof value.runId !== 'string' ||
        typeof value.reply !== 'function'
      )
        return;
      const subscription = subscriptions.get(`${value.sessionFile}\0${value.runId}`);
      if (!subscription) return;
      reconcile(pi, subscription, subscription.expectedTarget, subscription.expectedHead);
      value.reply(probeReply(subscription));
    }) ?? (() => undefined);
  pi.on('session_start', clearAll);
  pi.on('session_tree', clearAll);
  pi.on('session_shutdown', () => {
    clearAll();
    unsubscribe();
  });

  pi.registerTool({
    name: 'agentic_code_review_subscribe',
    label: 'Subscribe to external review',
    description,
    parameters: Type.Object({
      reviewSessionId: Type.String({ maxLength: 128 }),
      runId: Type.String(),
      expectedTarget: Type.String({ minLength: 1, maxLength: 4000 }),
      expectedHead: Type.String({ minLength: 1, maxLength: 256 }),
      timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    }),
    async execute(_id, input, signal, _onUpdate, ctx: ExtensionContext) {
      signal?.throwIfAborted();
      const { reviewSessionId, runId, expectedTarget, expectedHead, timeoutMinutes = 30 } = input;
      if (!SESSION_ID.test(reviewSessionId)) throw new Error('Invalid review session ID.');
      if (!RUN_ID.test(runId)) throw new Error('Invalid review run ID.');
      if (typeof expectedTarget !== 'string' || !expectedTarget || typeof expectedHead !== 'string' || !expectedHead)
        throw new Error('Expected target and head are required.');
      const callerId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || typeof sessionFile !== 'string')
        throw new Error('The calling Pi session has no persisted session file.');
      if (reviewSessionId === callerId)
        throw new Error('A review in this same Pi session already has its native completion watcher.');
      const paths = artifactPaths(root, reviewSessionId, runId);
      const key = `${sessionFile}\0${runId}`;
      if (subscriptions.has(key)) throw new Error('This review run is already registered for the calling session.');
      const review = preparedReview(paths, reviewSessionId, runId, expectedTarget, expectedHead);
      if (review.status === 'complete') throw new Error('This review is already complete and cannot be subscribed.');
      if (['failed', 'cancelled', 'aborted', 'incomplete'].includes(review.status))
        throw new Error(`This review already has terminal status ${review.status}.`);
      const deadline = Date.now() + timeoutMinutes * 60_000;
      const subscription: Subscription = {
        key,
        sessionFile,
        reviewSessionId,
        runId,
        deadline,
        expectedTarget,
        expectedHead,
        paths,
        status: 'waiting',
      };
      subscriptions.set(key, subscription);
      try {
        subscription.watcher = watch(paths.directory, () => reconcile(pi, subscription, expectedTarget, expectedHead));
        subscription.watcher.on('error', () => terminal(pi, subscription, 'the artifact watcher failed'));
        subscription.timer = setTimeout(
          () => terminal(pi, subscription, 'the subscription timed out before a completed marker arrived'),
          timeoutMinutes * 60_000,
        );
        reconcile(pi, subscription, expectedTarget, expectedHead);
      } catch (error) {
        terminal(pi, subscription, error instanceof Error ? error.message : 'the artifact watcher could not start');
        throw new Error('The review subscription watcher could not start.');
      }
      if (subscription.status !== 'waiting')
        throw new Error('The review completed or became invalid while the subscription was enrolling.');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Waiting up to ${timeoutMinutes} minutes for external review ${runId}. This subscription validates artifact identity, not review relevance or launch ownership.`,
          },
        ],
        details: { runId, reviewSessionId, paths, deadline },
      };
    },
  });
}
