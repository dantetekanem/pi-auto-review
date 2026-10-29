type WorkerOutcome<T> = { id: string } & (
  | { status: 'settled'; value: T }
  | { status: 'unresolved' | 'not-started'; reason: string }
);

/** Fixed waves make admission order independent of completion order. Each slot owns one resource lease. */
export async function runWorkerBatch<T>(
  ids: readonly string[],
  workers: number,
  execute: (id: string, slot: number, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 2 || !Array.isArray(ids)
    || !ids.length || ids.length > 64 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id))
    || new Set(ids).size !== ids.length) throw new Error('Invalid bounded worker batch.');
  signal?.throwIfAborted();
  const pending = [...ids];
  const outcomes: WorkerOutcome<T>[] = [];
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const startedAt = performance.now();
  let peakWorkers = 0;
  let started = 0;
  try {
    for (let offset = 0; offset < pending.length && !controller.signal.aborted; offset += workers) {
      const wave = pending.slice(offset, offset + workers);
      peakWorkers = Math.max(peakWorkers, wave.length);
      const settled = await Promise.allSettled(wave.map(async (id, slot) => {
        started++;
        try {
          return await execute(id, slot, controller.signal);
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }));
      settled.forEach((result, index) => {
        outcomes.push(result.status === 'fulfilled'
          ? { id: wave[index], status: 'settled', value: result.value }
          : { id: wave[index], status: 'unresolved', reason: String(result.reason) });
      });
    }
    for (const id of pending.slice(outcomes.length)) {
      outcomes.push({ id, status: 'not-started', reason: 'Batch cancelled or a worker could not settle.' });
    }
    return {
      status: controller.signal.aborted ? 'inconclusive' : 'completed',
      workers,
      peakWorkers,
      started,
      durationMs: Math.ceil(performance.now() - startedAt),
      outcomes,
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
