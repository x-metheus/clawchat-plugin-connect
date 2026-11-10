import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Plugin } from "cordis";
import {
  type ConnectClientCoreServices,
  connectClientFacadeScope,
  createConnectClientHostFacade,
} from "../client-interface/core-host-facade";
import { registerConnectClientHostFacade } from "../client-interface/plugin-host-facade";
import { FileTurnSubmissionStaging } from "../client-interface/turn-submission-staging";
import { ConnectConfigMutationCoordinator, type LockedConfigMutation, loadConfig } from "../config";
import type {
  ConnectStateStore,
  PluginDurableStateMigrationCommit,
  PluginDurableStateNamespace,
} from "../persistence/state";
import { cacheRuntimeMedia } from "../runtime/media-cache";
import {
  type PreparedRuntimeAdapter,
  type RuntimeAdapterDefinition,
  RuntimeAdapterRegistry,
  type RuntimeAdapterReplacement,
} from "../runtime/registry";
import type { ConnectRuntimeAdapter } from "../runtime/types";
import type { BindingRuntimeHandle } from "../service/binding-runtime";
import {
  createLivewareControlDependencies,
  type LivewareApp,
  type LivewareControlDependencies,
} from "../service/liveware-control";
import type { AgentBindingConfig, ConnectConfig } from "../types";
import type { WorkspaceCatalog } from "../workspaces/workspaces";
import { agentBindingIdentity, normalizeAgentBinding } from "./binding";
import {
  type ManagedWebAppLease,
  type ManagedWebAppProviderDefinition,
  ManagedWebAppRegistry,
  type ManagedWebAppSelection,
} from "./managed-web-app-registry";
import { CONNECT_CLIENT_MANAGED_WEB_APP_REF, CONNECT_CLIENT_PLUGIN_ID } from "./official/connect-client-manifest";
import type { OfficialLivewareExposureServices, OfficialLivewareManagedDisposer } from "./official/liveware-entry";
import { OFFICIAL_LIVEWARE_CAPABILITY_ID, OFFICIAL_LIVEWARE_PLUGIN_ID } from "./official/liveware-manifest";
import {
  type BundledOfficialPluginEntry,
  discoverOfficialPlugins,
  isBundledOfficialPluginInstallation,
  type OfficialPluginDiscovery,
  type OfficialPluginDiscoveryOptions,
  resolveBundledOfficialPlugin,
} from "./official-registry";
import { RuntimeProviderValidationError } from "./runtime-provider-validation-error";
import type {
  ConnectExposureProviderHostCapability,
  ConnectManagedWebAppProviderHostCapability,
  ConnectPluginContext,
  ConnectPluginEntry,
  ConnectPluginExposureProvider,
  ConnectPluginHostCapabilities,
} from "./sdk";
import {
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  type ConnectDurableStateHostCapability,
  type ConnectPluginDisposer,
  type ConnectPluginDurableState,
  type ConnectPluginDurableStateManifest,
  type ConnectPluginDurableStateRecord,
  type ConnectPluginManagedWebAppProvider,
  type ConnectPluginRuntimeInstanceContext,
  type ConnectPluginRuntimeProvider,
  type ConnectRuntimeProviderHostCapability,
  type ManagedWebAppGenerationReference,
  type ManagedWebAppHealth,
  type RuntimeCapabilityRef,
} from "./sdk";
import {
  persistUploadedPluginSource,
  pluginSourceIdentity,
  type ResolvedPluginSource,
  resolvePluginSource,
  updateReferenceForSource,
} from "./source";
import {
  commitStagedPlugin,
  compilePluginConfigurationValidator,
  compilePluginDurableStateValidator,
  discardStagedPlugin,
  type InstalledPluginLockEntry,
  listInstalledPlugins,
  type PluginConfigurationValidator,
  pluginDependents,
  recordInstalledPluginError,
  removeInstalledPlugin,
  removePluginArtifacts,
  removeUnreferencedManagedPluginUploads,
  restoreInstalledPluginConfiguration,
  revalidateInstalledPlugin,
  type StagedPlugin,
  selectInstalledPluginVersion,
  setInstalledPluginStatus,
  stagePluginBundle,
  updateInstalledPluginConfiguration,
  validatePluginConfiguration,
} from "./store";

interface ActivePlugin {
  installed: InstalledPluginLockEntry;
  retireManagedWebApp(reference: ManagedWebAppGenerationReference): Promise<void>;
  reconcileManagedWebApps(): Promise<void>;
  dispose(): Promise<void>;
  preserveOnShutdown(preserve: boolean): void;
  retireManagedResources(): Promise<void>;
  activateExposures(): Promise<void>;
  retireBindings(bindingIds: readonly string[]): Promise<void>;
  fenceDurableState(): Promise<() => void>;
}

interface ActivatedCandidate {
  plugin: ActivePlugin;
  revokeRuntime(): Promise<void>;
  startContributions(): Promise<void>;
  publishRuntime(): Promise<void>;
  readonly durableStateMigrations: readonly PluginDurableStateMigrationCommit[];
  refreshDurableStateMigrations(): Promise<void>;
}

interface DurableStateGenerationGate {
  run<T>(operation: () => Promise<T>): Promise<T>;
  fence(): Promise<() => void>;
}
interface ResolvedOfficialPlugin {
  entry: BundledOfficialPluginEntry;
}

type ResolvedPluginInstallOptions = Pick<ManagePluginOptions, "installationConfiguration" | "capabilityConfigurations">;

interface ConnectPluginManagementDependencies {
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  workspaces: WorkspaceCatalog;
  quiesceRuntimeBindings?<T>(bindingIds: readonly string[], criticalSection: () => Promise<T>): Promise<T>;
  retireRuntimeBindings?(bindingIds: readonly string[]): Promise<void>;
  livewareDependencies?: LivewareControlDependencies;
  clientInterfaceServices?: Omit<ConnectClientCoreServices, "pluginManager" | "runtimes">;
}

type PendingProvider =
  | {
      readonly type: "runtime";
      readonly runtime: Readonly<RuntimeCapabilityRef>;
      readonly family: string;
      readonly implementation: ConnectPluginRuntimeProvider;
    }
  | {
      readonly type: "managed-web-app";
      readonly capabilityId: string;
      readonly implementation: ConnectPluginManagedWebAppProvider;
    }
  | {
      readonly type: "exposure";
      readonly capabilityId: string;
      readonly implementation: ConnectPluginExposureProvider;
    };

type PendingRuntimeProvider = Extract<PendingProvider, { type: "runtime" }>;

export interface ManagePluginOptions {
  source: string;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  capabilityConfigurations?: Record<string, unknown>;
}
type CoreManagePluginOptions = ManagePluginOptions;

export interface ConfigurePluginOptions {
  installationConfiguration: Record<string, unknown>;
  capabilityConfigurations: Record<string, Record<string, unknown>>;
  runtimeConfigurations: Record<string, Record<string, unknown>>;
}

export type PluginUpdateCheck =
  | { status: "current" | "available"; version: string; integrity: string; diagnostic: null }
  | { status: "check-failed"; version: null; integrity: null; diagnostic: string };
export interface UpsertBindingProviderResult {
  binding: AgentBindingConfig;
  modes: readonly string[];
}
export interface ManagedWebAppControlStatus {
  readonly bindingId: string;
  readonly runtime: Readonly<RuntimeCapabilityRef>;
  readonly selection: ManagedWebAppSelection | null;
  readonly instance: Readonly<{
    instanceKey: string;
    health: ManagedWebAppHealth;
    diagnostic: string | null;
    leaseCount: number;
  }> | null;
}

export const MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS = 4;

export interface ConnectPluginManagement {
  list(): Promise<InstalledPluginLockEntry[]>;
  listPublishedClientExtensions(): Promise<InstalledPluginLockEntry[]>;
  checkUpdates(): Promise<Record<string, PluginUpdateCheck>>;
  discoverOfficial(): Promise<OfficialPluginDiscovery>;
  install(options: ManagePluginOptions): Promise<InstalledPluginLockEntry>;
  installUpload(
    fileName: string,
    bytes: Uint8Array,
    options?: Omit<ManagePluginOptions, "source">,
  ): Promise<InstalledPluginLockEntry>;
  replace(pluginId: string, options: ManagePluginOptions): Promise<InstalledPluginLockEntry>;

  installOfficial(pluginIds: readonly string[]): Promise<InstalledPluginLockEntry[]>;
  update(pluginId: string, options?: Partial<ManagePluginOptions>): Promise<InstalledPluginLockEntry>;
  reinstall(pluginId: string): Promise<InstalledPluginLockEntry>;
  configure(pluginId: string, options: ConfigurePluginOptions): Promise<InstalledPluginLockEntry>;
  enable(pluginId: string): Promise<InstalledPluginLockEntry>;
  disable(pluginId: string): Promise<InstalledPluginLockEntry>;
  select(pluginId: string, version: string, integrity?: string): Promise<InstalledPluginLockEntry>;
  remove(pluginId: string, force?: boolean): Promise<InstalledPluginLockEntry>;
  upsertBindingProvider(bindingId: string, binding: AgentBindingConfig): Promise<UpsertBindingProviderResult>;
  readonly configMutations?: ConnectConfigMutationCoordinator;
}

export class ConnectPluginHost implements ConnectPluginManagement {
  private readonly active = new Map<string, ActivePlugin>();
  private readonly operationCoordinator: ConnectConfigMutationCoordinator;
  readonly configMutations: ConnectConfigMutationCoordinator | undefined;
  private readonly officialCandidates = new Map<string, ResolvedOfficialPlugin>();
  private bindingRuntimes: readonly BindingRuntimeHandle[] = [];
  private optionalSurfacesReady = false;
  private preservePublicationsOnShutdown = false;
  private readonly managedWebAppLeaseRetirers = new Set<
    (reference: ManagedWebAppGenerationReference) => Promise<void>
  >();
  readonly managedWebApps = new ManagedWebAppRegistry();

  constructor(
    private readonly configPath: string,
    private readonly runtimeAdapters: RuntimeAdapterRegistry,
    private readonly reportActivationFailure: (pluginId: string, error: unknown) => void,
    private readonly management?: ConnectPluginManagementDependencies,
    private readonly sourceOptions: OfficialPluginDiscoveryOptions = {},
  ) {
    this.operationCoordinator = new ConnectConfigMutationCoordinator(management?.config, configPath);
    this.configMutations = management ? this.operationCoordinator : undefined;
  }

  async activateOptionalSurfaces(runtimes: readonly BindingRuntimeHandle[]): Promise<void> {
    this.bindingRuntimes = runtimes;
    this.optionalSurfacesReady = true;
    for (const [pluginId, plugin] of [...this.active]) {
      try {
        await plugin.activateExposures();
      } catch (error) {
        this.active.delete(pluginId);
        await plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(pluginId, error).catch(() => undefined);
        this.reportActivationFailure(pluginId, error);
      }
    }
    for (const activePlugin of this.active.values()) {
      await activePlugin.reconcileManagedWebApps();
    }
  }

  async listPublishedClientExtensions(): Promise<InstalledPluginLockEntry[]> {
    return [...this.active.values()]
      .map((plugin) => plugin.installed)
      .filter((installed) =>
        installed.manifest.capabilities.some((capability) => capability.type === "client-extension"),
      )
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  async retireBindings(bindingIds: readonly string[]): Promise<void> {
    for (const plugin of this.active.values()) await plugin.retireBindings(bindingIds);
  }

  registerManagedWebAppLeaseRetirer(
    retire: (reference: ManagedWebAppGenerationReference) => Promise<void>,
  ): ConnectPluginDisposer {
    this.managedWebAppLeaseRetirers.add(retire);
    return () => {
      this.managedWebAppLeaseRetirers.delete(retire);
    };
  }

  async activateInstalled(): Promise<void> {
    const installedPlugins = await listInstalledPlugins(this.configPath);
    for (const installed of installedPlugins) {
      if (installed.status !== "active") continue;
      let activated: ActivatedCandidate | undefined;
      try {
        await revalidateInstalledPlugin(installed);
        this.validateDependentBindings(installed);
        activated = await this.activateCandidate(installed);
        await this.commitDurableStateMigrations(activated);
        await activated.revokeRuntime();
        await activated.startContributions();
        await activated.publishRuntime();
        this.active.set(installed.pluginId, activated.plugin);
      } catch (error) {
        await activated?.plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, installed.pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(installed.pluginId, error);
        this.reportActivationFailure(installed.pluginId, error);
      }
    }
    await this.markInactiveRuntimeBindings(await listInstalledPlugins(this.configPath));
  }

  activePluginIds(): string[] {
    return [...this.active.keys()].sort();
  }
  managedWebAppStatus(bindingId: string): ManagedWebAppControlStatus {
    const binding = this.management?.config.agents[bindingId];
    if (!binding) throw new Error(`Agent Binding ${bindingId} is not configured`);
    const selection = this.managedWebApps.select(binding.runtime);
    const snapshot = selection
      ? this.managedWebApps
          .snapshots()
          .find(
            (candidate) =>
              candidate.bindingIds.includes(bindingId) &&
              candidate.selection.pluginId === selection.pluginId &&
              candidate.selection.capabilityId === selection.capabilityId &&
              candidate.selection.activationGeneration === selection.activationGeneration,
          )
      : undefined;
    return {
      bindingId,
      runtime: Object.freeze({ ...binding.runtime }),
      selection,
      instance: snapshot
        ? Object.freeze({
            instanceKey: snapshot.instanceKey,
            health: snapshot.health,
            diagnostic: snapshot.diagnostic,
            leaseCount: snapshot.bindingLeases.find((entry) => entry.bindingId === bindingId)?.leaseCount ?? 0,
          })
        : null,
    };
  }

  async acquireManagedWebApp(bindingId: string, requested?: RuntimeCapabilityRef): Promise<ManagedWebAppLease | null> {
    const binding = this.management?.config.agents[bindingId];
    if (!binding) throw new Error(`Agent Binding ${bindingId} is not configured`);
    return await this.managedWebApps.acquire(
      {
        bindingId,
        runtime: binding.runtime,
        runtimeConfiguration: deepFreeze(structuredClone(binding.runtimeConfig)),
      },
      requested,
    );
  }

  async validateRuntimeBinding(binding: AgentBindingConfig): Promise<void> {
    const installed = await this.requireInstalled(binding.runtime.pluginId);
    if (installed.status !== "active") {
      const diagnostic = installed.error ? `: ${installed.error}` : "";
      throw new Error(`Plugin ${installed.pluginId} is not active (status: ${installed.status})${diagnostic}`);
    }
    const capability = installed.manifest.capabilities.find(
      (candidate) => candidate.id === binding.runtime.capabilityId,
    );
    if (capability?.type !== "runtime") {
      throw new Error(
        `Plugin ${installed.pluginId} does not declare Runtime capability ${binding.runtime.capabilityId}`,
      );
    }

    let validationFailure: { error: unknown } | null = null;
    let activated: ActivatedCandidate | undefined;
    try {
      await revalidateInstalledPlugin(installed);
      activated = await this.activateCandidate(installed);
      await activated.revokeRuntime();
      await activated.startContributions();
      await activated.publishRuntime();
      await this.runtimeAdapters.prepare(binding);
    } catch (error) {
      validationFailure = { error };
    }
    try {
      await activated?.plugin.dispose();
    } catch (error) {
      if (!validationFailure) throw error;
    }
    if (validationFailure) throw validationFailure.error;
  }

  async upsertBindingProvider(bindingId: string, binding: AgentBindingConfig): Promise<UpsertBindingProviderResult> {
    return await this.runExclusive(async (commitConfig) => {
      const management = this.management;
      if (!management) throw new Error("Agent Binding provider mutation requires the running Connect service");
      const id = bindingId.trim();
      if (!id || id !== bindingId) throw new Error("Agent Binding ID must be a non-empty exact identity");
      const candidate = normalizeAgentBinding(id, binding);
      const installed = await this.requireInstalled(candidate.runtime.pluginId);
      if (installed.status !== "active") {
        throw new Error(`Plugin ${installed.pluginId} is not active (status: ${installed.status})`);
      }
      const capability = installed.manifest.capabilities.find(
        (entry) => entry.id === candidate.runtime.capabilityId && entry.type === "runtime",
      );
      if (capability?.type !== "runtime") {
        throw new Error(
          `Plugin ${installed.pluginId} does not declare Runtime capability ${candidate.runtime.capabilityId}`,
        );
      }
      candidate.runtimeConfig = validatePluginConfiguration(
        capability.configurationSchema,
        candidate.runtimeConfig,
        `Agent Binding ${id} Runtime configuration`,
      );
      let prepared: PreparedRuntimeAdapter;
      try {
        prepared = await this.runtimeAdapters.prepareBindingAdapter(id, candidate);
      } catch (error) {
        throw new RuntimeProviderValidationError(error instanceof Error ? error.message : String(error), error);
      }
      let committedCandidate: AgentBindingConfig;
      try {
        committedCandidate = await commitConfig(async (config) => {
          await prepared.commit();
          config.agents[id] = candidate;
          if (!config.defaultAgent) config.defaultAgent = id;
          return structuredClone(candidate);
        });
      } catch (error) {
        await prepared.rollback().catch(() => undefined);
        throw error;
      }
      await prepared.finalize().catch((error) => this.reportActivationFailure(candidate.runtime.pluginId, error));
      return { binding: committedCandidate, modes: [...prepared.modes] };
    });
  }

  async list(): Promise<InstalledPluginLockEntry[]> {
    return await listInstalledPlugins(this.configPath);
  }

  async install(options: CoreManagePluginOptions): Promise<InstalledPluginLockEntry> {
    const resolved = await resolvePluginSource(options.source, { ...this.sourceOptions, target: options.target });
    return await this.installResolved(resolved, options);
  }

  async installUpload(
    fileName: string,
    bytes: Uint8Array,
    options: Omit<ManagePluginOptions, "source"> = {},
  ): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      try {
        const resolved = await persistUploadedPluginSource(this.configPath, fileName, bytes, options);
        const staged = await stagePluginBundle({
          configPath: this.configPath,
          source: resolved.source,
          bundle: resolved.bundle,
          target: resolved.target,
          installationConfiguration: options.installationConfiguration,
          capabilityConfigurations: options.capabilityConfigurations,
        });
        const alreadyInstalled = (await listInstalledPlugins(this.configPath)).some(
          (installed) => installed.pluginId === staged.entry.pluginId,
        );
        return alreadyInstalled
          ? await this.switchToStaged(staged, "upload-replace")
          : await this.installStaged(staged);
      } catch (error) {
        await removeUnreferencedManagedPluginUploads(this.configPath).catch(() => undefined);
        throw error;
      }
    });
  }
  async replace(pluginId: string, options: CoreManagePluginOptions): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const resolved = await resolvePluginSource(options.source, {
        ...this.sourceOptions,
        target: options.target ?? installed.target,
      });
      const staged = await stagePluginBundle({
        configPath: this.configPath,
        source: resolved.source,
        bundle: resolved.bundle,
        target: resolved.target,
        installationConfiguration: options.installationConfiguration ?? installed.installationConfiguration,
        capabilityConfigurations: options.capabilityConfigurations ?? installed.capabilityConfigurations,
      });
      if (staged.entry.pluginId !== pluginId) {
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
        throw new Error(
          `Replacement Bundle identity ${staged.entry.pluginId} does not match installed Plugin ${pluginId}`,
        );
      }
      return await this.switchToStaged(staged, "source-replace");
    });
  }

  async reinstall(pluginId: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const resolverOptions: OfficialPluginDiscoveryOptions = { ...this.sourceOptions, target: installed.target };
      if (installed.source.type === "npm") resolverOptions.npmRegistry = installed.source.registry;
      if (installed.source.type === "github") resolverOptions.githubApiBase = installed.source.apiBase;
      const reference =
        installed.source.type === "local"
          ? `local:${installed.source.path}`
          : installed.source.type === "npm"
            ? `npm:${installed.source.package}@${installed.source.version}`
            : `github:${installed.source.repository}@${installed.source.release}`;
      const resolved = await resolvePluginSource(reference, resolverOptions);
      const staged = await stagePluginBundle({
        configPath: this.configPath,
        source: resolved.source,
        bundle: resolved.bundle,
        target: installed.target,
        installationConfiguration: installed.installationConfiguration,
        capabilityConfigurations: installed.capabilityConfigurations,
      });
      if (staged.entry.pluginId !== pluginId || staged.entry.version !== installed.version) {
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
        throw new Error(`Reinstall must preserve exact Plugin identity and version ${pluginId}@${installed.version}`);
      }
      return await this.switchToStaged(staged, "update");
    });
  }

  async checkUpdates(): Promise<Record<string, PluginUpdateCheck>> {
    const installed = await this.list();
    const checks = new Array<readonly [string, PluginUpdateCheck]>(installed.length);
    let nextIndex = 0;
    const checkNext = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        if (index >= installed.length) return;
        nextIndex += 1;
        const entry = installed[index];
        if (!entry) return;
        try {
          const resolverOptions: OfficialPluginDiscoveryOptions = { ...this.sourceOptions, target: entry.target };
          if (entry.source.type === "npm") resolverOptions.npmRegistry = entry.source.registry;
          if (entry.source.type === "github") resolverOptions.githubApiBase = entry.source.apiBase;
          const resolved = await resolvePluginSource(updateReferenceForSource(entry.source), resolverOptions);
          const artifact = resolved.bundle.manifest.artifacts.find((candidate) => candidate.target === entry.target);
          if (!artifact) throw new Error(`Resolved Plugin does not support target ${entry.target}`);
          if (pluginSourceIdentity(resolved.source) !== pluginSourceIdentity(entry.source)) {
            throw new Error("Update discovery resolved a different Plugin source");
          }
          const status =
            resolved.bundle.manifest.version === entry.version && artifact.integrity === entry.integrity
              ? "current"
              : "available";
          checks[index] = [
            entry.pluginId,
            { status, version: resolved.bundle.manifest.version, integrity: artifact.integrity, diagnostic: null },
          ];
        } catch (error) {
          checks[index] = [
            entry.pluginId,
            {
              status: "check-failed",
              version: null,
              integrity: null,
              diagnostic: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(installed.length, MAX_CONCURRENT_PLUGIN_UPDATE_CHECKS) }, () => checkNext()),
    );
    return Object.fromEntries(checks);
  }

  async configure(pluginId: string, options: ConfigurePluginOptions): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async (commitConfig) => {
      const installed = await this.requireInstalled(pluginId);
      const installationConfiguration = validatePluginConfiguration(
        installed.manifest.installationConfigurationSchema,
        options.installationConfiguration,
        `Plugin ${pluginId} installation configuration`,
      );
      const installationCapabilities = installed.manifest.capabilities.filter(
        (capability) =>
          capability.type === "managed-web-app" ||
          capability.type === "exposure" ||
          capability.type === "client-extension",
      );
      const installationCapabilityIds = new Set(installationCapabilities.map((capability) => capability.id));
      const unknownCapabilities = Object.keys(options.capabilityConfigurations).filter(
        (id) => !installationCapabilityIds.has(id),
      );
      if (unknownCapabilities.length > 0) {
        throw new Error(`Plugin ${pluginId} has no installation-scoped capability ${unknownCapabilities.join(", ")}`);
      }
      const capabilityConfigurations = Object.fromEntries(
        installationCapabilities.map((capability) => [
          capability.id,
          validatePluginConfiguration(
            capability.configurationSchema,
            options.capabilityConfigurations[capability.id] ?? {},
            `Plugin ${pluginId}/${capability.id} ${
              capability.type === "managed-web-app"
                ? "Managed Web App"
                : capability.type === "exposure"
                  ? "Exposure"
                  : "Client Extension"
            } configuration`,
          ),
        ]),
      );
      const nextRuntimeConfigurations = this.validatedRuntimeConfigurations(installed, options.runtimeConfigurations);
      const configuredCandidate: InstalledPluginLockEntry = {
        ...installed,
        activationGeneration: installed.activationGeneration + 1,
        installationConfiguration,
        capabilityConfigurations,
        error: null,
      };
      const dependentBindingIds = this.validateDependentBindings(
        configuredCandidate,
        new Map(nextRuntimeConfigurations),
      );
      const oldActive = this.active.get(pluginId);
      let candidate: ActivatedCandidate | undefined;
      let restoreOldDurableState: (() => void) | undefined;
      let configurationCommitted = false;
      let configured!: InstalledPluginLockEntry;
      try {
        const activatedCandidate = await this.activateCandidate(
          configuredCandidate,
          oldActive ? runtimeRefs(installed) : undefined,
          installed.activationGeneration,
        );
        candidate = activatedCandidate;
        return await this.withBindingQuiescence(dependentBindingIds, async () => {
          restoreOldDurableState = await oldActive?.fenceDurableState();
          await activatedCandidate.refreshDurableStateMigrations();
          await this.commitDurableStateMigrations(activatedCandidate);
          configured = await updateInstalledPluginConfiguration(
            this.configPath,
            pluginId,
            installationConfiguration,
            capabilityConfigurations,
          );
          configurationCommitted = true;
          try {
            await this.saveRuntimeConfigurations(nextRuntimeConfigurations, commitConfig);
          } catch (error) {
            await restoreInstalledPluginConfiguration(this.configPath, installed);
            configurationCommitted = false;
            throw error;
          }
          if (installed.status !== "active") {
            activatedCandidate.plugin.installed = configured;
            await activatedCandidate.plugin.dispose();
            return configured;
          }

          activatedCandidate.plugin.installed = configured;
          await activatedCandidate.revokeRuntime();
          this.active.delete(pluginId);
          await oldActive?.dispose();
          await activatedCandidate.startContributions();
          await activatedCandidate.publishRuntime();
          this.active.set(pluginId, activatedCandidate.plugin);
          return configured;
        });
      } catch (error) {
        if (configurationCommitted) {
          this.active.delete(pluginId);
          await oldActive?.dispose().catch(() => undefined);
        }
        await candidate?.plugin.dispose().catch(() => undefined);
        if (!configurationCommitted && candidate) {
          await this.discardDurableStateMigrations(candidate).catch(() => undefined);
        }
        if (!configurationCommitted) restoreOldDurableState?.();
        if (configurationCommitted) await this.markDependentBindingsUnavailable(pluginId, error);
        await recordInstalledPluginError(
          this.configPath,
          pluginId,
          error,
          !configurationCommitted && installed.status === "active",
        ).catch(() => undefined);
        this.reportActivationFailure(pluginId, error);
        throw error;
      }
    });
  }

  async update(pluginId: string, options: Partial<CoreManagePluginOptions> = {}): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const resolverOptions: OfficialPluginDiscoveryOptions = {
        ...this.sourceOptions,
        target: options.target ?? installed.target,
      };
      if (installed.source.type === "npm") resolverOptions.npmRegistry = installed.source.registry;
      if (installed.source.type === "github") resolverOptions.githubApiBase = installed.source.apiBase;
      const resolved = await resolvePluginSource(
        options.source ?? updateReferenceForSource(installed.source),
        resolverOptions,
      );
      if (pluginSourceIdentity(resolved.source) !== pluginSourceIdentity(installed.source)) {
        throw new Error(
          `Plugin ${pluginId} source is immutable; installed ${pluginSourceIdentity(installed.source)}, resolved ${pluginSourceIdentity(resolved.source)}`,
        );
      }
      const staged = await stagePluginBundle({
        configPath: this.configPath,
        source: resolved.source,
        bundle: resolved.bundle,
        target: resolved.target,
        installationConfiguration: options.installationConfiguration ?? installed.installationConfiguration,
        capabilityConfigurations: options.capabilityConfigurations ?? installed.capabilityConfigurations,
      });
      if (staged.entry.pluginId !== pluginId) {
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
        throw new Error(`Update Bundle identity ${staged.entry.pluginId} does not match installed Plugin ${pluginId}`);
      }
      return await this.switchToStaged(staged, "update");
    });
  }

  async select(pluginId: string, version: string, integrity?: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const staged = await selectInstalledPluginVersion(this.configPath, pluginId, version, integrity);
      await revalidateInstalledPlugin(staged.entry);
      return await this.switchToStaged(staged, "select");
    });
  }
  async discoverOfficial(): Promise<OfficialPluginDiscovery> {
    this.officialCandidates.clear();
    return await discoverOfficialPlugins(this.sourceOptions, (entry) => {
      this.officialCandidates.set(entry.pluginId, { entry });
    });
  }

  async installOfficial(pluginIds: readonly string[]): Promise<InstalledPluginLockEntry[]> {
    const requested = new Set(pluginIds);
    if (requested.size !== pluginIds.length || [...requested].some((pluginId) => !pluginId.trim())) {
      throw new Error("Official Plugin selection contains an empty or duplicate identity");
    }
    const installed: InstalledPluginLockEntry[] = [];
    try {
      for (const pluginId of pluginIds) {
        const candidate = this.officialCandidates.get(pluginId);
        if (!candidate) {
          throw new Error(
            `Official Plugin ${pluginId} is not in the latest staged discovery; discover again before setup`,
          );
        }
        const entry = candidate.entry;
        const resolved = await resolveBundledOfficialPlugin(entry, this.sourceOptions);
        installed.push(
          await this.installOfficialResolved(resolved, {
            installationConfiguration: entry.installationConfiguration,
            capabilityConfigurations: entry.capabilityConfigurations,
          }),
        );
      }
      return installed;
    } finally {
      this.officialCandidates.clear();
    }
  }

  async disable(pluginId: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      const dependentBindingIds = this.management ? pluginDependents(this.management.config, pluginId) : [];
      return await this.withBindingQuiescence(dependentBindingIds, async () => {
        const active = this.active.get(pluginId);
        try {
          await active?.retireManagedResources();
          await active?.dispose();
        } catch (error) {
          this.reportActivationFailure(pluginId, error);
          throw new Error(`Plugin ${pluginId} could not be disabled because managed resource retirement failed`, {
            cause: error,
          });
        }
        this.active.delete(pluginId);
        await this.markDependentBindingsUnavailable(
          pluginId,
          new Error(`Plugin Bundle ${pluginId}@${installed.version} is disabled`),
        );
        return await setInstalledPluginStatus(this.configPath, pluginId, "disabled");
      });
    });
  }

  async enable(pluginId: string): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const installed = await this.requireInstalled(pluginId);
      if (this.active.has(pluginId)) return installed;
      const selected: InstalledPluginLockEntry = {
        ...installed,
        activationGeneration: installed.activationGeneration + 1,
        status: "active",
        error: null,
      };
      let candidate: ActivatedCandidate | undefined;
      let generationCommitted = false;
      try {
        await revalidateInstalledPlugin(selected);
        const dependentBindingIds = this.validateDependentBindings(selected);
        const activated = await this.activateCandidate(selected, undefined, installed.activationGeneration, true);
        candidate = activated;
        return await this.withBindingQuiescence(dependentBindingIds, async () => {
          await activated.refreshDurableStateMigrations();
          await this.commitDurableStateMigrations(activated);
          const enabled = await setInstalledPluginStatus(
            this.configPath,
            pluginId,
            "active",
            null,
            selected.activationGeneration,
          );
          generationCommitted = true;
          await activated.revokeRuntime();
          await activated.startContributions();
          await activated.publishRuntime();
          this.active.set(pluginId, activated.plugin);
          return enabled;
        });
      } catch (error) {
        this.active.delete(pluginId);
        await candidate?.plugin.dispose().catch(() => undefined);
        if (!generationCommitted && candidate) {
          await this.discardDurableStateMigrations(candidate).catch(() => undefined);
        }
        await recordInstalledPluginError(this.configPath, pluginId, error, !generationCommitted).catch(() => undefined);
        await this.markDependentBindingsUnavailable(pluginId, error);
        this.reportActivationFailure(pluginId, error);
        throw error;
      }
    });
  }

  async remove(pluginId: string, force = false): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async (commitConfig) => {
      await this.requireInstalled(pluginId);
      const config = this.management?.config ?? (await loadConfig(this.configPath));
      const dependents = pluginDependents(config, pluginId);
      if (dependents.length > 0 && !force) {
        throw new Error(
          `Plugin ${pluginId} is required by Agent Bindings: ${dependents.join(", ")}; retry with force to purge them`,
        );
      }
      if (dependents.length > 0 && !this.management?.retireRuntimeBindings) {
        await setInstalledPluginStatus(
          this.configPath,
          pluginId,
          "disabled",
          "Force removal is unavailable outside the running Connect service",
        );
        throw new Error(`Plugin ${pluginId} force removal requires running Agent Binding transport retirement`);
      }
      const originalConfig = dependents.length > 0 ? structuredClone(config) : config;
      return await this.withBindingQuiescence(dependents, async () => {
        const active = this.active.get(pluginId);
        if (active) {
          try {
            await active.retireManagedResources();
          } catch (error) {
            this.reportActivationFailure(pluginId, error);
            throw new Error(`Plugin ${pluginId} could not be removed because managed resource retirement failed`, {
              cause: error,
            });
          }
        }
        if (dependents.length > 0) {
          const retireRuntimeBindings = this.management?.retireRuntimeBindings;
          if (!retireRuntimeBindings) throw new Error("Agent Binding transport retirement is unavailable");
          try {
            await retireRuntimeBindings(dependents);
          } catch (error) {
            await recordInstalledPluginError(this.configPath, pluginId, error).catch(() => undefined);
            await this.markDependentBindingsUnavailable(pluginId, error).catch(() => undefined);
            this.reportActivationFailure(pluginId, error);
            throw error;
          }
        }
        if (active) {
          try {
            await active.dispose();
            this.active.delete(pluginId);
          } catch (error) {
            const failure = new Error(
              `Plugin Bundle disposal failed: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
            await recordInstalledPluginError(this.configPath, pluginId, failure).catch(() => undefined);
            await this.markDependentBindingsUnavailable(pluginId, failure).catch(() => undefined);
            this.reportActivationFailure(pluginId, failure);
            throw failure;
          }
        }
        if (dependents.length > 0) {
          if (!this.management) throw new Error("Binding purge requires running Connect management dependencies");
          await setInstalledPluginStatus(this.configPath, pluginId, "disabled");
          await commitConfig((config) => {
            for (const bindingId of dependents) delete config.agents[bindingId];
            if (config.defaultAgent && dependents.includes(config.defaultAgent)) {
              config.defaultAgent = Object.keys(config.agents)[0] ?? null;
            }
          });
          for (const [index, bindingId] of dependents.entries()) {
            try {
              await this.purgeDependentBindingState(bindingId);
            } catch (error) {
              await commitConfig((config) => {
                for (const pendingBindingId of dependents.slice(index)) {
                  config.agents[pendingBindingId] = originalConfig.agents[pendingBindingId];
                }
                if (originalConfig.defaultAgent && config.agents[originalConfig.defaultAgent]) {
                  config.defaultAgent = originalConfig.defaultAgent;
                } else if (config.defaultAgent && !config.agents[config.defaultAgent]) {
                  config.defaultAgent = Object.keys(config.agents)[0] ?? null;
                }
              });
              throw error;
            }
          }
        }
        await this.management?.stateStore.deletePluginDurableStateForPlugin(pluginId);
        const removed = await removeInstalledPlugin(this.configPath, pluginId);
        try {
          await removePluginArtifacts(this.configPath, pluginId);
        } finally {
          await removeUnreferencedManagedPluginUploads(this.configPath);
        }
        return removed;
      });
    });
  }

  async retireManagedResources(): Promise<void> {
    for (const plugin of [...this.active.values()].reverse()) {
      await plugin.retireManagedResources();
    }
  }

  preserveOnShutdown(preserve: boolean): void {
    this.preservePublicationsOnShutdown = preserve;
    for (const plugin of this.active.values()) plugin.preserveOnShutdown(preserve);
  }

  async close(): Promise<void> {
    this.officialCandidates.clear();
    await this.operationCoordinator.idle();
    this.optionalSurfacesReady = false;
    const active = [...this.active.values()].reverse();
    const results: PromiseSettledResult<void>[] = [];
    if (!this.preservePublicationsOnShutdown)
      results.push(...(await Promise.allSettled([this.retireManagedResources()])));
    this.active.clear();
    for (const plugin of active) {
      results.push(...(await Promise.allSettled([plugin.dispose()])));
    }
    results.push(...(await Promise.allSettled([this.managedWebApps.close()])));
    this.bindingRuntimes = [];
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private validatedRuntimeConfigurations(
    installed: InstalledPluginLockEntry,
    configurations: Record<string, Record<string, unknown>>,
  ): Array<[bindingId: string, configuration: Record<string, unknown>]> {
    if (Object.keys(configurations).length > 0 && !this.management) {
      throw new Error("Runtime capability configuration requires the running Connect service");
    }
    return Object.entries(configurations).map(([bindingId, configuration]) => {
      const binding = this.management?.config.agents[bindingId];
      if (!binding || binding.runtime.pluginId !== installed.pluginId) {
        throw new Error(`Agent Binding ${bindingId} is not a dependent of Plugin ${installed.pluginId}`);
      }
      const capability = installed.manifest.capabilities.find(
        (candidate) => candidate.type === "runtime" && candidate.id === binding.runtime.capabilityId,
      );
      if (capability?.type !== "runtime") {
        throw new Error(
          `Plugin ${installed.pluginId} does not declare Runtime capability ${binding.runtime.capabilityId}`,
        );
      }
      return [
        bindingId,
        validatePluginConfiguration(
          capability.configurationSchema,
          configuration,
          `Agent Binding ${bindingId} Runtime configuration for ${installed.pluginId}/${capability.id}`,
        ),
      ];
    });
  }

  private async saveRuntimeConfigurations(
    configurations: Array<[bindingId: string, configuration: Record<string, unknown>]>,
    commitConfig: LockedConfigMutation,
  ): Promise<void> {
    if (configurations.length === 0) return;
    if (!this.management) throw new Error("Runtime capability configuration requires the running Connect service");
    await commitConfig((config) => {
      for (const [bindingId, configuration] of configurations) {
        const binding = config.agents[bindingId];
        if (!binding) throw new Error(`Agent Binding ${bindingId} is no longer available`);
        binding.runtimeConfig = configuration;
      }
    });
  }
  private async installOfficialResolved(
    resolved: ResolvedPluginSource,
    options: ResolvedPluginInstallOptions,
  ): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => {
      const staged = await stagePluginBundle({
        configPath: this.configPath,
        source: resolved.source,
        bundle: resolved.bundle,
        target: resolved.target,
        installationConfiguration: options.installationConfiguration,
        capabilityConfigurations: options.capabilityConfigurations,
      });
      const alreadyInstalled = (await listInstalledPlugins(this.configPath)).some(
        (installed) => installed.pluginId === staged.entry.pluginId,
      );
      return alreadyInstalled
        ? await this.switchToStaged(staged, "official-replace")
        : await this.installStaged(staged);
    });
  }

  private async installResolved(
    resolved: ResolvedPluginSource,
    options: ResolvedPluginInstallOptions,
  ): Promise<InstalledPluginLockEntry> {
    return await this.runExclusive(async () => await this.installResolvedWithinQueue(resolved, options));
  }

  private async installResolvedWithinQueue(
    resolved: ResolvedPluginSource,
    options: ResolvedPluginInstallOptions,
  ): Promise<InstalledPluginLockEntry> {
    const staged = await stagePluginBundle({
      configPath: this.configPath,
      source: resolved.source,
      bundle: resolved.bundle,
      target: resolved.target,
      installationConfiguration: options.installationConfiguration,
      capabilityConfigurations: options.capabilityConfigurations,
    });
    return await this.installStaged(staged);
  }

  private async installStaged(staged: StagedPlugin): Promise<InstalledPluginLockEntry> {
    let candidate: ActivatedCandidate | undefined;
    let lockCommitted = false;
    try {
      this.validateDependentBindings(staged.entry);
      candidate = await this.activateCandidate(staged.entry, [], null);
      await candidate.refreshDurableStateMigrations();
      await this.commitDurableStateMigrations(candidate);
      const installed = await commitStagedPlugin(this.configPath, staged, "install");
      lockCommitted = true;
      candidate.plugin.installed = installed;
      await candidate.revokeRuntime();
      await candidate.startContributions();
      await candidate.publishRuntime();
      this.active.set(installed.pluginId, candidate.plugin);
      for (const activePlugin of this.active.values()) {
        await activePlugin.reconcileManagedWebApps();
      }
      return installed;
    } catch (error) {
      await candidate?.plugin.dispose().catch(() => undefined);
      if (lockCommitted) {
        await recordInstalledPluginError(this.configPath, staged.entry.pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(staged.entry.pluginId, error);
      } else {
        if (candidate) await this.discardDurableStateMigrations(candidate).catch(() => undefined);
        await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
      }
      this.reportActivationFailure(staged.entry.pluginId, error);
      throw error;
    }
  }

  private async switchToStaged(
    staged: StagedPlugin,
    operation: "update" | "upload-replace" | "source-replace" | "official-replace" | "select",
  ): Promise<InstalledPluginLockEntry> {
    const existing = await this.requireInstalled(staged.entry.pluginId);
    const oldActive = this.active.get(staged.entry.pluginId);
    const replacedRuntimeRefs = oldActive ? runtimeRefs(existing) : undefined;
    const dependentBindingIds = this.validateDependentBindings(staged.entry);
    let candidate: ActivatedCandidate | undefined;
    let lockCommitted = false;
    const oldManagedWebAppReferences = oldActive ? managedWebAppReferences(existing) : [];
    try {
      const activated = await this.activateCandidate(staged.entry, replacedRuntimeRefs, existing.activationGeneration);
      candidate = activated;
      return await this.withBindingQuiescence(dependentBindingIds, async () => {
        await activated.refreshDurableStateMigrations();
        await this.commitDurableStateMigrations(activated);
        const installed = await commitStagedPlugin(this.configPath, staged, operation);
        lockCommitted = true;
        activated.plugin.installed = installed;
        if (oldActive) {
          for (const reference of oldManagedWebAppReferences) this.managedWebApps.fence(reference);
          await oldActive.fenceDurableState();
        }
        await activated.revokeRuntime();
        if (oldActive) {
          for (const reference of oldManagedWebAppReferences) {
            for (const retire of this.managedWebAppLeaseRetirers) await retire(reference);
            for (const activePlugin of this.active.values()) {
              await activePlugin.retireManagedWebApp(reference);
            }
          }
        }
        this.active.delete(installed.pluginId);
        await oldActive?.dispose();
        await activated.startContributions();
        await activated.publishRuntime();
        this.active.set(installed.pluginId, activated.plugin);
        for (const activePlugin of this.active.values()) {
          await activePlugin.reconcileManagedWebApps();
        }
        return installed;
      });
    } catch (error) {
      if (lockCommitted) {
        this.active.delete(staged.entry.pluginId);
        await oldActive?.dispose().catch(() => undefined);
        await candidate?.plugin.dispose().catch(() => undefined);
        await recordInstalledPluginError(this.configPath, staged.entry.pluginId, error).catch(() => undefined);
        await this.markDependentBindingsUnavailable(staged.entry.pluginId, error);
        this.reportActivationFailure(staged.entry.pluginId, error);
        throw error;
      }

      await candidate?.plugin.dispose().catch(() => undefined);
      if (candidate) await this.discardDurableStateMigrations(candidate).catch(() => undefined);
      await discardStagedPlugin(this.configPath, staged).catch(() => undefined);
      await recordInstalledPluginError(
        this.configPath,
        staged.entry.pluginId,
        error,
        existing.status === "active",
      ).catch(() => undefined);
      this.reportActivationFailure(staged.entry.pluginId, error);
      throw error;
    }
  }

  private validateDependentBindings(
    installed: InstalledPluginLockEntry,
    runtimeConfigurations?: ReadonlyMap<string, Record<string, unknown>>,
  ): string[] {
    if (!this.management) return [];
    const dependentBindingIds = pluginDependents(this.management.config, installed.pluginId);
    for (const bindingId of dependentBindingIds) {
      const binding = this.management.config.agents[bindingId];
      if (!binding || binding.runtime.pluginId !== installed.pluginId) {
        throw new Error(`Agent Binding ${bindingId} is not an exact dependent of Plugin ${installed.pluginId}`);
      }
      const capability = installed.manifest.capabilities.find(
        (candidate) => candidate.id === binding.runtime.capabilityId,
      );
      if (capability?.type !== "runtime") {
        throw new Error(
          `Agent Binding ${bindingId} requires missing Runtime capability ${installed.pluginId}/${binding.runtime.capabilityId}`,
        );
      }
      validatePluginConfiguration(
        capability.configurationSchema,
        runtimeConfigurations?.get(bindingId) ?? binding.runtimeConfig,
        `Agent Binding ${bindingId} Runtime configuration for ${installed.pluginId}/${capability.id}`,
      );
    }
    return dependentBindingIds;
  }

  private async requireInstalled(pluginId: string): Promise<InstalledPluginLockEntry> {
    const installed = (await listInstalledPlugins(this.configPath)).find(
      (candidate) => candidate.pluginId === pluginId,
    );
    if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
    return installed;
  }

  private async markDependentBindingsUnavailable(pluginId: string, error: unknown): Promise<void> {
    if (!this.management) return;
    const detail = `Plugin Bundle ${pluginId} unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const dependents = pluginDependents(this.management.config, pluginId);
    await Promise.allSettled(
      dependents.map(async (bindingId) => {
        await this.management?.stateStore.setRuntimeAvailability(bindingId, "startup-unavailable", detail);
      }),
    );
  }

  private async markInactiveRuntimeBindings(installedPlugins: readonly InstalledPluginLockEntry[]): Promise<void> {
    if (!this.management) return;
    await Promise.allSettled(
      Object.entries(this.management.config.agents).map(async ([bindingId, binding]) => {
        if (this.runtimeAdapters.hasProvider(binding)) return;
        const installed = installedPlugins.find((candidate) => candidate.pluginId === binding.runtime.pluginId);
        const capability = installed?.manifest.capabilities.find(
          (candidate) => candidate.id === binding.runtime.capabilityId && candidate.type === "runtime",
        );
        let reason: string;
        if (!installed) {
          reason = `Plugin ${binding.runtime.pluginId} is not installed`;
        } else if (capability?.type !== "runtime") {
          reason = `Plugin ${installed.pluginId} does not declare this Runtime capability`;
        } else if (installed.status !== "active") {
          reason = `Plugin ${installed.pluginId} is ${installed.status}${installed.error ? `: ${installed.error}` : ""}`;
        } else {
          reason = `Plugin ${installed.pluginId} failed to activate this Runtime capability`;
        }
        await this.management?.stateStore.setRuntimeAvailability(
          bindingId,
          "startup-unavailable",
          `Runtime Plugin capability ${binding.runtime.pluginId}/${binding.runtime.capabilityId} is not active: ${reason}`,
        );
      }),
    );
  }

  private async purgeDependentBindingState(bindingId: string): Promise<void> {
    if (!this.management) throw new Error("Binding purge requires running Connect management dependencies");
    const sessionRefs = (await this.management.stateStore.listAllRuntimeSessions())
      .filter((session) => session.agentId === bindingId)
      .map((session) => session.sessionRef);
    await new FileTurnSubmissionStaging(this.management.config.stateDbPath).purgeSessions(sessionRefs);
    await this.management.workspaces.purgeBindingCatalog(bindingId);
    await this.management.stateStore.purgeAgentBinding(bindingId);
  }

  private async withBindingQuiescence<T>(bindingIds: readonly string[], criticalSection: () => Promise<T>): Promise<T> {
    if (!this.management?.quiesceRuntimeBindings) return await criticalSection();
    return await this.management.quiesceRuntimeBindings(bindingIds, criticalSection);
  }

  private async runExclusive<T>(operation: (commitConfig: LockedConfigMutation) => Promise<T>): Promise<T> {
    return await this.operationCoordinator.runExclusive(operation);
  }
  private async commitDurableStateMigrations(candidate: ActivatedCandidate): Promise<void> {
    if (candidate.durableStateMigrations.length === 0) return;
    if (!this.management)
      throw new Error("Plugin Durable State migration requires running Connect management dependencies");
    await this.management.stateStore.commitPluginDurableStateMigrations(candidate.durableStateMigrations);
  }
  private async discardDurableStateMigrations(candidate: ActivatedCandidate): Promise<void> {
    if (candidate.durableStateMigrations.length === 0 || !this.management) return;
    await Promise.all(
      candidate.durableStateMigrations.map(
        async ({ namespace }) => await this.management?.stateStore.deletePluginDurableStateNamespace(namespace),
      ),
    );
  }

  private createRuntimeDurableState(
    installed: InstalledPluginLockEntry,
    capabilityId: string,
    declaration: ConnectPluginDurableStateManifest | undefined,
    binding: AgentBindingConfig,
    durableStateGate: DurableStateGenerationGate,
  ): ConnectPluginDurableState | undefined {
    if (!declaration) return undefined;
    const bindingId = agentBindingIdentity(binding);
    if (!bindingId) {
      throw new Error(
        `Plugin ${installed.pluginId}/${capabilityId} Durable State requires an identified Agent Binding`,
      );
    }
    return this.createCapabilityDurableState(
      installed,
      capabilityId,
      declaration,
      bindingId,
      async () =>
        declaration.lifetime === "installation"
          ? "installation"
          : declaration.lifetime === "binding"
            ? bindingId
            : await this.requireInstallationOwner(installed.pluginId, capabilityId),
      durableStateGate,
    );
  }

  private createExposureDurableState(
    installed: InstalledPluginLockEntry,
    capabilityId: string,
    declaration: ConnectPluginDurableStateManifest | undefined,
    durableStateGate: DurableStateGenerationGate,
  ): ConnectPluginDurableState | undefined {
    if (!declaration || declaration.lifetime === "binding") return undefined;
    return this.createCapabilityDurableState(
      installed,
      capabilityId,
      declaration,
      "exposure",
      async () =>
        declaration.lifetime === "installation"
          ? "installation"
          : await this.requireInstallationOwner(installed.pluginId, capabilityId),
      durableStateGate,
    );
  }

  private createExposureBindingDurableState(
    installed: InstalledPluginLockEntry,
    capabilityId: string,
    bindingId: string,
    durableStateGate: DurableStateGenerationGate,
  ): ConnectPluginDurableState {
    if (
      typeof capabilityId !== "string" ||
      !capabilityId.trim() ||
      capabilityId !== capabilityId.trim() ||
      typeof bindingId !== "string" ||
      !bindingId.trim() ||
      bindingId !== bindingId.trim()
    ) {
      throw new Error("Exposure Binding Durable State requires exact capability and Agent Binding identities");
    }
    const capability = installed.manifest.capabilities.find(
      (candidate) => candidate.id === capabilityId && candidate.type === "exposure",
    );
    const declaration = capability?.type === "exposure" ? capability.durableState : undefined;
    if (declaration?.lifetime !== "binding") {
      throw new Error(`Plugin ${installed.pluginId}/${capabilityId} does not declare Exposure Binding Durable State`);
    }
    return this.createCapabilityDurableState(
      installed,
      capabilityId,
      declaration,
      bindingId,
      async () => {
        if (!this.management) {
          throw new Error("Plugin Durable State requires running Connect management dependencies");
        }
        if (!this.management.config.agents[bindingId]) {
          throw new Error(`Agent Binding ${bindingId} is not available to Plugin ${installed.pluginId}`);
        }
        return bindingId;
      },
      durableStateGate,
    );
  }

  private createCapabilityDurableState(
    installed: InstalledPluginLockEntry,
    capabilityId: string,
    declaration: ConnectPluginDurableStateManifest,
    instanceId: string,
    scopeKey: () => Promise<string>,
    durableStateGate: DurableStateGenerationGate,
  ): ConnectPluginDurableState {
    const validateState = compilePluginDurableStateValidator(
      declaration.schema,
      `Plugin ${installed.pluginId}/${capabilityId} Durable State`,
    );
    const namespace = async (): Promise<PluginDurableStateNamespace> => ({
      pluginId: installed.pluginId,
      activationGeneration: installed.activationGeneration,
      capabilityId,
      instanceId,
      lifetime: declaration.lifetime,
      scopeKey: await scopeKey(),
    });
    const assertGeneration = async (): Promise<ConnectStateStore> => {
      const selected = await this.requireInstalled(installed.pluginId);
      if (selected.status !== "active" || selected.activationGeneration !== installed.activationGeneration) {
        throw new Error(
          `Plugin ${installed.pluginId}/${capabilityId} Durable State rejected stale Activation Generation ${installed.activationGeneration}`,
        );
      }
      if (!this.management) throw new Error("Plugin Durable State requires running Connect management dependencies");
      return this.management.stateStore;
    };
    return Object.freeze({
      read: async (): Promise<ConnectPluginDurableStateRecord | null> =>
        await durableStateGate.run(async () => {
          const store = await assertGeneration();
          const record = await store.readPluginDurableState(await namespace());
          if (!record) return null;
          if (record.schemaVersion !== declaration.schemaVersion) {
            throw new Error(
              `Plugin ${installed.pluginId}/${capabilityId} Durable State schema ${record.schemaVersion} is not selected schema ${declaration.schemaVersion}`,
            );
          }
          return Object.freeze({
            schemaVersion: record.schemaVersion,
            revision: record.revision,
            value: deepFreeze(validateState(record.value)),
          });
        }),
      compareAndSwap: async (
        expectedRevision: number | null,
        value: Readonly<Record<string, unknown>>,
      ): Promise<ConnectPluginDurableStateRecord> =>
        await durableStateGate.run(async () => {
          const store = await assertGeneration();
          const record = await store.compareAndSwapPluginDurableState(
            await namespace(),
            expectedRevision,
            declaration.schemaVersion,
            validateState(value),
          );
          return Object.freeze({
            schemaVersion: record.schemaVersion,
            revision: record.revision,
            value: deepFreeze(validateState(record.value)),
          });
        }),
    });
  }

  private async requireInstallationOwner(pluginId: string, capabilityId: string): Promise<string> {
    if (!this.management) throw new Error("Plugin Durable State requires running Connect management dependencies");
    const owner = await this.management.stateStore.getInstallationOwner();
    if (!owner) {
      throw new Error(`Plugin ${pluginId}/${capabilityId} owner-scoped Durable State requires an Installation Owner`);
    }
    return owner;
  }

  private async prepareDurableStateMigrations(
    installed: InstalledPluginLockEntry,
    entry: ConnectPluginEntry,
    sourceActivationGeneration: number | null,
    reactivateDurableState: boolean,
  ): Promise<PluginDurableStateMigrationCommit[]> {
    if (sourceActivationGeneration === installed.activationGeneration) return [];
    if (!this.management || sourceActivationGeneration === null) return [];
    const snapshots = await this.management.stateStore.listPluginDurableState(
      installed.pluginId,
      sourceActivationGeneration,
    );
    const capabilities = new Map(installed.manifest.capabilities.map((capability) => [capability.id, capability]));
    const migrations: PluginDurableStateMigrationCommit[] = [];
    for (const snapshot of snapshots) {
      const capability = capabilities.get(snapshot.namespace.capabilityId);
      const declaration = capability && "durableState" in capability ? capability.durableState : undefined;
      if (!capability || !declaration) continue;
      if (snapshot.namespace.lifetime !== declaration.lifetime) {
        throw new Error(
          `Plugin ${installed.pluginId}/${capability.id} cannot change Durable State lifetime from ${snapshot.namespace.lifetime} to ${declaration.lifetime}`,
        );
      }
      const validateState = compilePluginDurableStateValidator(
        declaration.schema,
        `Plugin ${installed.pluginId}/${capability.id} Durable State`,
      );
      if (snapshot.record.schemaVersion > declaration.schemaVersion) {
        throw new Error(
          `Plugin ${installed.pluginId}/${capability.id} Durable State schema ${snapshot.record.schemaVersion} is newer than selected schema ${declaration.schemaVersion}`,
        );
      }
      let schemaVersion = snapshot.record.schemaVersion;
      let revision = snapshot.record.revision;
      let value = snapshot.record.value;
      while (schemaVersion < declaration.schemaVersion) {
        if (!entry.migrateDurableState) {
          throw new Error(
            `Plugin ${installed.pluginId}/${capability.id} must migrate Durable State schema ${schemaVersion} to ${declaration.schemaVersion}`,
          );
        }
        const nextVersion = schemaVersion + 1;
        if (
          !declaration.migrations.some((migration) => migration.from === schemaVersion && migration.to === nextVersion)
        ) {
          throw new Error(
            `Plugin ${installed.pluginId}/${capability.id} does not declare Durable State migration ${schemaVersion} -> ${nextVersion}`,
          );
        }
        value = await entry.migrateDurableState(
          Object.freeze({
            capabilityId: capability.id,
            fromSchemaVersion: schemaVersion,
            toSchemaVersion: nextVersion,
            value: deepFreeze(structuredClone(value)) as Readonly<Record<string, unknown>>,
          }),
        );
        schemaVersion = nextVersion;
        revision += 1;
      }
      if (entry.migrateDurableStateGeneration) {
        value = await entry.migrateDurableStateGeneration(
          Object.freeze({
            capabilityId: capability.id,
            capabilityInstanceId: snapshot.namespace.instanceId,
            schemaVersion,
            fromActivationGeneration: sourceActivationGeneration,
            toActivationGeneration: installed.activationGeneration,
            reactivating: reactivateDurableState,
            value: deepFreeze(structuredClone(value)) as Readonly<Record<string, unknown>>,
          }),
        );
      }
      migrations.push({
        namespace: {
          ...snapshot.namespace,
          activationGeneration: installed.activationGeneration,
        },
        revision,
        schemaVersion,
        value: validateState(value),
      });
    }
    return migrations;
  }

  private async activateCandidate(
    installed: InstalledPluginLockEntry,
    replacedRuntimeRefs?: readonly RuntimeCapabilityRef[],
    durableStateSourceGeneration: number | null = installed.activationGeneration,
    reactivateDurableState = false,
  ): Promise<ActivatedCandidate> {
    const bundledOfficialInstallation = await isBundledOfficialPluginInstallation(installed);
    // Plugin artifact paths are runtime-selected and version-distinct, so static imports cannot represent this boundary.
    const namespace: unknown = await import(pathToFileURL(installed.activeArtifact).href);
    if (!namespace || typeof namespace !== "object" || !("default" in namespace)) {
      throw new Error(`Plugin ${installed.pluginId} entry artifact must export a default Connect Plugin entry`);
    }
    const entry = namespace.default;
    if (!entry || typeof entry !== "object" || !("activate" in entry) || typeof entry.activate !== "function") {
      throw new Error(`Plugin ${installed.pluginId} default export does not implement activate(context)`);
    }
    const pluginEntry = entry as ConnectPluginEntry;
    const durableStateGate = createDurableStateGenerationGate(
      `Plugin ${installed.pluginId} rejected stale Activation Generation ${installed.activationGeneration}`,
    );
    let durableStateMigrations = await this.prepareDurableStateMigrations(
      installed,
      pluginEntry,
      durableStateSourceGeneration,
      reactivateDurableState,
    );
    const declaredHostCapabilities = new Set(installed.manifest.dependencies.map((dependency) => dependency.id));
    const pending = new Map<string, PendingProvider>();
    let acceptingRegistrations = true;
    const register = (type: PendingProvider["type"], provider: unknown): void => {
      if (!acceptingRegistrations) {
        throw new Error(`Plugin ${installed.pluginId} attempted to register a provider after Bundle activation`);
      }
      if (!provider || typeof provider !== "object") {
        throw new Error(`Plugin ${installed.pluginId} registered a malformed ${type} provider`);
      }
      const providerRecord = provider as Record<string, unknown>;
      const capabilityId = typeof providerRecord.capabilityId === "string" ? providerRecord.capabilityId.trim() : "";
      const validOperation =
        type === "runtime"
          ? typeof providerRecord.create === "function"
          : type === "managed-web-app"
            ? typeof providerRecord.instanceKey === "function" && typeof providerRecord.acquire === "function"
            : typeof providerRecord.activate === "function";
      if (!capabilityId || !validOperation) {
        throw new Error(`Plugin ${installed.pluginId} registered a malformed ${type} provider`);
      }
      if (pending.has(capabilityId)) {
        throw new Error(`Plugin ${installed.pluginId} registered capability ${capabilityId} more than once`);
      }
      if (type === "runtime") {
        const family = typeof providerRecord.family === "string" ? providerRecord.family.trim() : "";
        if (!family) throw new Error(`Plugin ${installed.pluginId} registered a malformed Runtime provider`);
        pending.set(
          capabilityId,
          Object.freeze({
            type,
            runtime: Object.freeze({ pluginId: installed.pluginId, capabilityId }),
            family,
            implementation: provider as ConnectPluginRuntimeProvider,
          }),
        );
        return;
      }
      if (type === "managed-web-app") {
        pending.set(
          capabilityId,
          Object.freeze({
            type,
            capabilityId,
            implementation: provider as ConnectPluginManagedWebAppProvider,
          }),
        );
        return;
      }
      pending.set(
        capabilityId,
        Object.freeze({
          type,
          capabilityId,
          implementation: provider as ConnectPluginExposureProvider,
        }),
      );
    };
    const runtimeHostCapability: ConnectRuntimeProviderHostCapability = Object.freeze({
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      register: (provider: ConnectPluginRuntimeProvider) => register("runtime", provider),
    });
    const managedWebAppHostCapability: ConnectManagedWebAppProviderHostCapability = Object.freeze({
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      register: (provider: ConnectPluginManagedWebAppProvider) => register("managed-web-app", provider),
    });
    const exposureHostCapability: ConnectExposureProviderHostCapability = Object.freeze({
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      register: (provider: ConnectPluginExposureProvider) => register("exposure", provider),
    });
    const durableStateHostCapability: ConnectDurableStateHostCapability = Object.freeze({
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
      forBinding: (capabilityId: string, bindingId: string) =>
        this.createExposureBindingDurableState(installed, capabilityId, bindingId, durableStateGate),
    });
    const hostCapabilities = Object.freeze({
      get: (id: "runtime-provider" | "managed-web-app-provider" | "durable-state" | "exposure-provider") => {
        if (!declaredHostCapabilities.has(id)) {
          throw new Error(`Plugin ${installed.pluginId} used undeclared Host Capability ${id}`);
        }
        if (id === "runtime-provider") return runtimeHostCapability;
        if (id === "managed-web-app-provider") return managedWebAppHostCapability;
        if (id === "durable-state") return durableStateHostCapability;
        return exposureHostCapability;
      },
    }) as ConnectPluginHostCapabilities;
    const context: ConnectPluginContext = Object.freeze({
      activationGeneration: installed.activationGeneration,
      interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
      installationConfiguration: deepFreeze(structuredClone(installed.installationConfiguration)),
      hostCapabilities,
    });

    let pluginDisposer: ConnectPluginDisposer | undefined;
    let replacement: RuntimeAdapterReplacement | undefined;
    const runtimeDefinitions: RuntimeAdapterDefinition[] = [];
    const stagedExposures: Array<{
      capabilityId: string;
      provider: ConnectPluginExposureProvider;
      configuration: Readonly<Record<string, unknown>>;
      durableState?: ConnectPluginDurableState;
    }> = [];
    const stagedManagedWebApps: ManagedWebAppProviderDefinition[] = [];
    let managedWebAppsActivated = false;
    const exposureDisposers: ConnectPluginDisposer[] = [];
    const clientFacadeDisposers: ConnectPluginDisposer[] = [];
    const managedDisposers: OfficialLivewareManagedDisposer[] = [];
    const managedRetirements: Array<() => Promise<void>> = [];
    const managedBindingRetirements: Array<(bindingIds: readonly string[]) => Promise<void>> = [];
    let managedResourcesRetired = false;
    try {
      const activated = await pluginEntry.activate(context);
      acceptingRegistrations = false;
      if (typeof activated === "function") pluginDisposer = activated;
      const declared = installed.manifest.capabilities;
      const providerCapabilities = declared.filter(
        (capability) =>
          capability.type === "runtime" || capability.type === "managed-web-app" || capability.type === "exposure",
      );
      if (pending.size !== providerCapabilities.length) {
        throw new Error(
          `Plugin ${installed.pluginId} registered ${pending.size} providers; manifest declares ${providerCapabilities.length} server capabilities`,
        );
      }

      for (const capability of declared) {
        if (capability.type === "client-extension") continue;
        const registration = pending.get(capability.id);
        if (!registration) throw new Error(`Plugin ${installed.pluginId} did not register capability ${capability.id}`);
        if (capability.type === "runtime") {
          if (registration.type !== "runtime") {
            throw new Error(
              `Plugin ${installed.pluginId}/${capability.id} registered as ${registration.type}, expected ${capability.type}`,
            );
          }
          if (registration.family !== capability.family) {
            throw new Error(
              `Plugin ${installed.pluginId}/${capability.id} registered family ${registration.family}, expected ${capability.family}`,
            );
          }
          const validateConfiguration = compilePluginConfigurationValidator(
            capability.configurationSchema,
            `Agent Binding Runtime configuration for ${installed.pluginId}/${capability.id}`,
          );
          runtimeDefinitions.push({
            family: registration.family,
            runtime: registration.runtime,
            create: (binding) => {
              const durableState = this.createRuntimeDurableState(
                installed,
                capability.id,
                capability.durableState,
                binding,
                durableStateGate,
              );
              return bridgeRuntimeProvider(
                registration,
                validateConfiguration,
                binding,
                Object.freeze({
                  activationGeneration: installed.activationGeneration,
                  ...(durableState ? { durableState } : {}),
                }),
              );
            },
          });
          continue;
        }
        if (capability.type === "managed-web-app") {
          if (registration.type !== "managed-web-app") {
            throw new Error(
              `Plugin ${installed.pluginId}/${capability.id} registered as ${registration.type}, expected ${capability.type}`,
            );
          }
          stagedManagedWebApps.push({
            pluginId: installed.pluginId,
            activationGeneration: installed.activationGeneration,
            manifest: capability,
            installationConfiguration: deepFreeze(structuredClone(installed.installationConfiguration)),
            configuration: deepFreeze(structuredClone(installed.capabilityConfigurations[capability.id] ?? {})),
            provider: registration.implementation,
          });
          continue;
        }
        if (registration.type !== "exposure") {
          throw new Error(
            `Plugin ${installed.pluginId}/${capability.id} registered as ${registration.type}, expected ${capability.type}`,
          );
        }
        stagedExposures.push({
          capabilityId: capability.id,
          provider: registration.implementation,
          configuration: deepFreeze(structuredClone(installed.capabilityConfigurations[capability.id] ?? {})),
          durableState: this.createExposureDurableState(
            installed,
            capability.id,
            capability.durableState,
            durableStateGate,
          ),
        });
      }
    } catch (error) {
      acceptingRegistrations = false;
      await replacement?.rollback().catch(() => undefined);
      if (pluginDisposer) {
        await Promise.allSettled([Promise.resolve().then(async () => await pluginDisposer?.())]);
      }
      throw error;
    }

    let state:
      | "prepared"
      | "fencing"
      | "fenced"
      | "starting"
      | "started"
      | "publishing"
      | "published"
      | "failed"
      | "disposed" = "prepared";
    let startedExposureCount = 0;
    const assertActivationLifecycle = (): void => {
      if (state !== "starting" && state !== "started" && state !== "publishing" && state !== "published") {
        throw new Error(
          `Plugin ${installed.pluginId} rejected stale Activation Generation ${installed.activationGeneration}`,
        );
      }
    };
    const activateExposures = async (): Promise<void> => {
      while (startedExposureCount < stagedExposures.length) {
        const staged = stagedExposures[startedExposureCount];
        if (!staged) throw new Error("Exposure activation index is out of bounds");
        const officialLiveware = this.officialLivewareServices(
          installed,
          staged.capabilityId,
          bundledOfficialInstallation,
          assertActivationLifecycle,
        );
        const disposer = await staged.provider.activate(
          Object.freeze({
            activationGeneration: installed.activationGeneration,
            configuration: staged.configuration,
            ...(staged.durableState ? { durableState: staged.durableState } : {}),
            ...(officialLiveware ? { officialLiveware } : {}),
          }),
        );
        if (typeof disposer === "function") {
          exposureDisposers.push(disposer);
          if (isManagedOfficialDisposer(disposer)) {
            managedRetirements.push(async () => await disposer.retire());
            managedBindingRetirements.push(async (bindingIds) => await disposer.retireBindings(bindingIds));
            managedDisposers.push(disposer);
          }
        }
        startedExposureCount += 1;
      }
    };
    const plugin: ActivePlugin = {
      installed,
      dispose: async () => {
        if (state === "disposed") return;
        state = "disposed";
        await durableStateGate.fence();
        const results: PromiseSettledResult<void>[] = [];
        if (replacement) {
          results.push(...(await Promise.allSettled([replacement.rollback()])));
          results.push(...(await Promise.allSettled([replacement.unregister()])));
        }
        results.push(
          ...(await Promise.allSettled(exposureDisposers.reverse().map(async (dispose) => await dispose()))),
        );
        if (managedWebAppsActivated) {
          results.push(
            ...(await Promise.allSettled(
              stagedManagedWebApps.map(
                async (definition) => await this.managedWebApps.remove(managedWebAppReference(definition)),
              ),
            )),
          );
        }
        results.push(
          ...(await Promise.allSettled(clientFacadeDisposers.reverse().map(async (dispose) => await dispose()))),
        );
        if (pluginDisposer) results.push(...(await Promise.allSettled([pluginDisposer()])));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      },
      preserveOnShutdown: (preserve) => {
        for (const disposer of managedDisposers) disposer.preserveOnShutdown(preserve);
      },
      retireManagedResources: async () => {
        if (managedResourcesRetired) return;
        for (const definition of stagedManagedWebApps) {
          const reference = managedWebAppReference(definition);
          for (const retire of this.managedWebAppLeaseRetirers) await retire(reference);
          for (const activePlugin of this.active.values()) {
            await activePlugin.retireManagedWebApp(reference);
          }
        }
        for (const retire of managedRetirements.toReversed()) await retire();
        managedResourcesRetired = true;
      },
      retireBindings: async (bindingIds) => {
        for (const retire of managedBindingRetirements.toReversed()) await retire(bindingIds);
      },
      retireManagedWebApp: async (reference) => {
        for (const disposer of managedDisposers.toReversed()) {
          await disposer.retireManagedWebApp(reference);
        }
      },
      reconcileManagedWebApps: async () => {
        for (const disposer of managedDisposers.toReversed()) {
          await disposer.reconcileManagedWebApps();
        }
      },
      fenceDurableState: async () => {
        const previousState = state;
        state = "fencing";
        const restoreGate = await durableStateGate.fence();
        state = "fenced";
        let restored = false;
        return () => {
          if (restored) return;
          restored = true;
          restoreGate();
          state = previousState;
        };
      },
      activateExposures: async () => {
        if (state !== "started" && state !== "published") {
          throw new Error(`Plugin ${installed.pluginId} Exposures cannot be activated before contribution start`);
        }
        await activateExposures();
      },
    };
    return {
      plugin,
      get durableStateMigrations() {
        return durableStateMigrations;
      },
      refreshDurableStateMigrations: async () => {
        durableStateMigrations = await this.prepareDurableStateMigrations(
          installed,
          pluginEntry,
          durableStateSourceGeneration,
          reactivateDurableState,
        );
      },
      revokeRuntime: async () => {
        if (state === "fenced" || state === "started" || state === "published") return;
        if (state !== "prepared") {
          throw new Error(`Plugin ${installed.pluginId} candidate Runtime cannot be fenced`);
        }
        state = "fencing";
        try {
          if (
            durableStateSourceGeneration !== null &&
            durableStateSourceGeneration !== installed.activationGeneration
          ) {
            for (const definition of stagedManagedWebApps) {
              this.managedWebApps.fence({
                pluginId: definition.pluginId,
                capabilityId: definition.manifest.id,
                activationGeneration: durableStateSourceGeneration,
              });
            }
          }
          state = "fenced";
        } catch (error) {
          state = "failed";
          throw error;
        }
      },
      startContributions: async () => {
        if (state === "started" || state === "published") return;
        if (state !== "fenced") {
          throw new Error(`Plugin ${installed.pluginId} candidate contributions cannot be started`);
        }
        state = "starting";
        try {
          // Generic Exposures are the first effectful candidate contribution. A
          // failure must leave Provider registrations and Runtime definitions staged.
          if (this.optionalSurfacesReady) await activateExposures();
          if (stagedManagedWebApps.length > 0) {
            managedWebAppsActivated = true;
            for (const definition of stagedManagedWebApps) this.managedWebApps.activate(definition);
          }
          if (
            bundledOfficialInstallation &&
            installed.pluginId === CONNECT_CLIENT_PLUGIN_ID &&
            this.management?.clientInterfaceServices
          ) {
            const definition = stagedManagedWebApps.find(
              (candidate) => candidate.manifest.id === CONNECT_CLIENT_MANAGED_WEB_APP_REF.capabilityId,
            );
            if (!definition) throw new Error("Official Connect Client Plugin did not declare its Managed Web App");
            const services = this.management.clientInterfaceServices;
            clientFacadeDisposers.push(
              registerConnectClientHostFacade(
                createConnectClientHostFacade(
                  connectClientFacadeScope(CONNECT_CLIENT_MANAGED_WEB_APP_REF, installed.activationGeneration),
                  {
                    ...services,
                    pluginManager: this,
                    runtimes: () => this.bindingRuntimes,
                  },
                ),
              ),
            );
          }
          state = "started";
        } catch (error) {
          state = "failed";
          throw error;
        }
      },
      publishRuntime: async () => {
        if (state === "published") return;
        if (state !== "started") {
          throw new Error(`Plugin ${installed.pluginId} candidate Runtime cannot be published`);
        }
        state = "publishing";
        try {
          replacement = this.runtimeAdapters.replaceAll(runtimeDefinitions, replacedRuntimeRefs ?? []);
          await replacement.revoke();
          await replacement?.publish();
          state = "published";
        } catch (error) {
          state = "failed";
          throw error;
        }
      },
    };
  }

  private officialLivewareServices(
    installed: InstalledPluginLockEntry,
    capabilityId: string,
    bundledOfficialInstallation: boolean,
    assertActivationLifecycle: () => void,
  ): OfficialLivewareExposureServices | undefined {
    if (
      installed.pluginId !== OFFICIAL_LIVEWARE_PLUGIN_ID ||
      capabilityId !== OFFICIAL_LIVEWARE_CAPABILITY_ID ||
      !bundledOfficialInstallation ||
      !this.management
    ) {
      return undefined;
    }
    const management = this.management;
    const dependencies = async (): Promise<LivewareControlDependencies> => {
      if (management.livewareDependencies) return management.livewareDependencies;
      const livewarePath = join(dirname(installed.activeArtifact), "..", "assets", "liveware");
      await chmod(livewarePath, 0o700);
      return createLivewareControlDependencies({
        livewarePath,
        clawChatBaseUrl: management.config.baseUrl,
      });
    };
    const activationFor = async (bindingId: string) => {
      const activation = await management.stateStore.getActivation(bindingId);
      if (!activation) throw new Error(`Agent Binding ${bindingId} has no activation credential`);
      return activation;
    };
    const assertGeneration = async (): Promise<void> => {
      assertActivationLifecycle();
      const selected = await this.requireInstalled(installed.pluginId);
      if (selected.status !== "active" || selected.activationGeneration !== installed.activationGeneration) {
        throw new Error(
          `Plugin ${installed.pluginId}/${capabilityId} rejected stale Activation Generation ${installed.activationGeneration}`,
        );
      }
    };
    return {
      listBindings: async () => {
        await assertGeneration();
        const deviceId = await management.stateStore.getOrCreateDeviceId();
        const targets = [];
        for (const bindingId of Object.keys(management.config.agents).sort()) {
          if (await management.stateStore.getActivation(bindingId)) targets.push({ bindingId, deviceId });
        }
        return targets;
      },
      controlPlane: {
        connect: async (bindingId) => {
          await assertGeneration();
          const activation = await activationFor(bindingId);
          const control = await (await dependencies()).controlPlane.connect(activation.accessToken);
          return {
            listApps: async () => {
              await assertGeneration();
              return (await control.listApps()).map(toPublicationApp);
            },
            inspectApp: async (appId) => {
              await assertGeneration();
              if (control.inspectApp) return toPublicationApp(await control.inspectApp(appId));
              const matches = (await control.listApps()).filter((app) => app.appId === appId);
              const match = matches[0];
              if (!match || matches.length !== 1) {
                throw new Error(`Liveware App lookup for ${appId} returned ${matches.length} matches`);
              }
              return toPublicationApp(match);
            },
            createApp: async (correlationKey) => {
              await assertGeneration();
              return toPublicationApp(await control.createApp(correlationKey, "private"));
            },
            bindTunnel: async (appId, upstream) => {
              await assertGeneration();
              return await control.bindTunnel(appId, upstream);
            },
            startAgent: async () => {
              await assertGeneration();
              return await control.startAgent();
            },
            deleteApp: async (appId) => {
              await assertGeneration();
              await control.deleteApp(appId);
            },
          };
        },
      },
      registrations: {
        list: async (bindingId, deviceId) => {
          await assertGeneration();
          return await (await dependencies()).clawChat.list(await activationFor(bindingId), deviceId);
        },
        register: async (bindingId, deviceId, registration) => {
          await assertGeneration();
          await (await dependencies()).clawChat.register(await activationFor(bindingId), deviceId, registration);
        },
        unregister: async (bindingId, deviceId, livewareId) => {
          await assertGeneration();
          await (await dependencies()).clawChat.unregister(await activationFor(bindingId), deviceId, livewareId);
        },
      },
      acquireManagedWebApp: async (bindingId) => {
        await assertGeneration();
        const binding = management.config.agents[bindingId];
        if (!binding) throw new Error(`Agent Binding ${bindingId} is not configured`);
        let lease: ManagedWebAppLease | null;
        try {
          lease = await this.managedWebApps.acquire({
            bindingId,
            runtime: binding.runtime,
            runtimeConfiguration: deepFreeze(structuredClone(binding.runtimeConfig)),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.reportActivationFailure(
            installed.pluginId,
            new Error(`Agent Binding ${bindingId} Managed Web App acquisition failed: ${detail}`),
          );
          throw error;
        }
        if (!lease) return null;
        return Object.freeze({
          selection: Object.freeze({
            pluginId: lease.selection.pluginId,
            capabilityId: lease.selection.capabilityId,
            activationGeneration: lease.selection.activationGeneration,
            displayName: lease.selection.displayName,
            description: lease.selection.description,
          }),
          instanceKey: lease.instanceKey,
          upstream: lease.upstream,
          health: () => lease.health(),
          release: async () => await lease.release(),
        });
      },
    };
  }
}

function toPublicationApp(app: LivewareApp) {
  return {
    appId: app.appId,
    name: app.name,
    publicUrl: app.publicUrl || null,
  };
}
function managedWebAppReference(definition: ManagedWebAppProviderDefinition): ManagedWebAppGenerationReference {
  return Object.freeze({
    pluginId: definition.pluginId,
    capabilityId: definition.manifest.id,
    activationGeneration: definition.activationGeneration,
  });
}

function managedWebAppReferences(installed: InstalledPluginLockEntry): ManagedWebAppGenerationReference[] {
  return installed.manifest.capabilities
    .filter((capability) => capability.type === "managed-web-app")
    .map((capability) =>
      Object.freeze({
        pluginId: installed.pluginId,
        capabilityId: capability.id,
        activationGeneration: installed.activationGeneration,
      }),
    );
}

function isManagedOfficialDisposer(disposer: ConnectPluginDisposer): disposer is OfficialLivewareManagedDisposer {
  const candidate = disposer as Partial<OfficialLivewareManagedDisposer>;
  return (
    typeof candidate.retire === "function" &&
    typeof candidate.preserveOnShutdown === "function" &&
    typeof candidate.retireBindings === "function" &&
    typeof candidate.retireManagedWebApp === "function" &&
    typeof candidate.reconcileManagedWebApps === "function"
  );
}

export async function validateInstalledRuntimeBinding(configPath: string, binding: AgentBindingConfig): Promise<void> {
  const runtimeAdapters = new RuntimeAdapterRegistry([]);
  const host = new ConnectPluginHost(configPath, runtimeAdapters, () => undefined);
  let validationFailure: { error: unknown } | null = null;
  try {
    await host.validateRuntimeBinding(binding);
  } catch (error) {
    validationFailure = { error };
  }
  try {
    await runtimeAdapters.close();
  } catch (error) {
    if (!validationFailure) throw error;
  }
  if (validationFailure) throw validationFailure.error;
}

function runtimeRefs(installed: InstalledPluginLockEntry): RuntimeCapabilityRef[] {
  return installed.manifest.capabilities
    .filter((capability) => capability.type === "runtime")
    .map((capability) => ({ pluginId: installed.pluginId, capabilityId: capability.id }));
}

function bridgeRuntimeProvider(
  registration: PendingRuntimeProvider,
  validateConfiguration: PluginConfigurationValidator,
  binding: AgentBindingConfig,
  instanceContext: ConnectPluginRuntimeInstanceContext,
): ConnectRuntimeAdapter {
  const {
    runtime: { pluginId, capabilityId },
    family,
    implementation,
  } = registration;
  if (binding.runtime.pluginId !== pluginId || binding.runtime.capabilityId !== capabilityId) {
    throw new Error(`Runtime provider ${pluginId}/${capabilityId} received a different Agent Binding provider`);
  }
  const configuration = deepFreeze(validateConfiguration(binding.runtimeConfig));
  const adapter = implementation.create(configuration, instanceContext);
  const discoverWorkspaces = adapter.discoverWorkspaces?.bind(adapter);
  const discoverThreads = adapter.discoverThreads?.bind(adapter);
  const discoverAllThreads = adapter.discoverAllThreads?.bind(adapter);
  const discoverArchivedThreads = adapter.discoverArchivedThreads?.bind(adapter);
  const internal: ConnectRuntimeAdapter = {
    kind: family,
    modes: adapter.modes,
    lifecycleCapabilities: adapter.lifecycleCapabilities,
    prepare: adapter.prepare ? async () => await adapter.prepare?.() : undefined,
    modesFor: adapter.modesFor ? (_binding, scope) => adapter.modesFor?.(scope) ?? adapter.modes : undefined,
    listModels: adapter.listModels ? async (_binding, scope) => (await adapter.listModels?.(scope)) ?? [] : undefined,
    listSessionOptions: adapter.listSessionOptions
      ? async (_binding, workspace, scope) => (await adapter.listSessionOptions?.(workspace, scope)) ?? []
      : undefined,
    listSkills: adapter.listSkills
      ? async (_binding, workspace, options) => (await adapter.listSkills?.(workspace, options)) ?? []
      : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands
      ? async (_binding, workspace, options) => (await adapter.listCommands?.(workspace, options)) ?? []
      : undefined,
    onCommandsChanged: adapter.onCommandsChanged?.bind(adapter),
    onCatalogsChanged: adapter.onCatalogsChanged?.bind(adapter),
    discoverWorkspaces: discoverWorkspaces ? async () => await discoverWorkspaces() : undefined,
    discoverThreads: discoverThreads ? async (_binding, workspace) => await discoverThreads(workspace) : undefined,
    discoverAllThreads: discoverAllThreads ? async () => await discoverAllThreads() : undefined,
    discoverArchivedThreads: discoverArchivedThreads ? async () => await discoverArchivedThreads() : undefined,
    verifyThreadReady: adapter.verifyThreadReady
      ? async (_binding, runtimeThreadId) => await adapter.verifyThreadReady?.(runtimeThreadId)
      : undefined,
    readActivity: adapter.readActivity
      ? async (_binding, runtimeThreadId) => {
          const snapshot = await adapter.readActivity?.(runtimeThreadId);
          if (!snapshot) throw new Error(`Runtime provider ${pluginId}/${capabilityId} returned no activity`);
          return snapshot;
        }
      : undefined,
    reconcileInput: adapter.reconcileInput
      ? async (_binding, runtimeThreadId, candidate) =>
          (await adapter.reconcileInput?.(runtimeThreadId, candidate)) ?? { outcome: "unknown" }
      : undefined,
    archiveThread: adapter.archiveThread
      ? async (_binding, runtimeThreadId) => await adapter.archiveThread?.(runtimeThreadId)
      : undefined,
    unarchiveThread: adapter.unarchiveThread
      ? async (_binding, runtimeThreadId) => await adapter.unarchiveThread?.(runtimeThreadId)
      : undefined,
    deleteThread: adapter.deleteThread
      ? async (_binding, runtimeThreadId) => await adapter.deleteThread?.(runtimeThreadId)
      : undefined,
    start: async (_binding, context) =>
      await adapter.start({
        activationGeneration: instanceContext.activationGeneration,
        bindingId: context.agentId,
        chatId: context.chatId,
        sessionId: context.sessionId,
        runtimeThreadId: context.runtimeSessionId,
        onRuntimeThreadId: context.onRuntimeSessionId,
        cacheMedia: async (media, trustedOrigins) => {
          if (!context.stateDbPath) {
            throw new Error(`Runtime provider ${pluginId}/${capabilityId} cannot cache media without state storage`);
          }
          return await cacheRuntimeMedia(media, context.stateDbPath, { trustedOrigins });
        },
      }),
    close: adapter.close ? async () => await adapter.close?.() : undefined,
  };
  return internal;
}

function createDurableStateGenerationGate(staleGenerationMessage: string): DurableStateGenerationGate {
  let accepting = true;
  const pending = new Set<Promise<unknown>>();
  return {
    run: async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!accepting) throw new Error(staleGenerationMessage);
      const work = Promise.resolve().then(operation);
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    },
    fence: async (): Promise<() => void> => {
      accepting = false;
      await Promise.allSettled([...pending]);
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        accepting = true;
      };
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

declare module "cordis" {
  interface Context {
    connectPluginHost: ConnectPluginHost;
  }
}

export async function mountMandatoryPluginHost(
  root: Context,
  configPath: string,
  config: ConnectConfig,
  reportFailure: (pluginId: string, error: unknown) => void,
  retireRuntimeBindings: (bindingIds: readonly string[]) => Promise<void>,
): Promise<ConnectPluginHost> {
  let host!: ConnectPluginHost;
  const pluginHostModule = {
    name: "connect-plugin-host",
    inject: [
      "connectRuntimeAdapters",
      "connectSessionQueue",
      "connectSessionTurnExecutor",
      "connectPersistence",
      "connectWorkspaces",
      "connectTranscriptProjection",
      "connectRuntimeInteractions",
      "connectSessionContinuity",
    ],
    provide: "connectPluginHost",
    apply: async (ctx) => {
      host = new ConnectPluginHost(configPath, ctx.connectRuntimeAdapters, reportFailure, {
        config,
        stateStore: ctx.connectPersistence.state,
        workspaces: ctx.connectWorkspaces,
        retireRuntimeBindings,
        clientInterfaceServices: {
          config,
          configPath,
          stateStore: ctx.connectPersistence.state,
          runtimeAdapters: ctx.connectRuntimeAdapters,
          transcriptProjection: ctx.connectTranscriptProjection,
          runtimeInteractions: ctx.connectRuntimeInteractions,
          workspaces: ctx.connectWorkspaces,
          sessionContinuityModule: ctx.connectSessionContinuity,
        },
        quiesceRuntimeBindings: async (bindingIds, criticalSection) =>
          await ctx.connectSessionQueue.quiesceBindings(
            bindingIds,
            async () => await ctx.connectSessionTurnExecutor.releaseBindings(bindingIds),
            criticalSection,
          ),
      });
      await host.activateInstalled();
      ctx.provide("connectPluginHost", host);
      return async () => await host.close();
    },
  } satisfies Plugin;
  await root.plugin(pluginHostModule);
  return host;
}
