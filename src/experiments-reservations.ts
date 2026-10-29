import { canonicalSha256 } from './experiments-oracle.ts';

type Reservation = { key: string; expiresAt: number; state: 'active' | 'settled' | 'fenced'; attemptId?: string };

/** Identity only: the caller must still hold the existing host execution grant. */
export function experimentKey(request: { runId: string; [key: string]: unknown }, oracleSha256: string, schedule = 'serial-v1') {
  if (!/^[a-f0-9]{64}$/.test(oracleSha256) || typeof schedule !== 'string' || !schedule || schedule.length > 128) {
    throw new Error('Invalid experiment oracle or schedule identity.');
  }
  const { runId: _runId, ...inputs } = request;
  return canonicalSha256({ inputs, oracleSha256, schedule });
}

/** One host-plan lifetime. The existing durable .claimed fence prevents restart reuse. */
export class ExperimentReservations {
  private latest = new Map<string, Reservation>();
  private tokens = new WeakMap<object, Reservation>();
  private now: () => number;

  constructor(now = Date.now) {
    this.now = now;
  }

  reserve(key: string, expiresAt: number, replayOf?: string): object {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(expiresAt)) throw new Error('Invalid experiment reservation.');
    const previous = this.latest.get(key);
    if (previous && previous.state !== 'settled') throw new Error('Experiment is active or fenced; do not retry ambiguous work.');
    if (this.now() >= expiresAt) throw new Error('Experiment reservation expired.');
    if (previous && replayOf === undefined) throw new Error(`Experiment already ran as ${previous.attemptId}; use an explicit replay.`);
    if (replayOf !== undefined && (!previous || previous.attemptId !== replayOf)) throw new Error('Replay must name the latest settled attempt for these exact inputs.');
    const reservation: Reservation = { key, expiresAt, state: 'active' };
    const token = Object.freeze({});
    this.latest.set(key, reservation);
    this.tokens.set(token, reservation);
    return token;
  }

  settle(token: object, result: { attemptId: string; cleanupConfirmed: boolean }): void {
    const reservation = this.tokens.get(token);
    if (!reservation || reservation.state !== 'active' || this.latest.get(reservation.key) !== reservation) {
      throw new Error('Unknown or settled experiment reservation.');
    }
    this.tokens.delete(token);
    reservation.state = 'fenced';
    if (this.now() >= reservation.expiresAt) throw new Error('Late result: experiment reservation expired; ownership remains fenced.');
    if (!result.cleanupConfirmed) throw new Error('Experiment cleanup is unconfirmed; ownership remains fenced.');
    if (typeof result.attemptId !== 'string' || !result.attemptId) throw new Error('Invalid experiment attempt identity.');
    reservation.attemptId = result.attemptId;
    reservation.state = 'settled';
  }

  fence(token: object): void {
    const reservation = this.tokens.get(token);
    if (!reservation) return;
    reservation.state = 'fenced';
    this.tokens.delete(token);
  }
}
