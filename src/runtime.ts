import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
export type ReviewIntake = {
  body: string;
  threads: string;
  data: Record<string, unknown>;
  checks: Record<string, unknown> | unknown[] | null;
  diff: string;
  gaps: string[];
};

export type ReviewPreflight = {
  target: string;
  provider: 'github' | 'meteorite' | 'local';
  number: number | null;
  title: string | null;
  base: string;
  head: string;
  checkout: string;
  model: string;
  thinking: 'medium';
  elapsedMs: number;
  intake?: ReviewIntake;
};

type ExecResult = { code: number; stdout: string; stderr: string };

async function checked(pi: ExtensionAPI, command: string, args: string[], timeout = 20_000): Promise<ExecResult> {
  const result = await pi.exec(command, args, { timeout });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${String(result.stderr || result.stdout).trim().slice(0, 1000)}`);
  }
  return result;
}

async function capture(pi: ExtensionAPI, command: string, args: string[], allowedCodes = [0]): Promise<ExecResult> {
  try {
    const result = await pi.exec(command, args, { timeout: 30_000 });
    if (!allowedCodes.includes(result.code)) return { ...result, stderr: result.stderr || `${command} exited ${result.code}` };
    return result;
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function optionalJson(result: ExecResult): Record<string, unknown> | unknown[] | null {
  if (result.code !== 0 && result.code !== 8) return null;
  try {
    const value: unknown = JSON.parse(result.stdout);
    return value && typeof value === 'object' ? value as Record<string, unknown> | unknown[] : null;
  } catch {
    return null;
  }
}

function parseJson(result: ExecResult, command: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // The error below includes the command, not provider output that may contain private text.
  }
  throw new Error(`${command} returned invalid JSON.`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Preflight could not resolve ${label}.`);
  return value;
}

async function ensureCommit(pi: ExtensionAPI, checkout: string, commit: string, fetchRef?: string): Promise<void> {
  const probe = await capture(pi, 'git', ['-C', checkout, 'cat-file', '-e', `${commit}^{commit}`]);
  if (probe.code === 0) return;
  if (!fetchRef) throw new Error(`The reviewed commit ${commit} is missing from ${checkout}, and preflight has no ref to fetch.`);
  await checked(pi, 'git', ['-C', checkout, 'fetch', '--no-tags', 'origin', fetchRef], 60_000);
  await checked(pi, 'git', ['-C', checkout, 'cat-file', '-e', `${commit}^{commit}`]);
}

function supportsMedium(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }): boolean {
  return Boolean(model.reasoning) && model.thinkingLevelMap?.medium !== null;
}

async function modelFor(ctx: ExtensionContext): Promise<{ spec: string; thinking: 'medium' }> {
  if (ctx.model && supportsMedium(ctx.model)) return { spec: `${ctx.model.provider}/${ctx.model.id}`, thinking: 'medium' };
  const scoped = (ctx.scopedModels ?? []).map(item => item.model).filter(supportsMedium);
  type ReviewModel = { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> };
  const registry = ctx.modelRegistry as unknown as { getAvailable?: () => ReviewModel[] | Promise<ReviewModel[]>; find?: (provider: string, id: string) => ReviewModel | undefined } | undefined;
  const available = registry?.getAvailable ? (await registry.getAvailable()).filter(supportsMedium) : [];
  const candidates = [...scoped, ...available].filter((model, index, all) => all.findIndex(item => item.provider === model.provider && item.id === model.id) === index);
  if (!candidates.length && ctx.hasUI && registry?.find) {
    const spec = await ctx.ui.input('Medium model for auto-review', 'provider/model');
    if (spec) {
      const slash = spec.indexOf('/');
      const selected = slash > 0 ? registry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
      if (selected && supportsMedium(selected)) candidates.push(selected);
      else ctx.ui.notify(`${spec} is unavailable or does not support medium. Choose another model to resume the review.`, 'warning');
    }
  }
  if (!candidates.length) throw new Error('Auto-review is waiting for a medium-capable model selection; no review failed or was created.');
  let model = candidates[0]!;
  if (ctx.hasUI && candidates.length > 1) {
    const specs = candidates.map(item => `${item.provider}/${item.id}`);
    const selected = await ctx.ui.select('Choose the medium auto-review model', specs);
    if (selected) model = candidates[specs.indexOf(selected)] ?? model;
  }
  return { spec: `${model.provider}/${model.id}`, thinking: 'medium' };
}

function repositoryKey(value: string): string {
  let key = value.trim();
  try {
    key = new URL(key).pathname;
  } catch {
    key = key.replace(/^git@[^:]+:/, '').replace(/^[^/]+\.[^/]+\//, '');
  }
  return key.replace(/^\/(?:repos\/)?/, '').replace(/\.git$/, '').toLowerCase();
}

function priorCheckout(historyRoot: string, repository: string): string | undefined {
  if (!existsSync(historyRoot)) return undefined;
  const wanted = repositoryKey(repository);
  const candidates: Array<{ root: string; time: number }> = [];
  for (const directory of readdirSync(historyRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.name === 'codebases') continue;
    const session = `${historyRoot}/${directory.name}`;
    for (const name of readdirSync(session).filter(item => item.endsWith('.review.json'))) {
      const path = `${session}/${name}`;
      try {
        const review = JSON.parse(readFileSync(path, 'utf8')) as { codebases?: Array<{ repository?: unknown; root?: unknown }> };
        const codebase = review.codebases?.find(item => typeof item.repository === 'string' && repositoryKey(item.repository) === wanted && typeof item.root === 'string' && existsSync(item.root));
        if (codebase && typeof codebase.root === 'string') candidates.push({ root: codebase.root, time: statSync(path).mtimeMs });
      } catch {
        // Ignore incomplete or concurrently written historical artifacts.
      }
    }
  }
  return candidates.sort((left, right) => right.time - left.time)[0]?.root;
}

export async function preflightReview(pi: ExtensionAPI, ctx: ExtensionContext, context: string, historyRoot: string, requestedCheckout?: string): Promise<ReviewPreflight> {
  const started = Date.now();
  const selected = await modelFor(ctx);
  const meteorite = context.match(/https?:\/\/(?:meteorite|gitstream)\.shopify\.io\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/i);
  if (meteorite) {
    const number = Number(meteorite[3]);
    const checkout = requestedCheckout ?? priorCheckout(historyRoot, `${meteorite[1]}/${meteorite[2]}`) ?? ctx.cwd;
    const viewResult = await capture(pi, 'gs', ['pr', 'view', String(number), '--json']);
    const parsed = optionalJson(viewResult);
    if (!parsed || Array.isArray(parsed)) {
      const diffResult = await capture(pi, 'gs', ['pr', 'diff', String(number)]);
      return {
        target: meteorite[0], provider: 'meteorite', number, title: null, base: 'unresolved', head: 'unresolved', checkout,
        model: selected.spec, thinking: selected.thinking, elapsedMs: Date.now() - started,
        intake: { body: '', threads: '', data: {}, checks: null, diff: diffResult.code === 0 ? diffResult.stdout : '', gaps: [`PR metadata: ${viewResult.stderr.slice(0, 300)}`, ...(diffResult.code === 0 ? [] : [`PR diff: ${diffResult.stderr.slice(0, 300)}`])] },
      };
    }
    const data = parsed;
    const [threadsResult, checksResult] = await Promise.all([
      capture(pi, 'gs', ['pr', 'view', String(number), '--comments']),
      capture(pi, 'gs', ['pr', 'checks', String(number), '--json'], [0, 8]),
    ]);
    const base = requireString(data.baseSha, 'PR base SHA');
    const head = requireString(data.headSha, 'PR head SHA');
    const commitGaps: string[] = [];
    try { await ensureCommit(pi, checkout, base, typeof data.baseRef === 'string' ? data.baseRef : undefined); } catch (error) { commitGaps.push(`base commit: ${error instanceof Error ? error.message : String(error)}`); }
    try { await ensureCommit(pi, checkout, head, typeof data.headRef === 'string' ? data.headRef : undefined); } catch (error) { commitGaps.push(`head commit: ${error instanceof Error ? error.message : String(error)}`); }
    const diffResult = commitGaps.length ? await capture(pi, 'gs', ['pr', 'diff', String(number)]) : { code: 0, stdout: '', stderr: '' };
    const gaps = [
      threadsResult.code === 0 ? null : `review comments: ${threadsResult.stderr.slice(0, 300)}`,
      optionalJson(checksResult) ? null : `CI checks: ${checksResult.stderr.slice(0, 300)}`,
      ...commitGaps,
      commitGaps.length && diffResult.code !== 0 ? `PR diff: ${diffResult.stderr.slice(0, 300)}` : null,
    ].filter((item): item is string => Boolean(item));
    return {
      target: requireString(data.htmlUrl ?? data.url, 'Meteorite URL'),
      provider: 'meteorite',
      number,
      title: typeof data.title === 'string' ? data.title : null,
      base,
      head,
      checkout,
      model: selected.spec,
      thinking: selected.thinking,
      elapsedMs: Date.now() - started,
      intake: {
        body: typeof data.body === 'string' ? data.body : '',
        threads: threadsResult.code === 0 ? threadsResult.stdout : '',
        data,
        checks: optionalJson(checksResult),
        diff: diffResult.stdout,
        gaps,
      },
    };
  }

  const github = context.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (github) {
    const number = Number(github[3]);
    const checkout = requestedCheckout ?? priorCheckout(historyRoot, `${github[1]}/${github[2]}`) ?? ctx.cwd;
    const viewResult = await capture(pi, 'gh', [
      'pr', 'view', context.match(/https?:\/\/github\.com\/[^\s]+/)?.[0] ?? String(number),
      '--json', 'number,title,body,state,isDraft,author,labels,baseRefName,headRefName,baseRefOid,headRefOid,url,closingIssuesReferences,reviews,comments,latestReviews',
    ]);
    const parsed = optionalJson(viewResult);
    if (!parsed || Array.isArray(parsed)) {
      const diffResult = await capture(pi, 'gh', ['pr', 'diff', github[0]]);
      return {
        target: github[0], provider: 'github', number, title: null, base: 'unresolved', head: 'unresolved', checkout,
        model: selected.spec, thinking: selected.thinking, elapsedMs: Date.now() - started,
        intake: { body: '', threads: '', data: {}, checks: null, diff: diffResult.code === 0 ? diffResult.stdout : '', gaps: [`PR metadata: ${viewResult.stderr.slice(0, 300)}`, ...(diffResult.code === 0 ? [] : [`PR diff: ${diffResult.stderr.slice(0, 300)}`])] },
      };
    }
    const data = parsed;
    const threadQuery = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body createdAt url}}}}}}}';
    const [threadsResult, checksResult] = await Promise.all([
      capture(pi, 'gh', ['api', 'graphql', '-F', `o=${github[1]}`, '-F', `r=${github[2]}`, '-F', `n=${number}`, '-f', `query=${threadQuery}`]),
      capture(pi, 'gh', ['pr', 'checks', String(number), '--repo', `${github[1]}/${github[2]}`, '--json', 'name,state,bucket,link,workflow']),
    ]);
    const base = requireString(data.baseRefOid, 'PR base SHA');
    const head = requireString(data.headRefOid, 'PR head SHA');
    const commitGaps: string[] = [];
    try { await ensureCommit(pi, checkout, base, typeof data.baseRefName === 'string' ? data.baseRefName : undefined); } catch (error) { commitGaps.push(`base commit: ${error instanceof Error ? error.message : String(error)}`); }
    try { await ensureCommit(pi, checkout, head, `pull/${number}/head`); } catch (error) { commitGaps.push(`head commit: ${error instanceof Error ? error.message : String(error)}`); }
    const diffResult = commitGaps.length ? await capture(pi, 'gh', ['pr', 'diff', github[0]]) : { code: 0, stdout: '', stderr: '' };
    const gaps = [
      optionalJson(threadsResult) ? null : `review threads: ${threadsResult.stderr.slice(0, 300)}`,
      optionalJson(checksResult) ? null : `CI checks: ${checksResult.stderr.slice(0, 300)}`,
      ...commitGaps,
      commitGaps.length && diffResult.code !== 0 ? `PR diff: ${diffResult.stderr.slice(0, 300)}` : null,
    ].filter((item): item is string => Boolean(item));
    return {
      target: requireString(data.url, 'GitHub URL'),
      provider: 'github',
      number,
      title: typeof data.title === 'string' ? data.title : null,
      base,
      head,
      checkout,
      model: selected.spec,
      thinking: selected.thinking,
      elapsedMs: Date.now() - started,
      intake: {
        body: typeof data.body === 'string' ? data.body : '',
        threads: threadsResult.code === 0 ? threadsResult.stdout : '',
        data,
        checks: optionalJson(checksResult),
        diff: diffResult.stdout,
        gaps,
      },
    };
  }

  const checkout = requestedCheckout ?? ctx.cwd;
  const headResult = await capture(pi, 'git', ['-C', checkout, 'rev-parse', 'HEAD']);
  const diffResult = await capture(pi, 'git', ['-C', checkout, 'diff', '--no-color', '--no-ext-diff', 'HEAD']);
  const head = headResult.code === 0 && headResult.stdout.trim() ? headResult.stdout.trim() : 'unresolved';
  return {
    target: context.trim() || 'local working tree',
    provider: 'local',
    number: null,
    title: null,
    base: head === 'unresolved' ? 'unresolved' : 'HEAD',
    head,
    checkout,
    model: selected.spec,
    thinking: selected.thinking,
    elapsedMs: Date.now() - started,
    intake: head === 'unresolved' ? {
      body: context,
      threads: '',
      data: {},
      checks: null,
      diff: diffResult.code === 0 ? diffResult.stdout : '',
      gaps: [`local checkout: ${headResult.stderr.slice(0, 300)}`],
    } : undefined,
  };
}

function direction(layout: Record<string, unknown>, paneId: string): 'right' | 'down' {
  const result = layout.result as Record<string, unknown> | undefined;
  const value = result?.layout as Record<string, unknown> | undefined;
  const panes = Array.isArray(value?.panes) ? value.panes : [];
  const pane = panes.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).pane_id === paneId) as Record<string, unknown> | undefined;
  const rect = pane?.rect as Record<string, unknown> | undefined;
  return Number(rect?.width ?? 0) >= 150 ? 'right' : 'down';
}

function parsePane(stdout: string): string {
  const data: unknown = JSON.parse(stdout);
  const pane = (data as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
  return requireString(pane, 'new Herdr pane ID');
}

export const missionPrompt = (missionPath: string) => `Read the complete auto-review mission at ${missionPath} and execute it now.`;

const REVIEW_TOOLS = [
  'read', 'bash', 'edit', 'write',
  'agentic_code_review_append_finding', 'agentic_code_review_read_learning', 'agentic_code_review_save_learning', 'agentic_code_review_complete',
  'sparsity_scan', 'sparsity_collect',
  'spawn_swarm_agents', 'get_agent_status', 'check_teammate', 'stop_teammate', 'read_inbox',
  'ask_user', 'ask_user_batch',
].join(',');

export async function launchReviewPane(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: { name: string; missionPath: string; preflight: ReviewPreflight },
): Promise<{ name: string; paneId: string; model: string; thinking: 'medium' }> {
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID) {
    throw new Error('Auto-review needs a Herdr-managed Pi pane. Run it from Herdr; no delegated coordinator was started.');
  }
  const paneId = process.env.HERDR_PANE_ID;
  const layoutResult = await checked(pi, 'herdr', ['pane', 'layout', '--pane', paneId]);
  const layout = parseJson(layoutResult, 'herdr pane layout');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const name = attempt === 0 ? input.name : `${input.name}-recovery`;
    const split = await checked(pi, 'herdr', [
      'pane', 'split', '--pane', paneId, '--direction', direction(layout, paneId), '--ratio', '0.5', '--cwd', input.preflight.checkout, '--no-focus',
    ]);
    const childPane = parsePane(split.stdout);
    let started = false;
    try {
      await checked(pi, 'herdr', [
        'agent', 'start', name, '--kind', 'pi', '--pane', childPane, '--timeout', '300000', '--',
        '--model', input.preflight.model,
        '--thinking', input.preflight.thinking,
        '--name', name,
        '--no-skills', '--no-prompt-templates', '--no-context-files',
        '--tools', REVIEW_TOOLS,
      ], 310_000);
      started = true;
      const prompt = missionPrompt(input.missionPath);
      let prompted = await capture(pi, 'herdr', ['agent', 'prompt', name, prompt]);
      if (prompted.code !== 0) prompted = await capture(pi, 'herdr', ['agent', 'prompt', name, prompt]);
      if (prompted.code !== 0) throw new Error(prompted.stderr || 'Review session did not accept its mission.');
      return { name, paneId: childPane, model: input.preflight.model, thinking: input.preflight.thinking };
    } catch (error) {
      lastError = error;
      await pi.exec('herdr', ['pane', 'close', childPane], { timeout: 10_000 }).catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runHeadlessReview(
  pi: ExtensionAPI,
  input: { name: string; missionPath: string; preflight: ReviewPreflight },
): Promise<{ name: string; paneId: 'headless'; model: string; thinking: 'medium' }> {
  const args = [
    '--mode', 'json', '-p', '--no-session', '--no-approve',
    '--model', input.preflight.model, '--thinking', input.preflight.thinking,
    '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--tools', REVIEW_TOOLS,
    missionPrompt(input.missionPath),
  ];
  let error = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await pi.exec('pi', args, {}).catch(cause => ({ code: 1, stdout: '', stderr: cause instanceof Error ? cause.message : String(cause) }));
    if (result.code === 0) return { name: input.name, paneId: 'headless', model: input.preflight.model, thinking: input.preflight.thinking };
    error = result.stderr || result.stdout;
  }
  throw new Error(`The visible and headless review sessions could not start: ${error.slice(0, 1000)}`);
}

export function formatPreflight(preflight: ReviewPreflight, artifact: string): string {
  return [
    `Target: ${preflight.title ? `${preflight.title} — ` : ''}${preflight.target}`,
    `Provider: ${preflight.provider}${preflight.number ? ` PR ${preflight.number}` : ''}`,
    `Range: ${preflight.base.slice(0, 12)}...${preflight.head.slice(0, 12)}`,
    `Model: ${preflight.model}`,
    `Thinking: ${preflight.thinking}`,
    `Preflight: ${(preflight.elapsedMs / 1000).toFixed(1)}s`,
    `Artifacts: ${artifact}`,
  ].join('\n');
}

export function completionFileName(runId: string): string {
  return `${runId}.complete.json`;
}

