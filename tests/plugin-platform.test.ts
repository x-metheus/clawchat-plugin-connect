import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawChatApiClient } from "../src/clawchat/api-client";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/clawchat/protocol";
import { defaultConfig, getAgentBinding, loadConfig, saveConfig, upsertAgentBinding } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { createAgentBinding } from "../src/plugin/binding";
import {
  commitStagedPlugin,
  listInstalledPlugins,
  readConnectPluginBundle,
  removeInstalledPlugin,
  stagePluginBundle,
} from "../src/plugin/store";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { startBindingRuntime } from "../src/service/binding-runtime";
import { runConnectCli } from "../src/service/cli";
import { startConnectService } from "../src/service/connect-service";
import type { ActivationCredentials } from "../src/types";

interface ReferenceExposureFixture {
  readonly activationKeys: string[];
  readonly activationFrozen: boolean;
  readonly configurationFrozen: boolean;
}

function referenceExposure(): ReferenceExposureFixture {
  const exposure = Reflect.get(globalThis, "__connectReferenceExposure") as ReferenceExposureFixture | undefined;
  if (!exposure) throw new Error("Reference Exposure fixture is not active");
  return exposure;
}

class MemoryTransport implements Transport {
  state: TransportState = "closed";
  handlers: TransportEvents | null = null;
  sent: Envelope[] = [];

  async connect(_url: string, handlers: TransportEvents): Promise<void> {
    this.state = "open";
    this.handlers = handlers;
    handlers.onOpen();
    handlers.onMessage(
      JSON.stringify({
        version: "2",
        event: EVENT.CONNECT_CHALLENGE,
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
      }),
    );
  }

  send(data: string): void {
    const envelope = parseEnvelope(data);
    this.sent.push(envelope);
    if (envelope.event !== EVENT.CONNECT) return;
    this.handlers?.onMessage(
      JSON.stringify({
        version: "2",
        event: EVENT.HELLO_OK,
        trace_id: envelope.trace_id,
        emitted_at: 2,
        payload: { device_id: "plugin-test-device", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
      }),
    );
  }

  close(): void {
    this.state = "closed";
  }
}

function activation(agentId: string): ActivationCredentials {
  return {
    localAgentId: agentId,
    accessToken: `token-${agentId}`,
    refreshToken: null,
    serverAgentId: `server-${agentId}`,
    userId: `user-${agentId}`,
    ownerUserId: "owner-1",
    conversationId: `chat-${agentId}`,
  };
}

async function installOfficialFixture(configPath: string, bundlePath: string) {
  const bundle = await readConnectPluginBundle(bundlePath);
  const staged = await stagePluginBundle({
    configPath,
    source: { type: "local", path: bundlePath },
    bundle,
    capabilityConfigurations: { "reference-exposure": { channel: "private" } },
  });
  return await commitStagedPlugin(configPath, staged, "install");
}

describe("official multi-capability Plugin platform", () => {
  it("runs class-instance Plugin providers through headless service activation and disposal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-plugin-platform-"));
    Reflect.deleteProperty(globalThis, "__connectReferenceExposure");
    Reflect.deleteProperty(globalThis, "__connectReferenceExposureEffects");
    const configPath = join(directory, "config.json");
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const fixturePath = join(import.meta.dir, "fixtures", "reference-runtime.connect-plugin");
    const secondBundlePath = join(directory, "reference-runtime-two.connect-plugin");
    const secondBundle = JSON.parse(await readFile(fixturePath, "utf8")) as { manifest: { pluginId: string } };
    secondBundle.manifest.pluginId = "test.reference-runtime-two";
    await writeFile(secondBundlePath, `${JSON.stringify(secondBundle, null, 2)}\n`);

    const firstInstall = await installOfficialFixture(configPath, fixturePath);
    const secondInstall = await installOfficialFixture(configPath, secondBundlePath);
    expect(firstInstall.activeArtifact).not.toBe(secondInstall.activeArtifact);
    expect(firstInstall.activeArtifact).toContain("plugins");
    await expect(listInstalledPlugins(configPath)).resolves.toHaveLength(2);

    let config = defaultConfig();
    config.stateDbPath = stateStore.dbPath;
    config = upsertAgentBinding(
      config,
      "trace-alpha",
      createAgentBinding({
        pluginId: firstInstall.pluginId,
        capabilityId: "reference-runtime",
        configuration: { instance: "alpha" },
      }),
    );
    config = upsertAgentBinding(
      config,
      "trace-beta",
      createAgentBinding({
        pluginId: secondInstall.pluginId,
        capabilityId: "reference-runtime",
        configuration: { instance: "beta" },
      }),
    );
    await saveConfig(config, configPath);
    await stateStore.upsertActivation(activation("trace-alpha"));
    await stateStore.upsertActivation(activation("trace-beta"));
    const serviceErrors: string[] = [];
    let resolveRuntimeAdapters!: (registry: RuntimeAdapterRegistry) => void;
    const runtimeAdaptersReady = new Promise<RuntimeAdapterRegistry>((resolve) => {
      resolveRuntimeAdapters = resolve;
    });
    let resolveServiceReady!: () => void;
    const serviceReady = new Promise<void>((resolve) => {
      resolveServiceReady = resolve;
    });
    let releaseService: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    const service = startConnectService(
      {
        config,
        configPath,
        stateStore,
        waitUntilShutdown: async () => {
          resolveServiceReady();
          await shutdown;
        },
        writeOutput: () => undefined,
        writeError: (message) => serviceErrors.push(message),
      },
      {
        createRuntimeAdapterRegistry: () => {
          const registry = new RuntimeAdapterRegistry([]);
          resolveRuntimeAdapters(registry);
          return registry;
        },
        verifyInstalledSkills: async () => undefined,
        startBindingRuntime: async (options) => {
          const clawChatApi: ClawChatApiClient = {
            agentsConnect: async () => {
              throw new Error("activation is outside this Plugin Platform scenario");
            },
            getUserProfile: async () => ({ nickname: "Owner" }),
            updateMyProfile: async () => undefined,
            getMyGroupSettings: async () => ({ authoritative: true, rows: [] }),
          };
          return await startBindingRuntime({
            ...options,
            wsTransport: new MemoryTransport(),
            clawChatApi,
            verifyInstalledSkills: async () => undefined,
          });
        },
      },
    );

    const registry = await Promise.race([
      Promise.all([runtimeAdaptersReady, serviceReady]).then(([readyRegistry]) => readyRegistry),
      service.then(() => {
        throw new Error("Connect Service stopped before the headless Plugin surfaces became ready");
      }),
    ]);
    expect(serviceErrors).toEqual([]);
    const exposure = referenceExposure();
    expect(exposure).toMatchObject({
      activationKeys: ["activationGeneration", "configuration"],
      activationFrozen: true,
      configurationFrozen: true,
    });
    expect(Reflect.get(globalThis, "__connectReferenceExposureEffects")).toEqual([
      "activate:private",
      "activate:private",
    ]);
    expect(registry.modesFor(getAgentBinding(config, "trace-alpha"))).toEqual(["trace"]);
    expect(registry.modesFor(getAgentBinding(config, "trace-beta"))).toEqual(["trace"]);
    await expect(stateStore.getRuntimeStatus("trace-alpha")).resolves.toMatchObject({ websocketConnected: true });
    await expect(stateStore.getRuntimeStatus("trace-beta")).resolves.toMatchObject({ websocketConnected: true });

    const output: string[] = [];
    await expect(
      runConnectCli(["plugin", "list", "--config", configPath], {
        writeStdout: (value) => output.push(value),
        writeStderr: (value) => output.push(value),
        pluginManagementFetch: async () => {
          throw new Error("Plugin manager is not listening in this injected service");
        },
      }),
    ).resolves.toBe(0);
    expect(output.join("\n")).toContain("source: local:");
    expect(output.join("\n")).toContain("reference-runtime (runtime:reference)");
    expect(output.join("\n")).toContain("dependent Bindings: trace-alpha");
    expect(output.join("\n")).toContain("dependent Bindings: trace-beta");

    releaseService?.();
    await expect(service).resolves.toEqual({ startedAgentIds: ["trace-alpha", "trace-beta"] });
    await expect(registry.prepare(getAgentBinding(config, "trace-alpha"))).rejects.toThrow("is not active");
    expect(Reflect.get(globalThis, "__connectReferenceExposure")).toBeUndefined();
    expect(Reflect.get(globalThis, "__connectReferenceExposureEffects")).toEqual([
      "activate:private",
      "activate:private",
      "dispose",
      "dispose",
    ]);
    await removeInstalledPlugin(configPath, firstInstall.pluginId);
    expect((await listInstalledPlugins(configPath)).map((plugin) => plugin.pluginId)).toEqual([secondInstall.pluginId]);
    expect(await loadConfig(configPath)).toMatchObject({
      agents: {
        "trace-alpha": {
          runtime: { pluginId: firstInstall.pluginId, capabilityId: "reference-runtime" },
          runtimeConfig: { instance: "alpha" },
        },
      },
    });
  });
});

const referenceFixturePath = join(import.meta.dir, "fixtures", "reference-runtime.connect-plugin");
const referenceFixtureBundle = await readConnectPluginBundle(referenceFixturePath);

describe("reference Runtime Bundle integrity", () => {
  const fixturePath = referenceFixturePath;
  const bundle = referenceFixtureBundle;

  it("packages the canonical reference source unchanged", async () => {
    const source = await readFile(join(import.meta.dir, "fixtures", "reference-runtime-plugin.mjs"), "utf8");
    expect(bundle.files["runtime.mjs"]).toEqual({ encoding: "utf8", content: source });
  });

  it.each(bundle.manifest.artifacts.map(({ target }) => target))(
    "stages the declared %s artifact with integrity verification",
    async (target) => {
      const directory = await mkdtemp(join(tmpdir(), "connect-reference-target-"));
      const staged = await stagePluginBundle({
        configPath: join(directory, "config.json"),
        source: { type: "local", path: fixturePath },
        bundle,
        target,
        capabilityConfigurations: { "reference-exposure": { channel: "private" } },
      });
      expect(staged.entry.target).toBe(target);
      expect(await readFile(staged.entry.activeArtifact, "utf8")).toBe(bundle.files["runtime.mjs"]?.content);
    },
  );
});
