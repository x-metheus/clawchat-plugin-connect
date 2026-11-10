import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin, discoverOfficialPluginDescriptors } from "../scripts/build-official-plugins";
import { materializeRuntimeOutput, policyForOutputVisibility } from "../src/clawchat/output-visibility";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { ConnectPluginHost } from "../src/plugin/host";
import descriptor from "../src/plugin/official/deepseek-harness-descriptor";
import {
  DEEPSEEK_HARNESS_BINDING_CONFIGURATION_SCHEMA,
  DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
  DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
  DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
  DEEPSEEK_HARNESS_WEB_APP_CONFIGURATION_SCHEMA,
} from "../src/plugin/official/deepseek-harness-manifest";
import {
  createDeepSeekHarnessRuntimeAdapter,
  type DeepSeekHarnessRuntimeAdapterBinding,
  DshActivityProjector,
  dshPromptInput,
  projectDshHistory,
} from "../src/runtime/deepseek-harness-adapter";
import type { DshBridgeClient } from "../src/runtime/deepseek-harness-process";
import type {
  DshBridgeCatalogModel,
  DshBridgeEvent,
  DshBridgeHello,
  DshBridgeInteraction,
  DshBridgeSessionSummary,
  DshSessionEvent,
} from "../src/runtime/deepseek-harness-protocol";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { ClawChatTurnSurface } from "../src/runtime/turn-surface";
import type { ConnectRuntimePrompt, ConnectRuntimeStartContext } from "../src/runtime/types";
import type { RuntimeWorkspace } from "../src/types";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";

const target = `${process.platform}-${process.arch}`;

const SUPPORTED_HELLO: DshBridgeHello = {
  type: "hello",
  protocol: { name: "clawchat-connect-dsh-bridge", major: 1, build: "test" },
  home: "",
  profile: "default",
  capabilities: {
    promptQueue: true,
    promptSteer: true,
    cancel: true,
    durableReceipt: true,
    history: true,
    approvals: false,
    questions: false,
    models: true,
    presets: false,
    permissionPresets: false,
    skills: true,
    commands: true,
    imageInput: false,
    localProducedFilePresentation: false,
    portableArtifactOutput: false,
    archive: true,
    restore: false,
    delete: false,
    crossProcessSessionOwnership: false,
  },
};

const WORKSPACE = (directory: string): RuntimeWorkspace => ({
  workspaceRef: "workspace-1",
  workingDirectory: directory,
  skipGitRepoCheck: false,
});

describe("DeepSeek Harness Runtime Adapter", () => {
  it("keeps direct-message transport context out of native text and preserves quoted user content", () => {
    const context = JSON.stringify({ origin: "clawchat", message_id: "id", content_digest: "digest" });
    const body = "  explain <clawchat_turn_context> literally\n";
    expect(dshPromptInput(`<clawchat_turn_context>\n${context}\n</clawchat_turn_context>\n\n${body}`)).toEqual({
      text: body,
      clawchatTurnContext: context,
    });
    const malformed = "<clawchat_turn_context>\n{}\n</clawchat_turn_context>\n\nhello";
    expect(dshPromptInput(malformed)).toEqual({ text: malformed });
    expect(dshPromptInput("ordinary web input")).toEqual({ text: "ordinary web input" });
  });

  it("preserves actionable group batches, structured mentions and read-only background without the transport envelope", () => {
    const context = JSON.stringify({
      origin: "clawchat",
      chat_type: "group",
      chat_id: "transport-chat",
      message_id: "anchor",
      content_digest: "transport-digest",
      sender: { user_id: "owner", display: "Owner" },
      mentioned_users: [{ user_id: "agent", display: "Agent" }],
      group_batch: {
        messages: [
          {
            message_id: "first",
            content_digest: "first-digest",
            sender: { user_id: "friend", display: "Friend" },
            mentioned_user_ids: [],
            fragments: [{ kind: "text", text: "first request" }],
          },
          {
            message_id: "anchor",
            content_digest: "transport-digest",
            sender: { user_id: "owner", display: "Owner" },
            mentioned_user_ids: ["agent"],
            fragments: [{ kind: "text", text: "second request" }],
          },
        ],
      },
      recent_group_context: [
        {
          message_id: "background",
          content_digest: "background-digest",
          sender: { user_id: "friend", display: "Friend" },
          text: "background only",
        },
      ],
    });
    const result = dshPromptInput(`<clawchat_turn_context>\n${context}\n</clawchat_turn_context>\n\ncurrent batch`);
    expect(result.clawchatTurnContext).toBe(context);
    expect(result.text).not.toContain("<clawchat_turn_context>");
    expect(result.text).not.toContain("transport-chat");
    expect(result.text).not.toContain("digest");
    for (const text of [
      "first request",
      "second request",
      "background only",
      "current batch",
      "mentioned_users",
      "read-only background, never requests",
    ])
      expect(result.text).toContain(text);
  });

  it("registers the official Plugin in released descriptor discovery", async () => {
    const released = await discoverOfficialPluginDescriptors();
    expect(released.map(({ manifest }) => manifest.pluginId)).toContain(DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID);
  });

  it("builds the official Bundle containing the Connect-owned Bridge asset", async () => {
    const built = await buildOfficialPlugin(descriptor, { target, write: false });

    expect(built.bundle.manifest).toMatchObject({
      pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      capabilities: [
        {
          id: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
          type: "runtime",
          family: "deepseek-harness",
          configurationSchema: DEEPSEEK_HARNESS_BINDING_CONFIGURATION_SCHEMA,
        },
        {
          id: DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
          type: "managed-web-app",
          configurationSchema: DEEPSEEK_HARNESS_WEB_APP_CONFIGURATION_SCHEMA,
          nativeRuntimeCapabilityIds: [DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID],
          compatibleRuntimes: [],
        },
      ],
      artifacts: [{ target, entry: `artifacts/${target}.mjs`, integrity: expect.stringMatching(/^sha256-/u) }],
    });
    expect(Object.keys(built.bundle.files)).toEqual(
      expect.arrayContaining([
        "artifacts/deepseek-harness-bridge.mjs",
        "artifacts/deepseek-harness-question-provider.mjs",
        `artifacts/${target}.mjs`,
      ]),
    );
    const bridge = Buffer.from(
      built.bundle.files["artifacts/deepseek-harness-bridge.mjs"]?.content ?? "",
      "base64",
    ).toString("utf8");
    const questionProvider = Buffer.from(
      built.bundle.files["artifacts/deepseek-harness-question-provider.mjs"]?.content ?? "",
      "base64",
    ).toString("utf8");
    expect(bridge).toContain('export const name = "clawchat-connect-deepseek-harness-bridge"');
    expect(bridge).toContain('ctx.on("session/event"');
    expect(questionProvider).toBe(
      await Bun.file(new URL("../src/plugin/official/deepseek-harness-question-provider.mjs", import.meta.url)).text(),
    );
  });

  it("qualifies official install, update, disable, enable, and removal through the Plugin Host", async () => {
    const builtDsh = await buildOfficialPlugin(descriptor, { target, write: false });
    const directory = await mkdtemp(join(tmpdir(), "connect-official-dsh-"));
    const bundlePath = join(directory, builtDsh.filename);
    await writeFile(bundlePath, `${JSON.stringify(builtDsh.bundle, null, 2)}\n`);
    const config = defaultConfig();
    const store = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(store);
    const registry = new RuntimeAdapterRegistry([]);
    const host = new ConnectPluginHost(join(directory, "config.json"), registry, () => undefined, {
      config,
      stateStore: store,
      workspaces,
    });
    const binding: DeepSeekHarnessRuntimeAdapterBinding = {
      runtime: {
        pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
        capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      },
      runtimeConfig: { profile: "default" },
      profile: "default",
      homePath: directory,
    };
    try {
      const installed = await host.install({ source: bundlePath, target, installationConfiguration: {} });
      expect(installed).toMatchObject({ status: "active" });
      expect(registry.hasProvider(binding)).toBe(true);
      await expect(host.update(DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({ status: "active" });
      await expect(host.disable(DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({ status: "disabled" });
      await expect(host.enable(DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID)).resolves.toMatchObject({ status: "active" });
      await host.remove(DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID, true);
      expect(await host.list()).toEqual([]);
    } finally {
      await host.close();
      await store.close();
    }
  });

  it("projects one native Session log identically for history and live replacement semantics", () => {
    const events: DshSessionEvent[] = [
      event(1, "turn/start", { turn: 1 }),
      event(2, "user/message", {
        turn: 1,
        id: "user-1",
        source: { kind: "user" },
        content: [{ type: "text", text: "hello" }],
      }),
      event(3, "assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", text: "hel" } }),
      event(4, "assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", text: "lo" } }),
      event(5, "assistant/message", {
        turn: 1,
        step: 0,
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      event(6, "tool/call", { turn: 1, callId: "call-1", name: "read", arguments: '{"path":"a"}' }),
      event(7, "tool/result", {
        turn: 1,
        message: {
          source: { callId: "call-1" },
          content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }],
        },
      }),
      event(8, "future/event", { turn: 1, secret: "safe-projection" }),
      event(9, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];

    const snapshot = projectDshHistory("session-1", events);

    expect(snapshot).toMatchObject({ completeness: "complete", limitations: [] });
    expect(snapshot.activities).toEqual([
      expect.objectContaining({ id: "dsh:session-1:message:user-1", kind: "user", text: "hello", position: "1.0" }),
      expect.objectContaining({
        id: "dsh:session-1:assistant:1:0",
        kind: "assistant",
        text: "hello",
        state: "complete",
      }),
      expect.objectContaining({ id: "dsh:session-1:tool:call-1", kind: "tool", text: "ok", state: "complete" }),
      expect.objectContaining({
        id: "dsh:session-1:event:8",
        kind: "unknown",
        text: expect.stringContaining("future/event"),
      }),
      expect.objectContaining({ id: "dsh:session-1:turn:1", kind: "turn", state: "complete" }),
    ]);
    expect(new Set(snapshot.activities.map((activity) => activity.position)).size).toBe(snapshot.activities.length);
  });

  it("classifies DSH reasoning and terminal text for ClawChat output visibility", async () => {
    const events = [
      event(1, "turn/start", { turn: 1 }),
      event(2, "user/message", {
        turn: 1,
        id: "user-output",
        source: { kind: "user" },
        content: [{ type: "text", text: "question" }],
      }),
      event(3, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "reasoning-delta", text: "private reasoning" },
      }),
      event(4, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", text: "final answer" },
      }),
      event(5, "assistant/message", {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "final answer" },
          ],
        },
      }),
      event(6, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    const activities = projectDshHistory("session-output", events).activities;
    const deliveredText = async (mode: "minimal" | "normal" | "full") => {
      const replies: string[] = [];
      const policy = policyForOutputVisibility(mode);
      const surface = new ClawChatTurnSurface({
        project: async () => undefined,
        materialize: (activity) => materializeRuntimeOutput(activity, policy),
        deliver: async (_activity, reply) => {
          replies.push(reply.text);
        },
      });
      const projector = new DshActivityProjector(`session-${mode}`);
      for (const nativeEvent of events) {
        for (const activity of projector.accept(nativeEvent, "live")) await surface.accept(activity);
      }
      await surface.complete();
      return replies;
    };

    expect(activities).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "question",
        data: expect.objectContaining({ deliveryDisposition: "projection-only" }),
      }),
      expect.objectContaining({
        kind: "reasoning",
        text: "private reasoning",
        state: "complete",
        data: expect.objectContaining({ outputKind: "reasoning" }),
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "final answer",
        state: "complete",
        data: expect.objectContaining({ outputKind: "final" }),
      }),
      expect.objectContaining({ kind: "turn", text: "Turn completed.", state: "complete" }),
    ]);
    expect(await deliveredText("minimal")).toEqual(["final answer"]);
    expect(await deliveredText("normal")).toEqual(["final answer"]);
    expect(await deliveredText("full")).toEqual(["private reasoning", "final answer", "Turn completed."]);
  });

  it("creates a native Session, waits for durable admission, streams Events, and reconciles the input", async () => {
    const fixture = await runtimeFixture();
    const client = new FakeDshBridgeClient(fixture.home, fixture.workspace);
    const runtimeIds: string[] = [];
    const adapter = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/connect/deepseek-harness-bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/usr/local/bin/dsh" }),
      createBridge: async () => client,
    });
    const binding = fixture.binding;
    await adapter.prepare?.(binding);
    const context = startContext(runtimeIds);
    const session = await adapter.start(binding, context);
    let accepted = 0;
    const activities = await Array.fromAsync(
      session.prompt(
        prompt(fixture.workspace, {
          turnId: "connect-input-1",
          onAccepted: async () => {
            accepted += 1;
          },
        }),
      ),
    );

    expect(runtimeIds).toHaveLength(1);
    expect(accepted).toBe(1);
    expect(client.requests.map(({ method }) => method)).toEqual(["create", "selectModel", "history", "prompt"]);
    expect(activities).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "hello",
        inputIdentity: expect.objectContaining({
          anchor: { messageId: "connect-input-1", contentDigest: "sha256:connect-input-1" },
        }),
        source: "live",
      }),
      expect.objectContaining({ kind: "assistant", text: "world", state: "streaming" }),
      expect.objectContaining({
        kind: "assistant",
        text: "world",
        state: "complete",
        data: expect.objectContaining({ outputKind: "assistant" }),
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "world",
        state: "complete",
        data: expect.objectContaining({ outputKind: "final" }),
      }),
      expect.objectContaining({ kind: "turn", state: "complete" }),
    ]);
    const runtimeThreadId = runtimeIds[0] ?? "";
    await expect(
      adapter.reconcileInput?.(binding, runtimeThreadId, {
        messageId: "connect-input-1",
        contentDigest: "sha256:connect-input-1",
      }),
    ).resolves.toMatchObject({ outcome: "accepted" });
    await session.close();
    await adapter.close?.();
    expect(client.closeCount).toBe(1);
  });

  it("preserves a Client's valid envelope quotation without inventing a ClawChat receipt", async () => {
    const fixture = await runtimeFixture();
    const client = new FakeDshBridgeClient(fixture.home, fixture.workspace);
    const adapter = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/connect/bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/usr/local/bin/dsh" }),
      createBridge: async () => client,
    });
    const runtimeIds: string[] = [];
    const session = await adapter.start(fixture.binding, startContext(runtimeIds));
    const input = prompt(fixture.workspace, { turnOrigin: "client" });
    const activities = await Array.fromAsync(session.prompt(input));
    const user = activities.find((activity) => activity.kind === "user");
    expect(user?.text).toBe(input.prompt);
    expect(user?.inputIdentity).toBeUndefined();
    expect(client.requests.find((r) => r.method === "prompt")?.params).toMatchObject({
      text: input.prompt,
      inputOrigin: "client",
    });
    expect(client.requests.find((r) => r.method === "prompt")?.params).not.toHaveProperty("clawchatTurnContext");
    await expect(
      adapter.reconcileInput?.(fixture.binding, runtimeIds[0]!, {
        messageId: "connect-input-1",
        contentDigest: "sha256:connect-input-1",
      }),
    ).resolves.toMatchObject({ outcome: "absent" });
    await session.close();
    await adapter.close?.();
  });

  it("reads legacy bridge identities while leaving native Web quotations as ordinary text", () => {
    const text = prompt("/tmp").prompt;
    const legacy = projectDshHistory("legacy", [
      event(1, "user/message", {
        id: "old",
        source: { kind: "user", connectInputId: "old-turn" },
        content: [{ type: "text", text }],
      }),
    ]);
    expect(legacy.activities[0]?.inputIdentity?.anchor.messageId).toBe("connect-input-1");
    const web = projectDshHistory("web", [
      event(1, "user/message", { id: "web", source: { kind: "user" }, content: [{ type: "text", text }] }),
    ]);
    expect(web.activities[0]?.text).toBe(text);
    expect(web.activities[0]?.inputIdentity).toBeUndefined();
  });

  it("settles DSH approval requests through the Connect interaction port", async () => {
    const fixture = await runtimeFixture();
    const client = new FakeDshBridgeClient(fixture.home, fixture.workspace);
    client.interactionOnPrompt = {
      type: "interaction",
      id: "approval-1",
      sessionId: "created",
      request: {
        kind: "approval",
        action: "command",
        title: "DeepSeek Harness requests shell",
        description: "Allow shell for this turn?",
        options: [
          { id: "approve-once", label: "Approve once" },
          { id: "deny", label: "Deny" },
        ],
      },
    };
    const adapter = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/connect/deepseek-harness-bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/usr/local/bin/dsh" }),
      createBridge: async () => client,
    });
    const session = await adapter.start(fixture.binding, startContext([]));
    let observedRequest: unknown;
    let deliveryConfirmed = false;

    await Array.fromAsync(
      session.prompt(
        prompt(fixture.workspace, {
          turnId: "connect-input-1",
          turnOrigin: "client",
          metadata: { sessionRef: "session-ref-1" },
          interactionPort: {
            request: async (request, context) => {
              observedRequest = request;
              void context.deliveryConfirmation.then(() => {
                deliveryConfirmed = true;
              });
              return { kind: "approval", optionId: "approve-once" };
            },
          },
        }),
      ),
    );
    await Promise.resolve();

    expect(observedRequest).toEqual(client.interactionOnPrompt.request);
    expect(client.interactionResponse).toEqual({
      id: "approval-1",
      sessionId: client.interactionOnPrompt.sessionId,
      response: { kind: "approval", optionId: "approve-once" },
    });
    expect(deliveryConfirmed).toBe(true);
    await adapter.close?.();
  });

  it("negotiates image limits, stages raster input, switches the exact model, and applies permission presets", async () => {
    const fixture = await runtimeFixture();
    const client = new FakeDshBridgeClient(fixture.home, fixture.workspace);
    client.hello.capabilities.imageInput = true;
    client.hello.capabilities.permissionPresets = true;
    client.models = [
      {
        provider: "vision",
        id: "vision-1",
        name: "Vision",
        inputModalities: ["text", "image"],
        imageLimits: {
          maxImageBytes: 1_000_000,
          maxImagesPerMessage: 4,
          maxMessageImageBytes: 2_000_000,
          mediaTypes: ["image/png"],
        },
      },
    ];
    const adapter = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/connect/deepseek-harness-bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/usr/local/bin/dsh" }),
      createBridge: async () => client,
    });
    const models = await adapter.listModels?.(fixture.binding);
    const sessionOptions = await adapter.listSessionOptions?.(fixture.binding, WORKSPACE(fixture.workspace));
    expect(models?.[0]?.turnSubmissionCapability?.attachments).toEqual({
      allowedKinds: ["image"],
      allowedMediaTypes: ["image/png"],
      maxCount: 4,
      maxBytesEach: 1_000_000,
      maxBytesTotal: 2_000_000,
    });
    expect(sessionOptions).toEqual([
      {
        id: "permissionPreset",
        displayName: "Permission Preset",
        description: "DeepSeek Harness sandbox and approval policy",
        category: "execution",
        changePolicy: "new-runtime-session",
        defaultValue: "workspace-write",
        values: [{ id: "workspace-write", displayName: "Workspace write", description: "Ask before writes" }],
      },
    ]);

    const stagedPath = join(fixture.workspace, "staged-image.png");
    await Bun.write(stagedPath, "fake-image-for-adapter-boundary");
    const session = await adapter.start(fixture.binding, {
      ...startContext([]),
      cacheMedia: async () => stagedPath,
    });
    await Array.fromAsync(
      session.prompt(
        prompt(fixture.workspace, {
          model: { provider: "vision", model: "vision-1" },
          reasoningEffort: "high",
          sessionOptions: { permissionPreset: "workspace-write" },
          media: [
            {
              kind: "image",
              url: "https://trusted.example/image.png",
              mime: "image/png",
              name: "../private/image.png",
            },
          ],
        }),
      ),
    );

    expect(client.requests.find(({ method }) => method === "create")?.params).toMatchObject({
      model: { provider: "vision", model: "vision-1", reasoningEffort: "high" },
      permissionPreset: "workspace-write",
    });
    expect(client.requests.find(({ method }) => method === "selectModel")?.params).toMatchObject({
      model: { provider: "vision", model: "vision-1", reasoningEffort: "high" },
    });
    expect(client.requests.find(({ method }) => method === "prompt")?.params).toMatchObject({
      images: [{ path: stagedPath, mediaType: "image/png", name: "image.png" }],
    });
    await adapter.close?.();
  });

  it("exposes usable persisted Sessions for native resume regardless of creator", async () => {
    const fixture = await runtimeFixture();
    const client = new FakeDshBridgeClient(fixture.home, fixture.workspace);
    client.sessions = [
      sessionSummary("owned", fixture.workspace, true, false),
      sessionSummary("external", fixture.workspace, false, false),
      sessionSummary("archived", fixture.workspace, false, true),
      sessionSummary("subagent", fixture.workspace, false, false, "subagent"),
    ];
    const adapter = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/connect/deepseek-harness-bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/usr/local/bin/dsh" }),
      createBridge: async () => client,
    });

    const active = await adapter.discoverAllThreads?.(fixture.binding);
    const archived = await adapter.discoverArchivedThreads?.(fixture.binding);

    expect(active?.threads.map(({ runtimeThreadId }) => runtimeThreadId)).toEqual(["owned", "external"]);
    expect(active?.threads.map(({ adoption }) => adoption)).toEqual([{ status: "available" }, { status: "available" }]);
    expect(archived?.threads).toEqual([
      expect.objectContaining({ runtimeThreadId: "archived", adoption: { status: "unavailable", reason: "archived" } }),
    ]);
    await expect(adapter.verifyThreadReady?.(fixture.binding, "external")).resolves.toBeUndefined();

    const resumed = await adapter.start(fixture.binding, { ...startContext([]), runtimeSessionId: "external" });
    await Array.fromAsync(resumed.prompt(prompt(fixture.workspace)));
    expect(client.requests).toContainEqual({ method: "resume", params: { sessionId: "external" } });
    await adapter.close?.();
  });

  it("allows shared Homes and activates with optional native capabilities absent", async () => {
    const fixture = await runtimeFixture();
    const first = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/dsh" }),
      createBridge: async () => new FakeDshBridgeClient(fixture.home, fixture.workspace),
    });
    const second = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/dsh" }),
      createBridge: async () => new FakeDshBridgeClient(fixture.home, fixture.workspace),
    });
    await expect(first.prepare?.(fixture.binding)).resolves.toBeUndefined();
    await expect(second.prepare?.(fixture.binding)).resolves.toBeUndefined();
    await first.close?.();
    await second.close?.();

    const reducedClient = new FakeDshBridgeClient(fixture.home, fixture.workspace);
    reducedClient.hello.capabilities.archive = false;
    reducedClient.hello.profile = null;
    const reduced = createDeepSeekHarnessRuntimeAdapter({
      bridgePath: "/bridge.mjs",
      bridgeBuild: "test",
      probeExecutable: () => ({ path: "/dsh" }),
      createBridge: async () => reducedClient,
    });
    const binding = { ...fixture.binding, runtimeConfig: {}, profile: undefined };
    await expect(reduced.prepare?.(binding)).resolves.toBeUndefined();
    expect(reduced.lifecycleCapabilities?.archive).toBe(false);
    await reduced.close?.();
  });
});

class FakeDshBridgeClient implements DshBridgeClient {
  readonly hello: DshBridgeHello;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  sessions: DshBridgeSessionSummary[] = [];
  closeCount = 0;
  interactionOnPrompt: DshBridgeInteraction | null = null;
  models: DshBridgeCatalogModel[] = [];
  permissionPresetCatalog = {
    defaultId: "workspace-write",
    presets: [{ id: "workspace-write", name: "Workspace write", description: "Ask before writes" }],
  };
  interactionResponse: unknown = null;
  private settleInteraction: (() => void) | null = null;
  private readonly listeners = new Set<(event: DshBridgeEvent) => void>();
  private readonly interactionListeners = new Set<(interaction: DshBridgeInteraction) => void>();
  private readonly histories = new Map<string, DshSessionEvent[]>();

  constructor(
    home: string,
    private readonly workspace: string,
  ) {
    this.hello = structuredClone(SUPPORTED_HELLO);
    this.hello.home = home;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    const values = params as {
      sessionId?: string;
      inputId?: string;
      text?: string;
      clawchatTurnContext?: string;
      inputOrigin?: string;
    };
    if (method === "history") {
      const sessionId = values.sessionId ?? "missing";
      return {
        header: { id: sessionId, createdAt: 1, cwd: this.workspace },
        events: this.histories.get(sessionId) ?? [],
      } as T;
    }
    if (method === "create") {
      const sessionId = values.sessionId ?? "created";
      this.histories.set(sessionId, []);
      return { sessionId, header: { id: sessionId, createdAt: 1, cwd: this.workspace } } as T;
    }
    if (method === "resume") {
      const sessionId = values.sessionId ?? "missing";
      if (!this.histories.has(sessionId)) this.histories.set(sessionId, []);
      return { sessionId, header: { id: sessionId, createdAt: 1, cwd: this.workspace } } as T;
    }
    if (method === "prompt") {
      const sessionId = values.sessionId ?? "missing";
      const inputId = values.inputId ?? "missing";
      if (this.interactionOnPrompt) {
        this.interactionOnPrompt = { ...this.interactionOnPrompt, sessionId };
        const settled = new Promise<void>((resolve) => {
          this.settleInteraction = resolve;
        });
        for (const listener of this.interactionListeners) listener(this.interactionOnPrompt);
        await settled;
      }
      const emitted = [
        event(1, "turn/start", { turn: 1 }),
        event(2, "user/message", {
          turn: 1,
          id: inputId,
          source: {
            kind: "user",
            connectInputId: inputId,
            connectInputOrigin: values.inputOrigin,
            clawchatTurnContext: values.clawchatTurnContext,
          },
          content: [{ type: "text", text: values.text ?? "" }],
        }),
        event(3, "assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", text: "world" } }),
        event(4, "assistant/message", {
          turn: 1,
          step: 0,
          message: { content: [{ type: "text", text: "world" }] },
        }),
        event(5, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      ];
      this.histories.set(sessionId, emitted);
      for (const nativeEvent of emitted) this.emit({ type: "event", sessionId, event: nativeEvent });
      return { inputId, messageId: inputId } as T;
    }
    if (method === "discover") return this.sessions as T;
    if (method === "interactionResponse") {
      this.interactionResponse = params;
      this.settleInteraction?.();
      this.settleInteraction = null;
      return { accepted: true } as T;
    }
    if (method === "cancel") return { reason: "aborted", idle: true } as T;
    if (method === "archive") return {} as T;
    if (method === "selectModel") {
      if (params && typeof params === "object" && "model" in params) return params.model as T;
      throw new Error("Fake DSH selectModel request has no model");
    }
    if (method === "models") return this.models as T;
    if (method === "permissionPresets") return this.permissionPresetCatalog as T;
    if (method === "skills" || method === "commands") return [] as T;
    throw new Error(`Unexpected fake DSH Bridge request: ${method}`);
  }

  onInteraction(listener: (interaction: DshBridgeInteraction) => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  onEvent(listener: (event: DshBridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  private emit(event: DshBridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function runtimeFixture(): Promise<{
  home: string;
  workspace: string;
  binding: DeepSeekHarnessRuntimeAdapterBinding;
}> {
  const root = await mkdtemp(join(tmpdir(), "connect-dsh-adapter-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(join(home, "profiles", "default"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await Bun.write(join(home, "profiles", "default", "package.json"), "{}\n");
  await Bun.write(join(home, "profiles", "default", "cordis.patch.yml"), "{}\n");
  const canonicalHome = await realpath(home);
  return {
    home: canonicalHome,
    workspace: await realpath(workspace),
    binding: {
      runtime: {
        pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
        capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
      },
      runtimeConfig: { profile: "default", homePath: canonicalHome },
      profile: "default",
      homePath: canonicalHome,
    },
  };
}

function startContext(runtimeIds: string[]): ConnectRuntimeStartContext {
  return {
    agentId: "deepseek",
    chatId: "chat-1",
    sessionId: "session-1",
    runtimeSessionId: null,
    onRuntimeSessionId: async (runtimeThreadId) => {
      runtimeIds.push(runtimeThreadId);
    },
    cacheMedia: async () => {
      throw new Error("media cache should not be used");
    },
  };
}

function prompt(workspaceDirectory: string, overrides: Partial<ConnectRuntimePrompt> = {}): ConnectRuntimePrompt {
  return {
    prompt: [
      "<clawchat_turn_context>",
      JSON.stringify({
        origin: "clawchat",
        message_id: "connect-input-1",
        content_digest: "sha256:connect-input-1",
      }),
      "</clawchat_turn_context>",
      "",
      "hello",
    ].join("\n"),
    workspace: WORKSPACE(workspaceDirectory),
    model: { provider: "deepseek", model: "deepseek-chat" },
    turnOrigin: "clawchat",
    ...overrides,
  };
}

function event(seq: number, type: string, data: unknown): DshSessionEvent {
  return { seq, time: seq, type, data };
}

function sessionSummary(
  id: string,
  cwd: string,
  owned: boolean,
  archived: boolean,
  origin?: "subagent",
): DshBridgeSessionSummary {
  return {
    header: { id, createdAt: 1, cwd, ...(origin ? { origin } : {}) },
    owned,
    archived,
    title: id,
    updatedAt: 1,
  };
}
