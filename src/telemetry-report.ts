type Fields = Record<string, unknown>;
export const object = (value: unknown): Fields =>
  value !== null && typeof value === 'object' ? value as Fields : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const metric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const rounded = (value: number) => Math.round(value * 1e12) / 1e12;
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoning'] as const;
type Tokens = Record<typeof tokenKeys[number], number | null>;
type UsageRecord = {
  provider: string | null;
  model: string | null;
  responseModel: string | null;
  costUsd: number | null;
  tokens: Tokens;
  response: boolean;
  durationMs: number | null;
};
export type RecordedCost = { knownUsd: number; totalUsd: number | null };

function usageRecords(entries: readonly unknown[]): UsageRecord[] {
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  for (const value of entries) {
    const entry = object(value);
    const message = object(entry.message);
    const assistant = entry.type === 'message' && message.role === 'assistant';
    const tool = entry.type === 'message' && message.role === 'toolResult' && message.usage !== undefined;
    const standalone = entry.type === 'usage';
    const summary = entry.type === 'compaction' || entry.type === 'branch_summary';
    if (!assistant && !tool && !standalone && !summary) continue;
    const id = text(entry.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const source = assistant || tool ? message : entry;
    const usage = object(source.usage);
    const observed = assistant || standalone ? source : {};
    records.push({
      provider: text(observed.provider),
      model: text(observed.model),
      responseModel: text(observed.responseModel),
      costUsd: metric(object(usage.cost).total),
      tokens: Object.fromEntries(tokenKeys.map(key => [key, metric(usage[key])])) as Tokens,
      response: assistant,
      durationMs: assistant ? metric(message.durationMs) : null,
    });
  }
  return records;
}

function costTotal(costs: RecordedCost[], available = true): RecordedCost {
  const knownUsd = rounded(costs.reduce((sum, cost) => sum + cost.knownUsd, 0));
  const complete = available && costs.every(cost => cost.totalUsd !== null) && Number.isFinite(knownUsd);
  return { knownUsd: Number.isFinite(knownUsd) ? knownUsd : 0, totalUsd: complete ? knownUsd : null };
}

function tokenTotals(records: { tokens: Tokens }[], available = true): Tokens {
  return Object.fromEntries(tokenKeys.map(key => {
    const values = records.map(record => record.tokens[key]);
    const total = available && values.every(value => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    return [key, total];
  })) as Tokens;
}

function usageTotal(records: UsageRecord[], available = true) {
  return {
    usageRecords: records.length,
    recordedResponses: records.filter(record => record.response).length,
    cost: costTotal(records.map(record => ({ knownUsd: record.costUsd ?? 0, totalUsd: record.costUsd })), available),
    tokens: tokenTotals(records, available),
    recordedResponseTimeMs: available && records.filter(record => record.response).every(record => record.durationMs !== null)
      ? records.reduce((sum, record) => sum + (record.durationMs ?? 0), 0) : null,
  };
}

function modelTotals(records: UsageRecord[]) {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.provider, record.model, record.responseModel]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    provider: group[0].provider,
    model: group[0].model,
    responseModel: group[0].responseModel,
    ...usageTotal(group),
  }));
}

export function receiptIdentity(value: unknown): string | null {
  const receipt = object(value);
  const fields = [receipt.rootSessionId, receipt.teamName, receipt.lifecycleRunId];
  return fields.every(value => text(value) !== null) ? JSON.stringify(fields) : null;
}

export function settledReceipts(values: readonly unknown[]): Fields[] {
  const receipts = new Map<string, Fields>();
  for (const value of values) {
    const receipt = object(value);
    const id = receiptIdentity(receipt);
    if (!id || !['pending', 'final', 'excluded'].includes(String(receipt.phase))) continue;
    if (!receipts.has(id) || receipts.get(id)?.phase === 'pending') receipts.set(id, receipt);
  }
  return [...receipts.values()];
}

export type ReviewTelemetryInput = {
  sessionId: string;
  runId: string;
  coordinatorSessionId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  capturedAt: number;
  entries: readonly unknown[];
  children: readonly unknown[];
  rootAvailable: boolean;
};
const duration = (start: number | null, end: number | null) =>
  start !== null && end !== null ? Math.max(0, end - start) : null;

type AgentTelemetry = ReturnType<typeof usageTotal> & {
  id: string;
  sessionId: string | null;
  name: string;
  role: string;
  lifecycleRunId: string | null;
  parentLifecycleRunId: string | null;
  modelSlot: string | null;
  phase: string;
  outcome: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  models: ReturnType<typeof modelTotals>;
};

export function buildReviewTelemetry(input: ReviewTelemetryInput) {
  const rootRecords = usageRecords(input.entries);
  const rootTotal = usageTotal(rootRecords, input.rootAvailable && input.completedAt !== null);
  const agents: AgentTelemetry[] = [{
    id: `coordinator:${input.coordinatorSessionId ?? 'unknown'}`,
    sessionId: input.coordinatorSessionId,
    name: 'coordinator',
    role: 'coordinator',
    lifecycleRunId: null,
    parentLifecycleRunId: null,
    modelSlot: null,
    phase: input.completedAt === null ? 'pending' : 'final',
    outcome: null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: duration(input.startedAt, input.completedAt),
    ...rootTotal, models: modelTotals(rootRecords),
  }];
  const allRecords = [...rootRecords];
  const gaps = new Set<string>();
  if (!input.rootAvailable) gaps.add('coordinator-usage-unavailable');
  const sessions = new Set([input.coordinatorSessionId]);
  let modelsComplete = input.rootAvailable;
  let unattributedLegacyCost = 0;
  for (const receipt of settledReceipts(input.children)) {
    const childSessionId = text(receipt.childSessionId);
    if (childSessionId && sessions.has(childSessionId)) continue;
    if (childSessionId) sessions.add(childSessionId);
    const telemetry = object(receipt.telemetry);
    const available = telemetry.schemaVersion === 1 && Array.isArray(telemetry.entries);
    const records = available ? usageRecords(telemetry.entries as unknown[]) : [];
    const total = usageTotal(records, available && receipt.phase === 'final');
    if (receipt.phase === 'excluded') gaps.add('excluded-agent-usage');
    if (!available) {
      modelsComplete = false;
      if (receipt.phase === 'final') {
        gaps.add('legacy-child-usage');
        total.cost = { knownUsd: metric(receipt.costUsd) ?? 0, totalUsd: metric(receipt.costUsd) };
        unattributedLegacyCost += total.cost.knownUsd;
      }
    }
    allRecords.push(...records);
    const startedAt = metric(telemetry.startedAt);
    const completedAt = metric(telemetry.completedAt);
    agents.push({
      id: receiptIdentity(receipt)!,
      sessionId: childSessionId,
      name: text(telemetry.agentName) ?? String(receipt.lifecycleRunId),
      role: text(telemetry.role) ?? 'unknown',
      lifecycleRunId: text(receipt.lifecycleRunId),
      parentLifecycleRunId: text(telemetry.parentLifecycleRunId),
      modelSlot: text(telemetry.modelSlot),
      phase: String(receipt.phase),
      outcome: text(receipt.outcome),
      startedAt,
      completedAt,
      durationMs: duration(startedAt, completedAt),
      ...total,
      models: modelTotals(records),
    });
  }
  const spawned = new Map<string, Record<string, unknown>>();
  for (const entry of input.entries) {
    const message = object(object(entry).message);
    if (message.role !== 'toolResult' || !['spawn_agent', 'spawn_swarm_agents'].includes(String(message.toolName))) continue;
    const details = object(message.details);
    const results = Array.isArray(details.spawned) ? details.spawned : [details];
    for (const result of results) {
      const detail = object(result);
      if (text(detail.agentId)) spawned.set(String(detail.agentId), detail);
    }
  }
  // Pending native receipts lack names. Their final receipt resolves attribution without adding their cost twice.
  if (!agents.some(agent => agent.lifecycleRunId && agent.phase === 'pending')) {
    for (const [id, detail] of spawned) {
      const name = id.split('@')[0];
      if (agents.some(agent => agent.name === name)) continue;
      gaps.add('unmeasured-spawned-agent');
      modelsComplete = false;
      agents.push({
        id: `unmeasured:${id}`,
        sessionId: null,
        name,
        role: text(detail.role) ?? 'unknown',
        lifecycleRunId: null,
        parentLifecycleRunId: null,
        modelSlot: text(detail.modelSlot),
        phase: 'unavailable',
        outcome: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        ...usageTotal([], false),
        models: [],
      });
    }
  }
  if (agents.some(agent => agent.phase === 'pending')) gaps.add('unsettled-agents');
  if (agents.some(agent => agent.cost.totalUsd === null)) gaps.add('recorded-cost-incomplete');
  const unattributedRecords = allRecords.filter(record => !record.provider || !record.model);
  if (unattributedRecords.length) modelsComplete = false;
  if (!modelsComplete) gaps.add('model-attribution-incomplete');
  const total = usageTotal(allRecords);
  const unattributed = usageTotal(unattributedRecords);
  unattributed.cost.knownUsd = rounded(unattributed.cost.knownUsd + unattributedLegacyCost);
  if (unattributed.cost.totalUsd !== null) unattributed.cost.totalUsd = unattributed.cost.knownUsd;
  total.tokens = tokenTotals(agents);
  if (agents.some(agent => agent.recordedResponseTimeMs === null)) total.recordedResponseTimeMs = null;
  return {
    schemaVersion: 1 as const,
    sessionId: input.sessionId,
    runId: input.runId,
    coordinatorSessionId: input.coordinatorSessionId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    capturedAt: input.capturedAt,
    durationMs: duration(input.startedAt, input.completedAt),
    settled: input.completedAt !== null && agents.every(agent => agent.phase !== 'pending'),
    ...total,
    cost: { ...costTotal(agents.map(agent => agent.cost)), source: 'pi-recorded-estimate' as const, billedUsd: null },
    agents,
    models: modelTotals(allRecords.filter(record => record.provider && record.model)),
    unattributed,
    coverage: { modelsComplete, allProviderCalls: 'unknown' as const, gaps: [...gaps] },
  };
}
export type ReviewTelemetry = ReturnType<typeof buildReviewTelemetry>;

export function summarizeReviewTelemetry(reports: readonly ReviewTelemetry[]) {
  const reviews = new Map<string, ReviewTelemetry>();
  for (const report of reports) {
    const key = JSON.stringify([report.sessionId, report.runId]);
    const previous = reviews.get(key);
    if (!previous || previous.capturedAt <= report.capturedAt) reviews.set(key, report);
  }
  const values = [...reviews.values()];
  const known = values.filter(report => report.cost.totalUsd !== null);
  const durations = values.filter(report => report.durationMs !== null);
  const cost = costTotal(values.map(report => report.cost));
  return {
    reviewCount: values.length,
    cost,
    averageCostPerReviewUsd: values.length && known.length === values.length ? rounded(cost.knownUsd / values.length) : null,
    averageKnownReviewCostUsd: known.length ? rounded(known.reduce((sum, report) => sum + report.cost.knownUsd, 0) / known.length) : null,
    costSampleCount: known.length,
    incompleteCostReviews: values.length - known.length,
    averageDurationMs: durations.length ? durations.reduce((sum, report) => sum + report.durationMs!, 0) / durations.length : null,
    durationSampleCount: durations.length,
  };
}
