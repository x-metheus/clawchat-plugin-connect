import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDeepSeekHarnessRuntimeAdapter,
  type DeepSeekHarnessRuntimeAdapter,
  type DeepSeekHarnessRuntimeAdapterBinding,
  type DeepSeekHarnessRuntimeAdapterOptions,
} from "../../runtime/deepseek-harness-adapter";
import { canonicalDshHome } from "../../runtime/deepseek-harness-identity";
import { type DshExecutableProbe, requireDshExecutable } from "../../runtime/deepseek-harness-process";
import {
  canonicalDshWebEnvironmentOverrides,
  type StartDshWebAppOptions,
  startDshWebApp,
} from "../../runtime/deepseek-harness-web-process";
import { canonicalExecutableIdentity } from "../../runtime/executable-identity";
import { CONNECT_VERSION } from "../../service/version";
import type {
  ConnectPluginConfiguration,
  ConnectPluginEntry,
  ConnectPluginManagedWebAppInstance,
  ConnectPluginManagedWebAppInstanceContext,
  ConnectPluginManagedWebAppProvider,
  ConnectPluginRuntimeAdapter,
  ConnectPluginRuntimeStartContext,
} from "../sdk";
import {
  DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
  DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
  DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
  DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
} from "./deepseek-harness-manifest";

interface DeepSeekHarnessInstallationConfiguration {
  executablePath?: string;
}

export interface DeepSeekHarnessOfficialPluginEntryOptions {
  runtimeAdapter?: Partial<DeepSeekHarnessRuntimeAdapterOptions>;
  createAdapter?: (options: DeepSeekHarnessRuntimeAdapterOptions) => DeepSeekHarnessRuntimeAdapter;
  webApp?: {
    probeExecutable?: (
      configuredPath: string | undefined,
      env: Readonly<Record<string, string>> | undefined,
    ) => DshExecutableProbe;
    start?: (options: StartDshWebAppOptions) => Promise<ConnectPluginManagedWebAppInstance>;
  };
}

export function createDeepSeekHarnessOfficialPluginEntry(
  options: DeepSeekHarnessOfficialPluginEntryOptions = {},
): ConnectPluginEntry {
  return {
    activate(context) {
      const installation = context.installationConfiguration as DeepSeekHarnessInstallationConfiguration;
      context.hostCapabilities.get("runtime-provider").register({
        capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
        family: DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
        create(configuration) {
          const binding = deepSeekHarnessBinding(installation, configuration);
          const adapterOptions: DeepSeekHarnessRuntimeAdapterOptions = {
            bridgePath:
              options.runtimeAdapter?.bridgePath ??
              fileURLToPath(new URL("./deepseek-harness-bridge.mjs", import.meta.url)),
            // Change the entry identity too, so older adapters restore the complete old asset graph on rollback.
            bridgeBuild: options.runtimeAdapter?.bridgeBuild ?? `${CONNECT_VERSION}:clawchat-tools-v1`,
            ...(options.runtimeAdapter?.createBridge ? { createBridge: options.runtimeAdapter.createBridge } : {}),
            ...(options.runtimeAdapter?.probeExecutable
              ? { probeExecutable: options.runtimeAdapter.probeExecutable }
              : {}),
          };
          const adapter = (options.createAdapter ?? createDeepSeekHarnessRuntimeAdapter)(adapterOptions);
          return bridgeDeepSeekHarnessAdapter(adapter, binding);
        },
      });
      const activeHomes = new Map<string, { executableIdentity: string; instances: number }>();
      context.hostCapabilities
        .get("managed-web-app-provider")
        .register(deepSeekHarnessWebProvider(installation, options, activeHomes));
    },
  };
}

interface DeepSeekHarnessWebScope {
  readonly key: string;
  readonly executable: string;
  readonly executableArguments: readonly string[];
  readonly executableIdentity: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
}

function deepSeekHarnessWebProvider(
  installation: DeepSeekHarnessInstallationConfiguration,
  options: DeepSeekHarnessOfficialPluginEntryOptions,
  activeHomes: Map<string, { executableIdentity: string; instances: number }>,
): ConnectPluginManagedWebAppProvider {
  const probeExecutable = options.webApp?.probeExecutable ?? requireDshExecutable;
  const start = options.webApp?.start ?? startDshWebApp;
  return {
    capabilityId: DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
    instanceKey(context) {
      return deepSeekHarnessWebScope(installation, context, probeExecutable).key;
    },
    async acquire(context) {
      const scope = deepSeekHarnessWebScope(installation, context, probeExecutable);
      if (scope.key !== context.instanceKey) {
        throw new Error("DSH Web executable, Home, or Web configuration changed during acquisition");
      }
      const releaseHome = claimDshHome(activeHomes, scope.home, scope.executableIdentity);
      try {
        const instance = await start({
          executable: scope.executable,
          executableArguments: scope.executableArguments,
          home: scope.home,
          env: scope.env,
        });
        let released = false;
        return {
          upstream: instance.upstream,
          waitUntilReady: async () => await instance.waitUntilReady(),
          health: () => instance.health(),
          onHealthChange: (listener) => instance.onHealthChange(listener),
          onExit: (listener) => instance.onExit(listener),
          async release() {
            if (released) return;
            released = true;
            try {
              await instance.release();
            } finally {
              releaseHome();
            }
          },
        };
      } catch (error) {
        releaseHome();
        throw error;
      }
    },
  };
}

function deepSeekHarnessWebScope(
  installation: DeepSeekHarnessInstallationConfiguration,
  context: ConnectPluginManagedWebAppInstanceContext,
  probeExecutable: (
    configuredPath: string | undefined,
    env: Readonly<Record<string, string>> | undefined,
  ) => DshExecutableProbe,
): DeepSeekHarnessWebScope {
  const runtime = context.runtimeConfiguration as Partial<DeepSeekHarnessRuntimeAdapterBinding>;
  const configuredEnvironment = runtime.env;
  const configuredExecutable = runtime.executablePathOverride ?? installation.executablePath;
  const probe = probeExecutable(configuredExecutable, configuredEnvironment);
  const executable = canonicalExecutableIdentity(probe.path, "DeepSeek Harness");
  const executableArguments = Object.freeze([...(probe.executableArguments ?? [])]);
  const home = canonicalDshHome(runtime.homePath, configuredEnvironment);
  const env = canonicalDshWebEnvironmentOverrides(home, configuredEnvironment);
  return {
    key: JSON.stringify({
      executable: executable.identity,
      executableArguments,
      home,
      web: {
        host: "127.0.0.1",
        port: 0,
        openBrowser: false,
        environment: environmentIdentity(env),
      },
    }),
    executable: executable.path,
    executableArguments,
    executableIdentity: executable.identity,
    home,
    env,
  };
}

function environmentIdentity(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

function claimDshHome(
  activeHomes: Map<string, { executableIdentity: string; instances: number }>,
  home: string,
  executableIdentity: string,
): () => void {
  const active = activeHomes.get(home);
  if (active && active.executableIdentity !== executableIdentity) {
    throw new Error(`DSH Web Home ${home} is already active under a different DeepSeek Harness executable identity`);
  }
  if (active) active.instances += 1;
  else activeHomes.set(home, { executableIdentity, instances: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeHomes.get(home);
    if (!current || current.executableIdentity !== executableIdentity) return;
    current.instances -= 1;
    if (current.instances === 0) activeHomes.delete(home);
  };
}

function deepSeekHarnessBinding(
  installation: DeepSeekHarnessInstallationConfiguration,
  configuration: ConnectPluginConfiguration,
): DeepSeekHarnessRuntimeAdapterBinding {
  const binding = structuredClone(configuration) as Omit<
    DeepSeekHarnessRuntimeAdapterBinding,
    "runtime" | "runtimeConfig"
  >;
  return {
    runtime: {
      pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
    },
    runtimeConfig: structuredClone(configuration) as Record<string, unknown>,
    ...(installation.executablePath && !binding.executablePathOverride
      ? { executablePathOverride: installation.executablePath }
      : {}),
    ...binding,
  };
}

function bridgeDeepSeekHarnessAdapter(
  adapter: DeepSeekHarnessRuntimeAdapter,
  binding: DeepSeekHarnessRuntimeAdapterBinding,
): ConnectPluginRuntimeAdapter {
  const discoverThreads = adapter.discoverThreads?.bind(adapter);
  const discoverAllThreads = adapter.discoverAllThreads?.bind(adapter);
  const discoverArchivedThreads = adapter.discoverArchivedThreads?.bind(adapter);
  return {
    modes: adapter.modes,
    lifecycleCapabilities: adapter.lifecycleCapabilities,
    prepare: adapter.prepare ? async () => await adapter.prepare?.(binding) : undefined,
    modesFor: adapter.modesFor ? (scope) => adapter.modesFor?.(binding, scope) ?? adapter.modes : undefined,
    listModels: adapter.listModels ? async (scope) => (await adapter.listModels?.(binding, scope)) ?? [] : undefined,
    listSessionOptions: adapter.listSessionOptions
      ? async (workspace, scope) => (await adapter.listSessionOptions?.(binding, workspace, scope)) ?? []
      : undefined,
    listSkills: adapter.listSkills
      ? async (workspace, catalogOptions) => (await adapter.listSkills?.(binding, workspace, catalogOptions)) ?? []
      : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands
      ? async (workspace, catalogOptions) => (await adapter.listCommands?.(binding, workspace, catalogOptions)) ?? []
      : undefined,
    onCommandsChanged: adapter.onCommandsChanged?.bind(adapter),
    onCatalogsChanged: adapter.onCatalogsChanged?.bind(adapter),
    discoverThreads: discoverThreads ? async (workspace) => await discoverThreads(binding, workspace) : undefined,
    discoverAllThreads: discoverAllThreads ? async () => await discoverAllThreads(binding) : undefined,
    discoverArchivedThreads: discoverArchivedThreads ? async () => await discoverArchivedThreads(binding) : undefined,
    verifyThreadReady: adapter.verifyThreadReady
      ? async (runtimeThreadId) => await adapter.verifyThreadReady?.(binding, runtimeThreadId)
      : undefined,
    readActivity: adapter.readActivity
      ? async (runtimeThreadId) => {
          const snapshot = await adapter.readActivity?.(binding, runtimeThreadId);
          if (!snapshot) throw new Error("DeepSeek Harness Runtime Adapter returned no Activity");
          return snapshot;
        }
      : undefined,
    reconcileInput: adapter.reconcileInput
      ? async (runtimeThreadId, candidate) =>
          (await adapter.reconcileInput?.(binding, runtimeThreadId, candidate)) ?? { outcome: "unknown" }
      : undefined,
    archiveThread: adapter.archiveThread
      ? async (runtimeThreadId) => await adapter.archiveThread?.(binding, runtimeThreadId)
      : undefined,
    start: async (context) => await adapter.start(binding, runtimeStartContext(context)),
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
}

function runtimeStartContext(context: ConnectPluginRuntimeStartContext) {
  return {
    agentId: context.bindingId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia,
  };
}

export default createDeepSeekHarnessOfficialPluginEntry();
