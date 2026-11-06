export type CheckKind = 'safe' | 'mutant' | 'control' | 'counterexample';
export type PlannedCheck = { kind: CheckKind; text: string; rule: string | null; config: string };
type Config = { specification: string; constants: Map<string, string>; invariants: string[] };

function refuse(message: string): never {
  throw new Error(`Unsupported model checks: ${message}`);
}

/** Integer constants are bounds; TRUE constants are safeguards. TypeOK comes first, then the rules. */
function parseConfig(text: string): Config {
  const config: Config = { specification: '', constants: new Map(), invariants: [] };
  let block = '';
  for (const line of text.split('\n').map(line => line.trim()).filter(Boolean)) {
    const constant = /^([A-Za-z]\w*) = (-?\d+|TRUE|FALSE)$/.exec(line);
    if (!block && !config.specification && /^SPECIFICATION [A-Za-z]\w*$/.test(line)) config.specification = line;
    else if (line === 'CONSTANTS' || line === 'INVARIANTS') block = line;
    else if (block === 'CONSTANTS' && constant && !config.constants.has(constant[1])) config.constants.set(constant[1], constant[2]);
    else if (block === 'INVARIANTS' && /^[A-Za-z]\w*$/.test(line) && !/^[A-Z_]+$/.test(line)) config.invariants.push(line);
    else refuse(`the config line "${line}" is not supported`);
  }
  if (!config.specification || config.invariants[0] !== 'TypeOK' || config.invariants.length < 2) {
    refuse('the config needs SPECIFICATION, TypeOK as its first invariant and at least one rule');
  }
  return config;
}

function render({ specification, constants, invariants }: Config): string {
  return [specification, 'CONSTANTS', ...[...constants].map(([name, value]) => `    ${name} = ${value}`),
    'INVARIANTS', ...invariants.map(name => `    ${name}`), ''].join('\n');
}

/** One model config per check, after the unchanged config. Refuses a model with no control or an untested safeguard. */
export function planModelChecks(checksText: string, configText: string, moduleText: string): PlannedCheck[] {
  const base = parseConfig(configText);
  const rules = base.invariants.slice(1);
  const safeguards = [...base.constants].filter(([, value]) => value === 'TRUE').map(([name]) => name);
  const isSetting = ([name, value, extra]: string[]) =>
    /^-?\d+$/.test(base.constants.get(name) ?? '') && /^-?\d+$/.test(value ?? '') && extra === undefined;
  const defined = (name: string) => /^[A-Za-z]\w*$/.test(name) && !base.invariants.includes(name)
    && new RegExp(`^${name} ==`, 'm').test(moduleText);
  const variant = (changes: string[][], invariants: string[]) =>
    render({ ...base, constants: new Map([...base.constants, ...changes] as [string, string][]), invariants });
  const checks: PlannedCheck[] = [{ kind: 'safe', text: 'unchanged config', rule: null, config: render(base) }];
  const mutated = new Set<string>();
  const lines = checksText.split('\n').map(line => line.trim());
  lines.forEach((line, index) => {
    if (!line || line.startsWith('#')) return;
    const [kind, ...names] = line.split(/\s+/);
    const add = (rule: string | null, config: string) => checks.push({ kind: kind as CheckKind, text: line, rule, config });
    const bounds = names.map(setting => setting.split('='));
    if (kind === 'safe' && names.length >= 1 && names.length <= 3 && bounds.every(isSetting)) {
      add(null, variant(bounds, base.invariants));
    } else if (kind === 'mutant' && names.length === 2 && safeguards.includes(names[0]) && rules.includes(names[1])) {
      mutated.add(names[0]);
      add(names[1], variant([[names[0], 'FALSE']], ['TypeOK', names[1]]));
    } else if (kind === 'control' && names.length === 1 && /^Never[A-Z]/.test(names[0]) && defined(names[0])) {
      add(names[0], variant([], ['TypeOK', names[0]]));
    } else if (kind === 'counterexample' && names.length === 1 && defined(names[0]) && lines[index - 1]?.startsWith('#')) {
      add(names[0], variant([], ['TypeOK', names[0]]));
    } else refuse(`line ${index + 1} is not a valid check: "${line}"`);
  });
  const untested = safeguards.filter(name => !mutated.has(name));
  if (untested.length) refuse(`no mutant turns off ${untested.join(', ')}`);
  if (!checks.some(check => check.kind === 'control')) refuse('the model has no control');
  return checks;
}

/** A safe check must finish without an error; any other check must break exactly its named rule. */
export function gradeCheck(check: PlannedCheck, result: { status: string; invariant?: string }): 'pass' | 'fail' | 'unknown' {
  if (result.status !== 'bounded-model-checked' && result.status !== 'model-counterexample') return 'unknown';
  if (check.kind === 'safe') return result.status === 'bounded-model-checked' ? 'pass' : 'fail';
  return result.invariant === check.rule ? 'pass' : 'fail';
}
