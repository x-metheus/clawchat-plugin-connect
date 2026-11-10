import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleChatCommand } from "../src/clawchat/chat-commands";
import type { NormalizedInboundMessage } from "../src/clawchat/protocol";
import type { ConnectWsClient } from "../src/clawchat/ws-client";
import { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { defaultConfig, upsertAgentBinding } from "../src/config";
import { type ConnectStateStore, createStateStore } from "../src/persistence/state";
import { ConnectRuntime } from "../src/runtime/connect-runtime";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import {
  type ConnectRuntimeAdapter,
  type ConnectRuntimePrompt,
  type ConnectRuntimeSession,
  type ConnectRuntimeStartContext,
  completeRuntimeThreadDiscovery,
  type RuntimeActivity,
} from "../src/runtime/types";
import { createWorkBuddyRuntimeAdapter, type WorkBuddyRuntimeSource } from "../src/runtime/workbuddy-adapter";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

function message(text = "hello"): NormalizedInboundMessage {
  return {
    event: "message.send",
    chatId: "chat-1",
    chatType: "direct",
    messageId: "message-1",
    traceId: "trace-1",
    sender: { id: "user-1", type: "direct", nick_name: "User" },
    emittedAt: Date.now(),
    text,
    fragments: [{ kind: "text", text }],
    mentions: [],
    replyToMessageId: null,
    raw: {} as never,
  };
}

function session(
  prompt: (context: ConnectRuntimeStartContext) => AsyncIterable<RuntimeActivity>,
  context: ConnectRuntimeStartContext,
): ConnectRuntimeSession {
  return {
    prompt: () => prompt(context),
    close: mock(async () => undefined),
    cancel: mock(async () => true),
  };
}

let nextActivityId = 0;
function activity(text: string, outputKind: "final" | "progress" = "final"): RuntimeActivity {
  const position = `${nextActivityId++}`;
  return {
    id: `test-activity-${position}`,
    position,
    parentId: null,
    kind: outputKind === "final" ? "assistant" : "progress",
    text,
    state: "complete",
    source: "live",
    data: { outputKind },
  };
}

async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-runtime-"));
  const config = upsertAgentBinding(defaultConfig(), "codex", pluginBinding());
  config.stateDbPath = join(directory, "state.sqlite");
  const store = createStateStore({ dbPath: config.stateDbPath });
  await store.upsertRuntimeSession({
    chatId: "chat-1",
    sessionId: "session-1",
    agentId: "codex",
    workspaceRef: null,
    isCurrent: true,
  });
  const uploadMedia = mock(async (_file: Blob, _options?: { filename?: string }) => ({
    kind: "image" as const,
    url: "https://cdn.example/uploaded-image",
    name: "00-TheFool.jpg",
    mime: "image/jpeg",
    size: 11,
  }));
  const sendMessageEnvelope = mock(async () => ({ payload: {} }));
  const wsClient = { uploadMedia, sendMessageEnvelope } as unknown as ConnectWsClient;
  return { config, store, wsClient, uploadMedia, sendMessageEnvelope, configPath: join(directory, "config.json") };
}

async function resetToUnlockedRuntimeSession(store: ConnectStateStore) {
  await store.deleteRuntimeSession("chat-1", "codex", "session-1");
  return await store.resolveOrMaterializeRuntimeSession({
    chatId: "chat-1",
    agentId: "codex",
    sessionId: "session-1",
    acceptedTurn: false,
  });
}
describe("ConnectRuntime Agent Binding sessions", () => {
  it.each(["workbuddy-ai", "workbuddy-cn"] as const)(
    "serializes Client and ClawChat turns through one adopted %s Task Attachment",
    async (profile) => {
      const fixture = await runtimeFixture();
      const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
      if (!current) throw new Error("current Session is missing");
      const taskId = "00000000-0000-4000-8000-000000000001";
      await fixture.store.setRuntimeSessionId(current.chatId, current.agentId, current.sessionId, taskId);
      fixture.config.agents.codex = pluginBinding({ profile });
      const prompts: ConnectRuntimePrompt[] = [];
      let starts = 0;
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const runtimeSource: WorkBuddyRuntimeSource = {
        listTasks: async () => [{ id: taskId, title: "Adopted", workspace: tmpdir(), updatedAt: Date.now() }],
        attachTask: async () => ({ activities: [], completeness: "complete", limitations: [] }),
        startTask: async () => {
          starts += 1;
          return {
            verification: {
              taskId,
              replayFingerprint: "verified-history",
              replayStarted: true,
              replayCompleted: true,
              activities: [],
              connectionOwner: null,
            },
            catalog: {
              models: [],
              currentModelId: null,
              modes: [],
              currentModeId: null,
              configOptions: [],
              currentConfig: {},
              commands: [],
              skills: [],
            },
            onCatalogChanged: () => () => undefined,
            prompt: async function* (input) {
              const turn = prompts.length;
              prompts.push(input);
              if (turn === 0) await firstGate;
              const nativeId = input.turnId ?? `turn-${turn}`;
              yield {
                id: `workbuddy:user:${nativeId}`,
                position: `${turn}.1`,
                parentId: null,
                kind: "user",
                text: input.prompt,
                state: "complete",
                source: "live",
                data:
                  input.turnOrigin === "clawchat"
                    ? { clawchatMessageId: nativeId }
                    : { clientMessageId: `turn_${nativeId}_user` },
              };
              yield {
                id: `workbuddy:assistant:${nativeId}`,
                position: `${turn}.2`,
                parentId: null,
                kind: "assistant",
                text: `answer ${turn + 1}`,
                state: "complete",
                source: "live",
              };
            },
            close: async () => undefined,
          };
        },
      };
      const adapter = createWorkBuddyRuntimeAdapter({ createSource: () => runtimeSource });
      const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
      const transcriptProjection = new TranscriptProjection({
        stateStore: fixture.store,
        config: fixture.config,
        runtimeAdapters,
      });
      const runtime = new ConnectRuntime({
        agentId: "codex",
        config: fixture.config,
        configPath: fixture.configPath,
        stateStore: fixture.store,
        wsClient: fixture.wsClient,
        runtimeAdapters,
        transcriptProjection,
      });

      const accepted = await runtime.enqueueClientTurn(current.sessionRef, "client asks first");
      while (prompts.length === 0) await Bun.sleep(0);
      const clawchatTurn = runtime.handleInboundMessage({
        ...message("clawchat asks second"),
        messageId: "clawchat-turn",
      });
      await Bun.sleep(5);
      expect(prompts).toHaveLength(1);

      releaseFirst?.();
      await clawchatTurn;
      while (runtime.activeClientTurnId(current.sessionRef) === accepted.turnId) await Bun.sleep(0);

      expect(starts).toBe(2);
      expect(prompts.map((prompt) => prompt.turnOrigin)).toEqual(["client", "clawchat"]);
      const blocks = await fixture.store.listTranscriptBlocks(current.sessionRef);
      expect(blocks.filter((block) => block.type === "message" && block.role === "user")).toHaveLength(2);
      expect(blocks.filter((block) => block.type === "message" && block.role === "assistant")).toHaveLength(2);

      await runtime.dispose();
      await runtimeAdapters.close();
      await fixture.store.close();
    },
  );

  it("starts and resumes a CodeBuddy Session on both turn surfaces without creating a WorkBuddy Task", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("current Session is missing");
    fixture.config.agents.codex = pluginBinding({ profile: "workbuddy-ai" });
    let nativeStarts = 0;
    const runtimeSource: WorkBuddyRuntimeSource = {
      listTasks: async () => [],
      attachTask: async () => ({ activities: [], completeness: "complete", limitations: [] }),
      startTask: async () => {
        nativeStarts += 1;
        return {
          verification: {
            taskId: "unmapped",
            replayFingerprint: "verified-history",
            replayStarted: true,
            replayCompleted: true,
            activities: [],
            connectionOwner: null,
          },
          prompt: async function* () {},
          close: async () => undefined,
        };
      },
    };
    const directStarts: Array<string | null> = [];
    const adapter = createWorkBuddyRuntimeAdapter({
      createSource: () => runtimeSource,
      createCodeBuddySession: async (input) => {
        directStarts.push(input.sessionId);
        if (!input.sessionId) await input.onSessionId("codebuddy-native-1");
        return {
          prompt: async function* () {
            yield activity("answer from CodeBuddy Session");
          },
          close: async () => undefined,
        };
      },
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const transcriptProjection = new TranscriptProjection({
      stateStore: fixture.store,
      config: fixture.config,
      runtimeAdapters,
    });
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters,
      transcriptProjection,
    });

    const accepted = await runtime.enqueueClientTurn(current.sessionRef, "client without mapping");
    while (runtime.activeClientTurnId(current.sessionRef) === accepted.turnId) await Bun.sleep(0);
    const clientBlocks = await fixture.store.listTranscriptBlocks(current.sessionRef);
    expect(clientBlocks.some((block) => block.plainText.includes("answer from CodeBuddy Session"))).toBeTrue();
    await runtime.dispose();

    const resumedRuntime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters,
      transcriptProjection,
    });
    await resumedRuntime.handleInboundMessage({
      ...message("clawchat without mapping"),
      messageId: "unmapped-clawchat",
    });
    expect(JSON.stringify(fixture.sendMessageEnvelope.mock.calls)).toContain("answer from CodeBuddy Session");
    expect(directStarts).toEqual([null, "codebuddy-native-1"]);
    expect(nativeStarts).toBe(0);
    expect(await fixture.store.getRuntimeSessionByRef(current.sessionRef)).toMatchObject({
      runtimeSessionId: "codebuddy-session:codebuddy-native-1",
    });

    await resumedRuntime.dispose();
    await runtimeAdapters.close();
    await fixture.store.close();
  });

  it("synchronizes Runtime-reported identities into the Binding Workspace Catalog", async () => {
    const fixture = await runtimeFixture();
    const registeredRoot = join(dirname(fixture.config.stateDbPath), "clawchat-plugin-connect");
    const discoveredRoot = join(dirname(fixture.config.stateDbPath), "clawpet");
    await Promise.all([mkdir(registeredRoot), mkdir(discoveredRoot)]);
    const workspaces = new WorkspaceCatalog(fixture.store);
    const registered = await workspaces.add("codex", registeredRoot);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      discoverAllThreads: async () =>
        completeRuntimeThreadDiscovery([
          {
            runtimeThreadId: "thread-connect",
            name: "Connect task",
            updatedAt: 2,
            workingDirectory: registeredRoot,
          },
          {
            runtimeThreadId: "thread-clawpet",
            name: "Clawpet task",
            updatedAt: 1,
            workingDirectory: discoveredRoot,
          },
        ]),
      discoverArchivedThreads: async () =>
        completeRuntimeThreadDiscovery(
          [
            {
              runtimeThreadId: "thread-archived-worktree",
              name: "Archived worktree task",
              updatedAt: 1,
              workingDirectory: join(
                dirname(fixture.config.stateDbPath),
                ".codex",
                "worktrees",
                "0ed0",
                "clawchat-plugin-connect",
              ),
              isArchived: true,
            },
          ],
          { reason: "archived" },
        ),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      discoverWorkspaces: async () => ({
        status: "complete",
        identities: [
          { key: "connect", kind: "persistent", localRoot: registeredRoot },
          { key: "clawpet", kind: "persistent", localRoot: discoveredRoot },
        ],
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      workspaces,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await expect(runtime.listRuntimeWorkspaces()).resolves.toEqual([
      {
        name: "clawchat-plugin-connect",
        workspaceRef: registered.workspaceRef,
        rootPath: await realpath(registeredRoot),
      },
      {
        name: "clawpet",
        workspaceRef: expect.any(String),
        rootPath: await realpath(discoveredRoot),
      },
      expect.objectContaining({
        name: "Default",
        workspaceRef: expect.any(String),
      }),
    ]);

    await runtime.dispose();
    await fixture.store.close();
  });

  it("uploads Web media and includes it in the client Runtime turn", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("current Session is missing");
    const received: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: async () => ({
        prompt: async function* (input) {
          received.push(input);
          yield activity("done");
        },
        close: async () => undefined,
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const media = await runtime.uploadClientMedia(new Blob(["image"], { type: "image/jpeg" }), "photo.jpg");
    await runtime.enqueueClientTurn(current.sessionRef, "inspect", [media]);
    while (received.length === 0) await Bun.sleep(0);

    expect(fixture.uploadMedia).toHaveBeenCalledWith(expect.any(Blob), { filename: "photo.jpg" });
    expect(received[0]?.media).toEqual([media]);
    expect(received[0]?.trustedMediaOrigins).toContain(new URL(fixture.config.mediaUploadUrl).origin);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("projects queued ClawChat messages before waiting for Runtime startup", async () => {
    const fixture = await runtimeFixture();
    let releaseRuntimeStart: (() => void) | undefined;
    const runtimeStartGate = new Promise<void>((resolve) => {
      releaseRuntimeStart = resolve;
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => {
        await runtimeStartGate;
        return {
          prompt: async function* () {
            yield activity("done");
          },
          close: mock(async () => undefined),
        };
      }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const transcriptProjection = new TranscriptProjection({
      stateStore: fixture.store,
      config: fixture.config,
      runtimeAdapters,
    });
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters,
      transcriptProjection,
      resolveSenderDisplayName: async (senderId) => (senderId === "user-1" ? "ColinShen" : null),
    });
    const firstInbound = {
      ...message("commit"),
      sender: { id: "user-1", type: "direct" as const, nick_name: "user-1" },
    };
    const secondInbound = {
      ...message("push"),
      messageId: "message-2",
      traceId: "trace-2",
    };
    const firstTurn = runtime.handleInboundMessage(firstInbound);
    const secondTurn = runtime.handleInboundMessage(secondInbound);

    try {
      const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
      if (!current) throw new Error("expected current Session");
      for (
        let attempt = 0;
        attempt < 25 && (await fixture.store.countTranscriptBlocks(current.sessionRef)) < 2;
        attempt += 1
      )
        await Bun.sleep(2);
      await expect(fixture.store.listTranscriptBlocks(current.sessionRef)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: firstInbound.messageId,
            type: "message",
            role: "user",
            origin: "clawchat",
            plainText: "commit",
            author: "ColinShen",
            sender: { id: "user-1", displayName: "ColinShen" },
            conversationType: "direct",
          }),
          expect.objectContaining({
            id: secondInbound.messageId,
            type: "message",
            role: "user",
            origin: "clawchat",
            plainText: "push",
            sender: { id: "user-1", displayName: "User" },
            conversationType: "direct",
          }),
        ]),
      );
    } finally {
      releaseRuntimeStart?.();
      await Promise.all([firstTurn, secondTurn]);
      await runtime.dispose();
      await fixture.store.close();
    }
  });

  it("starts the first message in the Binding Default Workspace", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.deleteRuntimeSession("chat-1", "codex", "session-1");
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message());

    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    expect(current?.workspaceRef).toEqual(expect.any(String));
    const promptInput = prompts[0];
    if (!promptInput) throw new Error("expected runtime prompt");
    expect(promptInput.workspace).toMatchObject({ workspaceRef: current?.workspaceRef, skipGitRepoCheck: true });
    expect((await stat(promptInput.workspace.workingDirectory)).isDirectory()).toBe(true);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("routes concurrent first messages through one materialized Session in arrival order", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.deleteRuntimeSession("chat-1", "codex", "session-1");
    await fixture.store.setSessionIntent({
      chatId: "chat-1",
      agentId: "codex",
      workspaceRef: null,
      model: { model: "gpt-session" },
      reasoningEffort: "high",
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => [
        {
          id: "gpt-session",
          selection: { model: "gpt-session" },
          displayName: "Session model",
          description: "Session selection",
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["high"],
          inputModalities: ["text"],
        },
      ],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          if (prompts.length === 1) {
            markFirstStarted?.();
            await firstGate;
          }
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });
    const firstMessage = message("first");
    firstMessage.messageId = "message-1";
    const secondMessage = message("second");
    secondMessage.messageId = "message-2";

    const first = runtime.handleInboundMessage(firstMessage);
    await firstStarted;
    const second = runtime.handleInboundMessage(secondMessage);
    await Bun.sleep(5);
    expect(prompts).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([first, second]);

    const sessions = await fixture.store.listRuntimeSessions("chat-1", "codex");
    expect(sessions).toHaveLength(1);
    expect(await fixture.store.getSessionIntent("chat-1", "codex")).toBeNull();
    expect(prompts.map((input) => input.metadata?.sessionId)).toEqual([sessions[0]?.sessionId, sessions[0]?.sessionId]);
    expect(prompts.map((input) => [input.model, input.reasoningEffort])).toEqual([
      [{ model: "gpt-session" }, "high"],
      [{ model: "gpt-session" }, "high"],
    ]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("preserves inbound ClawChat media for the Runtime Adapter", async () => {
    const fixture = await runtimeFixture();
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });
    const inbound = message("describe the attachments");
    inbound.fragments = [
      { kind: "text", text: "describe the attachments" },
      {
        kind: "image",
        url: "https://media.example/photo.png?signature=opaque",
        name: "photo.png",
        mime: "image/png",
        size: 123,
      },
      {
        kind: "file",
        url: "https://media.example/report.pdf?signature=opaque",
        name: "report.pdf",
        mime: "application/pdf",
        size: 456,
      },
    ];

    await runtime.handleInboundMessage(inbound);

    expect(prompts[0]).toMatchObject({
      media: [
        {
          kind: "image",
          url: "https://media.example/photo.png?signature=opaque",
          name: "photo.png",
          mime: "image/png",
          size: 123,
        },
        {
          kind: "file",
          url: "https://media.example/report.pdf?signature=opaque",
          name: "report.pdf",
          mime: "application/pdf",
          size: 456,
        },
      ],
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("resolves Session model selection before the Agent Binding default", async () => {
    const fixture = await runtimeFixture();
    fixture.config.agents.codex = pluginBinding({}, { model: { model: "gpt-binding" }, modelReasoningEffort: "low" });
    await fixture.store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      model: { model: "gpt-session" },
      reasoningEffort: "high",
    });
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => [
        {
          id: "gpt-session",
          selection: { model: "gpt-session" },
          displayName: "Session model",
          description: "Session choice",
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high"],
          inputModalities: ["text", "image"],
        },
        {
          id: "gpt-binding",
          selection: { model: "gpt-binding" },
          displayName: "Binding model",
          description: "Binding default",
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "medium"],
          inputModalities: ["text"],
        },
      ],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message("use the session choice"));

    expect(prompts[0]).toMatchObject({ model: { model: "gpt-session" }, reasoningEffort: "high" });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("applies an ordered /model change to the next turn without replacing its Runtime Thread", async () => {
    const fixture = await runtimeFixture();
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prompts: ConnectRuntimePrompt[] = [];
    const models = [
      {
        id: "gpt-default",
        selection: { model: "gpt-default" },
        displayName: "Default model",
        description: "Runtime default",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
        inputModalities: ["text" as const],
      },
      {
        id: "gpt-deep",
        selection: { model: "gpt-deep" },
        displayName: "Deep model",
        description: "Deep work",
        isDefault: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high", "xhigh"],
        inputModalities: ["text" as const],
      },
    ];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => models,
      start: mock(async (_binding, startContext) => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          if (prompts.length === 1) {
            await startContext.onRuntimeSessionId("thread-stable");
            markFirstStarted?.();
            await firstGate;
          }
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const workspaces = new WorkspaceCatalog(fixture.store);
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      workspaces,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const first = runtime.handleInboundMessage(message("first turn"));
    await firstStarted;
    const controlMessage = message("/model gpt-deep xhigh");
    controlMessage.messageId = "model-control";
    const control = runtime.handleInboundMessage(
      controlMessage,
      async () =>
        (
          await handleChatCommand({
            message: controlMessage,
            agentId: "codex",
            ownerUserId: "user-1",
            config: fixture.config,
            stateStore: fixture.store,
            workspaces,
            listRuntimeModels: async () => models,
            runtimeFamilyFor: () => "codex",
          })
        ).handled,
      true,
    );
    const followingMessage = message("next turn");
    followingMessage.messageId = "message-after-model";
    const following = runtime.handleInboundMessage(followingMessage);
    await Bun.sleep(5);
    expect(prompts).toHaveLength(1);

    releaseFirst?.();
    await Promise.all([first, control, following]);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({ model: { model: "gpt-default" }, reasoningEffort: "medium" });
    expect(prompts[1]).toMatchObject({ model: { model: "gpt-deep" }, reasoningEffort: "xhigh" });
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-stable",
      model: { model: "gpt-deep" },
      reasoningEffort: "xhigh",
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("reports an unavailable persisted Session model without silently falling back", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-1",
      agentId: "codex",
      model: { model: "gpt-removed" },
      reasoningEffort: "high",
    });
    const start = mock(async () => ({
      prompt: async function* () {
        yield activity("must not run");
      },
      close: mock(async () => undefined),
    }));
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      listModels: async () => [
        {
          id: "gpt-current",
          selection: { model: "gpt-current" },
          displayName: "Current model",
          description: "Still available",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium", "high"],
          inputModalities: ["text"],
        },
      ],
      start,
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message("do not fall back"));

    expect(start).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.sendMessageEnvelope.mock.calls)).toContain("Model is not available: gpt-removed");
    await runtime.dispose();
    await fixture.store.close();
  });

  it("uploads a safe local Markdown image before replying with a media Fragment", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test Session was not created");
    const imagePath = join(dirname(fixture.config.stateDbPath), "media-cache", "cached-image", "00-TheFool.jpg");
    await mkdir(dirname(imagePath), { recursive: true });
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    await writeFile(imagePath, imageBytes);
    const output = activity(`![00-TheFool.jpg](${imagePath})`);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          yield output;
        },
        close: mock(async () => undefined),
      })),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const transcriptProjection = new TranscriptProjection({
      stateStore: fixture.store,
      config: fixture.config,
      runtimeAdapters,
    });
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters,
      transcriptProjection,
    });

    await runtime.handleInboundMessage(message("send the image back"));

    expect(fixture.uploadMedia).toHaveBeenCalledTimes(1);
    const [uploadedFile, uploadOptions] = fixture.uploadMedia.mock.calls[0] ?? [];
    expect(uploadOptions).toEqual({ filename: "00-TheFool.jpg" });
    expect(Buffer.from(await uploadedFile?.arrayBuffer())).toEqual(imageBytes);
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: {
          body: {
            fragments: [
              {
                kind: "image",
                url: "https://cdn.example/uploaded-image",
                name: "00-TheFool.jpg",
                mime: "image/jpeg",
                size: 11,
              },
            ],
          },
          context: expect.any(Object),
        },
      }),
      { toType: "direct" },
    );
    await expect(fixture.store.listTranscriptBlocks(current.sessionRef)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        markdown: "",
        media: [
          expect.objectContaining({
            kind: "image",
            url: "https://cdn.example/uploaded-image",
            name: "00-TheFool.jpg",
            mime: "image/jpeg",
          }),
        ],
      }),
    );

    await transcriptProjection.upsertRuntimeActivity(current.sessionRef, { ...output, source: "history" });
    await expect(fixture.store.listTranscriptBlocks(current.sessionRef)).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        markdown: "",
        media: [expect.objectContaining({ url: "https://cdn.example/uploaded-image" })],
      }),
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("does not turn a non-image workspace file into an outbound media Fragment", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    const workspace = await new WorkspaceCatalog(fixture.store).resolveWorkspace(current);
    const secretPath = join(workspace.workingDirectory, ".env");
    await writeFile(secretPath, "SECRET_TOKEN=do-not-upload\n");
    const markdown = `![result](${secretPath})`;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* () {
          yield activity(markdown);
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message("send the result"));

    expect(fixture.uploadMedia).not.toHaveBeenCalled();
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: expect.objectContaining({ body: { fragments: [{ kind: "text", text: markdown }] } }),
      }),
      { toType: "direct" },
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("sends a local Markdown document link to ClawChat as unchanged text", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    const workspace = await new WorkspaceCatalog(fixture.store).resolveWorkspace(current);
    const specPath = join(workspace.workingDirectory, ".scratch", "example-spec", "spec.md");
    await mkdir(dirname(specPath), { recursive: true });
    await writeFile(specPath, "# Example spec\n");
    const markdown = `[Example spec](${specPath})`;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* () {
          yield activity(markdown);
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message("write the spec"));

    expect(fixture.uploadMedia).not.toHaveBeenCalled();
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: expect.objectContaining({ body: { fragments: [{ kind: "text", text: markdown }] } }),
      }),
      { toType: "direct" },
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("does not upload a local Markdown image outside the media cache or Runtime Workspace", async () => {
    const fixture = await runtimeFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "clawchat-outside-media-"));
    const outsideImage = join(outsideDirectory, "private.png");
    await writeFile(outsideImage, "private-bytes");
    const markdown = `![private.png](${outsideImage})`;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          yield activity(markdown);
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message("send a private file"));

    expect(fixture.uploadMedia).not.toHaveBeenCalled();
    expect(fixture.sendMessageEnvelope).toHaveBeenCalledWith(
      "message.reply",
      "chat-1",
      expect.objectContaining({
        message: expect.objectContaining({
          body: { fragments: [{ kind: "text", text: markdown }] },
        }),
      }),
      { toType: "direct" },
    );
    await runtime.dispose();
    await fixture.store.close();
  });

  it("discovers within a pending Project and materializes its Session on the first message", async () => {
    const fixture = await runtimeFixture();
    const workspaces = new WorkspaceCatalog(fixture.store);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "clawchat-connect-selected-project-"));
    const canonicalProjectRoot = await realpath(workspaceRoot);
    const project = await workspaces.add("codex", workspaceRoot);
    await fixture.store.setSessionIntent({
      chatId: "chat-1",
      agentId: "codex",
      workspaceRef: project.workspaceRef,
      name: "Planned work",
      mode: "read-only",
      model: { model: "gpt-planned" },
      reasoningEffort: "medium",
    });
    const discoveredWorkspaces: string[] = [];
    const prompts: ConnectRuntimePrompt[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      listModels: async () => [
        {
          id: "gpt-planned",
          selection: { model: "gpt-planned" },
          displayName: "Planned model",
          description: "For planned work",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          inputModalities: ["text"],
        },
      ],
      discoverThreads: mock(async (_agent, workspace) => {
        discoveredWorkspaces.push(workspace.workingDirectory);
        return completeRuntimeThreadDiscovery([
          { runtimeThreadId: "thread-existing", name: "Existing thread", updatedAt: 1 },
        ]);
      }),
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          prompts.push(input);
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      workspaces,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toBeNull();
    await expect(runtime.discoverRuntimeThreads("chat-1")).resolves.toEqual([
      expect.objectContaining({ runtimeThreadId: "thread-existing", name: "Existing thread" }),
    ]);
    expect(discoveredWorkspaces).toEqual([canonicalProjectRoot]);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toBeNull();

    await runtime.handleInboundMessage(message("start planned work"));

    await expect(fixture.store.getSessionIntent("chat-1", "codex")).resolves.toBeNull();
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      workspaceRef: project.workspaceRef,
      name: "Planned work",
      mode: "read-only",
      model: { model: "gpt-planned" },
      reasoningEffort: "medium",
      hasMessages: true,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      workspace: { workspaceRef: project.workspaceRef, workingDirectory: canonicalProjectRoot },
      mode: "read-only",
      model: { model: "gpt-planned" },
      reasoningEffort: "medium",
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("serializes lifecycle commands behind an active turn for the same chat", async () => {
    const fixture = await runtimeFixture();
    let releaseTurn: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const order: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async () => ({
        prompt: async function* () {
          order.push("turn-started");
          markStarted?.();
          await release;
          order.push("turn-finished");
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const turn = runtime.handleInboundMessage(message());
    await started;
    await expect(fixture.store.getRuntimeStatus("codex")).resolves.toMatchObject({
      globalRunning: 1,
      globalQueued: 0,
    });
    const command = runtime.handleInboundMessage(
      message("/project none"),
      async () => {
        order.push("command");
        return true;
      },
      true,
    );
    await Bun.sleep(5);
    expect(order).toEqual(["turn-started"]);
    releaseTurn?.();
    await Promise.all([turn, command]);
    expect(order).toEqual(["turn-started", "turn-finished", "command"]);
    await expect(fixture.store.getRuntimeStatus("codex")).resolves.toMatchObject({
      globalRunning: 0,
      globalQueued: 0,
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("routes the message after /new to the newly selected Session", async () => {
    const fixture = await runtimeFixture();
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const promptedSessionIds: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          promptedSessionIds.push(input.metadata?.sessionId ?? "missing");
          if (promptedSessionIds.length === 1) {
            markFirstStarted?.();
            await gate;
          }
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const workspaces = new WorkspaceCatalog(fixture.store);
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      workspaces,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const first = runtime.handleInboundMessage(message("first turn"));
    await firstStarted;
    const controlMessage = message("/new Planned");
    const control = runtime.handleInboundMessage(
      controlMessage,
      async () =>
        (
          await handleChatCommand({
            message: controlMessage,
            agentId: "codex",
            ownerUserId: "user-1",
            config: fixture.config,
            stateStore: fixture.store,
            workspaces,
            closeRuntimeSession: async (chatId) => await runtime.closeSession(chatId),
            runtimeFamilyFor: () => "codex",
          })
        ).handled,
      true,
    );
    const followingMessage = message("after new");
    followingMessage.messageId = "message-after-new";
    const following = runtime.handleInboundMessage(followingMessage);
    await Bun.sleep(5);
    expect(promptedSessionIds).toEqual(["session-1"]);
    releaseFirst?.();
    await Promise.all([first, control, following]);

    const sessions = await fixture.store.listRuntimeSessions("chat-1", "codex");
    const planned = sessions.find((session) => session.name === "Planned");
    if (!planned) throw new Error("expected the planned Session to materialize");
    expect(promptedSessionIds).toEqual(["session-1", planned.sessionId]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("routes following messages after ordered /workspace and /switch controls", async () => {
    for (const scenario of ["workspace", "switch"] as const) {
      const fixture = await runtimeFixture();
      const workspaces = new WorkspaceCatalog(fixture.store);
      const workspaceRoot = join(dirname(fixture.configPath), `repo-${scenario}`);
      await mkdir(workspaceRoot);
      const project = await workspaces.add("codex", workspaceRoot);
      if (scenario === "switch") {
        await fixture.store.upsertRuntimeSession({
          chatId: "chat-1",
          sessionId: "session-target",
          agentId: "codex",
          workspaceRef: project.workspaceRef,
          name: "Target Session",
          isCurrent: false,
        });
      }
      let releaseFirst: (() => void) | undefined;
      let markFirstStarted: (() => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const prompted: Array<{ sessionId: string; workspaceRef: string }> = [];
      const adapter: ConnectRuntimeAdapter = {
        kind: "codex",
        modes: ["workspace-write"],
        start: mock(async () => ({
          prompt: async function* (input: ConnectRuntimePrompt) {
            prompted.push({
              sessionId: input.metadata?.sessionId ?? "missing",
              workspaceRef: input.metadata?.workspaceRef ?? "missing",
            });
            if (prompted.length === 1) {
              markFirstStarted?.();
              await firstGate;
            }
            yield activity("done");
          },
          close: mock(async () => undefined),
        })),
      };
      const runtime = new ConnectRuntime({
        agentId: "codex",
        config: fixture.config,
        configPath: fixture.configPath,
        stateStore: fixture.store,
        wsClient: fixture.wsClient,
        workspaces,
        runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
      });

      const first = runtime.handleInboundMessage(message("first turn"));
      await firstStarted;
      const controlMessage = message(
        scenario === "workspace" ? `/workspace ${project.workspaceRef}` : "/switch Target Session",
      );
      controlMessage.messageId = `${scenario}-control`;
      const control = runtime.handleInboundMessage(
        controlMessage,
        async () =>
          (
            await handleChatCommand({
              message: controlMessage,
              agentId: "codex",
              ownerUserId: "user-1",
              config: fixture.config,
              stateStore: fixture.store,
              workspaces,
              closeRuntimeSession: async (chatId) => await runtime.closeSession(chatId),
              discoverRuntimeThreads: async (chatId) => await runtime.discoverRuntimeThreads(chatId),
              runtimeFamilyFor: () => "codex",
            })
          ).handled,
        true,
      );
      const followingMessage = message(`after ${scenario}`);
      followingMessage.messageId = `${scenario}-following`;
      const following = runtime.handleInboundMessage(followingMessage);
      await Bun.sleep(5);
      expect(prompted).toEqual([{ sessionId: "session-1", workspaceRef: expect.any(String) }]);
      expect(prompted[0]?.workspaceRef).not.toBe(project.workspaceRef);

      releaseFirst?.();
      await Promise.all([first, control, following]);

      expect(prompted).toHaveLength(2);
      expect(prompted[1]?.workspaceRef).toBe(project.workspaceRef);
      if (scenario === "switch") expect(prompted[1]?.sessionId).toBe("session-target");
      else expect(prompted[1]?.sessionId).not.toBe("session-1");
      await runtime.dispose();
      await fixture.store.close();
    }
  });

  it("serializes ClawChat and Client turns on the same logical Session", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    let releaseClawChat: (() => void) | undefined;
    let markClawChatStarted: (() => void) | undefined;
    let markClientFinished: (() => void) | undefined;
    const clawChatStarted = new Promise<void>((resolve) => {
      markClawChatStarted = resolve;
    });
    const clientFinished = new Promise<void>((resolve) => {
      markClientFinished = resolve;
    });
    const clawChatGate = new Promise<void>((resolve) => {
      releaseClawChat = resolve;
    });
    const order: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* (input: ConnectRuntimePrompt) {
          if (input.metadata?.origin === "client") {
            order.push("client-started", "client-finished");
            markClientFinished?.();
          } else {
            order.push("clawchat-started");
            markClawChatStarted?.();
            await clawChatGate;
            order.push("clawchat-finished");
          }
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const clawChatTurn = runtime.handleInboundMessage(message("from clawchat"));
    await clawChatStarted;
    await runtime.enqueueClientTurn(current.sessionRef, "from web");
    await Bun.sleep(5);
    expect(order).toEqual(["clawchat-started"]);
    releaseClawChat?.();
    await Promise.all([clawChatTurn, clientFinished]);
    expect(order).toEqual(["clawchat-started", "clawchat-finished", "client-started", "client-finished"]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("accepts a queued Client turn immediately and exposes it for withdrawal", async () => {
    const fixture = await runtimeFixture();
    fixture.config.maxConcurrentTurns = 1;
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    expect(current).not.toBeNull();
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const prompts: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: async () => ({
        prompt: async function* (input) {
          prompts.push(input.prompt);
          if (input.prompt === "first") {
            markFirstStarted();
            await firstGate;
          }
          yield activity("done");
        },
        close: async () => undefined,
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const first = await runtime.enqueueClientTurn(current?.sessionRef ?? "", "first");
    await firstStarted;
    const queued = await runtime.enqueueClientTurn(current?.sessionRef ?? "", "second");

    expect(queued.turnId).not.toBe(first.turnId);
    expect(runtime.queuedClientTurns(current?.sessionRef ?? "")).toMatchObject([
      { turnId: queued.turnId, prompt: "second", attachments: [] },
    ]);
    expect(runtime.cancelQueuedClientTurn(current?.sessionRef ?? "", queued.turnId)).toBe(true);
    expect(runtime.queuedClientTurns(current?.sessionRef ?? "")).toEqual([]);

    releaseFirst();
    await Bun.sleep(0);
    expect(prompts).toEqual(["first"]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("cancels the selected Session immediately while its turn is active", async () => {
    const fixture = await runtimeFixture();
    let releaseTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const cancel = mock(async () => true);
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* () {
          markStarted?.();
          await gate;
          yield activity("done");
        },
        cancel,
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const turn = runtime.handleInboundMessage(message("long turn"));
    await started;
    await expect(runtime.cancelTurn("chat-1")).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    releaseTurn?.();
    await turn;
    await runtime.dispose();
    await fixture.store.close();
  });

  it("settles an active Client turn and releases its handle before Session lifecycle commits", async () => {
    const fixture = await runtimeFixture();
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    let finishTurn: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const turnGate = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    let finishCancel: (() => void) | undefined;
    let markCancelStarted: (() => void) | undefined;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    let finishLifecycle: (() => void) | undefined;
    let markLifecycleClaimed: (() => void) | undefined;
    const lifecycleClaimed = new Promise<void>((resolve) => {
      markLifecycleClaimed = resolve;
    });
    const lifecycleGate = new Promise<void>((resolve) => {
      finishLifecycle = resolve;
    });
    const order: string[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: async () => ({
        prompt: async function* () {
          order.push("turn-started");
          markStarted?.();
          await turnGate;
          order.push("turn-settled");
          yield activity("cancelled");
        },
        cancel: async () => {
          order.push("turn-cancelled");
          markCancelStarted?.();
          await cancelGate;
          finishTurn?.();
          return true;
        },
        close: async () => {
          order.push("handle-closed");
        },
      }),
    };
    const runtimeAdapters = new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]);
    const transcriptProjection = new TranscriptProjection({
      stateStore: fixture.store,
      config: fixture.config,
      runtimeAdapters,
    });
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters,
      transcriptProjection,
    });

    await runtime.enqueueClientTurn(current.sessionRef, "long client turn");
    await started;
    const lifecycle = (async () => {
      const release = await runtime.claimSessionLifecycle(current.sessionRef);
      try {
        order.push("lifecycle-commit");
        markLifecycleClaimed?.();
        await lifecycleGate;
        await fixture.store.deleteSessionByRef(current.sessionRef);
      } finally {
        await release();
      }
    })();
    await cancelStarted;
    await expect(runtime.enqueueClientTurn(current.sessionRef, "during cancel")).rejects.toMatchObject({
      code: "session-state-conflict",
    });
    finishCancel?.();
    await lifecycleClaimed;
    await expect(runtime.enqueueClientTurn(current.sessionRef, "too late")).rejects.toMatchObject({
      code: "session-state-conflict",
    });
    finishLifecycle?.();
    await lifecycle;

    expect(order).toEqual(["turn-started", "turn-cancelled", "turn-settled", "handle-closed", "lifecycle-commit"]);
    await expect(fixture.store.getRuntimeSessionByRef(current.sessionRef)).resolves.toBeNull();
    await runtime.dispose();
    await fixture.store.close();
  });

  it("coordinates lifecycle for a discovered Runtime Thread without requiring an adopted Session", async () => {
    const fixture = await runtimeFixture();
    const sessionRef = await fixture.store.getOrCreateSessionRef({
      chatId: "__connect_client_catalog__",
      agentId: "codex",
      runtimeSessionId: "thread-discovered",
    });
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({
          kind: "codex",
          modes: [],
          start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
        }),
      ]),
    });
    const firstRelease = await runtime.claimSessionLifecycle(sessionRef);
    await expect(runtime.claimSessionLifecycle(sessionRef)).rejects.toMatchObject({
      code: "session-state-conflict",
      message: expect.stringContaining("lifecycle operation is in progress"),
    });
    await firstRelease();
    const secondRelease = await runtime.claimSessionLifecycle(sessionRef);
    await secondRelease();
    await runtime.dispose();
    await fixture.store.close();
  });

  it("leaves an ordinary ClawChat Session unlocked when queue capacity rejects admission", async () => {
    const fixture = await runtimeFixture();
    fixture.config.maxPendingPerSession = 0;
    const current = await resetToUnlockedRuntimeSession(fixture.store);
    const start = mock(async () => ({
      prompt: async function* () {
        yield activity("must not run");
      },
      close: mock(async () => undefined),
    }));
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({ kind: "codex", modes: ["workspace-write"], start }),
      ]),
    });

    await runtime.handleInboundMessage(message("capacity rejected"));

    expect(start).not.toHaveBeenCalled();
    await expect(fixture.store.sessionBindingLock(current.sessionRef)).resolves.toBeNull();
    await expect(fixture.store.getRuntimeSessionByRef(current.sessionRef)).resolves.toMatchObject({
      agentId: "codex",
      hasMessages: false,
    });
    expect(JSON.stringify(fixture.sendMessageEnvelope.mock.calls)).toContain("too many pending turns");
    await runtime.dispose();
    await fixture.store.close();
  });

  it("locks an ordinary ClawChat Session only after queue admission", async () => {
    const fixture = await runtimeFixture();
    const current = await resetToUnlockedRuntimeSession(fixture.store);
    const start = mock(async () => ({
      prompt: async function* () {
        yield activity("accepted");
      },
      close: mock(async () => undefined),
    }));
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({ kind: "codex", modes: ["workspace-write"], start }),
      ]),
    });

    await runtime.handleInboundMessage(message("accepted"));

    expect(start).toHaveBeenCalledTimes(1);
    await expect(fixture.store.sessionBindingLock(current.sessionRef)).resolves.toBe("accepted-turn");
    await expect(fixture.store.getRuntimeSessionByRef(current.sessionRef)).resolves.toMatchObject({
      agentId: "codex",
      hasMessages: true,
    });
    await runtime.dispose();
    await fixture.store.close();
  });

  it("rejects a Client Turn when its Session switches Binding before queue acceptance", async () => {
    const fixture = await runtimeFixture();
    const current = await resetToUnlockedRuntimeSession(fixture.store);
    const start = mock(async () => ({
      prompt: async function* () {
        yield activity("must not run");
      },
      close: mock(async () => undefined),
    }));
    const acceptSessionTurn = fixture.store.acceptSessionTurn.bind(fixture.store);
    fixture.store.acceptSessionTurn = async (input) => {
      const moved = await fixture.store.changeSessionBinding(current.sessionRef, "opencode");
      expect(moved).toEqual({ changed: true });
      return await acceptSessionTurn(input);
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({ kind: "codex", modes: ["workspace-write"], start }),
      ]),
    });

    await expect(runtime.enqueueClientTurn(current.sessionRef, "race")).rejects.toMatchObject({
      code: "session-state-conflict",
      message: expect.stringContaining("Agent Binding changed"),
    });
    expect(start).not.toHaveBeenCalled();
    await expect(fixture.store.getRuntimeSessionByRef(current.sessionRef)).resolves.toMatchObject({
      agentId: "opencode",
      hasMessages: false,
    });
    await expect(fixture.store.sessionBindingLock(current.sessionRef)).resolves.toBeNull();
    await runtime.dispose();
    await fixture.store.close();
  });

  it("rejects a ClawChat Turn when its Session switches Binding before queue acceptance", async () => {
    const fixture = await runtimeFixture();
    const current = await resetToUnlockedRuntimeSession(fixture.store);
    const start = mock(async () => ({
      prompt: async function* () {
        yield activity("must not run");
      },
      close: mock(async () => undefined),
    }));
    const acceptSessionTurn = fixture.store.acceptSessionTurn.bind(fixture.store);
    fixture.store.acceptSessionTurn = async (input) => {
      const moved = await fixture.store.changeSessionBinding(current.sessionRef, "opencode");
      expect(moved).toEqual({ changed: true });
      return await acceptSessionTurn(input);
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([
        fixedRuntimeAdapter({ kind: "codex", modes: ["workspace-write"], start }),
      ]),
    });

    await runtime.handleInboundMessage(message("race"));

    expect(start).not.toHaveBeenCalled();
    await expect(fixture.store.getRuntimeSessionByRef(current.sessionRef)).resolves.toMatchObject({
      agentId: "opencode",
      hasMessages: false,
    });
    await expect(fixture.store.sessionBindingLock(current.sessionRef)).resolves.toBeNull();
    expect(JSON.stringify(fixture.sendMessageEnvelope.mock.calls)).toContain("Agent Binding changed");
    await runtime.dispose();
    await fixture.store.close();
  });

  it("reports a Session Ref when that Session exceeds its pending-turn limit", async () => {
    const fixture = await runtimeFixture();
    fixture.config.maxConcurrentTurns = 1;
    fixture.config.maxPendingPerSession = 1;
    const current = await fixture.store.getCurrentRuntimeSession("chat-1", "codex");
    if (!current) throw new Error("test session was not created");
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let promptCount = 0;
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* () {
          promptCount += 1;
          if (promptCount === 1) {
            markStarted?.();
            await gate;
          }
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });
    const firstMessage = message("first");
    const secondMessage = message("second");
    secondMessage.messageId = "message-2";
    const thirdMessage = message("third");
    thirdMessage.messageId = "message-3";

    const first = runtime.handleInboundMessage(firstMessage);
    await started;
    const second = runtime.handleInboundMessage(secondMessage);
    await Bun.sleep(5);
    await runtime.handleInboundMessage(thirdMessage);
    const replies = JSON.stringify(fixture.sendMessageEnvelope.mock.calls);
    expect(replies).toContain(`too many pending turns for Session ${current.sessionRef}`);
    expect(replies).not.toContain("pending turns for chat");
    releaseFirst?.();
    await Promise.all([first, second]);
    await runtime.dispose();
    await fixture.store.close();
  });

  it("runs two Sessions in one ClawChat conversation concurrently", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.upsertRuntimeSession({
      chatId: "chat-1",
      sessionId: "session-2",
      agentId: "codex",
      workspaceRef: null,
      isCurrent: false,
    });
    const sessions = await fixture.store.listRuntimeSessions("chat-1", "codex");
    const refs = sessions.map((entry) => entry.sessionRef);
    expect(refs).toHaveLength(2);
    let releaseTurns: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTurns = resolve;
    });
    let started = 0;
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let finished = 0;
    let markBothFinished: (() => void) | undefined;
    const bothFinished = new Promise<void>((resolve) => {
      markBothFinished = resolve;
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["workspace-write"],
      start: mock(async () => ({
        prompt: async function* () {
          started += 1;
          if (started === 2) markBothStarted?.();
          await gate;
          finished += 1;
          if (finished === 2) markBothFinished?.();
          yield activity("done");
        },
        close: mock(async () => undefined),
      })),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await Promise.all(refs.map(async (sessionRef) => await runtime.enqueueClientTurn(sessionRef, sessionRef)));
    const concurrency = await Promise.race([bothStarted.then(() => true), Bun.sleep(50).then(() => false)]);
    expect(concurrency).toBe(true);
    releaseTurns?.();
    await bothFinished;
    await runtime.dispose();
    await fixture.store.close();
  });

  it("persists a Codex thread id and resumes it after runtime restart", async () => {
    const fixture = await runtimeFixture();
    const starts: ConnectRuntimeStartContext[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async (_agent, context) => {
        starts.push(context);
        return session(async function* (startContext) {
          await startContext.onRuntimeSessionId("thread-1");
          yield activity("done");
        }, context);
      }),
    };

    const first = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });
    await first.handleInboundMessage(message());
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await first.dispose();

    const second = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });
    await second.handleInboundMessage(message("again"));

    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ runtimeSessionId: null, configPath: fixture.configPath });
    expect(starts[1]).toMatchObject({ runtimeSessionId: "thread-1", configPath: fixture.configPath });
    await second.dispose();
    await fixture.store.close();
  });

  it("backfills names for managed Runtime Threads and returns only unclaimed discoveries", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.setRuntimeSessionId("chat-1", "codex", "session-1", "thread-managed");
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      discoverThreads: mock(async () =>
        completeRuntimeThreadDiscovery([
          { runtimeThreadId: "thread-managed", name: "Managed history", updatedAt: 2 },
          { runtimeThreadId: "thread-external", name: "External history", updatedAt: 1 },
        ]),
      ),
      start: mock(async () => session(async function* () {}, {} as ConnectRuntimeStartContext)),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    const discovered = await runtime.discoverRuntimeThreads("chat-1");
    expect(discovered).toEqual([
      {
        runtimeThreadId: "thread-external",
        name: "External history",
        updatedAt: 1,
        sessionRef: expect.stringMatching(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u),
      },
    ]);
    await expect(runtime.discoverRuntimeThreads("chat-1")).resolves.toEqual(discovered);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      name: "Managed history",
    });
    await fixture.store.close();
  });

  it("preserves a thread when closing and clears it when invalidating", async () => {
    const fixture = await runtimeFixture();
    await fixture.store.setRuntimeSessionId("chat-1", "codex", "session-1", "thread-1");
    const createdSessions: ConnectRuntimeSession[] = [];
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: ["read-only", "workspace-write", "danger-full-access"],
      start: mock(async (_agent, context) => {
        const created = session(async function* () {
          yield activity("done");
        }, context);
        createdSessions.push(created);
        return created;
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      config: fixture.config,
      configPath: fixture.configPath,
      stateStore: fixture.store,
      wsClient: fixture.wsClient,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });

    await runtime.handleInboundMessage(message());
    await expect(runtime.closeSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: "thread-1",
    });
    await runtime.handleInboundMessage(message("resume"));
    await expect(runtime.invalidateSession("chat-1")).resolves.toBe(true);
    await expect(fixture.store.getCurrentRuntimeSession("chat-1", "codex")).resolves.toMatchObject({
      runtimeSessionId: null,
    });
    expect(createdSessions.every((created) => (created.close as ReturnType<typeof mock>).mock.calls.length === 1)).toBe(
      true,
    );
    await fixture.store.close();
  });
});

describe("ClawChat typing lifecycle", () => {
  it.each([false, true])("signals typing while a turn is pending and clears on failure=%s", async (fails) => {
    const fixture = await runtimeFixture();
    const typing = mock((_chat: string, _active: boolean, _options: unknown) => {});
    fixture.wsClient.sendTyping = typing;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter: ConnectRuntimeAdapter = {
      kind: "codex",
      modes: [],
      start: async () => ({
        async *prompt() {
          entered();
          await pending;
          if (fails) throw new Error("fixture failure");
          yield activity("done");
        },
        close: async () => {},
      }),
    };
    const runtime = new ConnectRuntime({
      agentId: "codex",
      ...fixture,
      stateStore: fixture.store,
      runtimeAdapters: new RuntimeAdapterRegistry([fixedRuntimeAdapter(adapter)]),
    });
    const turn = runtime.handleInboundMessage(message());
    try {
      await started;
      expect(typing.mock.calls).toEqual([["chat-1", true, { toType: "direct" }]]);
    } finally {
      release();
      await turn;
      await runtime.dispose();
      await fixture.store.close();
    }
    expect(typing.mock.calls.at(-1)).toEqual(["chat-1", false, { toType: "direct" }]);
  });
});
