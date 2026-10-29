// Inert host boundaries: registrations and delivery are observed, never launched.
export function reviewHost() {
  const tools = new Map(), events = new Map(), messages = [];
  const pi = {
    __disableAutoReviewWatchdog: true,
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand() {},
    on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler]); },
    events: { on() {}, off() {}, emit() {} },
    sendMessage: message => messages.push(message),
    exec: async () => { throw new Error('Case attempted an unmodeled external command.'); },
  };
  const emit = async (name, ctx) => { for (const handler of events.get(name) ?? []) await handler({}, ctx); };
  return { pi, tools, events, messages, emit };
}
