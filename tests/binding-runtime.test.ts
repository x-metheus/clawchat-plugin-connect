import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Envelope,
  EVENT,
  parseEnvelope,
  type Transport,
  type TransportEvents,
  type TransportState,
} from "../src/clawchat/protocol";
import { defaultConfig } from "../src/config";
import { createStateStore } from "../src/persistence/state";
import { RuntimeAdapterRegistry } from "../src/runtime/registry";
import { type ConnectRuntimePrompt, completeRuntimeThreadDiscovery } from "../src/runtime/types";
import { WorkBuddyDiscoveryError } from "../src/runtime/workbuddy-task-discovery";
import {
  type BindingProtocolEvent,
  type BindingRuntimeHandle,
  startBindingRuntime,
} from "../src/service/binding-runtime";
import { WorkspaceCatalog } from "../src/workspaces/workspaces";
import { fixedRuntimeAdapter, pluginBinding } from "./runtime-adapter-fixture";

class MemoryTransport implements Transport {
  state: TransportState = "closed";
  handlers: TransportEvents | null = null;
  sent: Envelope[] = [];

  async connect(_url: string, handlers: TransportEvents): Promise<void> {
    this.state = "open";
    this.handlers = handlers;
    handlers.onOpen();
  }

  send(data: string): void {
    this.sent.push(parseEnvelope(data));
  }

  close(): void {
    this.state = "closed";
  }

  receive(envelope: Envelope): void {
    this.handlers?.onMessage(JSON.stringify(envelope));
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForTransport(transport: MemoryTransport): Promise<void> {
  for (let attempt = 0; attempt < 50 && !transport.handlers; attempt += 1) await Bun.sleep(1);
  if (!transport.handlers) throw new Error("Binding transport did not start");
}
async function completeBindingHandshake(
  transport: MemoryTransport,
  starting: Promise<BindingRuntimeHandle>,
  ackEpoch: string,
): Promise<BindingRuntimeHandle> {
  await waitForTransport(transport);
  transport.receive({
    version: "2",
    event: EVENT.CONNECT_CHALLENGE,
    trace_id: "challenge",
    emitted_at: 1,
    payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
  });
  await flush();
  const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
  if (!connect) throw new Error("connect frame was not sent");
  transport.receive({
    version: "2",
    event: EVENT.HELLO_OK,
    trace_id: connect.trace_id,
    emitted_at: 2,
    payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: ackEpoch },
  });
  return await starting;
}

describe("Binding Runtime Protocol v2 assembly", () => {
  it("rejects Binding startup before opening transport when managed skills do not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-skills-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: "codex",
      activeChats: 1,
      globalRunning: 1,
      globalQueued: 2,
      recentError: "stale process state",
    });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding() };
    const transport = new MemoryTransport();
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used");
        },
      }),
    ]);

    await expect(
      startBindingRuntime({
        agentId: "codex",
        activation: {
          localAgentId: "codex",
          accessToken: "token",
          refreshToken: null,
          serverAgentId: "agt_server",
          userId: "usr_alice",
          ownerUserId: "usr_owner",
          conversationId: "chat-owner",
        },
        config,
        configPath: join(directory, "config.json"),
        deviceId: "device-local",
        stateStore,
        workspaces: new WorkspaceCatalog(stateStore),
        runtimeAdapters,
        wsTransport: transport,
        verifyInstalledSkills: async () => {
          throw new Error("managed skills mismatch");
        },
        writeError: () => undefined,
      }),
    ).rejects.toThrow("managed skills mismatch");
    expect(transport.state).toBe("closed");
    await expect(stateStore.getRuntimeStatus("codex")).resolves.toMatchObject({
      websocketConnected: false,
      activeChats: 0,
      globalRunning: 0,
      globalQueued: 0,
      recentError: null,
    });
    await runtimeAdapters.close();
    await stateStore.close();
  });

  it("advertises each optional capability only when its production handler is installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-capabilities-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      protocolEventHandlers: {
        notify: async () => undefined,
      },
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);

    expect(connect?.payload).toMatchObject({
      capabilities: {
        chat_meta_events: false,
        notify_signals: true,
        permission_events: false,
        history_sync: false,
      },
    });
    transport.close();
    await runtimeAdapters.close();
    await stateStore.close();
    void starting.catch(() => undefined);
  });

  it("does not block Binding readiness on optional Runtime Project synchronization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-project-sync-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    let releaseDiscovery: () => void = () => undefined;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        discoverAllThreads: async () => {
          await discoveryGate;
          return completeRuntimeThreadDiscovery([]);
        },
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });

    let handle: Awaited<typeof starting> | null = null;
    let closed = false;
    try {
      handle = await Promise.race([starting, Bun.sleep(50).then(() => null)]);
      expect(handle).not.toBeNull();
      if (handle === null) throw new Error("Binding readiness was blocked by Runtime Project synchronization");
      const closing = handle.close();
      await expect(Promise.race([closing.then(() => "closed"), Bun.sleep(10).then(() => "waiting")])).resolves.toBe(
        "waiting",
      );
      releaseDiscovery();
      await closing;
      closed = true;
    } finally {
      releaseDiscovery();
      handle ??= await starting;
      if (!closed) await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("does not block Binding readiness on native input receipt recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-receipt-readiness-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const envelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "receipt-readiness",
      emitted_at: 1,
      chat_id: "chat-receipt-readiness",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-receipt-readiness",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "recover after readiness" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id,
      messageId: "msg-receipt-readiness",
      text: "recover after readiness",
      raw: envelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-receipt-readiness",
      sessionId: "session-receipt-readiness",
      agentId: "codex",
      runtimeSessionId: "thread-receipt-readiness",
      isCurrent: true,
      hasMessages: true,
    });
    let releaseReceiptScan: () => void = () => undefined;
    const receiptScanGate = new Promise<void>((resolve) => {
      releaseReceiptScan = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async () => {
          await receiptScanGate;
          return { outcome: "unknown" };
        },
        start: async () => {
          throw new Error("not used by this readiness test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AF" },
    });

    let handle: Awaited<typeof starting> | null = null;
    let closing: Promise<void> | null = null;
    try {
      handle = await Promise.race([starting, Bun.sleep(50).then(() => null)]);
      expect(handle).not.toBeNull();
      if (!handle) throw new Error("Binding readiness was blocked by native input receipt recovery");
      closing = handle.close();
      await expect(Promise.race([closing.then(() => "closed"), Bun.sleep(10).then(() => "waiting")])).resolves.toBe(
        "waiting",
      );
      releaseReceiptScan();
      await closing;
    } finally {
      releaseReceiptScan();
      handle ??= await starting;
      if (!closing) await handle.close();
      else await closing;
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("joins background receipt recovery before disposing a Binding whose startup later fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-receipt-startup-failure-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const envelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "receipt-startup-failure",
      emitted_at: 1,
      chat_id: "chat-receipt-startup-failure",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-receipt-startup-failure",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "do not replay after failed startup" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id,
      messageId: "msg-receipt-startup-failure",
      text: "do not replay after failed startup",
      raw: envelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-receipt-startup-failure",
      sessionId: "session-receipt-startup-failure",
      agentId: "codex",
      runtimeSessionId: "thread-receipt-startup-failure",
      isCurrent: true,
      hasMessages: true,
    });
    let publishReceiptScanStarted: () => void = () => undefined;
    const receiptScanStarted = new Promise<void>((resolve) => {
      publishReceiptScanStarted = resolve;
    });
    let releaseReceiptScan: () => void = () => undefined;
    const receiptScanGate = new Promise<void>((resolve) => {
      releaseReceiptScan = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async () => {
          publishReceiptScanStarted();
          await receiptScanGate;
          return { outcome: "absent", receipts: { identities: [], complete: true } };
        },
        start: async () => {
          throw new Error("must not replay after failed startup");
        },
      }),
    ]);
    const persistConnectionStatus = stateStore.setRuntimeConnectionStatus.bind(stateStore);
    stateStore.setRuntimeConnectionStatus = mock(async (agentId, connected, recentError) => {
      if (connected) {
        await receiptScanStarted;
        throw new Error("connection status persistence failed");
      }
      await persistConnectionStatus(agentId, connected, recentError);
    });
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    const observed = starting.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AG" },
    });
    await receiptScanStarted;

    try {
      await expect(Promise.race([observed, Bun.sleep(20).then(() => "waiting" as const)])).resolves.toBe("waiting");
      releaseReceiptScan();
      const result = await observed;
      expect(result).toBeInstanceOf(Error);
      expect(result).toMatchObject({ message: "connection status persistence failed" });
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-receipt-startup-failure", envelope)).resolves.toBe(
        false,
      );
    } finally {
      releaseReceiptScan();
      await observed;
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("recovers WorkBuddy preparation without restarting live Binding intake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-workbuddy-startup-unavailable-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "workbuddy";
    config.agents = { workbuddy: pluginBinding({}, { displayName: "Alice" }) };
    let publishRuntimeAvailable: () => void = () => undefined;
    const runtimeAvailable = new Promise<void>((resolve) => {
      publishRuntimeAvailable = resolve;
    });
    const setRuntimeAvailability = stateStore.setRuntimeAvailability.bind(stateStore);
    stateStore.setRuntimeAvailability = async (agentId, availability, recentError) => {
      await setRuntimeAvailability(agentId, availability, recentError);
      if (availability === "available") publishRuntimeAvailable();
    };
    let publishPreparationRetry: () => void = () => undefined;
    const preparationRetryStarted = new Promise<void>((resolve) => {
      publishPreparationRetry = resolve;
    });
    let releasePreparationRetry: () => void = () => undefined;
    const preparationRetryGate = new Promise<void>((resolve) => {
      releasePreparationRetry = resolve;
    });
    let preparationAttempts = 0;
    let publishWorkspaceSynchronization: () => void = () => undefined;
    const workspaceSynchronizationStarted = new Promise<void>((resolve) => {
      publishWorkspaceSynchronization = resolve;
    });
    let workspaceSynchronizationCalls = 0;
    let runtimeStarts = 0;
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "workbuddy",
        modes: ["read-only"],
        prepare: async () => {
          preparationAttempts += 1;
          if (preparationAttempts === 1) {
            throw new WorkBuddyDiscoveryError(
              "application-stopped",
              "WorkBuddy AI is installed but not running; open it before discovering Tasks.",
            );
          }
          publishPreparationRetry();
          await preparationRetryGate;
        },
        discoverWorkspaces: async () => {
          workspaceSynchronizationCalls += 1;
          publishWorkspaceSynchronization();
          return { status: "complete", identities: [] };
        },
        start: async () => {
          runtimeStarts += 1;
          throw new Error("help intake must not start an unavailable WorkBuddy Runtime");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "workbuddy",
      activation: {
        localAgentId: "workbuddy",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      runtimePreparationRetryMs: 0,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    const observed = starting.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    let handle: BindingRuntimeHandle | null = null;

    try {
      await waitForTransport(transport);
      let startupSettled = false;
      void observed.then(() => {
        startupSettled = true;
      });
      await flush();
      expect(startupSettled).toBe(false);
      expect(transport.state).toBe("open");

      let publishConnect: (event: Envelope) => void = () => undefined;
      const connectSent = new Promise<Envelope>((resolve) => {
        publishConnect = resolve;
      });
      const sendBeforeConnect = transport.send.bind(transport);
      transport.send = (data) => {
        sendBeforeConnect(data);
        const sent = transport.sent.at(-1);
        if (sent?.event === EVENT.CONNECT) publishConnect(sent);
      };
      transport.receive({
        version: "2",
        event: EVENT.CONNECT_CHALLENGE,
        trace_id: "challenge",
        emitted_at: 1,
        payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
      });
      const connect = await connectSent;
      transport.receive({
        version: "2",
        event: EVENT.HELLO_OK,
        trace_id: connect.trace_id,
        emitted_at: 2,
        payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AW" },
      });
      handle = await starting;

      await expect(stateStore.getRuntimeStatus("workbuddy")).resolves.toMatchObject({
        runtimeAvailability: "startup-unavailable",
        websocketConnected: true,
        recentError: expect.stringContaining("installed but not running"),
      });

      let publishHelpReply: (reply: Envelope) => void = () => undefined;
      const helpReplySent = new Promise<Envelope>((resolve) => {
        publishHelpReply = resolve;
      });
      const sendTransport = transport.send.bind(transport);
      transport.send = (data) => {
        sendTransport(data);
        const sent = transport.sent.at(-1);
        if (sent?.event === EVENT.MESSAGE_REPLY && sent.chat_id === "chat-help") publishHelpReply(sent);
      };
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_SEND,
        trace_id: "workbuddy-unavailable-help",
        emitted_at: 3,
        dseq: 1,
        chat_id: "chat-help",
        chat_type: "direct",
        sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
        payload: {
          message_id: "msg-workbuddy-unavailable-help",
          message_mode: "normal",
          message: {
            body: { fragments: [{ kind: "text", text: "/help" }] },
            context: { mentions: [], reply: null },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
      const reply = await helpReplySent;
      expect(runtimeStarts).toBe(0);
      expect(reply?.payload).toMatchObject({
        message: {
          body: {
            fragments: [
              expect.objectContaining({ kind: "text", text: expect.stringContaining("ClawChat Connect commands") }),
            ],
          },
        },
      });
      if (!reply) throw new Error("help reply was not sent");
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_ACK,
        trace_id: reply.trace_id,
        emitted_at: 4,
        chat_id: "chat-help",
        payload: { message_id: "reply-workbuddy-unavailable-help", accepted_at: 4 },
      });
      await flush();
      await preparationRetryStarted;
      releasePreparationRetry();
      await runtimeAvailable;
      await workspaceSynchronizationStarted;
      expect(preparationAttempts).toBe(2);
      expect(workspaceSynchronizationCalls).toBe(1);
      await expect(stateStore.getRuntimeStatus("workbuddy")).resolves.toMatchObject({
        runtimeAvailability: "available",
        websocketConnected: true,
        recentError: null,
      });

      const closing = handle.close();
      handle = null;
      await expect(closing).resolves.toBeUndefined();
      expect(transport.state).toBe("closed");
      await expect(stateStore.getRuntimeStatus("workbuddy")).resolves.toMatchObject({
        runtimeAvailability: "available",
        websocketConnected: false,
      });
      expect(workspaceSynchronizationCalls).toBe(1);
    } finally {
      releasePreparationRetry();
      if (handle) await handle.close();
      await observed;
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("keeps unsupported WorkBuddy preparation live without retrying", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-workbuddy-unsupported-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "workbuddy";
    config.agents = { workbuddy: pluginBinding() };
    let preparationAttempts = 0;
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "workbuddy",
        modes: [],
        prepare: async () => {
          preparationAttempts += 1;
          throw new WorkBuddyDiscoveryError(
            "protocol-incompatible",
            "WorkBuddy AI does not expose a supported Task Attachment protocol.",
          );
        },
        start: async () => {
          throw new Error("not used by unsupported preparation test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "workbuddy",
      activation: {
        localAgentId: "workbuddy",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      runtimePreparationRetryMs: 0,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    const handle = await completeBindingHandshake(transport, starting, "01JXYZ8K3MNPQRSTVWXYZ0AX");

    try {
      await flush();
      expect(preparationAttempts).toBe(1);
      expect(transport.state).toBe("open");
      await expect(stateStore.getRuntimeStatus("workbuddy")).resolves.toMatchObject({
        runtimeAvailability: "startup-unavailable",
        websocketConnected: true,
        recentError: expect.stringContaining("does not expose a supported"),
      });
    } finally {
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("shuts down a live Binding when a WorkBuddy preparation retry fails fatally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-workbuddy-retry-fatal-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "workbuddy";
    config.agents = { workbuddy: pluginBinding() };
    let publishFatalRetry: () => void = () => undefined;
    const fatalRetryStarted = new Promise<void>((resolve) => {
      publishFatalRetry = resolve;
    });
    let publishFatalStatus: () => void = () => undefined;
    const fatalStatusRecorded = new Promise<void>((resolve) => {
      publishFatalStatus = resolve;
    });
    const setRuntimeConnectionStatus = stateStore.setRuntimeConnectionStatus.bind(stateStore);
    stateStore.setRuntimeConnectionStatus = async (agentId, websocketConnected, recentError) => {
      await setRuntimeConnectionStatus(agentId, websocketConnected, recentError);
      if (!websocketConnected && recentError?.includes("preparation core failed")) publishFatalStatus();
    };
    let preparationAttempts = 0;
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "workbuddy",
        modes: [],
        prepare: async () => {
          preparationAttempts += 1;
          if (preparationAttempts === 1) {
            throw new WorkBuddyDiscoveryError("endpoint-unavailable", "WorkBuddy AI endpoint is unavailable.");
          }
          publishFatalRetry();
          throw new Error("Runtime preparation core failed");
        },
        start: async () => {
          throw new Error("not used by fatal preparation retry test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "workbuddy",
      activation: {
        localAgentId: "workbuddy",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      runtimePreparationRetryMs: 0,
      verifyInstalledSkills: async () => undefined,
      writeError: (message) => errors.push(message),
    });
    const handle = await completeBindingHandshake(transport, starting, "01JXYZ8K3MNPQRSTVWXYZ0AY");

    try {
      await fatalRetryStarted;
      await fatalStatusRecorded;
      expect(preparationAttempts).toBe(2);
      expect(transport.state).toBe("closed");
      expect(errors).toContainEqual(expect.stringContaining("preparation retry failed fatally"));
      await expect(stateStore.getRuntimeStatus("workbuddy")).resolves.toMatchObject({
        websocketConnected: false,
        recentError: "Runtime preparation core failed",
      });
      await expect(handle.close()).resolves.toBeUndefined();
    } finally {
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("joins startup group settings refresh when Runtime preparation fails before connecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-settings-prepare-failure-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    let publishSettingsReadStarted: () => void = () => undefined;
    const settingsReadStarted = new Promise<void>((resolve) => {
      publishSettingsReadStarted = resolve;
    });
    let releaseSettingsRead: () => void = () => undefined;
    const settingsReadGate = new Promise<void>((resolve) => {
      releaseSettingsRead = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        prepare: async () => {
          await settingsReadStarted;
          throw new Error("Runtime preparation failed");
        },
        start: async () => {
          throw new Error("not used by this startup failure test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      clawChatApi: {
        getUserProfile: async () => ({ nickname: null }),
        getMyGroupSettings: async () => {
          publishSettingsReadStarted();
          await settingsReadGate;
          return { authoritative: true, rows: [] };
        },
      } as never,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    const observed = starting.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await settingsReadStarted;

    try {
      await expect(Promise.race([observed, Bun.sleep(20).then(() => "waiting" as const)])).resolves.toBe("waiting");
      releaseSettingsRead();
      const result = await observed;
      expect(result).toBeInstanceOf(Error);
      expect(result).toMatchObject({ message: "Runtime preparation failed" });
      expect(transport.state).toBe("closed");
    } finally {
      releaseSettingsRead();
      await observed;
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("defers replayed WebSocket input until native receipt absence is authoritative", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-receipt-replay-gate-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const envelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "receipt-replay-stored",
      emitted_at: 1,
      chat_id: "chat-receipt-replay",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-receipt-replay",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "submit only after authoritative absence" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id,
      messageId: "msg-receipt-replay",
      text: "submit only after authoritative absence",
      raw: envelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-receipt-replay",
      sessionId: "session-receipt-replay",
      agentId: "codex",
      runtimeSessionId: "thread-receipt-replay",
      isCurrent: true,
      hasMessages: true,
    });
    let publishReceiptScanStarted: () => void = () => undefined;
    const receiptScanStarted = new Promise<void>((resolve) => {
      publishReceiptScanStarted = resolve;
    });
    let releaseFirstReceiptScan: () => void = () => undefined;
    const firstReceiptScanGate = new Promise<void>((resolve) => {
      releaseFirstReceiptScan = resolve;
    });
    let reconcileAttempts = 0;
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async () => {
          reconcileAttempts += 1;
          if (reconcileAttempts === 1) {
            publishReceiptScanStarted();
            await firstReceiptScanGate;
            return { outcome: "unknown" };
          }
          return { outcome: "absent", receipts: { identities: [], complete: true } };
        },
        start: async () => ({
          prompt: async function* (input) {
            prompts.push(input);
            await input.onAccepted?.();
            yield* [];
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    let publishRetry: (callback: () => void) => void = () => undefined;
    const retryScheduled = new Promise<() => void>((resolve) => {
      publishRetry = resolve;
    });
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      groupIntakeClock: {
        now: () => Date.now(),
        setTimer: (callback) => {
          publishRetry(callback);
          return callback;
        },
        clearTimer: () => undefined,
      },
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AH" },
    });
    const handle = await starting;
    await receiptScanStarted;

    try {
      transport.receive({ ...envelope, trace_id: "receipt-replay-live-one", emitted_at: 4, dseq: 1 });
      await Bun.sleep(20);
      expect(prompts).toEqual([]);

      releaseFirstReceiptScan();
      const retry = await retryScheduled;
      await Bun.sleep(10);
      expect(prompts).toEqual([]);

      transport.receive({
        chat_type: "direct",
        sender: { nick_name: "Bob", type: "direct", id: "usr_bob" },
        chat_id: "chat-receipt-replay",
        payload: {
          message: {
            streaming: { mutation_policy: "sealed", sequence: 0, status: "static" },
            context: { reply: null, mentions: [] },
            body: { fragments: [{ text: "submit only after authoritative absence", kind: "text" }] },
          },
          message_mode: "normal",
          message_id: "msg-receipt-replay",
        },
        dseq: 2,
        emitted_at: 5,
        trace_id: "receipt-replay-live-two",
        event: EVENT.MESSAGE_SEND,
        version: "2",
      });
      await Bun.sleep(10);
      expect(prompts).toEqual([]);

      retry();
      for (let attempt = 0; attempt < 100 && prompts.length === 0; attempt += 1) await Bun.sleep(2);
      expect(reconcileAttempts).toBe(2);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toContain("submit only after authoritative absence");
    } finally {
      releaseFirstReceiptScan();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("joins group settings recovery before Binding shutdown completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-group-recovery-close-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    let publishSettingsReadStarted: () => void = () => undefined;
    const settingsReadStarted = new Promise<void>((resolve) => {
      publishSettingsReadStarted = resolve;
    });
    let releaseSettingsRead: () => void = () => undefined;
    const settingsReadGate = new Promise<void>((resolve) => {
      releaseSettingsRead = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this shutdown test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      clawChatApi: {
        getUserProfile: async () => ({ nickname: null }),
        getMyGroupSettings: async () => {
          publishSettingsReadStarted();
          await settingsReadGate;
          return { authoritative: true, rows: [] };
        },
      } as never,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AJ" },
    });
    const handle = await starting;
    await settingsReadStarted;
    const closing = handle.close();

    try {
      await expect(Promise.race([closing.then(() => "closed"), Bun.sleep(20).then(() => "waiting")])).resolves.toBe(
        "waiting",
      );
      releaseSettingsRead();
      await closing;
    } finally {
      releaseSettingsRead();
      await closing;
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("gates group replay intake while authoritative settings and native receipts are resolving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-group-replay-gate-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.replaceGroupSettingsSnapshot("codex", [
      {
        conversationId: "group-replay-gate",
        muted: false,
        replyMode: "mention",
        batchDelaySeconds: 60,
        version: 1,
      },
    ]);
    const envelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "group-replay-stored",
      emitted_at: 1,
      chat_id: "group-replay-gate",
      chat_type: "group",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-group-replay-gate",
        message_mode: "normal",
        message: {
          body: {
            fragments: [
              { kind: "mention", user_id: "usr_alice", display: "Alice" },
              { kind: "text", text: " do not replay before settings and receipts" },
            ],
          },
          context: { mentions: [{ user_id: "usr_alice", display: "Alice" }], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id,
      messageId: "msg-group-replay-gate",
      text: "@Alice do not replay before settings and receipts",
      raw: envelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "group-replay-gate",
      sessionId: "session-group-replay-gate",
      agentId: "codex",
      runtimeSessionId: "thread-group-replay-gate",
      isCurrent: true,
      hasMessages: true,
    });
    let publishSettingsReadStarted: () => void = () => undefined;
    const settingsReadStarted = new Promise<void>((resolve) => {
      publishSettingsReadStarted = resolve;
    });
    let releaseSettingsRead: () => void = () => undefined;
    const settingsReadGate = new Promise<void>((resolve) => {
      releaseSettingsRead = resolve;
    });
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async (_binding, _runtimeThreadId, candidate) => ({
          outcome: "accepted",
          identity: { origin: "clawchat", anchor: candidate, actionable: [candidate], context: [] },
        }),
        start: async () => ({
          prompt: async function* (input) {
            prompts.push(input);
            await input.onAccepted?.();
            yield* [];
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config: {
        ...defaultConfig(),
        defaultAgent: "codex",
        agents: { codex: pluginBinding({}, { displayName: "Alice" }) },
      },
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      clawChatApi: {
        getUserProfile: async () => ({ nickname: null }),
        getMyGroupSettings: async () => {
          publishSettingsReadStarted();
          await settingsReadGate;
          return {
            authoritative: true,
            rows: [
              {
                conversationId: "group-replay-gate",
                muted: false,
                replyMode: "mention",
                batchDelaySeconds: 60,
                version: 1,
              },
            ],
          };
        },
      } as never,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AK" },
    });
    const handle = await starting;
    await settingsReadStarted;

    try {
      transport.receive({ ...envelope, trace_id: "group-replay-live", emitted_at: 4, dseq: 1 });
      await Bun.sleep(20);
      expect(prompts).toEqual([]);
      releaseSettingsRead();
      for (
        let attempt = 0;
        attempt < 100 && !(await stateStore.hasHandledInboundMessage("codex", "msg-group-replay-gate", envelope));
        attempt += 1
      )
        await Bun.sleep(2);
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-group-replay-gate", envelope)).resolves.toBe(true);
      expect(prompts).toEqual([]);
    } finally {
      releaseSettingsRead();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("resets stale active-turn counters when a new Binding Runtime starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-runtime-status-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    await stateStore.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: "codex",
      activeChats: 1,
      globalRunning: 1,
      globalQueued: 2,
      recentError: "stale process state",
    });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    await expect(stateStore.getRuntimeStatus("codex")).resolves.toMatchObject({
      websocketConnected: true,
      activeChats: 0,
      globalRunning: 0,
      globalQueued: 0,
      recentError: null,
    });

    await handle.close();
    await runtimeAdapters.close();
    await stateStore.close();
  });

  it("waits for a reliable production handler before acknowledging its dseq", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-handler-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    let handlerStarted = false;
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      protocolEventHandlers: {
        notify: async () => {
          handlerStarted = true;
          await handlerGate;
        },
      },
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "notify-1",
      emitted_at: 3,
      dseq: 1,
      payload: {
        type: "friend.added",
        entity_id: "usr_bob",
        version: 1,
        event_id: "event-1",
        message_id: "msg-1",
      },
    });
    await flush();

    try {
      expect(handlerStarted).toBe(true);
      expect(transport.sent.some((event) => event.event === EVENT.MESSAGE_SYNC_ACK)).toBe(false);
      releaseHandler?.();
      await Bun.sleep(220);
      expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });
    } finally {
      releaseHandler?.();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("acknowledges durable handoff promptly and recovers unfinished messages after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-recovery-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const recoveredEnvelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "recovered-message",
      emitted_at: 1,
      chat_id: "chat-recovery",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-recovered",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "recover me" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: recoveredEnvelope.trace_id,
      chatId: recoveredEnvelope.chat_id,
      messageId: "msg-recovered",
      text: "recover me",
      raw: recoveredEnvelope,
    });
    const reconciledEnvelope: Envelope = {
      ...recoveredEnvelope,
      trace_id: "reconciled-message",
      chat_id: "chat-reconciled",
      payload: {
        message_id: "msg-reconciled",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "already accepted" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: reconciledEnvelope.trace_id,
      chatId: reconciledEnvelope.chat_id,
      messageId: "msg-reconciled",
      text: "already accepted",
      raw: reconciledEnvelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-reconciled",
      sessionId: "session-reconciled",
      agentId: "codex",
      runtimeSessionId: "thread-reconciled",
      isCurrent: false,
      hasMessages: true,
    });
    await Bun.sleep(2);
    for (let index = 0; index < 101; index += 1) {
      await stateStore.upsertRuntimeSession({
        chatId: "chat-reconciled",
        sessionId: `session-decoy-${index}`,
        agentId: "codex",
        runtimeSessionId: `thread-decoy-${index}`,
        isCurrent: false,
        hasMessages: true,
      });
    }
    await stateStore.upsertRuntimeSession({
      chatId: "chat-reconciled",
      sessionId: "session-current",
      agentId: "codex",
      runtimeSessionId: "thread-current",
      isCurrent: true,
      hasMessages: true,
    });
    const reconciledSession = await stateStore.getCurrentRuntimeSession("chat-reconciled", "codex");
    if (!reconciledSession) throw new Error("expected reconciled Session");

    const prompts: ConnectRuntimePrompt[] = [];
    const reconciledThreads: string[] = [];
    let releaseFirstPrompt: (() => void) | undefined;
    const firstPromptGate = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async (_binding, runtimeThreadId, candidate) => {
          if (candidate.messageId === "msg-reconciled") reconciledThreads.push(runtimeThreadId);
          return runtimeThreadId === "thread-reconciled"
            ? {
                outcome: "accepted",
                identity: {
                  origin: "clawchat",
                  anchor: candidate,
                  actionable: [candidate],
                  context: [],
                },
              }
            : { outcome: "absent" };
        },
        start: async () => ({
          prompt: async function* (input: ConnectRuntimePrompt) {
            prompts.push(input);
            await input.onAccepted?.();
            if (prompts.length === 1) await firstPromptGate;
            yield {
              id: "processed",
              position: "0",
              parentId: null,
              kind: "progress",
              text: "processed",
              state: "complete",
              source: "live",
              data: { outputKind: "progress" },
            } as const;
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: (message) => errors.push(message),
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    for (let attempt = 0; attempt < 50 && prompts.length === 0; attempt += 1) await Bun.sleep(2);
    expect(prompts[0]?.prompt).toContain("recover me");
    await expect(stateStore.hasHandledInboundMessage("codex", "msg-recovered", recoveredEnvelope)).resolves.toBe(true);
    await expect(stateStore.hasHandledInboundMessage("codex", "msg-reconciled", reconciledEnvelope)).resolves.toBe(
      true,
    );
    expect(prompts.some((prompt) => prompt.prompt.includes("already accepted"))).toBe(false);
    expect(reconciledThreads.indexOf("thread-reconciled")).toBeGreaterThan(100);

    const liveEnvelope: Envelope = {
      ...recoveredEnvelope,
      trace_id: "live-message",
      emitted_at: 4,
      dseq: 1,
      payload: {
        message_id: "msg-live",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "live message" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    transport.receive(liveEnvelope);

    try {
      await Bun.sleep(220);
      expect(prompts).toHaveLength(1);
      expect(transport.sent.at(-1)).toMatchObject({ event: EVENT.MESSAGE_SYNC_ACK, payload: { dseq: 1 } });

      releaseFirstPrompt?.();
      for (let attempt = 0; attempt < 50 && prompts.length < 2; attempt += 1) await Bun.sleep(2);
      expect(prompts[1]?.prompt).toContain("live message");
      for (
        let attempt = 0;
        attempt < 50 && !(await stateStore.hasHandledInboundMessage("codex", "msg-live", liveEnvelope));
        attempt += 1
      )
        await Bun.sleep(2);
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-recovered", recoveredEnvelope)).resolves.toBe(
        true,
      );
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-live", liveEnvelope)).resolves.toBe(true);
      expect(errors).toEqual([]);
    } finally {
      releaseFirstPrompt?.();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("recovers persisted WorkBuddy control commands without reconciling Task receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-workbuddy-control-recovery-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const workspaces = new WorkspaceCatalog(stateStore);
    const workspace = await workspaces.ensureDefault("workbuddy");
    const config = defaultConfig();
    config.defaultAgent = "workbuddy";
    config.agents = { workbuddy: pluginBinding({ profile: "workbuddy-ai" }, { displayName: "Alice" }) };
    const envelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "workbuddy-control-recovery",
      emitted_at: 1,
      chat_id: "chat-workbuddy-control",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-workbuddy-control",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "/help" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "workbuddy",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id,
      messageId: "msg-workbuddy-control",
      text: "/help",
      raw: envelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-workbuddy-control",
      sessionId: "session-workbuddy-task",
      agentId: "workbuddy",
      runtimeSessionId: "task-native-1",
      workspaceRef: workspace.workspaceRef,
      name: "Materialized WorkBuddy Task",
      isCurrent: true,
      hasMessages: true,
    });

    let publishHelpHandled: () => void = () => undefined;
    const helpHandled = new Promise<void>((resolve) => {
      publishHelpHandled = resolve;
    });
    const markInboundMessageHandled = stateStore.markInboundMessageHandled.bind(stateStore);
    stateStore.markInboundMessageHandled = async (agentId, messageId, raw, outcome) => {
      await markInboundMessageHandled(agentId, messageId, raw, outcome);
      if (messageId === "msg-workbuddy-control") publishHelpHandled();
    };

    let reconcileAttempts = 0;
    let runtimeStarts = 0;
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "workbuddy",
        modes: ["read-only"],
        reconcileInput: async () => {
          reconcileAttempts += 1;
          return { outcome: "unknown" };
        },
        start: async () => {
          runtimeStarts += 1;
          throw new Error("local control recovery must not start the materialized WorkBuddy Task");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    let publishTransportConnected: () => void = () => undefined;
    const transportConnected = new Promise<void>((resolve) => {
      publishTransportConnected = resolve;
    });
    const connectTransport = transport.connect.bind(transport);
    transport.connect = async (url, handlers) => {
      await connectTransport(url, handlers);
      publishTransportConnected();
    };
    let publishConnect: (event: Envelope) => void = () => undefined;
    const connectSent = new Promise<Envelope>((resolve) => {
      publishConnect = resolve;
    });
    let publishHelpReply: (event: Envelope) => void = () => undefined;
    const helpReplySent = new Promise<Envelope>((resolve) => {
      publishHelpReply = resolve;
    });
    const sendTransport = transport.send.bind(transport);
    transport.send = (data) => {
      sendTransport(data);
      const sent = transport.sent.at(-1);
      if (sent?.event === EVENT.CONNECT) publishConnect(sent);
      if (sent?.event === EVENT.MESSAGE_REPLY && sent.chat_id === "chat-workbuddy-control") publishHelpReply(sent);
    };
    const starting = startBindingRuntime({
      agentId: "workbuddy",
      activation: {
        localAgentId: "workbuddy",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces,
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    let handle: BindingRuntimeHandle | null = null;

    try {
      await transportConnected;
      transport.receive({
        version: "2",
        event: EVENT.CONNECT_CHALLENGE,
        trace_id: "challenge",
        emitted_at: 2,
        payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
      });
      const connect = await connectSent;
      transport.receive({
        version: "2",
        event: EVENT.HELLO_OK,
        trace_id: connect.trace_id,
        emitted_at: 3,
        payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AX" },
      });
      handle = await starting;

      const reply = await helpReplySent;
      expect(reply.payload).toMatchObject({
        message: {
          body: {
            fragments: [
              expect.objectContaining({ kind: "text", text: expect.stringContaining("ClawChat Connect commands") }),
            ],
          },
        },
      });
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_ACK,
        trace_id: reply.trace_id,
        emitted_at: 4,
        chat_id: "chat-workbuddy-control",
        payload: { message_id: "reply-workbuddy-control", accepted_at: 4 },
      });
      await helpHandled;
      await expect(stateStore.hasHandledInboundMessage("workbuddy", "msg-workbuddy-control", envelope)).resolves.toBe(
        true,
      );
      expect(reconcileAttempts).toBe(0);
      expect(runtimeStarts).toBe(0);
    } finally {
      if (handle) await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("keeps unknown native acceptance pending through capped backoff until absence is authoritative", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-unknown-recovery-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const envelope: Envelope = {
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "unknown-recovery",
      emitted_at: 1,
      chat_id: "chat-unknown",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-unknown",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "retry only after certainty" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: envelope.trace_id,
      chatId: envelope.chat_id,
      messageId: "msg-unknown",
      text: "retry only after certainty",
      raw: envelope,
    });
    const secondEnvelope: Envelope = {
      ...envelope,
      trace_id: "unknown-recovery-second",
      payload: {
        message_id: "msg-unknown-second",
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text: "share one authoritative receipt read" }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    };
    await stateStore.upsertInboundMessage({
      agentId: "codex",
      direction: "inbound",
      kind: "message",
      eventType: EVENT.MESSAGE_SEND,
      traceId: secondEnvelope.trace_id,
      chatId: secondEnvelope.chat_id,
      messageId: "msg-unknown-second",
      text: "share one authoritative receipt read",
      raw: secondEnvelope,
    });
    await stateStore.upsertRuntimeSession({
      chatId: "chat-unknown",
      sessionId: "session-unknown",
      agentId: "codex",
      runtimeSessionId: "thread-unknown",
      isCurrent: true,
      hasMessages: true,
    });
    let attempts = 0;
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async () => {
          attempts += 1;
          if (attempts <= 6) throw new Error("native receipt history unavailable");
          return { outcome: "absent", receipts: { identities: [], complete: true } };
        },
        start: async () => ({
          prompt: async function* (input) {
            prompts.push(input);
            await input.onAccepted?.();
            yield* [];
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    let recoveryRetryTimers = 0;
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      groupIntakeClock: {
        now: () => Date.now(),
        setTimer: (callback) => {
          recoveryRetryTimers += 1;
          return setTimeout(callback, 0);
        },
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AD" },
    });
    const handle = await starting;
    try {
      for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt += 1) await Bun.sleep(2);
      expect(attempts).toBe(7);
      expect(recoveryRetryTimers).toBe(6);
      expect(prompts).toHaveLength(2);
      expect(prompts.some((prompt) => prompt.prompt.includes("retry only after certainty"))).toBe(true);
      expect(prompts.some((prompt) => prompt.prompt.includes("share one authoritative receipt read"))).toBe(true);
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-unknown", envelope)).resolves.toBe(true);
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-unknown-second", secondEnvelope)).resolves.toBe(
        true,
      );
    } finally {
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("joins an active receipt recovery and prevents shutdown-time recovery side effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-close-recovery-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const envelope = (messageId: string, text: string): Envelope => ({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: `trace-${messageId}`,
      emitted_at: 1,
      chat_id: "chat-close-recovery",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: messageId,
        message_mode: "normal",
        message: {
          body: { fragments: [{ kind: "text", text }] },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    const acceptedEnvelope = envelope("msg-close-accepted", "accepted while closing");
    const absentEnvelope = envelope("msg-close-absent", "absent while closing");
    for (const [raw, messageId, text] of [
      [acceptedEnvelope, "msg-close-accepted", "accepted while closing"],
      [absentEnvelope, "msg-close-absent", "absent while closing"],
    ] as const) {
      await stateStore.upsertInboundMessage({
        agentId: "codex",
        direction: "inbound",
        kind: "message",
        eventType: EVENT.MESSAGE_SEND,
        traceId: raw.trace_id,
        chatId: raw.chat_id,
        messageId,
        text,
        raw,
      });
    }
    await stateStore.upsertRuntimeSession({
      chatId: "chat-close-recovery",
      sessionId: "session-close-recovery",
      agentId: "codex",
      runtimeSessionId: "thread-close-recovery",
      isCurrent: true,
      hasMessages: true,
    });

    let reconcileAttempts = 0;
    let releaseReceiptScan: () => void = () => undefined;
    const receiptScanGate = new Promise<void>((resolve) => {
      releaseReceiptScan = resolve;
    });
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        reconcileInput: async (_binding, _runtimeThreadId, candidate) => {
          reconcileAttempts += 1;
          if (reconcileAttempts === 1) return { outcome: "unknown" };
          await receiptScanGate;
          return candidate.messageId === "msg-close-accepted"
            ? {
                outcome: "accepted",
                identity: { origin: "clawchat", anchor: candidate, actionable: [candidate], context: [] },
              }
            : { outcome: "absent", receipts: { identities: [], complete: true } };
        },
        start: async () => ({
          prompt: async function* (input) {
            prompts.push(input);
            await input.onAccepted?.();
            yield* [];
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    const errors: string[] = [];
    let publishRecoveryRetry: (callback: () => void) => void = () => undefined;
    const recoveryRetryScheduled = new Promise<() => void>((resolve) => {
      publishRecoveryRetry = resolve;
    });
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      clawChatApi: {
        getUserProfile: async () => ({ nickname: null }),
        getMyGroupSettings: async () => ({ authoritative: true, rows: [] }),
      } as never,
      groupIntakeClock: {
        now: () => Date.now(),
        setTimer: (callback, delay) => {
          if (delay === 250) publishRecoveryRetry(callback);
          return callback;
        },
        clearTimer: () => undefined,
      },
      verifyInstalledSkills: async () => undefined,
      writeError: (message) => errors.push(message),
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 2,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 3,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AE" },
    });
    const handle = await starting;

    let closing: Promise<void> | null = null;
    try {
      for (let attempt = 0; attempt < 50 && reconcileAttempts === 0; attempt += 1) await Bun.sleep(1);
      expect(reconcileAttempts).toBe(1);
      const retryRecovery = await recoveryRetryScheduled;
      retryRecovery();
      for (let attempt = 0; attempt < 50 && reconcileAttempts < 2; attempt += 1) await Bun.sleep(1);
      expect(reconcileAttempts).toBe(2);

      closing = handle.close();
      const closedBeforeReceipt = await Promise.race([closing.then(() => true), Bun.sleep(20).then(() => false)]);
      releaseReceiptScan();
      await closing;
      await Bun.sleep(10);

      expect(closedBeforeReceipt).toBe(false);
      expect(prompts).toEqual([]);
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-close-accepted", acceptedEnvelope)).resolves.toBe(
        false,
      );
      await expect(stateStore.hasHandledInboundMessage("codex", "msg-close-absent", absentEnvelope)).resolves.toBe(
        false,
      );
      expect(errors).toEqual([]);
    } finally {
      releaseReceiptScan();
      if (!closing) await handle.close();
      else await closing;
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("delivers inbound WS media fragments to the production Runtime Adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-media-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => ({
          prompt: async function* (input: ConnectRuntimePrompt) {
            prompts.push(input);
            await Bun.sleep(10);
            yield {
              id: "media-received",
              position: "0",
              parentId: null,
              kind: "assistant",
              text: "media received",
              state: "complete",
              source: "live",
              data: { outputKind: "final" },
            } as const;
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: (message) => errors.push(message),
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "media-message",
      emitted_at: 3,
      dseq: 1,
      chat_id: "chat-media",
      chat_type: "direct",
      sender: { id: "usr_bob", type: "direct", nick_name: "Bob" },
      payload: {
        message_id: "msg-media",
        message_mode: "normal",
        message: {
          body: {
            fragments: [
              { kind: "text", text: "What is in this image?" },
              {
                kind: "image",
                url: "https://media.example/photo.png?signature=opaque",
                name: "photo.png",
                mime: "image/png",
              },
            ],
          },
          context: { mentions: [], reply: null },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });
    for (let attempt = 0; attempt < 50 && prompts.length === 0; attempt += 1) await Bun.sleep(2);

    expect(prompts[0]).toMatchObject({
      trustedMediaOrigins: expect.arrayContaining(["https://media.clawling.chat"]),
      media: [
        {
          kind: "image",
          url: "https://media.example/photo.png?signature=opaque",
          name: "photo.png",
          mime: "image/png",
        },
      ],
    });
    expect(errors).toEqual([]);
    let reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY);
    for (let attempt = 0; attempt < 50 && !reply; attempt += 1) {
      await Bun.sleep(2);
      reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY);
    }
    expect(reply).toBeDefined();
    if (!reply) throw new Error("media reply was not sent");
    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_ACK,
      trace_id: reply.trace_id,
      emitted_at: 4,
      chat_id: "chat-media",
      payload: { message_id: "reply-media", accepted_at: 4 },
    });
    await flush();
    await handle.close();
    await runtimeAdapters.close();
    await stateStore.close();
  });

  it("routes group messages addressed by a leading Agent mention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-group-command-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const prompts: ConnectRuntimePrompt[] = [];
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => ({
          prompt: async function* (input: ConnectRuntimePrompt) {
            prompts.push(input);
            yield {
              id: "unexpected-runtime-turn",
              position: "0",
              parentId: null,
              kind: "assistant",
              text: "unexpected",
              state: "complete",
              source: "live",
              data: { outputKind: "final" },
            } as const;
          },
          close: mock(async () => undefined),
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.MESSAGE_SEND,
      trace_id: "group-help",
      emitted_at: 3,
      dseq: 1,
      chat_id: "chat-group",
      chat_type: "group",
      sender: { id: "usr_member", type: "direct", nick_name: "Member" },
      payload: {
        message_id: "msg-group-help",
        message_mode: "normal",
        message: {
          body: {
            fragments: [
              { kind: "mention", user_id: "usr_alice", display: "Alice" },
              { kind: "text", text: " /help" },
            ],
          },
          context: {
            mentions: [{ user_id: "usr_alice", display: "Alice" }],
            reply: null,
          },
          streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
        },
      },
    });

    let reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "chat-group");
    for (let attempt = 0; attempt < 1_000 && !reply; attempt += 1) {
      await Bun.sleep(2);
      reply = transport.sent.find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "chat-group");
    }

    try {
      expect(prompts).toEqual([]);
      expect(reply?.payload).toMatchObject({
        message: {
          body: {
            fragments: [expect.objectContaining({ kind: "text", text: expect.stringContaining("@Agent /help") })],
          },
          context: {
            reply: {
              reply_to_msg_id: "msg-group-help",
            },
          },
        },
      });
      if (!reply) throw new Error("group help reply was not sent");
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_ACK,
        trace_id: reply.trace_id,
        emitted_at: 4,
        chat_id: "chat-group",
        payload: { message_id: "reply-group-help", accepted_at: 4 },
      });
      await flush();

      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_SEND,
        trace_id: "group-invalid-status",
        emitted_at: 5,
        dseq: 2,
        chat_id: "chat-group",
        chat_type: "group",
        sender: { id: "usr_owner", type: "direct", nick_name: "Owner" },
        payload: {
          message_id: "msg-group-invalid-status",
          message_mode: "normal",
          message: {
            body: {
              fragments: [
                { kind: "mention", user_id: "usr_alice", display: "Alice" },
                { kind: "text", text: " /status extra" },
              ],
            },
            context: {
              mentions: [{ user_id: "usr_alice", display: "Alice" }],
              reply: null,
            },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
      let invalidReply = transport.sent.find(
        (event) =>
          event.event === EVENT.MESSAGE_REPLY && event.chat_id === "chat-group" && event.trace_id !== reply?.trace_id,
      );
      for (let attempt = 0; attempt < 1_000 && !invalidReply; attempt += 1) {
        await Bun.sleep(2);
        invalidReply = transport.sent.find(
          (event) =>
            event.event === EVENT.MESSAGE_REPLY && event.chat_id === "chat-group" && event.trace_id !== reply?.trace_id,
        );
      }
      if (invalidReply) {
        transport.receive({
          version: "2",
          event: EVENT.MESSAGE_ACK,
          trace_id: invalidReply.trace_id,
          emitted_at: 6,
          chat_id: "chat-group",
          payload: { message_id: "reply-invalid-status", accepted_at: 6 },
        });
      }
      expect(invalidReply?.payload).toMatchObject({
        message: {
          body: {
            fragments: [expect.objectContaining({ kind: "text", text: "Usage: @Agent /status" })],
          },
          context: { reply: { reply_to_msg_id: "msg-group-invalid-status" } },
        },
      });

      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_SEND,
        trace_id: "group-empty",
        emitted_at: 7,
        dseq: 3,
        chat_id: "chat-group",
        chat_type: "group",
        sender: { id: "usr_member", type: "direct", nick_name: "Member" },
        payload: {
          message_id: "msg-group-empty",
          message_mode: "normal",
          message: {
            body: {
              fragments: [{ kind: "mention", user_id: "usr_alice", display: "Alice" }],
            },
            context: {
              mentions: [{ user_id: "usr_alice", display: "Alice" }],
              reply: null,
            },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
      let emptyReply = transport.sent.find(
        (event) =>
          event.event === EVENT.MESSAGE_REPLY &&
          event.chat_id === "chat-group" &&
          event.trace_id !== reply?.trace_id &&
          event.trace_id !== invalidReply?.trace_id,
      );
      for (let attempt = 0; attempt < 1_000 && !emptyReply; attempt += 1) {
        await Bun.sleep(2);
        emptyReply = transport.sent.find(
          (event) =>
            event.event === EVENT.MESSAGE_REPLY &&
            event.chat_id === "chat-group" &&
            event.trace_id !== reply?.trace_id &&
            event.trace_id !== invalidReply?.trace_id,
        );
      }
      if (emptyReply) {
        transport.receive({
          version: "2",
          event: EVENT.MESSAGE_ACK,
          trace_id: emptyReply.trace_id,
          emitted_at: 8,
          chat_id: "chat-group",
          payload: { message_id: "reply-group-empty", accepted_at: 8 },
        });
      }
      expect(prompts).toEqual([]);
      expect(emptyReply?.payload).toMatchObject({
        message: {
          body: {
            fragments: [
              expect.objectContaining({
                kind: "text",
                text: "Please include a message, attachment, or use @Agent /help.",
              }),
            ],
          },
          context: { reply: { reply_to_msg_id: "msg-group-empty" } },
        },
      });

      const repliesBeforeContextOnlyMention = transport.sent.filter(
        (event) => event.event === EVENT.MESSAGE_REPLY,
      ).length;
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_SEND,
        trace_id: "group-context-only-mention",
        emitted_at: 9,
        dseq: 4,
        chat_id: "chat-group",
        chat_type: "group",
        sender: { id: "usr_member", type: "direct", nick_name: "Member" },
        payload: {
          message_id: "msg-group-context-only-mention",
          message_mode: "normal",
          message: {
            body: {
              fragments: [{ kind: "text", text: "inspect this metadata" }],
            },
            context: {
              mentions: [{ user_id: "usr_alice", display: "Alice" }],
              reply: null,
            },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
      await flush();
      expect(prompts).toEqual([]);
      expect(transport.sent.filter((event) => event.event === EVENT.MESSAGE_REPLY)).toHaveLength(
        repliesBeforeContextOnlyMention,
      );

      const sentBeforeOrdinaryTurn = transport.sent.length;
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_SEND,
        trace_id: "group-ordinary",
        emitted_at: 10,
        dseq: 5,
        chat_id: "chat-group",
        chat_type: "group",
        sender: { id: "usr_member", type: "direct", nick_name: "Member" },
        payload: {
          message_id: "msg-group-ordinary",
          message_mode: "normal",
          message: {
            body: {
              fragments: [
                { kind: "mention", user_id: "usr_alice", display: "Alice" },
                { kind: "text", text: " inspect this" },
              ],
            },
            context: {
              mentions: [{ user_id: "usr_alice", display: "Alice" }],
              reply: null,
            },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
      for (let attempt = 0; attempt < 1_000 && prompts.length === 0; attempt += 1) await Bun.sleep(2);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toEndWith("\n\ninspect this");

      let ordinaryReply = transport.sent
        .slice(sentBeforeOrdinaryTurn)
        .find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "chat-group");
      for (let attempt = 0; attempt < 1_000 && !ordinaryReply; attempt += 1) {
        await Bun.sleep(2);
        ordinaryReply = transport.sent
          .slice(sentBeforeOrdinaryTurn)
          .find((event) => event.event === EVENT.MESSAGE_REPLY && event.chat_id === "chat-group");
      }
      if (ordinaryReply) {
        transport.receive({
          version: "2",
          event: EVENT.MESSAGE_ACK,
          trace_id: ordinaryReply.trace_id,
          emitted_at: 11,
          chat_id: "chat-group",
          payload: { message_id: "reply-group-ordinary", accepted_at: 11 },
        });
      }
    } finally {
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });

  it("routes typed WS events and poison-frame quarantine through the production event seam", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-runtime-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.defaultAgent = "codex";
    config.agents = { codex: pluginBinding({}, { displayName: "Alice" }) };
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: ["read-only"],
        start: async () => {
          throw new Error("not used by this assembly test");
        },
      }),
    ]);
    const transport = new MemoryTransport();
    const events: BindingProtocolEvent[] = [];
    const errors: string[] = [];
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      protocolEventHandlers: {
        presence: (event) => {
          events.push(event);
        },
        quarantined: (event) => {
          events.push(event);
        },
      },
      verifyInstalledSkills: async () => undefined,
      writeError: (message) => errors.push(message),
    });
    await waitForTransport(transport);
    transport.receive({
      version: "2",
      event: EVENT.CONNECT_CHALLENGE,
      trace_id: "challenge",
      emitted_at: 1,
      payload: { nonce: "Wn9hZ3lJZkN1QXBkUEpYbmNk" },
    });
    await flush();
    const connect = transport.sent.find((event) => event.event === EVENT.CONNECT);
    if (!connect) throw new Error("connect frame was not sent");
    expect(connect.payload).toMatchObject({
      capabilities: {
        chat_meta_events: false,
        notify_signals: true,
        permission_events: false,
        history_sync: false,
      },
    });
    transport.receive({
      version: "2",
      event: EVENT.HELLO_OK,
      trace_id: connect.trace_id,
      emitted_at: 2,
      payload: { device_id: "device-local", ack_mode: "dseq", ack_epoch: "01JXYZ8K3MNPQRSTVWXYZ0AB" },
    });
    const handle = await starting;

    transport.receive({
      version: "2",
      event: EVENT.PRESENCE_UPDATE,
      trace_id: "presence-1",
      emitted_at: 3,
      payload: { user_id: "usr_bob", online: true },
    });
    transport.receive({
      version: "2",
      event: EVENT.NOTIFY_SIGNAL,
      trace_id: "poison-1",
      emitted_at: 4,
      dseq: 1,
      payload: { type: "friend.added" },
    });
    await flush();

    expect(events.map((event) => event.type)).toEqual(["presence", "quarantined"]);
    expect(errors.join("")).toContain("quarantined Protocol v2 notify.signal dseq=1");
    await handle.close();
    await runtimeAdapters.close();
    await stateStore.close();
  });
});

describe("direct ClawChat interaction presentation", () => {
  it("delivers a runtime question without quoting the source private message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-binding-question-"));
    const stateStore = createStateStore({ dbPath: join(directory, "state.sqlite") });
    const config = defaultConfig();
    config.agents = { codex: pluginBinding() };
    const controller = new AbortController();
    const runtimeAdapters = new RuntimeAdapterRegistry([
      fixedRuntimeAdapter({
        kind: "codex",
        modes: [],
        start: async () => ({
          async *prompt(input) {
            if (!input.interactionPort || !input.metadata?.sessionRef || !input.turnId)
              throw new Error("missing turn context");
            await input.interactionPort.request(
              {
                kind: "user-input",
                title: "Question",
                description: "Choose",
                autoResolutionMs: null,
                questions: [
                  { id: "q", header: "Q", prompt: "Choose a color", secret: false, allowOther: true, options: null },
                ],
              },
              {
                sessionRef: input.metadata.sessionRef,
                turnId: input.turnId,
                origin: "clawchat",
                deliveryConfirmation: Promise.resolve(),
                signal: controller.signal,
              },
            );
            yield {
              id: "question-done",
              position: "1",
              parentId: null,
              kind: "assistant",
              text: "done",
              state: "complete",
              source: "live",
              data: { outputKind: "final" },
            };
          },
          cancel: async () => {
            controller.abort();
            return true;
          },
          close: async () => {
            controller.abort();
          },
        }),
      }),
    ]);
    const transport = new MemoryTransport();
    const starting = startBindingRuntime({
      agentId: "codex",
      activation: {
        localAgentId: "codex",
        accessToken: "token",
        refreshToken: null,
        serverAgentId: "agt_server",
        userId: "usr_alice",
        ownerUserId: "usr_owner",
        conversationId: "chat-owner",
      },
      config,
      configPath: join(directory, "config.json"),
      deviceId: "device-local",
      stateStore,
      workspaces: new WorkspaceCatalog(stateStore),
      runtimeAdapters,
      wsTransport: transport,
      clawChatApi: {
        getUserProfile: async () => ({ nickname: "Owner" }),
        getMyGroupSettings: async () => ({ authoritative: true, rows: [] }),
      } as never,
      verifyInstalledSkills: async () => undefined,
      writeError: () => undefined,
    });
    const handle = await completeBindingHandshake(transport, starting, "01JXYZ8K3MNPQRSTVWXYZ0AQ");
    try {
      transport.receive({
        version: "2",
        event: EVENT.MESSAGE_SEND,
        trace_id: "question-input",
        dseq: 1,
        emitted_at: Date.now(),
        chat_id: "chat-owner",
        chat_type: "direct",
        sender: { id: "usr_owner", type: "direct", nick_name: "Owner" },
        payload: {
          message_id: "source-private",
          message_mode: "normal",
          message: {
            body: { fragments: [{ kind: "text", text: "ask me" }] },
            context: { mentions: [], reply: null },
            streaming: { status: "static", sequence: 0, mutation_policy: "sealed" },
          },
        },
      });
      let question: Envelope | undefined;
      for (let attempt = 0; attempt < 100 && !question; attempt++) {
        await Bun.sleep(5);
        question = transport.sent.find(
          (e) => e.event === EVENT.MESSAGE_REPLY && JSON.stringify(e.payload).includes("Choose a color"),
        );
      }
      expect(question).toBeDefined();
      expect(question?.payload).toMatchObject({ message: { context: { reply: null } } });
    } finally {
      controller.abort();
      await handle.close();
      await runtimeAdapters.close();
      await stateStore.close();
    }
  });
});
