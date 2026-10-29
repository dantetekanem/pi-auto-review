import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import * as host from '/bundle/deps/progress-host.mjs';

// Index keeps the real status producer; only unrelated host/lifecycle/tool boundaries are inert.
registerHooks({ resolve(specifier, context, next) {
  const source = 'file:///bundle/source/';
  const ui = source + 'extensions/ui/';
  if (specifier === '@mariozechner/pi-coding-agent'
    || context.parentURL === source + 'extensions/index.ts' && specifier.startsWith('.') && !specifier.startsWith('./ui/read-agent-status') && !specifier.startsWith('./ui/status-widget') && !specifier.startsWith('./ui/renderers')
    || context.parentURL === ui + 'activity-colors.ts' && specifier.includes('/settings')
    || context.parentURL === ui + 'read-agent-status.ts' && specifier.includes('/status-projection')) {
    return { url: 'file:///bundle/deps/progress-host.mjs', shortCircuit: true };
  }
  if (context.parentURL?.startsWith(source) && specifier.startsWith('.')) {
    const url = new URL(specifier.replace(/\.js$/, '') + '.ts', context.parentURL);
    if (existsSync(url)) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });

test('case-contract', async t => {
  const { progress } = JSON.parse(await readFile('/bundle/input.json', 'utf8'));
  await access('/bundle/deps/tui/utils.js');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  process.env.PI_TEAM_NAME = host.agent.teamName;
  delete process.env.PI_AGENT_NAME;
  let widget;
  const pi = { on() {}, registerCommand() {}, registerTool() {}, registerShortcut() {},
    events: { on() {}, off() {}, emit() {} } };
  const { default: extension } = await import('/bundle/source/extensions/index.ts');
  extension(pi);
  assert.ok(host.captured, 'Historical team-tool registration seam was not reached.');
  host.agent.latestProgress = progress;
  host.captured.runningReadAgents.set(`${host.agent.teamName}:${host.agent.name}`, host.agent);
  host.captured.setSessionCtx({ ui: { setStatus() {}, getToolsExpanded: () => false,
    setWidget(name, factory) {
      if (name === '01-pi-extended-teams-readers' && factory) widget = factory({ requestRender() {} });
    } } });
  try {
    const refresh = () => host.captured.readAgentOptions().renderLeadInboxStatus();
    await refresh();
    assert.ok(widget, 'Historical status producer did not mount the widget.');
    const frames = [widget.render(160).join('\n')];
    for (let cycle = 0; cycle < 3; cycle++) {
      t.mock.timers.tick(1000);
      await refresh();
      widget.render(160);
      t.mock.timers.tick(250);
      frames.push(widget.render(160).join('\n'));
    }
    t.diagnostic(`AR_OBSERVATION ${JSON.stringify({ frames })}`);
    assert.ok(frames.every(frame => frame.includes(progress)), 'final progress must remain visible during cleanup');
  } finally { widget?.dispose(); t.mock.timers.reset(); }
});
