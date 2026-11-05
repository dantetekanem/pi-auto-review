import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeCheck, planModelChecks } from '../src/model-check-contract.ts';

const moduleText = 'TypeOK == TRUE\nDoorStaysShut == TRUE\nNeverOpened == FALSE\nOpensWhileArmed == TRUE\n';
const config = 'SPECIFICATION Spec\nCONSTANTS\n    Doors = 2\n    LockChecked = TRUE\n    Alarm = FALSE\nINVARIANTS\n    TypeOK\n    DoorStaysShut\n';
const complete = 'mutant LockChecked DoorStaysShut\ncontrol NeverOpened\n';
const plan = (checks, cfg = config) => planModelChecks(checks, cfg, moduleText);

test('each check gets its own config, after the unchanged one', () => {
  const checks = plan(`safe Doors=3\n${complete}# door.ts:12 opens without reading the alarm\ncounterexample OpensWhileArmed\n`);

  assert.deepEqual(checks.map(check => [check.kind, check.rule]), [['safe', null], ['safe', null],
    ['mutant', 'DoorStaysShut'], ['control', 'NeverOpened'], ['counterexample', 'OpensWhileArmed']]);
  assert.equal(checks[0].config, config);
  assert.equal(checks[1].config, config.replace('Doors = 2', 'Doors = 3'));
  assert.equal(checks[2].config, config.replace('LockChecked = TRUE', 'LockChecked = FALSE'));
  assert.ok(checks[3].config.endsWith('INVARIANTS\n    TypeOK\n    NeverOpened\n'));
  assert.ok(checks[4].config.includes('LockChecked = TRUE') && checks[4].config.endsWith('    TypeOK\n    OpensWhileArmed\n'));
});

test('a model with no control or an untested safeguard is refused', () => {
  assert.throws(() => plan('mutant LockChecked DoorStaysShut\n'), /no control/);
  assert.throws(() => plan('control NeverOpened\n'), /no mutant turns off LockChecked/);
});

test('a check line that does not fit the config or module is refused', () => {
  for (const line of ['safe', 'safe Doors=1 Doors=2 Doors=3 Doors=4', 'safe LockChecked=1', 'safe Doors=two', 'safe Rooms=2',
    'mutant Alarm DoorStaysShut', 'mutant LockChecked TypeOK', 'mutant LockChecked', 'control DoorStaysShut', 'control NeverClosed',
    'counterexample OpensWhileArmed', 'wait NeverOpened']) {
    assert.throws(() => plan(`${line}\n${complete}`), /line 1 is not a valid check/, line);
  }
  assert.throws(() => plan(`# door.ts:12\ncounterexample DoorStaysShut\n${complete}`), /line 2 is not a valid check/);
});

test('a config outside the supported shape is refused', () => {
  for (const cfg of [config.replace('SPECIFICATION Spec\n', ''), config.replace('    TypeOK\n', ''), config.replace('    DoorStaysShut\n', ''),
    config.replace('Doors = 2', 'Doors = "two"'), `${config}PROPERTIES\n    Live\n`]) {
    assert.throws(() => plan(complete, cfg), /config/);
  }
});

test('a safe check must finish clean and every other check must break exactly its rule', () => {
  const [safe, mutant] = plan(complete);

  assert.equal(gradeCheck(safe, { status: 'bounded-model-checked' }), 'pass');
  assert.equal(gradeCheck(safe, { status: 'model-counterexample', invariant: 'DoorStaysShut' }), 'fail');
  assert.equal(gradeCheck(mutant, { status: 'model-counterexample', invariant: 'DoorStaysShut' }), 'pass');
  assert.equal(gradeCheck(mutant, { status: 'model-counterexample', invariant: 'TypeOK' }), 'fail');
  assert.equal(gradeCheck(mutant, { status: 'bounded-model-checked' }), 'fail');
  assert.equal(gradeCheck(mutant, { status: 'unknown' }), 'unknown');
});
