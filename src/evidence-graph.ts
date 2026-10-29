import { canonicalJson, canonicalSha256 } from './experiments-oracle.ts';

export type IdentityKind = 'source' | 'config' | 'fixture' | 'environment' | 'probe' | 'criterion';
export type EvidenceIdentity = { kind: IdentityKind; key: string; sha256: string | null };
export type EvidenceNode =
  | { id: string; kind: 'claim'; supports: string[] }
  | { id: string; kind: 'support'; dependsOn: string[] }
  | { id: string; kind: 'assumption'; identities: EvidenceIdentity[] }
  | { id: string; kind: 'evidence'; identities: EvidenceIdentity[] };
export type EvidenceGraph = {
  schemaVersion: 1;
  runId: string;
  nodes: EvidenceNode[];
  incompatibilities: { supportId: string; scope: string; reason: string; sourceId: string }[];
};

function record(value: unknown, fields?: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || fields && (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)))) {
    throw new Error('Invalid evidence record fields.');
  }
}

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('Invalid evidence text.');
}

function list(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Evidence list exceeds its bounded schema.');
}

function ids(value: unknown, max: number, description: string): asserts value is string[] {
  list(value, max);
  if (!value.length || new Set(value).size !== value.length) throw new Error(`Invalid evidence ${description}.`);
  value.forEach(text);
}

const identityKey = (identity: EvidenceIdentity) => canonicalJson([identity.kind, identity.key]);

export function validateIdentities(value: unknown): asserts value is EvidenceIdentity[] {
  list(value, 64);
  const keys = new Set<string>();
  for (const identity of value) {
    record(identity, ['kind', 'key', 'sha256']);
    if (!['source', 'config', 'fixture', 'environment', 'probe', 'criterion'].includes(String(identity.kind))) {
      throw new Error('Unsupported evidence identity kind.');
    }
    text(identity.key);
    if (identity.sha256 !== null && (typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(identity.sha256))) {
      throw new Error('Invalid evidence identity digest.');
    }
    const key = canonicalJson([identity.kind, identity.key]);
    if (keys.has(key)) throw new Error('Conflicting identity binding.');
    keys.add(key);
  }
}

function uniqueRecords(values: unknown[], runId?: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    record(value);
    text(value.id);
    if (runId !== undefined && value.runId !== runId) throw new Error(`Cross-run evidence record ${value.id}.`);
    const previous = result.get(value.id);
    if (previous && canonicalJson(previous) !== canonicalJson(value)) throw new Error(`Conflicting evidence ID ${value.id}.`);
    result.set(value.id, value);
  }
  return result;
}

/** Links and freshness are bookkeeping, not proof that an authored claim is true. */
export function validateEvidenceGraph(input: unknown, mapRecords: unknown[], runId: string): EvidenceGraph | undefined {
  if (input === undefined) return undefined;
  const graph: unknown = JSON.parse(canonicalJson(input));
  record(graph, ['schemaVersion', 'runId', 'nodes', 'incompatibilities']);
  if (graph.schemaVersion !== 1 || graph.runId !== runId) throw new Error('Evidence graph run identity or version changed.');
  list(graph.nodes, 256);
  list(graph.incompatibilities, 256);
  list(mapRecords, 4096);
  const records = uniqueRecords(mapRecords, runId);
  const nodes = uniqueRecords(graph.nodes);
  for (const [id, node] of nodes) {
    if (!records.has(id)) throw new Error(`Missing map record for evidence node ${id}.`);
    switch (node.kind) {
      case 'claim':
        record(node, ['id', 'kind', 'supports']);
        if (Array.isArray(node.supports) && node.supports.length > 4) throw new Error('A claim allows at most four alternatives.');
        ids(node.supports, 4, 'support alternatives');
        break;
      case 'support':
        record(node, ['id', 'kind', 'dependsOn']);
        ids(node.dependsOn, 32, 'dependencies');
        break;
      case 'assumption':
      case 'evidence':
        record(node, ['id', 'kind', 'identities']);
        validateIdentities(node.identities);
        break;
      default:
        throw new Error('Unsupported evidence node kind.');
    }
  }
  const typedNodes = [...nodes.values()] as EvidenceNode[];
  const references = new Map(typedNodes.map(node => [node.id,
    node.kind === 'claim' ? node.supports : node.kind === 'support' ? node.dependsOn : []]));
  for (const node of typedNodes) {
    for (const ref of references.get(node.id)!) {
      const target = nodes.get(ref);
      if (!target) throw new Error(`Dangling evidence reference ${ref}.`);
      if (node.kind === 'claim' && target.kind !== 'support') throw new Error('Claim must reference a support.');
      if (node.kind === 'support' && target.kind === 'support') throw new Error('A support dependency must be a claim, evidence or assumption.');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Evidence cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    references.get(id)!.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  nodes.forEach((_, id) => visit(id));
  for (const conflict of graph.incompatibilities) {
    record(conflict, ['supportId', 'scope', 'reason', 'sourceId']);
    text(conflict.supportId);
    text(conflict.scope);
    text(conflict.reason);
    text(conflict.sourceId);
    if (nodes.get(conflict.supportId)?.kind !== 'support') throw new Error('Incompatibility requires a support.');
    if (!records.has(conflict.sourceId)) throw new Error('Incompatibility requires a map source.');
  }
  return { ...graph, nodes: typedNodes } as EvidenceGraph;
}

type Freshness = 'fresh' | 'stale' | 'unknown';
type NodeAssessment = { id: string; kind: EvidenceNode['kind']; status: Freshness; reasons: string[]; validSupports?: string[] };

/** Evaluate relative to recorded identities, not an implicit live filesystem scan. */
export function assessEvidenceGraph(input: unknown, mapRecords: unknown[], runId: string, current: unknown = { identities: [], scopes: [] }) {
  const graph = validateEvidenceGraph(input, mapRecords, runId);
  if (!graph) return undefined;
  const context: unknown = JSON.parse(canonicalJson(current));
  record(context, ['identities', 'scopes']);
  validateIdentities(context.identities);
  list(context.scopes, 64);
  context.scopes.forEach(text);
  const currentIdentities = new Map(context.identities.map(item => [identityKey(item), item.sha256]));
  const activeScopes = new Set(context.scopes);
  const records = uniqueRecords(mapRecords, runId);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incompatibilities = graph.incompatibilities;
  const results = new Map<string, NodeAssessment>();
  function assess(id: string): NodeAssessment {
    const cached = results.get(id);
    if (cached) return cached;
    const node = nodes.get(id)!;
    const result: NodeAssessment = { id, kind: node.kind, status: 'fresh', reasons: [] };
    const state = records.get(id)!.state;
    if (state === 'superseded' || state === 'refuted' || state === 'unresolved') {
      result.status = 'unknown';
      result.reasons.push(`record-${state}`);
    } else if (node.kind === 'evidence' || node.kind === 'assumption') {
      if (!node.identities.length) result.reasons.push('missing-identity');
      if (state !== 'observed' && state !== 'confirmed') result.reasons.push('unestablished-record');
      for (const identity of node.identities) {
        const actual = currentIdentities.get(identityKey(identity));
        const label = `${identity.kind}:${identity.key}`;
        if (!identity.sha256 || !actual) result.reasons.push(`identity-missing:${label}`);
        else if (actual !== identity.sha256) result.reasons.push(`identity-drift:${label}`);
      }
      if (result.reasons.some(reason => reason.startsWith('identity-drift:'))) {
        result.status = 'stale';
      } else if (result.reasons.length) {
        result.status = 'unknown';
      }
    } else if (node.kind === 'support') {
      const dependencies = node.dependsOn.map(assess);
      for (const dependency of dependencies.filter(item => item.status !== 'fresh')) {
        result.reasons.push(`dependency-${dependency.status}:${dependency.id}`);
      }
      for (const conflict of incompatibilities.filter(item => item.supportId === id)) {
        if (!activeScopes.size || activeScopes.has(conflict.scope)) {
          result.reasons.push(`incompatible:${conflict.scope}:${conflict.sourceId}:${conflict.reason}`);
        }
      }
      if (dependencies.some(item => item.status === 'stale')) {
        result.status = 'stale';
      } else if (result.reasons.length) {
        result.status = 'unknown';
      }
    } else {
      const alternatives = node.supports.map(assess);
      const validSupports = alternatives.filter(item => item.status === 'fresh').map(item => item.id);
      result.validSupports = validSupports;
      if (!validSupports.length) {
        result.status = alternatives.some(item => item.status === 'unknown') ? 'unknown' : 'stale';
        result.reasons = alternatives.map(item => `support-${item.status}:${item.id}`);
      }
    }
    results.set(id, result);
    return result;
  }
  return {
    basis: 'recorded-identities' as const,
    graphSha256: canonicalSha256(graph),
    contextSha256: canonicalSha256(context),
    nodes: graph.nodes.map(node => assess(node.id)),
  };
}
