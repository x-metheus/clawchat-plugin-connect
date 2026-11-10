import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildOfficialPlugin } from "../scripts/build-official-plugins";
import { defaultConfig, saveConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectPluginHost } from "../src/plugin/host";
import livewareDescriptor from "../src/plugin/official/liveware-descriptor";
import {
  createOfficialLivewarePluginEntry,
  type OfficialLivewareExposureServices,
  type OfficialLivewareManagedDisposer,
} from "../src/plugin/official/liveware-entry";
import { OFFICIAL_LIVEWARE_CAPABILITY_ID, OFFICIAL_LIVEWARE_PLUGIN_ID } from "../src/plugin/official/liveware-manifest";
import {
  BindingLivewarePublicationLifecycle,
  type BindingLivewarePublicationState,
  type BindingLivewarePublicationStateRecord,
  type BindingLivewarePublicationStateStore,
  type LivewarePublicationApp,
  type LivewarePublicationControlPlane,
  type LivewarePublicationControlSession,
  type LivewarePublicationRegistration,
  type LivewarePublicationRegistrationPort,
} from "../src/plugin/official/liveware-publication";
import {
  ConnectBindingLivewarePublicationStateStore,
  resetBindingLivewarePublicationState,
} from "../src/plugin/official/liveware-publication-state";
import { retireOfficialLivewarePublications } from "../src/plugin/official/liveware-retirement";
import type {
  ConnectPluginExposureActivation,
  ConnectPluginExposureProvider,
  ConnectPluginHostCapabilities,
} from "../src/plugin/sdk";
import { installPluginBundle, listInstalledPlugins } from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { resolveLivewareExecutablePath } from "../src/service/liveware-control";
import { CONNECT_VERSION } from "../src/service/version";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

class MemoryPublicationStateStore implements BindingLivewarePublicationStateStore {
  readonly records = new Map<string, BindingLivewarePublicationStateRecord>();

  failNextCompareAndSwap = false;
  async read(bindingId: string): Promise<BindingLivewarePublicationStateRecord | null> {
    return structuredClone(this.records.get(bindingId) ?? null);
  }

  async compareAndSwap(
    bindingId: string,
    expectedRevision: number | null,
    value: BindingLivewarePublicationState,
  ): Promise<BindingLivewarePublicationStateRecord> {
    const current = this.records.get(bindingId);
    if ((current?.revision ?? null) !== expectedRevision) throw new Error("publication state conflict");
    if (this.failNextCompareAndSwap) {
      this.failNextCompareAndSwap = false;
      throw new Error("simulated crash before local identity commit");
    }
    const record = { revision: (current?.revision ?? 0) + 1, value: structuredClone(value) };
    this.records.set(bindingId, record);
    return structuredClone(record);
  }
}

class FakePublicationRemote
  implements LivewarePublicationControlPlane, LivewarePublicationControlSession, LivewarePublicationRegistrationPort
{
  readonly apps: LivewarePublicationApp[] = [];
  afterCreate?: () => void;
  publicUrlOnCreate = false;
  agentReady: Promise<void> = Promise.resolve();
  readonly agentExitResolvers: Array<() => void> = [];
  appLookupError: Error | null = null;
  afterBind?: () => void;
  afterRegister?: () => void;
  deleteError: Error | null = null;
  failUnregister = false;
  beforeListApps?: () => Promise<void>;
  readonly registrations: LivewarePublicationRegistration[] = [];
  readonly calls: string[] = [];

  async connect(bindingId: string): Promise<LivewarePublicationControlSession> {
    this.calls.push(`connect:${bindingId}`);
    return this;
  }

  async listApps(): Promise<LivewarePublicationApp[]> {
    this.calls.push("app:list");
    await this.beforeListApps?.();
    if (this.appLookupError) throw this.appLookupError;
    return structuredClone(this.apps);
  }

  async inspectApp(appId: string): Promise<LivewarePublicationApp> {
    this.calls.push(`app:inspect:${appId}`);
    const app = this.apps.find((candidate) => candidate.appId === appId);
    if (!app) throw new Error(`app not found: ${appId}`);
    return structuredClone(app);
  }

  async createApp(correlationKey: string): Promise<LivewarePublicationApp> {
    this.calls.push(`app:create:${correlationKey}`);
    const app: LivewarePublicationApp = {
      appId: `app-${this.apps.length + 1}`,
      name: correlationKey,
      publicUrl: this.publicUrlOnCreate ? `https://app-${this.apps.length + 1}.liveware.example` : null,
    };
    this.apps.push(app);
    this.afterCreate?.();
    return structuredClone(app);
  }
  async bindTunnel(appId: string, upstream: string): Promise<string> {
    this.calls.push(`tunnel:bind:${appId}:${upstream}`);
    const app = this.apps.find((candidate) => candidate.appId === appId);
    if (!app) throw new Error(`app not found: ${appId}`);
    app.publicUrl = `https://${appId}.liveware.example`;
    this.afterBind?.();
    return app.publicUrl;
  }
  async startAgent() {
    this.calls.push("agent:start");
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    this.agentExitResolvers.push(markExited);
    return {
      ready: this.agentReady,
      exited,
      stop: async () => {
        this.calls.push("agent:stop");
        markExited();
      },
    };
  }

  async deleteApp(appId: string): Promise<void> {
    this.calls.push(`app:delete:${appId}`);
    if (this.deleteError) throw this.deleteError;
    const index = this.apps.findIndex((candidate) => candidate.appId === appId);
    if (index >= 0) this.apps.splice(index, 1);
  }

  async list(bindingId: string, deviceId: string): Promise<LivewarePublicationRegistration[]> {
    this.calls.push(`registration:list:${bindingId}:${deviceId}`);
    return structuredClone(this.registrations);
  }

  async register(bindingId: string, deviceId: string, registration: LivewarePublicationRegistration): Promise<void> {
    this.calls.push(`registration:create:${bindingId}:${deviceId}:${registration.livewareId}`);
    this.registrations.push(structuredClone(registration));
    this.afterRegister?.();
  }

  async unregister(bindingId: string, deviceId: string, livewareId: string): Promise<void> {
    this.calls.push(`registration:delete:${bindingId}:${deviceId}:${livewareId}`);
    if (this.failUnregister) throw new Error("ClawChat unregister failed");
    const index = this.registrations.findIndex((candidate) => candidate.livewareId === livewareId);
    if (index >= 0) this.registrations.splice(index, 1);
  }
}

function managedWebAppSelection(activationGeneration: number) {
  return {
    pluginId: "fixture.managed-web-app",
    capabilityId: "web",
    activationGeneration,
    displayName: "Fixture Web",
    description: "Fixture browser interface",
  };
}

function selectedManagedWebApp(activationGeneration: number, instanceKey = "managed-web-app:fixture") {
  return {
    ...managedWebAppSelection(activationGeneration),
    instanceKey,
  };
}

describe("official Liveware Binding publication lifecycle", () => {
  it("resets legacy publication state instead of preserving obsolete remote identities", async () => {
    const entry = createOfficialLivewarePluginEntry();
    if (!entry.migrateDurableState) throw new Error("Official Liveware does not expose Durable State migration");
    const legacy = {
      bindingId: "legacy-binding",
      activationGeneration: 3,
      desired: "private",
      status: "active",
      transition: null,
      correlationKey: "ClawChat Connect · legacy-binding",
      appId: "app-legacy",
      publicUrl: "https://app-legacy.apps.clawling.io",
      registrationId: "app-legacy",
      diagnostic: null,
    };

    const schemaTwo = await entry.migrateDurableState({
      capabilityId: OFFICIAL_LIVEWARE_CAPABILITY_ID,
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
      value: legacy,
    });
    const schemaThree = await entry.migrateDurableState({
      capabilityId: OFFICIAL_LIVEWARE_CAPABILITY_ID,
      fromSchemaVersion: 2,
      toSchemaVersion: 3,
      value: schemaTwo,
    });

    const livewareCapability = livewareDescriptor.manifest.capabilities.find(
      (capability) => capability.type === "exposure" && capability.id === OFFICIAL_LIVEWARE_CAPABILITY_ID,
    );
    if (livewareCapability?.type !== "exposure") throw new Error("Official Liveware capability is missing");
    expect(livewareCapability.durableState?.migrations).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);
    expect(schemaThree).toEqual(resetBindingLivewarePublicationState("legacy-binding", 3));
  });

  it("skips offline retirement when selected Bindings have no publication state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-empty-retirement-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    try {
      await expect(
        retireOfficialLivewarePublications({
          bindingIds: ["without-publication"],
          clawChatBaseUrl: "https://clawchat.test",
          configPath: join(directory, "config.json"),
          stateStore,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await stateStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("embeds the target Liveware companion in the release-verified official Bundle", async () => {
    const built = await buildOfficialPlugin(livewareDescriptor, {
      target: `${process.platform}-${process.arch}`,
      write: false,
    });

    expect(built.bundle.manifest.version).toBe(CONNECT_VERSION);
    const companion = built.bundle.files["assets/liveware"];
    expect(companion).toMatchObject({ encoding: "base64" });
    if (!companion) throw new Error("official Liveware Bundle omitted its companion");
    expect(Buffer.from(companion.content, "base64").byteLength).toBeGreaterThan(1_000);
  });
  it("resolves Agent-managed Liveware operations to the installed official Bundle companion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-companion-"));
    try {
      const configPath = join(directory, "config.json");
      const built = await buildOfficialPlugin(livewareDescriptor, {
        target: `${process.platform}-${process.arch}`,
        write: false,
      });
      await installPluginBundle({
        configPath,
        source: { type: "local", path: directory },
        bundle: built.bundle,
      });
      const selected = (await listInstalledPlugins(configPath)).find(
        (plugin) => plugin.pluginId === OFFICIAL_LIVEWARE_PLUGIN_ID,
      );
      if (!selected) throw new Error("official Liveware Plugin was not selected");

      await expect(resolveLivewareExecutablePath(configPath)).resolves.toBe(
        join(dirname(selected.manifestPath), "assets", "liveware"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves retirement intent when the official Bundle restarts or advances generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-retirement-state-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.agents = {};
    await saveConfig(config, configPath);
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    await stateStore.initialize();
    const built = await buildOfficialPlugin(livewareDescriptor, {
      target: `${process.platform}-${process.arch}`,
      write: false,
    });
    const bundlePath = join(directory, "liveware.connect-plugin");
    await writeFile(bundlePath, `${JSON.stringify(built.bundle)}\n`);
    const installed = await installPluginBundle({
      configPath,
      source: { type: "local", path: bundlePath },
      bundle: built.bundle,
    });
    const retiring = {
      bindingId: "retiring-binding",
      activationGeneration: installed.activationGeneration,
      desired: "retired" as const,
      status: "retiring" as const,
      transition: "delete-app" as const,
      selectedApp: selectedManagedWebApp(installed.activationGeneration, "managed-web-app:retiring-binding"),
      correlationKey: "ClawChat Connect · retiring-binding",
      appId: "app-retiring",
      publicUrl: "https://app-retiring.liveware.example",
      registrationId: null,
      diagnostic: "remote App deletion failed",
    };
    const generationOne = new ConnectBindingLivewarePublicationStateStore(
      stateStore,
      async () => undefined,
      installed.activationGeneration,
    );
    await generationOne.compareAndSwap(retiring.bindingId, null, retiring);
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
    });

    await host.activateInstalled();
    await expect(generationOne.read(retiring.bindingId)).resolves.toMatchObject({ value: retiring });
    const reinstalled = await host.reinstall(OFFICIAL_LIVEWARE_PLUGIN_ID);
    const generationTwo = new ConnectBindingLivewarePublicationStateStore(
      stateStore,
      async () => undefined,
      reinstalled.activationGeneration,
    );
    await expect(generationTwo.read(retiring.bindingId)).resolves.toMatchObject({
      value: { ...retiring, activationGeneration: reinstalled.activationGeneration },
    });

    await host.close();
    await stateStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("provisions one private App, tunnel, and launcher for one Agent Binding", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 7,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(7),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    const publication = await lifecycle.ensurePrivate({ bindingId: "primary", deviceId: "device-primary" });

    expect(publication).toMatchObject({
      bindingId: "primary",
      activationGeneration: 7,
      desired: "private",
      status: "active",
      transition: null,
      selectedApp: selectedManagedWebApp(7),
      correlationKey: "Fixture Web · primary",
      appId: "app-1",
      publicUrl: "https://app-1.liveware.example",
      registrationId: "app-1",
    });
    expect(remote.apps).toHaveLength(1);
    expect(remote.registrations).toEqual([
      {
        livewareId: "app-1",
        name: "Fixture Web · primary",
        subtitle: "Fixture browser interface",
        url: "https://app-1.liveware.example",
      },
    ]);
    expect(remote.calls).not.toContain(expect.stringContaining("unbind"));
  });

  it("binds a newly created App even when the Control Plane preassigns its public URL", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.publicUrlOnCreate = true;
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "preassigned-url", deviceId: "device-preassigned-url" }),
    ).resolves.toMatchObject({
      status: "active",
      publicUrl: "https://app-1.liveware.example",
    });
    expect(remote.calls.filter((call) => call.startsWith("tunnel:bind:"))).toEqual([
      "tunnel:bind:app-1:http://127.0.0.1:47890",
    ]);
  });

  it("waits for the Binding Liveware agent before registering and stops it on disposal", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    let markReady: () => void = () => undefined;
    remote.agentReady = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    const publication = lifecycle.ensurePrivate({
      bindingId: "agent-ready",
      deviceId: "device-agent-ready",
    });
    await Bun.sleep(0);
    expect(remote.calls).toContain("agent:start");
    expect(remote.calls.some((call) => call.startsWith("registration:create:"))).toBeFalse();

    markReady();
    await expect(publication).resolves.toMatchObject({ status: "active" });
    expect(remote.calls.indexOf("agent:start")).toBeLessThan(
      remote.calls.findIndex((call) => call.startsWith("registration:create:")),
    );
    await lifecycle.dispose();
    expect(remote.calls).toContain("agent:stop");
  });

  it("restarts a Liveware agent that exits after readiness on the next reconciliation", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "agent-restart", deviceId: "device-agent-restart" };

    await lifecycle.ensurePrivate(target);
    remote.agentExitResolvers[0]?.();
    await Bun.sleep(0);
    await lifecycle.ensurePrivate(target);

    expect(remote.calls.filter((call) => call === "agent:start")).toHaveLength(2);
    await lifecycle.dispose();
  });

  it("adopts an App by its persisted correlation key after remote success and a crash before identity commit", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.publicUrlOnCreate = true;
    remote.afterCreate = () => {
      state.failNextCompareAndSwap = true;
    };
    const options = {
      activationGeneration: 3,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(3),
      state,
      controlPlane: remote,
      registrations: remote,
    };
    const interrupted = new BindingLivewarePublicationLifecycle(options);

    await expect(interrupted.ensurePrivate({ bindingId: "recover", deviceId: "device-recover" })).rejects.toThrow(
      "simulated crash",
    );
    expect(remote.apps).toHaveLength(1);
    expect((await state.read("recover"))?.value).toMatchObject({
      status: "provisioning",
      transition: "create-app",
      correlationKey: "Fixture Web · recover",
      appId: null,
    });

    remote.afterCreate = undefined;
    const restarted = new BindingLivewarePublicationLifecycle(options);
    await expect(restarted.ensurePrivate({ bindingId: "recover", deviceId: "device-recover" })).resolves.toMatchObject({
      status: "active",
      appId: "app-1",
    });
    expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);
    expect(remote.calls.filter((call) => call.startsWith("tunnel:bind:"))).toHaveLength(1);
  });

  it("recovers an uncommitted App identity by correlation key before retirement", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterCreate = () => {
      state.failNextCompareAndSwap = true;
    };
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 3,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(3),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "retire-recovery", deviceId: "device-retire-recovery" };
    await expect(lifecycle.ensurePrivate(target)).rejects.toThrow("simulated crash");
    remote.afterCreate = undefined;

    await expect(lifecycle.retire(target)).resolves.toMatchObject({ status: "retired", appId: "app-1" });

    expect(remote.apps).toEqual([]);
    expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);
    expect(remote.calls.filter((call) => call.startsWith("app:delete:"))).toEqual(["app:delete:app-1"]);
  });

  it("deletes every obsolete product App before rebuilding one selected Managed Web App", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.apps.push(
      { appId: "legacy-a", name: "ClawChat Connect · legacy-cutover", publicUrl: null },
      { appId: "legacy-b", name: "ClawChat Connect · legacy-cutover", publicUrl: null },
    );
    remote.registrations.push({
      livewareId: "legacy-a",
      name: "ClawChat Connect · legacy-cutover",
      subtitle: "Legacy Client",
      url: "https://legacy-a.liveware.example",
    });
    remote.registrations.push(
      {
        livewareId: "legacy-b",
        name: "ClawChat Connect · legacy-cutover",
        subtitle: "Legacy Client",
        url: "https://legacy-b.liveware.example",
      },
      {
        livewareId: "legacy-missing",
        name: "ClawChat Connect · legacy-cutover",
        subtitle: "Legacy Client",
        url: "https://legacy-missing.liveware.example",
      },
    );
    await state.compareAndSwap("legacy-cutover", null, {
      bindingId: "legacy-cutover",
      activationGeneration: 1,
      desired: "private",
      status: "degraded",
      transition: "create-app",
      selectedApp: null,
      correlationKey: "ClawChat Connect · legacy-cutover",
      appId: "legacy-a",
      publicUrl: "https://legacy-a.liveware.example",
      registrationId: "legacy-a",
      diagnostic: "legacy duplicate",
    });
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "legacy-cutover", deviceId: "device-legacy-cutover" }),
    ).resolves.toMatchObject({
      status: "active",
      correlationKey: "Fixture Web · legacy-cutover",
      selectedApp: selectedManagedWebApp(1),
    });
    expect(remote.calls.filter((call) => call.startsWith("app:delete:"))).toEqual([
      "app:delete:legacy-a",
      "app:delete:legacy-b",
    ]);
    expect(remote.apps.map((app) => app.name)).toEqual(["Fixture Web · legacy-cutover"]);
    expect(remote.registrations.map(({ name }) => name)).toEqual(["Fixture Web · legacy-cutover"]);
  });

  it("removes duplicate current Apps only when Durable State identifies the authoritative App", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.apps.push(
      { appId: "duplicate-a", name: "Fixture Web · authoritative", publicUrl: null },
      { appId: "duplicate-b", name: "Fixture Web · authoritative", publicUrl: null },
    );
    remote.registrations.push({
      livewareId: "duplicate-a",
      name: "Fixture Web · authoritative",
      subtitle: "Fixture browser interface",
      url: "https://duplicate-a.liveware.example",
    });
    await state.compareAndSwap("authoritative", null, {
      bindingId: "authoritative",
      activationGeneration: 1,
      desired: "private",
      status: "degraded",
      transition: "create-app",
      selectedApp: selectedManagedWebApp(1),
      correlationKey: "Fixture Web · authoritative",
      appId: "duplicate-b",
      publicUrl: null,
      registrationId: null,
      diagnostic: "duplicate recovery",
    });
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "authoritative", deviceId: "device-authoritative" }),
    ).resolves.toMatchObject({
      status: "active",
      appId: "duplicate-b",
    });
    expect(remote.calls.filter((call) => call.startsWith("app:delete:"))).toEqual(["app:delete:duplicate-a"]);
    expect(remote.registrations.map(({ livewareId }) => livewareId)).toEqual(["duplicate-b"]);
  });

  it("marks duplicate correlation-key matches degraded without creating or mutating a remote resource", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.apps.push(
      { appId: "duplicate-a", name: "Fixture Web · duplicate", publicUrl: null },
      { appId: "duplicate-b", name: "Fixture Web · duplicate", publicUrl: null },
    );
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "duplicate", deviceId: "device-duplicate" }),
    ).resolves.toMatchObject({
      status: "degraded",
      transition: "create-app",
      diagnostic: "multiple owned Apps match the publication correlation key",
      appId: null,
    });
    expect(remote.calls.some((call) => call.startsWith("app:create:"))).toBeFalse();
    expect(remote.calls.some((call) => call.startsWith("tunnel:bind:"))).toBeFalse();
    expect(remote.calls.some((call) => call.startsWith("registration:create:"))).toBeFalse();
  });

  it("performs no create when authoritative correlation-key lookup is unavailable", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.appLookupError = new Error("control plane unavailable");
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });

    await expect(
      lifecycle.ensurePrivate({ bindingId: "unavailable", deviceId: "device-unavailable" }),
    ).resolves.toMatchObject({
      status: "degraded",
      transition: "create-app",
      diagnostic: "App correlation-key lookup failed: control plane unavailable",
    });
    expect(remote.calls.some((call) => call.startsWith("app:create:"))).toBeFalse();
  });

  it("adopts a tunnel after a lost bind response without binding it twice", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterBind = () => {
      throw new Error("lost tunnel response");
    };
    const options = {
      activationGeneration: 2,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(2),
      state,
      controlPlane: remote,
      registrations: remote,
    };

    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "tunnel-recovery",
        deviceId: "device-tunnel",
      }),
    ).rejects.toThrow("lost tunnel response");
    remote.afterBind = undefined;
    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "tunnel-recovery",
        deviceId: "device-tunnel",
      }),
    ).resolves.toMatchObject({ status: "active", publicUrl: "https://app-1.liveware.example" });
    expect(remote.calls.filter((call) => call.startsWith("tunnel:bind:"))).toHaveLength(1);
  });

  it("adopts an exact launcher after a lost registration response without registering twice", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    remote.afterRegister = () => {
      throw new Error("lost registration response");
    };
    const options = {
      activationGeneration: 2,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(2),
      state,
      controlPlane: remote,
      registrations: remote,
    };

    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "registration-recovery",
        deviceId: "device-registration",
      }),
    ).rejects.toThrow("lost registration response");
    remote.afterRegister = undefined;
    await expect(
      new BindingLivewarePublicationLifecycle(options).ensurePrivate({
        bindingId: "registration-recovery",
        deviceId: "device-registration",
      }),
    ).resolves.toMatchObject({ status: "active", registrationId: "app-1" });
    expect(remote.calls.filter((call) => call.startsWith("registration:create:"))).toHaveLength(1);
  });

  it("durably retires the exact launcher and App without a separate tunnel unbind", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 5,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(5),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "retire", deviceId: "device-retire" };
    await lifecycle.ensurePrivate(target);
    remote.calls.length = 0;

    await expect(lifecycle.retire(target)).resolves.toMatchObject({
      desired: "retired",
      status: "retired",
      transition: null,
      appId: "app-1",
      registrationId: "app-1",
    });
    expect(remote.calls).toEqual([
      "registration:list:retire:device-retire",
      "registration:delete:retire:device-retire:app-1",
      "connect:retire",
      "app:list",
      "app:delete:app-1",
      "app:list",
      "agent:stop",
    ]);
    expect(remote.calls.some((call) => call.includes("unbind"))).toBeFalse();
    expect(remote.apps).toHaveLength(0);
    expect(remote.registrations).toHaveLength(0);
  });

  it("keeps retirement durable after cleanup failure and resumes only on an explicit retry", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 9,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(9),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const target = { bindingId: "retry-retirement", deviceId: "device-retry" };
    await lifecycle.ensurePrivate(target);
    remote.calls.length = 0;
    remote.deleteError = new Error("remote App deletion failed");

    await expect(lifecycle.retire(target)).rejects.toThrow("remote App deletion failed");
    expect((await state.read(target.bindingId))?.value).toMatchObject({
      desired: "retired",
      status: "retiring",
      transition: "delete-app",
      diagnostic: "remote App deletion failed",
      appId: "app-1",
      registrationId: "app-1",
    });
    expect(remote.registrations).toHaveLength(0);
    expect(remote.apps).toHaveLength(1);
    const callsAfterFailure = [...remote.calls];
    await expect(lifecycle.ensurePrivate(target)).rejects.toThrow("retiring and cannot be reprovisioned");
    expect(remote.calls).toEqual(callsAfterFailure);

    remote.deleteError = null;
    await expect(lifecycle.retire(target)).resolves.toMatchObject({ status: "retired", transition: null });
    expect(remote.apps).toHaveLength(0);
    expect(remote.calls.filter((call) => call.startsWith("registration:delete:"))).toHaveLength(1);
  });

  it("serializes one publication and rejects every stale-generation operation before remote dispatch", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    const target = { bindingId: "generation", deviceId: "device-generation" };
    const first = new BindingLivewarePublicationLifecycle({
      activationGeneration: 1,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(1),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const [left, right] = await Promise.all([first.ensurePrivate(target), first.ensurePrivate(target)]);
    expect(left).toEqual(right);
    expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);

    const selected = new BindingLivewarePublicationLifecycle({
      activationGeneration: 2,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(2),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    await expect(selected.ensurePrivate(target)).resolves.toMatchObject({
      activationGeneration: 2,
      status: "active",
      selectedApp: selectedManagedWebApp(2),
    });
    const callsAfterCutover = [...remote.calls];
    await expect(first.ensurePrivate(target)).rejects.toThrow("stale Liveware publication Activation Generation");
    await expect(first.retire(target)).rejects.toThrow("stale Liveware publication Activation Generation");
    expect(remote.calls).toEqual(callsAfterCutover);
  });

  it("fences a generation during an in-flight lookup before it can issue the next remote effect", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    let releaseLookup!: () => void;
    let observeLookup!: () => void;
    const lookupEntered = new Promise<void>((resolve) => {
      observeLookup = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    remote.beforeListApps = async () => {
      observeLookup();
      await lookupGate;
    };
    const lifecycle = new BindingLivewarePublicationLifecycle({
      activationGeneration: 4,
      upstream: "http://127.0.0.1:47890",
      selectedApp: selectedManagedWebApp(4),
      state,
      controlPlane: remote,
      registrations: remote,
    });
    const pending = lifecycle.ensurePrivate({ bindingId: "fenced", deviceId: "device-fenced" });
    await lookupEntered;

    const disposal = lifecycle.dispose();
    releaseLookup();
    await expect(pending).rejects.toThrow("Liveware publication generation is fenced");
    await disposal;
    expect(remote.calls.some((call) => call.startsWith("app:create:"))).toBeFalse();
    await expect(lifecycle.ensurePrivate({ bindingId: "fenced", deviceId: "device-fenced" })).rejects.toThrow(
      "Liveware publication generation is fenced",
    );
  });

  it("recovers publication identity from Binding-scoped Plugin Durable State after process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-publication-"));
    try {
      const dbPath = join(directory, "state.sqlite");
      const remote = new FakePublicationRemote();
      const target = { bindingId: "durable", deviceId: "device-durable" };
      const firstDatabase = createStateStore({ dbPath });
      const first = new BindingLivewarePublicationLifecycle({
        activationGeneration: 1,
        upstream: "http://127.0.0.1:47890",
        selectedApp: selectedManagedWebApp(1),
        state: new ConnectBindingLivewarePublicationStateStore(firstDatabase),
        controlPlane: remote,
        registrations: remote,
      });
      await first.ensurePrivate(target);
      await firstDatabase.close();

      const restartedDatabase = createStateStore({ dbPath });
      const restarted = new BindingLivewarePublicationLifecycle({
        activationGeneration: 2,
        upstream: "http://127.0.0.1:47890",
        selectedApp: selectedManagedWebApp(2),
        state: new ConnectBindingLivewarePublicationStateStore(restartedDatabase),
        controlPlane: remote,
        registrations: remote,
      });
      await expect(restarted.ensurePrivate(target)).resolves.toMatchObject({
        activationGeneration: 2,
        status: "active",
        appId: "app-1",
        selectedApp: selectedManagedWebApp(2),
      });
      expect(remote.calls.filter((call) => call.startsWith("app:create:"))).toHaveLength(1);
      expect(remote.calls.filter((call) => call.startsWith("tunnel:bind:"))).toHaveLength(2);
      await restartedDatabase.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes one selected lease per Binding and releases a shared Instance only after its final publication retires", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    let provider: ConnectPluginExposureProvider | undefined;
    const hostCapabilities = {
      get(id: "runtime-provider" | "durable-state" | "exposure-provider") {
        if (id === "exposure-provider") {
          return {
            interfaceVersion: "1",
            register(candidate: ConnectPluginExposureProvider) {
              provider = candidate;
            },
          };
        }
        if (id === "durable-state") {
          return {
            interfaceVersion: "1",
            forBinding(capabilityId: string, bindingId: string) {
              if (capabilityId !== "liveware") throw new Error("unexpected Durable State capability");
              return {
                async read() {
                  const record = await state.read(bindingId);
                  return record ? { schemaVersion: 3, revision: record.revision, value: record.value } : null;
                },
                async compareAndSwap(expectedRevision: number | null, value: Readonly<Record<string, unknown>>) {
                  const record = await state.compareAndSwap(
                    bindingId,
                    expectedRevision,
                    value as BindingLivewarePublicationState,
                  );
                  return { schemaVersion: 3, revision: record.revision, value: record.value };
                },
              };
            },
          };
        }
        throw new Error("unexpected Host Capability");
      },
    } as ConnectPluginHostCapabilities;
    await createOfficialLivewarePluginEntry().activate({
      activationGeneration: 12,
      interfaceVersion: "1",
      installationConfiguration: {},
      hostCapabilities,
    });
    let leaseAcquisitions = 0;
    let leaseReleases = 0;
    let activeSharedLeases = 0;
    let sharedInstanceStops = 0;
    const leaseActions: string[] = [];
    const bindingTargets = [
      { bindingId: "official-a", deviceId: "device-official" },
      { bindingId: "official-b", deviceId: "device-official" },
    ];
    const leaseHealth: Record<string, "ready" | "error"> = {
      "official-a": "ready",
      "official-b": "ready",
    };
    const officialLiveware: OfficialLivewareExposureServices = {
      async listBindings() {
        return bindingTargets;
      },
      controlPlane: remote,
      registrations: remote,
      async acquireManagedWebApp(bindingId, activationGeneration) {
        expect(["official-a", "official-b"]).toContain(bindingId);
        expect(activationGeneration).toBe(12);
        leaseAcquisitions += 1;
        leaseActions.push(`acquire:${bindingId}`);
        activeSharedLeases += 1;
        let released = false;
        const selectedApp = selectedManagedWebApp(activationGeneration, "managed-web-app:shared-runtime");
        return {
          selection: managedWebAppSelection(activationGeneration),
          instanceKey: selectedApp.instanceKey,
          upstream: "http://127.0.0.1:47889",
          health: () => leaseHealth[bindingId] ?? "error",
          async release() {
            if (released) return;
            released = true;
            leaseReleases += 1;
            leaseActions.push(`release:${bindingId}`);
            activeSharedLeases -= 1;
            if (activeSharedLeases === 0) sharedInstanceStops += 1;
          },
        };
      },
    };
    const activation = {
      activationGeneration: 12,
      configuration: { accessPolicy: "private" },
      officialLiveware,
    } as ConnectPluginExposureActivation & { officialLiveware: OfficialLivewareExposureServices };

    const dispose = await provider?.activate(activation);

    expect(provider?.capabilityId).toBe("liveware");
    expect(leaseAcquisitions).toBe(2);
    expect(activeSharedLeases).toBe(2);
    expect(leaseActions).toEqual(["acquire:official-a", "acquire:official-b"]);
    expect((await state.read("official-a"))?.value.selectedApp).toEqual(
      selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
    );
    expect((await state.read("official-b"))?.value.selectedApp).toEqual(
      selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
    );
    expect(remote.apps.map((app) => app.name)).toEqual(["Fixture Web · official-a", "Fixture Web · official-b"]);
    expect(remote.calls.filter((call) => call.endsWith(":http://127.0.0.1:47889"))).toHaveLength(2);
    const managed = dispose as typeof dispose & {
      retire(): Promise<void>;
      retireBindings(bindingIds: readonly string[]): Promise<void>;
      reconcileManagedWebApps(): Promise<void>;
    };
    remote.failUnregister = true;
    await expect(managed.retireBindings(["official-a"])).rejects.toThrow("ClawChat unregister failed");
    expect((await state.read("official-a"))?.value).toMatchObject({
      desired: "retired",
      status: "retiring",
      transition: "unregister-launcher",
      diagnostic: "ClawChat unregister failed",
      selectedApp: selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
    });
    expect(remote.apps.map((app) => app.name)).toEqual(["Fixture Web · official-a", "Fixture Web · official-b"]);
    expect(leaseReleases).toBe(0);
    expect(activeSharedLeases).toBe(2);
    expect(leaseActions).toEqual(["acquire:official-a", "acquire:official-b"]);
    leaseHealth["official-a"] = "error";
    await managed.reconcileManagedWebApps();
    expect(leaseReleases).toBe(0);
    // Exercise the real periodic reconciliation boundary: a durable retirement must remain explicit-retry-only.
    await Bun.sleep(1_100);
    expect(leaseReleases).toBe(0);
    expect(
      remote.calls.filter((call) => call.startsWith("registration:delete:official-a:device-official:")),
    ).toHaveLength(1);

    remote.failUnregister = false;
    await managed.retireBindings(["official-a"]);
    expect(remote.apps.map((app) => app.name)).toEqual(["Fixture Web · official-b"]);
    expect(leaseReleases).toBe(1);
    expect(activeSharedLeases).toBe(1);
    expect(sharedInstanceStops).toBe(0);
    expect((await state.read("official-a"))?.value.selectedApp).toEqual(
      selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
    );
    expect(leaseActions).toEqual(["acquire:official-a", "acquire:official-b", "release:official-a"]);

    await managed.retire();
    expect(remote.apps).toHaveLength(0);
    expect(leaseReleases).toBe(2);
    expect(activeSharedLeases).toBe(0);
    expect(sharedInstanceStops).toBe(1);
    expect(leaseActions).toEqual([
      "acquire:official-a",
      "acquire:official-b",
      "release:official-a",
      "release:official-b",
    ]);
    expect((await state.read("official-b"))?.value.selectedApp).toEqual(
      selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
    );
    await dispose?.();

    state.records.delete("official-a");
    state.records.delete("official-b");
    const shutdownDispose = await provider?.activate(activation);
    expect(remote.apps).toHaveLength(2);
    expect(leaseAcquisitions).toBe(4);
    await shutdownDispose?.();
    expect(remote.apps).toHaveLength(0);
    expect(leaseReleases).toBe(4);
    expect(activeSharedLeases).toBe(0);
    expect(sharedInstanceStops).toBe(2);

    expect(leaseActions).toEqual([
      "acquire:official-a",
      "acquire:official-b",
      "release:official-a",
      "release:official-b",
      "acquire:official-a",
      "acquire:official-b",
      "release:official-a",
      "release:official-b",
    ]);
    state.records.delete("official-a");
    state.records.delete("official-b");
    const upgradeDispose = (await provider?.activate(activation)) as OfficialLivewareManagedDisposer;
    const appsBeforeUpgrade = remote.apps.map((app) => app.appId);
    const registrationsBeforeUpgrade = structuredClone(remote.registrations);
    upgradeDispose.preserveOnShutdown(true);
    await upgradeDispose();
    expect(remote.apps.map((app) => app.appId)).toEqual(appsBeforeUpgrade);
    expect(remote.registrations).toEqual(registrationsBeforeUpgrade);
    expect((await state.read("official-a"))?.value.status).toBe("active");
    expect((await state.read("official-b"))?.value.desired).toBe("private");
    expect(activeSharedLeases).toBe(0);
    const restartedDispose = await provider?.activate(activation);
    expect(remote.apps.map((app) => app.appId)).toEqual(appsBeforeUpgrade);
    expect(remote.registrations).toHaveLength(2);
    await restartedDispose?.();
    expect(remote.apps).toHaveLength(0);
    const retire = await provider?.activate({
      ...activation,
      activationGeneration: 13,
      configuration: { accessPolicy: "off" },
      officialLiveware: {
        ...officialLiveware,
        acquireManagedWebApp: async () => {
          throw new Error("Liveware off must not acquire a Managed Web App lease");
        },
      },
    } as ConnectPluginExposureActivation & { officialLiveware: OfficialLivewareExposureServices });
    expect(remote.apps).toHaveLength(0);
    expect(remote.registrations).toHaveLength(0);
    await expect(state.read("official-a")).resolves.toMatchObject({
      value: {
        desired: "retired",
        status: "retired",
        selectedApp: selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
      },
    });
    await expect(state.read("official-b")).resolves.toMatchObject({
      value: {
        desired: "retired",
        status: "retired",
        selectedApp: selectedManagedWebApp(12, "managed-web-app:shared-runtime"),
      },
    });
    await retire?.();
    expect(leaseReleases).toBe(8);
  });

  it("reacquires a crashed shared App and rebinds both existing Publications to the same product", async () => {
    const state = new MemoryPublicationStateStore();
    const remote = new FakePublicationRemote();
    let provider: ConnectPluginExposureProvider | undefined;
    const hostCapabilities = {
      get(id: "runtime-provider" | "durable-state" | "exposure-provider") {
        if (id === "exposure-provider") {
          return {
            interfaceVersion: "1",
            register(candidate: ConnectPluginExposureProvider) {
              provider = candidate;
            },
          };
        }
        if (id === "durable-state") {
          return {
            interfaceVersion: "1",
            forBinding(capabilityId: string, bindingId: string) {
              if (capabilityId !== "liveware") throw new Error("unexpected Durable State capability");
              return {
                async read() {
                  const record = await state.read(bindingId);
                  return record ? { schemaVersion: 3, revision: record.revision, value: record.value } : null;
                },
                async compareAndSwap(expectedRevision: number | null, value: Readonly<Record<string, unknown>>) {
                  const record = await state.compareAndSwap(
                    bindingId,
                    expectedRevision,
                    value as BindingLivewarePublicationState,
                  );
                  return { schemaVersion: 3, revision: record.revision, value: record.value };
                },
              };
            },
          };
        }
        throw new Error("unexpected Host Capability");
      },
    } as ConnectPluginHostCapabilities;
    await createOfficialLivewarePluginEntry().activate({
      activationGeneration: 21,
      interfaceVersion: "1",
      installationConfiguration: {},
      hostCapabilities,
    });

    let health: "ready" | "error" = "ready";
    let upstream = "http://127.0.0.1:47889";
    let acquisitions = 0;
    let releases = 0;
    const targets = [
      { bindingId: "recovery-a", deviceId: "device-recovery" },
      { bindingId: "recovery-b", deviceId: "device-recovery" },
    ];
    const officialLiveware: OfficialLivewareExposureServices = {
      async listBindings() {
        return targets;
      },
      controlPlane: remote,
      registrations: remote,
      async acquireManagedWebApp(_bindingId, activationGeneration) {
        acquisitions += 1;
        let released = false;
        return {
          selection: managedWebAppSelection(activationGeneration),
          instanceKey: "managed-web-app:shared-runtime",
          upstream,
          health: () => health,
          async release() {
            if (released) return;
            released = true;
            releases += 1;
          },
        };
      },
    };
    const dispose = await provider?.activate({
      activationGeneration: 21,
      configuration: { accessPolicy: "private" },
      officialLiveware,
    } as ConnectPluginExposureActivation & { officialLiveware: OfficialLivewareExposureServices });
    const managed = dispose as typeof dispose & {
      reconcileManagedWebApps(): Promise<void>;
      retire(): Promise<void>;
    };

    expect(acquisitions).toBe(2);
    expect(remote.apps).toHaveLength(2);
    expect(remote.calls.filter((call) => call.endsWith(":http://127.0.0.1:47889"))).toHaveLength(2);

    health = "error";
    upstream = "http://127.0.0.1:47890";
    await managed.reconcileManagedWebApps();
    expect(releases).toBe(2);
    expect(acquisitions).toBe(2);
    expect(remote.apps).toHaveLength(2);

    health = "ready";
    await managed.reconcileManagedWebApps();
    expect(acquisitions).toBe(4);
    expect(remote.apps).toHaveLength(2);
    expect(remote.registrations).toHaveLength(2);
    expect(remote.calls.filter((call) => call.endsWith(":http://127.0.0.1:47890"))).toHaveLength(2);
    await expect(state.read("recovery-a")).resolves.toMatchObject({ value: { status: "active" } });
    await expect(state.read("recovery-b")).resolves.toMatchObject({ value: { status: "active" } });

    await managed.retire();
    expect(releases).toBe(4);
    expect(remote.apps).toHaveLength(0);
  });

  it("does not publish Bindings whose Runtime has no selected Managed Web App", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-liveware-no-managed-app-"));
    const configPath = join(directory, "config.json");
    const config = defaultConfig();
    config.stateDbPath = join(directory, "state.sqlite");
    config.agents = {
      "binding-a": {
        runtime: { pluginId: "fixture.runtime", capabilityId: "runtime" },
        runtimeConfig: {},
      },
      "binding-b": {
        runtime: { pluginId: "fixture.runtime", capabilityId: "runtime" },
        runtimeConfig: {},
      },
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const stateStore = createStateStore({ dbPath: config.stateDbPath });
    const activation = (localAgentId: string, accessToken: string) => ({
      localAgentId,
      accessToken,
      refreshToken: null,
      serverAgentId: `${localAgentId}-remote`,
      userId: "owner",
      ownerUserId: "owner",
      conversationId: null,
    });
    await stateStore.upsertActivation(activation("binding-a", "token-a"));
    await stateStore.upsertActivation(activation("binding-b", "token-b"));
    const built = await buildOfficialPlugin(livewareDescriptor, {
      target: `${process.platform}-${process.arch}`,
      write: false,
    });
    const bundlePath = join(directory, built.filename);
    await writeFile(bundlePath, `${JSON.stringify(built.bundle)}\n`);
    const remote = new FakePublicationRemote();
    const tokens: string[] = [];
    const host = new ConnectPluginHost(configPath, new RuntimeAdapterRegistry([]), () => undefined, {
      config,
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      livewareDependencies: {
        controlPlane: {
          async connect(accessToken) {
            tokens.push(accessToken);
            return {
              listApps: async () =>
                (await remote.listApps()).map((app) => ({ ...app, publicUrl: app.publicUrl ?? "" })),
              inspectApp: async (appId) => {
                const app = await remote.inspectApp(appId);
                return { ...app, publicUrl: app.publicUrl ?? "" };
              },
              createApp: async (correlationKey) => {
                const app = await remote.createApp(correlationKey);
                return { ...app, publicUrl: app.publicUrl ?? "" };
              },
              setAccessPolicy: async () => undefined,
              bindTunnel: remote.bindTunnel.bind(remote),
              deleteApp: remote.deleteApp.bind(remote),
              startAgent: async () => ({
                ready: Promise.resolve(),
                exited: new Promise<number>(() => undefined),
                stop: async () => undefined,
              }),
            };
          },
        },
        clawChat: {
          list: async (principal, deviceId) => await remote.list(principal.localAgentId, deviceId),
          register: async (principal, deviceId, registration) =>
            await remote.register(principal.localAgentId, deviceId, registration),
          unregister: async (principal, deviceId, livewareId) =>
            await remote.unregister(principal.localAgentId, deviceId, livewareId),
        },
      },
    });
    try {
      const artifact = built.bundle.manifest.artifacts[0];
      expect(artifact).toBeDefined();
      if (!artifact) throw new Error("official Liveware Bundle has no artifact");
      await host.install({
        source: bundlePath,
        target: artifact.target,
        capabilityConfigurations: { liveware: { accessPolicy: "private" } },
      });

      expect(tokens).toEqual([]);
      expect(remote.apps).toHaveLength(0);
      expect(await new ConnectBindingLivewarePublicationStateStore(stateStore).read("binding-a")).toBeNull();
      expect(await new ConnectBindingLivewarePublicationStateStore(stateStore).read("binding-b")).toBeNull();
      await host.disable(OFFICIAL_LIVEWARE_PLUGIN_ID);
      await host.enable(OFFICIAL_LIVEWARE_PLUGIN_ID);
      expect(tokens).toEqual([]);
      expect(remote.apps).toHaveLength(0);
    } finally {
      await host.close();
      await stateStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
