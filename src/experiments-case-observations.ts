const signatures = {
  'review-restoration-v1': 'completed reviews must hand back once',
  'review-dispatch-v1': 'review dispatch must use configured teams',
  'team-progress-v1': 'final progress must remain visible during cleanup',
  'review-thinking-v1': 'review must preserve supported caller thinking',
};
export type NodeCase = keyof typeof signatures;

export function nodeObservationContract(caseId?: NodeCase) {
  if (caseId === undefined) return { targetSignature: 'optional findings must be nonblocking', normalizerVersion: 'node-findings-v1' };
  if (typeof caseId !== 'string' || !Object.hasOwn(signatures, caseId)) throw new Error('Unsupported Node case.');
  return { targetSignature: signatures[caseId], normalizerVersion: `node-${caseId}` };
}

function record(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error('Invalid case input or observation fields.');
  }
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\x00-\x1f]/.test(value)) throw new Error('Invalid case text.');
  return value;
}
function strings(value: unknown, count: number): string[] {
  if (!Array.isArray(value) || value.length > count || value.some(item => typeof item !== 'string' || item.length > 200)) {
    throw new Error('Invalid case string list.');
  }
  return value;
}

/** Only these four authored predicates are supported; callers cannot supply assertions or normalizers. */
export function validateCaseInput(caseId: NodeCase, encoded: string): Record<string, unknown> {
  nodeObservationContract(caseId);
  const input: unknown = JSON.parse(encoded);
  const fields = caseId === 'team-progress-v1' ? ['progress']
    : caseId === 'review-thinking-v1' ? ['thinking', 'supported'] : [];
  record(input, fields);
  if (caseId === 'team-progress-v1') text(input.progress, 100);
  if (caseId === 'review-thinking-v1' && (typeof input.thinking !== 'string'
    || !['high', 'xhigh'].includes(input.thinking) || typeof input.supported !== 'boolean')) {
    throw new Error('Invalid thinking case input.');
  }
  return input;
}

/** A mismatch is an observation under a frozen probe, not independent requirement authority. */
export function caseObservationMismatch(caseId: NodeCase, encoded: string, observed: unknown): boolean {
  const input = validateCaseInput(caseId, encoded);
  switch (caseId) {
    case 'review-restoration-v1':
      record(observed, ['restored', 'priorCompletions', 'notices']);
      if (observed.restored !== true || observed.priorCompletions !== 1
        || typeof observed.notices !== 'number' || !Number.isSafeInteger(observed.notices) || observed.notices < 0) {
        throw new Error('Restoration case applicability is missing.');
      }
      return observed.notices !== 0;
    case 'review-dispatch-v1': {
      record(observed, ['registeredTools', 'launchTools']);
      const registered = strings(observed.registeredTools, 64);
      const launched = strings(observed.launchTools, 64);
      return !['agentic_code_review', 'agentic_code_review_complete'].every(name => registered.includes(name))
        || !launched.includes('spawn_swarm_agents') || registered.includes('agentic_code_review_wave') || launched.includes('agentic_code_review_wave');
    }
    case 'team-progress-v1': {
      record(observed, ['frames']);
      if (!Array.isArray(observed.frames) || observed.frames.length !== 4
        || observed.frames.some(frame => typeof frame !== 'string' || frame.length > 4096)) {
        throw new Error('Incomplete progress frames.');
      }
      const progress = text(input.progress, 100);
      return observed.frames.some(frame => !frame.includes(progress));
    }
    case 'review-thinking-v1':
      record(observed, ['selected', 'launched', 'blocked']);
      if (typeof observed.blocked !== 'boolean'
        || [observed.selected, observed.launched].some(level => level !== null
          && (typeof level !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)))) {
        throw new Error('Invalid thinking observation.');
      }
      return input.supported
        ? observed.blocked || observed.selected !== input.thinking || observed.launched !== input.thinking
        : !observed.blocked || observed.selected !== null || observed.launched !== null;
  }
}
