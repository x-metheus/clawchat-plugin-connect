import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReplyTextMessagePayload } from "../clawchat/message-mapper";
import {
  allowedRuntimeKinds,
  type MaterializedRuntimeReply,
  materializeRuntimeOutput,
  policyForOutputVisibility,
  resolveOutputVisibility,
} from "../clawchat/output-visibility";
import { EVENT, type Fragment, type NormalizedInboundMessage } from "../clawchat/protocol";
import type { ConnectWsClient } from "../clawchat/ws-client";
import type { MessageBlockContent } from "../client-contract";
import type { TranscriptProjection } from "../client-interface/transcript-projection";
import { defaultConfigPath, getAgentBinding } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import type {
  AgentBindingConfig,
  ConnectConfig,
  RuntimeSessionRecord,
  RuntimeWorkspace,
  WorkspaceRecord,
} from "../types";
import {
  createSessionContinuity,
  type SessionContinuity,
  SessionLifecycleError,
  type TurnTarget,
} from "../workspaces/session-continuity";
import type { RuntimeWorkspaceChoice } from "../workspaces/workspace-catalog";
import { synchronizeRuntimeWorkspaces } from "../workspaces/workspace-synchronizer";
import { WorkspaceCatalog } from "../workspaces/workspaces";
import type { ConnectExecutionCapabilities } from "./execution-capabilities";
import { MAX_RUNTIME_MEDIA_BYTES } from "./media-cache";
import { resolveModelSelection } from "./model-selection";
import { renderClawChatPrompt } from "./prompt-renderer";
import type { RuntimeAdapterRegistry } from "./registry";
import { type QueueStats, type SessionActivity, SessionQueue, type SessionQueueTicket } from "./session-queue";
import { SessionTurnExecutor } from "./session-turn-executor";
import { ClawChatTurnSurface, ClientTurnSurface, type ConnectTurnSurfaceCapabilities } from "./turn-surface";
import type {
  ConnectRuntimeMedia,
  QueuedClientTurn,
  RuntimeInteractionPort,
  RuntimeModelOption,
  RuntimeSlashSelection,
  SelectableRuntimeThread,
} from "./types";

export interface ConnectRuntimeOptions {
  agentId: string;
  config: ConnectConfig;
  configPath?: string;
  stateStore: ConnectStateStore;
  wsClient: ConnectWsClient;
  workspaces?: WorkspaceCatalog;
  sessionContinuity?: SessionContinuity;
  execution?: ConnectExecutionCapabilities;
  runtimeAdapters?: RuntimeAdapterRegistry;
  transcriptProjection?: TranscriptProjection;
  runtimeInteractions?: RuntimeInteractionPort;
  turnSurfaces?: ConnectTurnSurfaceCapabilities;
  resolveSenderDisplayName?: (senderId: string) => Promise<string | null>;
}

export class ConnectRuntime {
  private readonly typingTurns = new Map<string, number>();
  private readonly runtimeAdapters: RuntimeAdapterRegistry;
  private readonly workspaces: WorkspaceCatalog;
  private readonly sessionContinuity: SessionContinuity;
  private readonly transcriptProjection?: TranscriptProjection;
  private readonly ownsExecutor: boolean;
  private readonly executor: SessionTurnExecutor;
  private readonly activeTurnSessionChats = new Map<string, string>();
  private readonly acceptedClientTurnIds = new Map<string, string>();
  private readonly clientTurnTickets = new Map<string, { turn: QueuedClientTurn; ticket: SessionQueueTicket }>();
  private readonly routingTails = new Map<string, Promise<void>>();
  private readonly hydratedSenderIds = new Set<string>();
  private readonly queue: SessionQueue;

  constructor(private readonly options: ConnectRuntimeOptions) {
    getAgentBinding(options.config, options.agentId);
    const execution = options.execution;
    const runtimeAdapters = execution?.runtimeAdapters ?? options.runtimeAdapters;
    if (!runtimeAdapters) throw new Error("Runtime Adapter coordination is required");
    this.runtimeAdapters = runtimeAdapters;
    this.transcriptProjection = execution?.transcriptProjection ?? options.transcriptProjection;
    this.workspaces = options.workspaces ?? new WorkspaceCatalog(options.stateStore);
    this.sessionContinuity =
      options.sessionContinuity ??
      createSessionContinuity({
        stateStore: options.stateStore,
        resolveDefaultWorkspace: async (bindingId) => (await this.workspaces.ensureDefault(bindingId)).workspaceRef,
        resolveContinuationWorkspace: async (source, bindingId) => {
          if (source.agentId === bindingId && source.workspaceRef) return source.workspaceRef;
          const sourceWorkspace = source.workspaceRef
            ? await this.workspaces.get(source.agentId, source.workspaceRef)
            : null;
          const target = sourceWorkspace
            ? (await this.workspaces.list(bindingId)).find(
                (workspace) => resolve(workspace.rootPath) === resolve(sourceWorkspace.rootPath),
              )
            : null;
          return target?.workspaceRef ?? (await this.workspaces.ensureDefault(bindingId)).workspaceRef;
        },
      });
    const executorOptions = {
      configPath: options.configPath ?? defaultConfigPath(),
      stateDbPath: options.config.stateDbPath,
      bindingFor: (bindingId: string) => getAgentBinding(options.config, bindingId),
      attachRuntimeThread: async (sessionRef: string, runtimeThreadId: string | null) =>
        await this.sessionContinuity.forSession(sessionRef).attachRuntimeThread(runtimeThreadId),
    };
    this.executor =
      execution?.createSessionTurnExecutor(executorOptions) ??
      new SessionTurnExecutor({
        ...executorOptions,
        start: async (binding, context) => await this.runtimeAdapters.start(binding, context),
      });
    this.ownsExecutor = !execution;
    const queueOptions = {
      maxConcurrentTurns: options.config.maxConcurrentTurns,
      maxPendingPerSession: options.config.maxPendingPerSession,
      onStatsChange: async (stats: QueueStats) => await this.recordRuntimeStatus(stats),
    };
    this.queue = execution?.createSessionQueue(options.agentId, queueOptions) ?? new SessionQueue(queueOptions);
  }

  async handleInboundMessage(
    message: NormalizedInboundMessage,
    beforeTurn?: () => Promise<boolean>,
    orderedControl = false,
    onTurnAccepted?: () => Promise<void>,
  ): Promise<void> {
    message = await this.withResolvedSenderDisplayName(message);
    try {
      if (orderedControl) {
        await this.withRoutingGate(message.chatId, async () => {
          const selected = await this.options.stateStore.getCurrentRuntimeSession(message.chatId, this.options.agentId);
          const controlIdentity = selected
            ? sessionKey(selected.chatId, selected.sessionId)
            : pendingIntentKey(message.chatId, this.options.agentId);
          let handled = false;
          await this.queue.enqueue(
            controlIdentity,
            async () => {
              handled = (await beforeTurn?.()) ?? false;
            },
            selected ? `Session ${selected.sessionRef}` : "pending Session Intent",
          );
          if (!handled) {
            const current = await this.materializeCurrentSession(message.chatId);
            if (current.agentId !== this.options.agentId) {
              throw new SessionLifecycleError(
                "session-state-conflict",
                `Session ${current.sessionRef} belongs to a different Agent Binding`,
              );
            }
            await this.projectClawChatMessage(message, current);
            const ticket = await this.queue.submitAccepted(
              sessionKey(current.chatId, current.sessionId),
              async () => {
                await this.runTrackedTurn(message, current, onTurnAccepted);
              },
              async () => await this.acceptTurnTarget(current.sessionRef, current.agentId),
              `Session ${current.sessionRef}`,
            );
            await ticket.completion;
          }
        });
        return;
      }

      let completion: Promise<void> | null = null;
      await this.withRoutingGate(message.chatId, async () => {
        const current = await this.materializeCurrentSession(message.chatId);
        if (current.agentId !== this.options.agentId) {
          throw new SessionLifecycleError(
            "session-state-conflict",
            `Session ${current.sessionRef} belongs to a different Agent Binding`,
          );
        }
        await this.projectClawChatMessage(message, current);
        const key = sessionKey(current.chatId, current.sessionId);
        const ticket = await this.queue.submitAccepted(
          key,
          async () => {
            if (await beforeTurn?.()) return;
            await this.runTrackedTurn(message, current, onTurnAccepted);
          },
          async () => await this.acceptTurnTarget(current.sessionRef, current.agentId),
          `Session ${current.sessionRef}`,
        );
        completion = ticket.completion;
      });
      if (!completion) throw new Error("failed to enqueue Session turn");
      await completion;
    } catch (error) {
      await this.sendVisibleFailure(
        message,
        `ClawChat runtime turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async withResolvedSenderDisplayName(message: NormalizedInboundMessage): Promise<NormalizedInboundMessage> {
    const resolveDisplayName = this.options.resolveSenderDisplayName;
    if (!resolveDisplayName || (message.sender.nick_name && message.sender.nick_name !== message.sender.id)) {
      return message;
    }
    let displayName: string | null;
    try {
      displayName = (await resolveDisplayName(message.sender.id))?.trim() || null;
    } catch {
      return message;
    }
    if (!displayName || displayName === message.sender.id) return message;
    if (!this.hydratedSenderIds.has(message.sender.id)) {
      await this.options.stateStore.updateTranscriptSenderDisplayName(message.sender.id, displayName);
      this.hydratedSenderIds.add(message.sender.id);
    }
    return {
      ...message,
      sender: { ...message.sender, nick_name: displayName },
    };
  }

  async uploadClientMedia(file: Blob, filename: string): Promise<ConnectRuntimeMedia> {
    const fragment = await this.options.wsClient.uploadMedia(file, { filename });
    const record = fragment as Record<string, unknown>;
    if (!["image", "file", "audio", "video"].includes(fragment.kind) || typeof record.url !== "string") {
      throw new Error("ClawChat media upload returned an unsupported Fragment");
    }
    return {
      kind: fragment.kind as ConnectRuntimeMedia["kind"],
      url: record.url,
      name: typeof record.name === "string" ? record.name : filename,
      ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
      ...(typeof record.size === "number" ? { size: record.size } : {}),
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {}),
      ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
    };
  }

  async enqueueClientTurn(
    sessionRef: string,
    prompt: string,
    media: ConnectRuntimeMedia[] = [],
    selection: RuntimeSlashSelection | null = null,
    signal?: AbortSignal,
    requestedTurnId?: string,
  ): Promise<{ turnId: string; sessionRef: string }> {
    signal?.throwIfAborted();
    const text = prompt;
    if (!text.trim() && media.length === 0) throw new Error("prompt or media is required");
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    signal?.throwIfAborted();
    if (!current || current.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
    const target = await this.sessionContinuity.forSession(current.sessionRef).targetForTurn("client");
    signal?.throwIfAborted();
    if (target.bindingId !== this.options.agentId) {
      throw new SessionLifecycleError(
        "session-state-conflict",
        `Session ${current.sessionRef} belongs to a different Agent Binding`,
      );
    }
    const turnId = requestedTurnId?.trim() || randomUUID();
    const existing = this.clientTurnTickets.get(turnId);
    if (existing) {
      if (existing.turn.sessionRef !== current.sessionRef) throw new Error(`Turn ${turnId} belongs to another Session`);
      return { turnId, sessionRef: current.sessionRef };
    }
    const key = sessionKey(current.chatId, current.sessionId);
    let ticket: SessionQueueTicket;
    try {
      ticket = await this.queue.submitAccepted(
        key,
        async () => {
          this.activeTurnSessionChats.set(key, current.chatId);
          await this.recordRuntimeStatus(this.queue.stats());
          try {
            await this.runClientTurn(target, text, turnId, media, selection);
          } finally {
            this.activeTurnSessionChats.delete(key);
            await this.recordRuntimeStatus(this.queue.stats());
          }
        },
        async () => {
          signal?.throwIfAborted();
          await this.acceptTurnTarget(current.sessionRef, target.bindingId);
        },
        `Session ${current.sessionRef}`,
      );
    } catch (error) {
      if (error instanceof SessionLifecycleError) throw error;
      throw new SessionLifecycleError(
        "session-state-conflict",
        error instanceof Error ? error.message : `Session ${current.sessionRef} cannot accept another Turn`,
      );
    }
    const turn: QueuedClientTurn = {
      turnId,
      sessionRef: current.sessionRef,
      prompt: text,
      selection,
      attachments: media.map((item) => ({ name: item.name ?? "附件" })),
      createdAt: new Date().toISOString(),
    };
    this.clientTurnTickets.set(turnId, { turn, ticket });
    this.acceptedClientTurnIds.set(current.sessionRef, turnId);
    void ticket.completion
      .catch(() => undefined)
      .finally(() => {
        this.clientTurnTickets.delete(turnId);
        if (this.acceptedClientTurnIds.get(current.sessionRef) === turnId) {
          this.acceptedClientTurnIds.delete(current.sessionRef);
        }
      });
    return { turnId, sessionRef: current.sessionRef };
  }

  queuedClientTurns(sessionRef: string): QueuedClientTurn[] {
    const normalized = sessionRef.toUpperCase();
    return [...this.clientTurnTickets.values()]
      .filter(({ turn, ticket }) => turn.sessionRef.toUpperCase() === normalized && ticket.state === "queued")
      .map(({ turn }) => turn)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  cancelQueuedClientTurn(sessionRef: string, turnId: string): boolean {
    const queued = this.clientTurnTickets.get(turnId);
    if (!queued || queued.turn.sessionRef.toUpperCase() !== sessionRef.toUpperCase()) return false;
    const cancelled = queued.ticket.cancel();
    if (cancelled) this.clientTurnTickets.delete(turnId);
    return cancelled;
  }

  async cancelClientTurn(sessionRef: string): Promise<boolean> {
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    if (!current || current.agentId !== this.options.agentId) return false;
    return await this.executor.cancel(current.sessionRef);
  }

  async sessionActivity(sessionRef: string): Promise<SessionActivity> {
    const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
    if (!current) {
      const target = await this.options.stateStore.getSessionRefTarget(sessionRef);
      if (!target || target.agentId !== this.options.agentId) return "idle";
      return this.queue.activity(`discovered:${sessionRef.toUpperCase()}`);
    }
    if (current.agentId !== this.options.agentId) return "idle";
    return this.queue.activity(sessionKey(current.chatId, current.sessionId));
  }

  activeClientTurnId(sessionRef: string): string | null {
    return this.acceptedClientTurnIds.get(sessionRef.toUpperCase()) ?? null;
  }

  async claimSessionLifecycle(sessionRef: string): Promise<() => Promise<void>> {
    try {
      const current = await this.options.stateStore.getRuntimeSessionByRef(sessionRef);
      if (!current) {
        const target = await this.options.stateStore.getSessionRefTarget(sessionRef);
        if (!target || target.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
        return await this.queue.acquire(`discovered:${sessionRef.toUpperCase()}`, `Session ${sessionRef}`);
      }
      if (current.agentId !== this.options.agentId) throw new Error(`Unknown Session Ref: ${sessionRef}`);
      const key = sessionKey(current.chatId, current.sessionId);
      return await this.queue.acquire(
        key,
        `Session ${current.sessionRef}`,
        async () => {
          await this.executor.cancel(current.sessionRef);
        },
        async () => {
          await this.executor.release(current.sessionRef);
        },
      );
    } catch (error) {
      if (error instanceof SessionLifecycleError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/^Unknown Session Ref:/u.test(message)) {
        throw new SessionLifecycleError("session-not-found", message);
      }
      if (/lifecycle operation is in progress/iu.test(message)) {
        throw new SessionLifecycleError("session-state-conflict", message);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.ownsExecutor) await this.executor.close();
  }

  async closeSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, false);
  }

  async invalidateSession(chatId: string): Promise<boolean> {
    return await this.releaseSession(chatId, true);
  }

  async cancelTurn(chatId: string): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    const sessionRef = current?.sessionRef;
    return sessionRef ? await this.executor.cancel(sessionRef) : false;
  }

  runtimeModesFor(
    binding: AgentBindingConfig,
    selected?: RuntimeSessionRecord | import("../types").SessionIntentRecord | null,
  ): readonly string[] {
    return this.runtimeAdapters.modesFor(binding, {
      runtimeThreadId:
        selected && "runtimeSessionId" in selected ? (selected.runtimeSessionId ?? undefined) : undefined,
    });
  }
  runtimeFamilyFor(binding: AgentBindingConfig): string {
    return this.runtimeAdapters.familyFor(binding);
  }

  async listRuntimeModels(
    binding: AgentBindingConfig,
    selected?: RuntimeSessionRecord | import("../types").SessionIntentRecord | null,
  ): Promise<RuntimeModelOption[] | null> {
    const runtimeSession = selected && "runtimeSessionId" in selected ? selected : null;
    return await this.runtimeAdapters.listModels(binding, {
      runtimeThreadId: runtimeSession?.runtimeSessionId ?? undefined,
      workspace: runtimeSession ? await this.workspaces.resolveWorkspace(runtimeSession) : undefined,
    });
  }

  async listRuntimeWorkspaces(): Promise<RuntimeWorkspaceChoice[]> {
    const { workspaces } = await this.synchronizeRuntimeWorkspaces();
    return workspaces
      .map((workspace) => ({
        workspaceRef: workspace.workspaceRef,
        name: workspace.name,
        rootPath: workspace.rootPath,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.rootPath.localeCompare(right.rootPath));
  }

  async synchronizeRuntimeWorkspaces(): Promise<{
    workspaces: WorkspaceRecord[];
    failures: string[];
  }> {
    const binding = getAgentBinding(this.options.config, this.options.agentId);
    return await synchronizeRuntimeWorkspaces({
      bindingId: this.options.agentId,
      snapshot: await this.runtimeAdapters.discoverWorkspaces(binding),
      workspaces: this.workspaces,
    });
  }

  async discoverRuntimeThreads(chatId: string): Promise<SelectableRuntimeThread[]> {
    const intent = await this.options.stateStore.getSessionIntent(chatId, this.options.agentId);
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (!intent && !current) return [];
    if (intent && !intent.workspaceRef) return [];
    const binding = getAgentBinding(this.options.config, current?.agentId || intent?.agentId || this.options.agentId);
    const workspace = intent?.workspaceRef
      ? await this.workspaces.resolveWorkspaceRef(intent.agentId, intent.workspaceRef)
      : current
        ? await this.workspaces.resolveWorkspace(current)
        : null;
    if (!workspace) return [];
    const sessions = await this.options.stateStore.listRuntimeSessions(chatId, this.options.agentId);
    const discovery = await this.runtimeAdapters.discoverThreads(binding, workspace);
    const discovered = discovery.threads.filter((thread) => thread.adoption.status === "available");
    const discoveriesById = new Map(discovered.map((thread) => [thread.runtimeThreadId, thread]));
    await Promise.all(
      sessions.map(async (session) => {
        if (session.name || !session.runtimeSessionId) return;
        const name = discoveriesById.get(session.runtimeSessionId)?.name;
        if (name)
          await this.options.stateStore.setRuntimeSessionName(chatId, this.options.agentId, session.sessionId, name);
      }),
    );
    const managed = new Set(
      sessions.map((session) => session.runtimeSessionId).filter((id): id is string => Boolean(id)),
    );
    return await Promise.all(
      discovered
        .filter((thread) => !managed.has(thread.runtimeThreadId))
        .map(async ({ adoption: _adoption, ...thread }) => ({
          ...thread,
          sessionRef: await this.options.stateStore.getOrCreateSessionRef({
            chatId,
            agentId: this.options.agentId,
            runtimeSessionId: thread.runtimeThreadId,
          }),
        })),
    );
  }

  private async releaseSession(chatId: string, invalidateRuntimeId: boolean): Promise<boolean> {
    const current = await this.options.stateStore.getCurrentRuntimeSession(chatId, this.options.agentId);
    if (!current) return false;
    const released = invalidateRuntimeId
      ? await this.executor.invalidate(current.sessionRef)
      : await this.executor.release(current.sessionRef);
    return released || Boolean(current.runtimeSessionId);
  }

  private async runTurn(
    message: NormalizedInboundMessage,
    current: RuntimeSessionRecord,
    onTurnAccepted?: () => Promise<void>,
  ): Promise<void> {
    const activeAgentId = current.agentId || this.options.agentId;
    const workspace = await this.workspaces.resolveWorkspace(current);
    const model = await this.modelFor(current, activeAgentId, workspace);
    const target = await this.sessionContinuity.forSession(current.sessionRef).targetForTurn("clawchat");
    const mode = await resolveOutputVisibility({
      config: this.options.config,
      store: this.options.stateStore,
      bindingId: activeAgentId,
      chatId: message.chatId,
    });
    const policy = policyForOutputVisibility(mode);
    const surface =
      this.options.turnSurfaces?.createClawChat({
        sessionRef: current.sessionRef,
        noReplyProtocol: message.chatType === "group",
        materialize: (event) => materializeRuntimeOutput(event, policy),
        deliver: async (event, reply) => {
          const delivery = await this.sendReply(message, reply, workspace);
          if (delivery?.media.length) {
            await this.transcriptProjection?.applyRuntimeDelivery(current.sessionRef, event, delivery);
          }
        },
      }) ??
      new ClawChatTurnSurface({
        noReplyProtocol: message.chatType === "group",
        project: async (event) => {
          await this.transcriptProjection?.upsertRuntimeActivity(current.sessionRef, event);
        },
        materialize: (event) => materializeRuntimeOutput(event, policy),
        deliver: async (event, reply) => {
          const delivery = await this.sendReply(message, reply, workspace);
          if (delivery?.media.length) {
            await this.transcriptProjection?.applyRuntimeDelivery(current.sessionRef, event, delivery);
          }
        },
      });
    const runtimeInteractions = this.options.runtimeInteractions;
    for await (const event of this.executor.execute(target, {
      prompt: renderClawChatPrompt(message),
      media: runtimeMedia(message),
      trustedMediaOrigins: configuredMediaOrigins(this.options.config),
      workspace,
      mode: current.mode ?? undefined,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      sessionOptions: {
        ...(getAgentBinding(this.options.config, activeAgentId).sessionOptions ?? {}),
        ...(current.sessionOptions ?? {}),
      },
      turnId: message.messageId,
      interactionPort: runtimeInteractions
        ? {
            request: async (request, context) =>
              await runtimeInteractions.request(request, {
                ...context,
                clawchat: {
                  chatId: message.chatId,
                  chatType: message.chatType,
                  sourceMessageId: message.messageId,
                  sourceSender: {
                    id: message.sender.id,
                    displayName: message.sender.nick_name || message.sender.id,
                  },
                  sourceFragments: message.replyAnchorFragments ?? message.fragments,
                },
              }),
          }
        : undefined,
      onAccepted: onTurnAccepted,
      metadata: {
        sessionRef: current.sessionRef,
        chatId: message.chatId,
        sessionId: current.sessionId,
        agentId: activeAgentId,
        workspaceRef: target.workspaceRef,
      },
      outputPolicy: { mode: policy.mode, allowedKinds: allowedRuntimeKinds(policy) },
    })) {
      await surface.accept(event);
    }
    await surface.complete();
  }

  private async runClientTurn(
    target: TurnTarget,
    prompt: string,
    turnId: string,
    media: ConnectRuntimeMedia[],
    selection: RuntimeSlashSelection | null,
  ): Promise<void> {
    const current = runtimeSessionFromTurnTarget(target);
    const activeAgentId = target.bindingId || this.options.agentId;
    const workspace = await this.workspaces.resolveWorkspace(current);
    const model = await this.modelFor(current, activeAgentId, workspace);
    await this.transcriptProjection?.appendUserMessage({
      sessionRef: current.sessionRef,
      text: prompt,
      origin: "client",
      author: "You",
      id: `turn_${turnId}_user`,
      media: media.map((item) => ({
        kind: item.kind,
        url: item.url,
        name: item.name ?? null,
        mime: item.mime ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
      })),
    });
    const surface =
      this.options.turnSurfaces?.createClient({ sessionRef: current.sessionRef }) ??
      new ClientTurnSurface({
        project: async (event) => {
          await this.transcriptProjection?.upsertRuntimeActivity(current.sessionRef, event);
        },
      });
    try {
      for await (const event of this.executor.execute(target, {
        prompt,
        ...(selection?.kind === "skill" ? { skill: selection } : {}),
        ...(selection?.kind === "command" ? { command: selection } : {}),
        media,
        trustedMediaOrigins: configuredMediaOrigins(this.options.config),
        workspace,
        mode: current.mode ?? undefined,
        model: model.model,
        reasoningEffort: model.reasoningEffort,
        sessionOptions: {
          ...(getAgentBinding(this.options.config, activeAgentId).sessionOptions ?? {}),
          ...(current.sessionOptions ?? {}),
        },
        turnId,
        interactionPort: this.options.runtimeInteractions,
        metadata: {
          sessionRef: current.sessionRef,
          origin: "client",
          turnId,
          chatId: current.chatId,
          sessionId: current.sessionId,
          agentId: activeAgentId,
          workspaceRef: target.workspaceRef,
        },
        outputPolicy: {
          mode: "client-full",
          allowedKinds: ["final", "assistant", "tool", "progress", "reasoning", "control"],
        },
      })) {
        await surface.accept(event);
      }
      await surface.complete();
    } catch (error) {
      await surface.fail(error);
    }
  }

  private async recordRuntimeStatus(stats: QueueStats): Promise<void> {
    await this.options.stateStore.upsertRuntimeStatus({
      websocketConnected: true,
      activeAgent: this.options.agentId,
      activeChats: new Set(this.activeTurnSessionChats.values()).size,
      globalRunning: this.activeTurnSessionChats.size,
      globalQueued: stats.queued,
      recentError: null,
    });
  }

  private async sendVisibleFailure(message: NormalizedInboundMessage, text: string): Promise<void> {
    await this.sendReply(message, { text, requiredControl: false });
  }

  private async sendReply(
    message: NormalizedInboundMessage,
    reply: MaterializedRuntimeReply,
    workspace?: RuntimeWorkspace,
  ): Promise<DeliveredReplyProjection | null> {
    const route = { chatId: message.chatId, chatType: message.chatType };
    const localMedia = workspace
      ? await resolveLocalReplyMedia(reply.text, this.options.config.stateDbPath, workspace)
      : { text: reply.text, files: [] };
    const payload = buildReplyTextMessagePayload(localMedia.text, message);
    for (const file of localMedia.files) {
      payload.message.body.fragments.push(
        await this.options.wsClient.uploadMedia(Bun.file(file.path), { filename: file.filename }),
      );
    }
    if (payload.message.body.fragments.length === 0) return null;
    await this.options.wsClient.sendMessageEnvelope(EVENT.MESSAGE_REPLY, route.chatId, payload, {
      toType: route.chatType,
    });
    return {
      text: localMedia.text,
      media: transcriptMediaFromFragments(payload.message.body.fragments),
    };
  }

  private async materializeCurrentSession(chatId: string): Promise<RuntimeSessionRecord> {
    const target = await this.sessionContinuity
      .inConversation({ chatId, bindingId: this.options.agentId })
      .targetForOrdinaryTurn("clawchat");
    return runtimeSessionFromTurnTarget(target);
  }

  private async acceptTurnTarget(sessionRef: string, bindingId: string): Promise<void> {
    if (bindingId !== this.options.agentId) {
      throw new SessionLifecycleError(
        "session-state-conflict",
        `Session ${sessionRef} belongs to a different Agent Binding`,
      );
    }
    const accepted = await this.options.stateStore.acceptSessionTurn({
      sessionRef,
      bindingId: this.options.agentId,
    });
    if (!accepted) {
      throw new SessionLifecycleError(
        "session-state-conflict",
        `Session ${sessionRef} Agent Binding changed before the Turn was accepted`,
      );
    }
  }

  private async projectClawChatMessage(
    message: NormalizedInboundMessage,
    current: RuntimeSessionRecord,
  ): Promise<void> {
    await this.transcriptProjection?.appendUserMessage({
      sessionRef: current.sessionRef,
      text: message.text,
      origin: "clawchat",
      author: message.sender.nick_name || message.sender.id,
      sender: {
        id: message.sender.id,
        displayName: message.sender.nick_name || null,
      },
      conversationType: message.chatType,
      id: message.messageId || undefined,
      media: transcriptMedia(message),
    });
  }

  private async runTrackedTurn(
    message: NormalizedInboundMessage,
    current: RuntimeSessionRecord,
    onTurnAccepted?: () => Promise<void>,
  ): Promise<void> {
    const key = sessionKey(current.chatId, current.sessionId);
    this.activeTurnSessionChats.set(key, current.chatId);
    await this.recordRuntimeStatus(this.queue.stats());
    // Typing is transient: a disconnect must not fail or cancel the actual turn.
    const sendTyping = (active: boolean) => {
      try {
        this.options.wsClient.sendTyping?.(message.chatId, active, { toType: message.chatType });
      } catch {}
    };
    this.typingTurns.set(message.chatId, (this.typingTurns.get(message.chatId) ?? 0) + 1);
    sendTyping(true);
    const typingHeartbeat = setInterval(() => sendTyping(true), 5_000);
    typingHeartbeat.unref();
    try {
      await this.runTurn(message, current, onTurnAccepted);
    } finally {
      clearInterval(typingHeartbeat);
      const remaining = (this.typingTurns.get(message.chatId) ?? 1) - 1;
      if (remaining > 0) this.typingTurns.set(message.chatId, remaining);
      else {
        this.typingTurns.delete(message.chatId);
        sendTyping(false);
      }
      this.activeTurnSessionChats.delete(key);
      await this.recordRuntimeStatus(this.queue.stats());
    }
  }

  private async withRoutingGate<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.routingTails.get(chatId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await current);
    this.routingTails.set(chatId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release?.();
      if (this.routingTails.get(chatId) === tail) this.routingTails.delete(chatId);
    }
  }

  private async modelFor(current: RuntimeSessionRecord, agentId: string, workspace: RuntimeWorkspace) {
    const binding = getAgentBinding(this.options.config, agentId);
    if (this.runtimeAdapters.familyFor(binding) === "opencode") return { model: undefined, reasoningEffort: undefined };
    return resolveModelSelection(
      binding,
      current,
      await this.runtimeAdapters.listModels(binding, {
        runtimeThreadId: current.runtimeSessionId ?? undefined,
        workspace,
      }),
    );
  }
}

function runtimeSessionFromTurnTarget(target: TurnTarget): RuntimeSessionRecord {
  return {
    chatId: target.chatId,
    sessionId: target.sessionId,
    sessionRef: target.sessionRef,
    agentId: target.bindingId,
    runtimeSessionId: target.runtimeThreadId,
    workspaceRef: target.workspaceRef,
    name: target.name,
    mode: target.mode,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
    sessionOptions: target.sessionOptions,
    hasMessages: true,
    isCurrent: true,
    updatedAt: Date.now(),
  };
}

interface LocalReplyMediaFile {
  path: string;
  filename: string;
}

interface DeliveredReplyProjection {
  text: string;
  media: NonNullable<MessageBlockContent["media"]>;
}

const LOCAL_MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu;

async function resolveLocalReplyMedia(
  text: string,
  stateDbPath: string,
  workspace: RuntimeWorkspace,
): Promise<{ text: string; files: LocalReplyMediaFile[] }> {
  const roots = await Promise.all(
    [join(dirname(stateDbPath), "media-cache"), workspace.workingDirectory].map(
      async (root) => await realpath(root).catch(() => null),
    ),
  );
  const files: LocalReplyMediaFile[] = [];
  const seen = new Set<string>();
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(LOCAL_MARKDOWN_IMAGE_PATTERN)) {
    const index = match.index;
    const reference = match[1] ?? match[2] ?? "";
    const path = await resolveSafeLocalMediaPath(reference, workspace.workingDirectory, roots);
    result += text.slice(cursor, index);
    if (!path) {
      result += match[0];
    } else if (!(await isSupportedImageFile(path))) {
      result += match[0];
    } else if (!seen.has(path)) {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size <= 0) throw new Error(`Runtime media file is empty or invalid: ${path}`);
      if (metadata.size > MAX_RUNTIME_MEDIA_BYTES) {
        throw new Error(`Runtime media file exceeds the ${MAX_RUNTIME_MEDIA_BYTES}-byte upload limit: ${path}`);
      }
      seen.add(path);
      files.push({ path, filename: basename(path) });
    }
    cursor = index + match[0].length;
  }
  result += text.slice(cursor);
  return { text: result.trim(), files };
}

async function isSupportedImageFile(path: string): Promise<boolean> {
  const extension = extname(path).toLowerCase();
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (extension === ".png") {
      return (
        bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    }
    if (extension === ".jpg" || extension === ".jpeg") {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (extension === ".gif") {
      const signature = bytes.subarray(0, 6).toString("ascii");
      return signature === "GIF87a" || signature === "GIF89a";
    }
    if (extension === ".webp") {
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    }
    return false;
  } finally {
    await handle.close();
  }
}

function configuredMediaOrigins(config: ConnectConfig): string[] {
  const origins = new Set<string>(["https://media.clawling.chat"]);
  for (const value of [config.baseUrl, config.mediaUploadUrl]) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Endpoint validation reports malformed URLs at their owning transport boundary.
    }
  }
  return [...origins];
}

async function resolveSafeLocalMediaPath(
  reference: string,
  workingDirectory: string,
  roots: Array<string | null>,
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = reference.startsWith("file:") ? fileURLToPath(reference) : decodeURIComponent(reference);
  } catch {
    return null;
  }
  const candidate = await realpath(isAbsolute(decoded) ? decoded : resolve(workingDirectory, decoded)).catch(
    () => null,
  );
  if (!candidate) return null;
  return roots.some((root) => root && pathIsWithin(candidate, root)) ? candidate : null;
}

function pathIsWithin(candidate: string, root: string): boolean {
  const nested = relative(root, candidate);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function sessionKey(chatId: string, sessionId: string): string {
  return `${chatId}:${sessionId}`;
}

function pendingIntentKey(chatId: string, agentId: string): string {
  return `pending:${chatId}:${agentId}`;
}

function runtimeMedia(message: NormalizedInboundMessage): ConnectRuntimeMedia[] {
  return message.fragments.flatMap((fragment) => {
    if (fragment.kind !== "image" && fragment.kind !== "file" && fragment.kind !== "audio" && fragment.kind !== "video")
      return [];
    const record = fragment as Record<string, unknown>;
    if (typeof record.url !== "string" || !record.url) return [];
    return [
      {
        kind: fragment.kind,
        url: record.url,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
        ...(typeof record.size === "number" ? { size: record.size } : {}),
        ...(typeof record.width === "number" ? { width: record.width } : {}),
        ...(typeof record.height === "number" ? { height: record.height } : {}),
        ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
      },
    ];
  });
}

function transcriptMedia(message: NormalizedInboundMessage): import("../client-contract").MessageBlockContent["media"] {
  return transcriptMediaFromFragments(message.fragments);
}

function transcriptMediaFromFragments(fragments: readonly Fragment[]): NonNullable<MessageBlockContent["media"]> {
  return fragments.flatMap((fragment) => {
    if (!["image", "file", "audio", "video"].includes(fragment.kind)) return [];
    const record = fragment as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    if (!url) return [];
    return [
      {
        kind: fragment.kind as "image" | "file" | "audio" | "video",
        url,
        name: typeof record.name === "string" ? record.name : null,
        mime: typeof record.mime === "string" ? record.mime : null,
        width: typeof record.width === "number" ? record.width : null,
        height: typeof record.height === "number" ? record.height : null,
      },
    ];
  });
}
