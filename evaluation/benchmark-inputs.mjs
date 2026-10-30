import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readPinnedFile } from '../src/experiments-materialize.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort();

/** Explicit model inputs/tool access, not an OS sandbox for trusted extension code. */
export async function createBenchmarkInputs(sdk, { cwd, loaderDirectory, files, tools,
  extensions = [], extensionFactories = [], appendSystemPrompt = [] }) {
  if (!isAbsolute(cwd) || !isAbsolute(loaderDirectory) || !Array.isArray(files) || !files.length || files.length > 128
    || !Array.isArray(tools) || !tools.includes('read') || new Set(tools).size !== tools.length
    || tools.some(name => /^(bash|powershell|edit|write|codemode|tool_search|load_capabilities)$|^mcp__/.test(name))) {
    throw new Error('Explicit benchmark inputs and a restricted tool list are required.');
  }
  extensions = structuredClone(extensions);
  appendSystemPrompt = [...appendSystemPrompt];
  const pins = new Map();
  for (const pin of structuredClone(files)) {
    if (pins.has(pin.path)) throw new Error('Duplicate input pin.');
    await readPinnedFile(pin, 2 * 1048576);
    pins.set(pin.path, pin);
  }
  const read = path => {
    const pin = pins.get(path);
    if (!pin) throw new Error('Path is not admitted to this benchmark session.');
    return readPinnedFile(pin, 2 * 1048576);
  };
  const readTool = sdk.createReadToolDefinition(cwd, {
    operations: {
      access: async path => { await read(path); },
      readFile: read,
      detectImageMimeType: async () => undefined,
    },
  });
  for (const extension of extensions) await readPinnedFile(extension, 1048576);
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultTools: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
    enableSkillCommands: false,
  }, { projectTrusted: false });
  // Discovery is confined to a new empty directory, not the case checkout or personal agent directory.
  await mkdir(loaderDirectory, { mode: 0o700 });
  const loader = new sdk.DefaultResourceLoader({ cwd: loaderDirectory, agentDir: loaderDirectory, settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: '', appendSystemPrompt: [...appendSystemPrompt],
    additionalExtensionPaths: extensions.map(pin => pin.path), extensionFactories,
  });
  let loading;
  const resourceLoader = {
    ...Object.fromEntries(['getExtensions', 'getSkills', 'getPrompts', 'getThemes', 'getAgentsFiles', 'getSystemPrompt',
      'getSystemPromptSource', 'getAppendSystemPrompt', 'getAppendSystemPromptSources'].map(name => [name, () => loader[name]()])),
    reload: () => loading ??= loader.reload(),
    extendResources: paths => {
      if (Object.values(paths).some(entries => entries?.length)) throw new Error('Additional benchmark resources are not admitted.');
    },
  };
  const allowed = new Set(tools);
  return {
    options: { settingsManager, resourceLoader, tools: [...tools], excludeTools: ['mcp__*'], customTools: [readTool] },
    attest(session) {
      const registeredTools = sorted(session.getAllTools().map(tool => tool.name));
      const activeTools = sorted(session.getActiveToolNames());
      const callableTools = sorted(session.getCallableToolNames());
      if (session.resourceLoader !== resourceLoader || session.settingsManager !== settingsManager
        || session.autoRetryEnabled || session.autoCompactionEnabled || settingsManager.getCacheWarmingMode() !== 'off'
        || loader.getExtensions().errors.length || loader.getSkills().skills.length || loader.getPrompts().prompts.length
        || loader.getThemes().themes.length || loader.getAgentsFiles().agentsFiles.length
        || loader.getSystemPrompt() || loader.getSystemPromptSource()
        || JSON.stringify(loader.getAppendSystemPrompt()) !== JSON.stringify(appendSystemPrompt)
        || [...registeredTools, ...activeTools, ...callableTools].some(name => !allowed.has(name))
        || !activeTools.includes('read')) {
        throw new Error('Benchmark session input/tool attestation failed.');
      }
      return {
        sessionId: session.sessionManager.getSessionId(), cwd, settingsOrigin: 'in-memory',
        sourceManifestSha256: sha(JSON.stringify([...pins.values()])),
        promptSha256: sha(session.systemPrompt),
        registeredTools, activeTools, callableTools,
      };
    },
  };
}
