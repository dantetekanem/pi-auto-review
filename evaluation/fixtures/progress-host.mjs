// Frozen inert boundaries for the historical status producer, not replacement status/widget logic.
const noop = () => {};
const denied = () => { throw new Error('Progress replay crossed an unmodeled host boundary.'); };
export let captured;
export let hostApi;
// Idle classification is outside this short, active cleanup scenario.
export const AGENT_HANGING_MS = Number.POSITIVE_INFINITY;
export const agent = { name: 'reporter', teamName: 'fixture-team', runId: 'fixture-run', role: 'read',
  startedAt: 40000, tokensUsed: 0, status: 'finishing', teardownState: 'active', recentEvents: [],
  lastActivityAt: 100000 };
export function registerTeamTools(_pi, runtime) { captured = runtime; return {}; }
export function registerLeadAttachment(pi, create) { hostApi = pi; create(); }
export const createTeamHost = () => ({ api: hostApi, ready: true, attached: true });
export const getTerminalAdapter = () => ({ isAlive: () => false });
export const createCombinedSessionCost = () => undefined;
export const createWriterScreenState = () => ({});
export const createPendingChildController = () => ({});
export const createActiveAgentSleepController = () => ({ dispose: noop });
export const createWriteAgentRuntime = () => ({ startWriteAgent: denied, drainWriteQueue: denied,
  releaseWriteAgentSleepAssertion: noop });
export const createLifecycleRuntime = () => ({ shutdownTeammate: denied, startLeadWatchdog: denied,
  stopLeadWatchdog: noop });
export const createTeammateInterrupter = () => denied;
export const onLifecycleTombstoneCleared = () => noop;
export const generateExtensionInstanceId = () => 'fixture-extension';
export const generateLifecycleRunId = () => 'fixture-run';
export const listLifecycleTombstones = async () => [{ agentName: agent.name,
  result: { status: 'occupied', tombstone: { runId: agent.runId, phase: 'persistence_closed', role: 'read' } } }];
export const readConfig = async () => ({ members: [{ name: agent.name, lifecycleRunId: agent.runId,
  role: agent.role, isActive: true, joinedAt: agent.startedAt }] });
export const readInbox = async () => [];
export const initialContextUsage = () => ({ tokens: 0, percent: 0, contextWindow: 100000 });
export const hasActiveReadAgentLifecycle = state => state.teardownState === 'active';
export const canonicalPersistedModelSlot = slot => slot;
export const loadSettings = () => ({});
export const findLeadTeamForSession = () => undefined;
export const getPiSessionId = () => 'fixture-session';
export { noop as registerExtensionEvents, noop as registerWriterScreenShortcut,
  noop as registerFavoriteModelsCommand, noop as registerExtensionsCommand, noop as registerOnboardingCommand,
  noop as registerCheckpointsCommand, noop as registerCoordinationTools, noop as registerTaskRuntimeTools };
export { denied as registerLeadSession, denied as resolveSkillFile, denied as runReadAgentInProcess,
  denied as sendMessageToRunningReadAgent, denied as buildRoster, denied as formatRosterForPrompt,
  denied as releaseAllClaimsForAgent, denied as requireTeamContext, denied as requireWriteAgentTeam,
  denied as removeWriterScreenTab, denied as upsertWriterScreenTab, denied as installAgentNavigation,
  denied as orderAgentNavigationEntries, denied as buildReadHelperPrompt, denied as createReportProgressTool,
  denied as requireFavoriteModelLevel, denied as parseQualifiedModel, denied as runWithActiveAgentSleepAssertion,
  denied as panelBgFill, denied as framePanel, denied as frameWidget, denied as frameWidgetFullWidth,
  denied as logWindowStart, denied as requestCompletionGroupWake, denied as observeCompletionGroupWakes,
  denied as recoverCompletionGroups, denied as listReadHelperQueue, denied as removeQueuedReadHelperRequest,
  denied as projectAgentStatus, denied as projectLifecycleFence, denied as createSpawnResourcePlan,
  denied as parentProjectTrustForSpawn, denied as readLifecycleTombstone, denied as keyText };
