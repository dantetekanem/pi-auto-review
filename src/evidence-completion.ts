import { lstatSync, readFileSync } from 'node:fs';
import { assessEvidenceGraph } from './evidence-graph.ts';
import { digestBytes } from './experiments-contract.ts';

/** Legacy reviews do not opt into map validation retroactively. */
export function readCompletionEvidence(input: unknown, mapPath: string, runId: string, context?: unknown) {
  if (input === undefined) return undefined;
  const metadata = lstatSync(mapPath);
  if (!metadata.isFile() || metadata.size > 2_097_152) throw new Error('Evidence map must be a bounded regular file.');
  const bytes = readFileSync(mapPath);
  if (bytes.length > 2_097_152) throw new Error('Evidence map grew beyond its limit.');
  const records: unknown[] = bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  return { ...assessEvidenceGraph(input, records, runId, context), mapSha256: digestBytes(bytes) };
}
