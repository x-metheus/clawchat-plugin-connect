import { executeAgentLiveware, isAgentLivewareOperation } from "../agent/agent-liveware";
import { verifyInstalledSkills } from "../agent/skills";
import { executeConnectTool } from "../agent/tool-executor";
import { type ClawChatApiClient, createClawChatApiClient } from "../clawchat/api-client";
import { handleChatCommand, isConnectControlMessage, requiresOrderedSessionControl } from "../clawchat/chat-commands";
import { type GroupDispatchMode, type GroupIntakeClock, GroupIntakeCoordinator } from "../clawchat/group-intake";
import { inboundContentDigest } from "../clawchat/inbound-identity";
import {
  type AddressedInboundMessage,
  addressInboundMessage,
  buildReplyTextMessagePayload,
  buildTextMessagePayload,
  normalizeInboundMessage,
} from "../clawchat/message-mapper";
import { type Envelope, EVENT, type NormalizedInboundMessage, type Transport } from "../clawchat/protocol";
import { ConnectWsClient } from "../clawchat/ws-client";
import type { TranscriptProjection } from "../client-interface/transcript-projection";
import { getAgentBinding } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import { ConnectBindingLivewarePublicationStateStore } from "../plugin/official/liveware-publication-state";
import { ConnectRuntime } from "../runtime/connect-runtime";
import type { ConnectExecutionCapabilities } from "../runtime/execution-capabilities";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { RuntimeInteractionCoordinator } from "../runtime/runtime-interaction-coordinator";
import { RuntimeInteractionRouter } from "../runtime/runtime-interaction-router";
import type { SessionActivity } from "../runtime/session-queue";
import type { ConnectTurnSurfaceCapabilities } from "../runtime/turn-surface";
import {
  type ConnectRuntimeMedia,
  type QueuedClientTurn,
  type RuntimeInputReceiptSnapshot,
  type RuntimeSlashSelection,
  runtimeInputIdentityContains,
} from "../runtime/types";
import {
  type WorkBuddyCapabilityFailure,
  workBuddyCapabilityAvailability,
  workBuddyCapabilityFailure,
} from "../runtime/workbuddy-availability";
import type { ActivationCredentials, ConnectConfig } from "../types";
import {
  createSessionContinuity,
  type SessionContinuity,
  type SessionContinuityModule,
} from "../workspaces/session-continuity";
import type { WorkspaceCatalog } from "../workspaces/workspaces";

const DEFAULT_RUNTIME_PREPARATION_RETRY_MS = 5_000;

export interface BindingRuntimeOptions {
  agentId: string;
  activation: ActivationCredentials;
  config: ConnectConfig;
  configPath: string;
  deviceId: string;
  stateStore: ConnectStateStore;
  workspaces: WorkspaceCatalog;
  sessionContinuityModule?: SessionContinuityModule;
  execution?: ConnectExecutionCapabilities;
  runtimeAdapters?: RuntimeAdapterRegistry;
  transcriptProjection?: TranscriptProjection;
  runtimeInteractions?: RuntimeInteractionCoordinator;
  turnSurfaces?: ConnectTurnSurfaceCapabilities;
  wsTransport?: Transport;
  clawChatApi?: ClawChatApiClient;
  groupIntakeClock?: GroupIntakeClock;
  protocolEventHandlers?: BindingProtocolEventHandlers;
  runtimePreparationRetryMs?: number;
  verifyInstalledSkills?: () => Promise<void>;
  writeError: (message: string) => void;
}

export type BindingProtocolEventType =
  | "stream"
  | "typing"
  | "presence"
  | "delivered"
  | "metadata_invalidated"
  | "notify"
  | "permission"
  | "history_transit"
  | "replay_done"
  | "message_error"
  | "unknown";

export type BindingProtocolEvent =
  | {
      [Type in BindingProtocolEventType]: { type: Type; envelope: Envelope };
    }[BindingProtocolEventType]
  | { type: "quarantined"; envelope: Envelope; error: string };

export type BindingProtocolEventHandlers = {
  [Type in BindingProtocolEvent["type"]]?: (
    event: Extract<BindingProtocolEvent, { type: Type }>,
  ) => void | Promise<void>;
};

export interface BindingRuntimeHandle {
  agentId: string;
  websocketUrl: string;
  deviceId: string;
  close(): Promise<void>;
  enqueueClientTurn?(
    sessionRef: string,
    prompt: string,
    media?: ConnectRuntimeMedia[],
    selection?: RuntimeSlashSelection | null,
    signal?: AbortSignal,
    turnId?: string,
  ): Promise<{ turnId: string; sessionRef: string }>;
  uploadClientMedia?(file: Blob, filename: string): Promise<ConnectRuntimeMedia>;
  cancelClientTurn?(sessionRef: string): Promise<boolean>;
  queuedClientTurns?(sessionRef: string): QueuedClientTurn[];
  cancelQueuedClientTurn?(sessionRef: string, turnId: string): boolean;
  sessionActivity?(sessionRef: string): Promise<SessionActivity>;
  activeClientTurnId?(sessionRef: string): string | null;
  claimSessionLifecycle?(sessionRef: string): Promise<() => Promise<void>>;
  executeTool?(toolName: string, input: Record<string, unknown>): Promise<unknown>;
}

export async function startBindingRuntime(options: BindingRuntimeOptions): Promise<BindingRuntimeHandle> {
  await resetRuntimeStatus(options);
  await (options.verifyInstalledSkills ?? verifyInstalledSkills)();
  const binding = getAgentBinding(options.config, options.agentId);
  const execution = options.execution;
  const runtimeAdapters = execution?.runtimeAdapters ?? options.runtimeAdapters;
  if (!runtimeAdapters) throw new Error("Runtime Adapter coordination is required");
  const workBuddyRuntime = runtimeAdapters.familyFor(binding) === "workbuddy";
  const transcriptProjection = execution?.transcriptProjection ?? options.transcriptProjection;
  const runtimeInteractions = execution?.runtimeInteractions ?? options.runtimeInteractions;
  const runtimeConfig: ConnectConfig = {
    ...options.config,
    agents: { ...options.config.agents, [options.agentId]: binding },
  };
  const clawChatApi =
    options.clawChatApi ??
    createClawChatApiClient({
      baseUrl: options.config.baseUrl,
      deviceId: options.deviceId,
      token: options.activation.accessToken,
    });
  const senderDisplayNames = new Map<string, Promise<string | null>>();
  const resolveSenderDisplayName = async (senderId: string): Promise<string | null> => {
    const active = senderDisplayNames.get(senderId);
    if (active) return await active;
    const resolution = clawChatApi
      .getUserProfile(senderId)
      .then((profile) => profile.nickname)
      .catch(() => {
        senderDisplayNames.delete(senderId);
        return null;
      });
    senderDisplayNames.set(senderId, resolution);
    return await resolution;
  };
  const continuityOptions = {
    resolveDefaultWorkspace: async (bindingId: string) =>
      (await options.workspaces.ensureDefault(bindingId)).workspaceRef,
  };
  const sessionContinuity =
    options.sessionContinuityModule?.create(continuityOptions) ??
    createSessionContinuity({ ...continuityOptions, stateStore: options.stateStore });
  let runtime: ConnectRuntime;
  let inboundMessages: InboundMessageProcessor;
  let wsClient: ConnectWsClient;
  let interactionRouter: RuntimeInteractionRouter;
  let groupIntake: GroupIntakeCoordinator;
  let runtimeWorkspaceSynchronization = Promise.resolve();
  let runtimeStartupUnavailableDetail: string | null = null;
  let runtimePreparationRetryable = false;
  let runtimeWorkspaceSynchronizationStarted = false;
  let runtimePreparationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimePreparationRetryTask: Promise<void> | null = null;
  let runtimeClosing = false;
  let runtimeShutdown: Promise<void> | null = null;
  const recordRuntimeConnectionStatus = async (
    websocketConnected: boolean,
    recentError: string | null,
  ): Promise<void> => {
    await recordConnectionStatus(options, websocketConnected, recentError);
    if (runtimeStartupUnavailableDetail) {
      await options.stateStore.setRuntimeAvailability(
        options.agentId,
        "startup-unavailable",
        runtimeStartupUnavailableDetail,
      );
    }
  };
  wsClient = new ConnectWsClient({
    agentId: options.agentId,
    url: options.config.websocketUrl,
    mediaUploadUrl: options.config.mediaUploadUrl,
    token: options.activation.accessToken,
    userId: options.activation.userId,
    userNickName: options.agentId,
    stateStore: options.stateStore,
    deviceId: options.deviceId,
    transport: options.wsTransport,
    messageHandler: (message) => inboundMessages.accept(message),
    interactionSubmitHandler: async (envelope) => await interactionRouter.handleInteractionSubmit(envelope),
    protocolEventHandler: async (type, envelope) => {
      if (type === "notify") {
        try {
          await groupIntake.handleNotifySignal(envelope);
        } catch (error) {
          options.writeError(
            `${options.agentId}: group settings notification failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          throw error;
        }
      }
      await dispatchProtocolEventHandler(options, type, envelope);
    },
    capabilities: {
      chatMetadataEvents: Boolean(options.protocolEventHandlers?.metadata_invalidated),
      notifySignals: true,
      permissionEvents: Boolean(options.protocolEventHandlers?.permission),
      historySync: Boolean(options.protocolEventHandlers?.history_transit),
    },
  });
  interactionRouter = new RuntimeInteractionRouter({
    clientInteractions: runtimeInteractions,
    ownerUserId: options.activation.ownerUserId,
    ownerConversationId: options.activation.conversationId,
    agentUserId: options.activation.userId,
    agentDisplayName: options.agentId,
    resolveSenderDisplayName,
    sendClawChatMessage: async (delivery) => {
      const payload = buildTextMessagePayload(
        "",
        delivery.chatType === "group" && delivery.sourceMessageId
          ? {
              replyToMessageId: delivery.sourceMessageId,
              replyPreview:
                delivery.sourceSender && delivery.sourceFragments
                  ? {
                      id: delivery.sourceSender.id,
                      nickName: delivery.sourceSender.displayName,
                      fragments: delivery.sourceFragments,
                    }
                  : null,
            }
          : {},
      );
      payload.message.body.fragments = delivery.fragments;
      payload.message.context.mentions = delivery.fragments.flatMap((fragment) => {
        if (fragment.kind !== "mention" || !fragment.user_id) return [];
        return [
          {
            user_id: fragment.user_id,
            ...(fragment.display ? { display: fragment.display } : {}),
          },
        ];
      });
      await wsClient.sendMessageEnvelope(EVENT.MESSAGE_REPLY, delivery.chatId, payload, { toType: delivery.chatType });
    },
  });
  runtime = new ConnectRuntime({
    agentId: options.agentId,
    config: runtimeConfig,
    configPath: options.configPath,
    stateStore: options.stateStore,
    wsClient,
    workspaces: options.workspaces,
    sessionContinuity,
    execution,
    runtimeAdapters: execution ? undefined : runtimeAdapters,
    transcriptProjection: execution ? undefined : transcriptProjection,
    runtimeInteractions: interactionRouter,
    turnSurfaces: options.turnSurfaces,
    resolveSenderDisplayName,
  });
  groupIntake = new GroupIntakeCoordinator({
    bindingId: options.agentId,
    agentUserId: options.activation.userId,
    stateStore: options.stateStore,
    api: clawChatApi,
    writeError: options.writeError,
    clock: options.groupIntakeClock,
    reject: async (message, reason) => {
      await wsClient.sendMessageEnvelope(
        EVENT.MESSAGE_REPLY,
        message.chatId,
        buildReplyTextMessagePayload(reason, message),
        { toType: message.chatType },
      );
    },
    dispatch: async (message, groupDispatchMode, onTurnAccepted) =>
      await dispatchInboundMessage({
        ...options,
        message,
        wsClient,
        runtime,
        interactionRouter,
        sessionContinuity,
        onTurnAccepted,
        groupDispatchMode,
      }),
  });
  void groupIntake
    .initialize()
    .then(() => groupIntake.refreshInBackground())
    .catch((error) =>
      options.writeError(
        `${options.agentId}: group settings initialization failed: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );
  inboundMessages = new InboundMessageProcessor(
    options,
    wsClient,
    runtime,
    interactionRouter,
    groupIntake,
    sessionContinuity,
    runtimeAdapters,
  );
  let groupRecoveryAfterSettings: Promise<void> | null = null;
  const recoverGroupMessages = (): Promise<void> => {
    if (groupRecoveryAfterSettings) return groupRecoveryAfterSettings;
    groupRecoveryAfterSettings = inboundMessages
      .recover("group", async () => await groupIntake.resolveForRecovery())
      .finally(() => {
        groupRecoveryAfterSettings = null;
      });
    return groupRecoveryAfterSettings;
  };
  const closeInboundProcessing = async (): Promise<void> => {
    await inboundMessages.close();
    const groupRecovery = groupRecoveryAfterSettings;
    if (groupRecovery) await Promise.allSettled([groupRecovery]);
  };
  const shutdownBinding = (recentError: string | null): Promise<void> => {
    runtimeClosing = true;
    if (runtimePreparationRetryTimer) {
      clearTimeout(runtimePreparationRetryTimer);
      runtimePreparationRetryTimer = null;
    }
    if (runtimeShutdown) {
      return recentError
        ? runtimeShutdown.then(async () => await recordConnectionStatus(options, false, recentError))
        : runtimeShutdown;
    }
    wsClient.close();
    const preparation = runtimePreparationRetryTask;
    runtimeShutdown = (async () => {
      await Promise.all([closeInboundProcessing(), groupIntake.close(), ...(preparation ? [preparation] : [])]);
      await interactionRouter.close();
      await runtimeWorkspaceSynchronization;
      await runtime.dispose();
      if (recentError) await recordConnectionStatus(options, false, recentError);
      else await recordRuntimeConnectionStatus(false, null);
    })();
    return runtimeShutdown;
  };
  wireQuarantineEvents(wsClient, options);
  const synchronizeRuntimeWorkspaces = (): void => {
    if (runtimeWorkspaceSynchronizationStarted) return;
    runtimeWorkspaceSynchronizationStarted = true;
    runtimeWorkspaceSynchronization = runtime
      .synchronizeRuntimeWorkspaces()
      .then((synchronization) => {
        for (const failure of synchronization.failures) {
          options.writeError(`${options.agentId}: Workspace synchronization skipped ${failure}\n`);
        }
      })
      .catch((error) => {
        options.writeError(
          `${options.agentId}: Workspace synchronization unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
  };
  const workBuddyRuntimeFailure = (error: unknown): WorkBuddyCapabilityFailure | null =>
    workBuddyRuntime ? workBuddyCapabilityFailure(error) : null;
  const isRetryableWorkBuddyPreparationError = (error: WorkBuddyCapabilityFailure): boolean =>
    workBuddyCapabilityAvailability(error.code) === "unavailable";
  const retryRuntimePreparation = async (): Promise<void> => {
    try {
      await runtimeAdapters.prepare(binding);
    } catch (error) {
      const failure = workBuddyRuntimeFailure(error);
      if (!failure) {
        const detail = error instanceof Error ? error.message : String(error);
        options.writeError(`${options.agentId}: Runtime preparation retry failed fatally: ${detail}\n`);
        void shutdownBinding(detail).catch((shutdownError) =>
          options.writeError(
            `${options.agentId}: Binding shutdown failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}\n`,
          ),
        );
        return;
      }
      if (runtimeClosing) return;
      runtimeStartupUnavailableDetail = failure.message;
      runtimePreparationRetryable = isRetryableWorkBuddyPreparationError(failure);
      await options.stateStore.setRuntimeAvailability(
        options.agentId,
        "startup-unavailable",
        runtimeStartupUnavailableDetail,
      );
      if (runtimePreparationRetryable) scheduleRuntimePreparationRetry();
      return;
    }
    if (runtimeClosing) return;
    runtimePreparationRetryable = false;
    runtimeStartupUnavailableDetail = null;
    await options.stateStore.setRuntimeAvailability(options.agentId, "available", null);
    synchronizeRuntimeWorkspaces();
  };
  const scheduleRuntimePreparationRetry = (): void => {
    if (
      runtimeClosing ||
      !runtimePreparationRetryable ||
      !runtimeStartupUnavailableDetail ||
      runtimePreparationRetryTimer
    )
      return;
    runtimePreparationRetryTimer = setTimeout(() => {
      runtimePreparationRetryTimer = null;
      const preparation = retryRuntimePreparation().catch((error) => {
        options.writeError(
          `${options.agentId}: Runtime preparation retry failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      runtimePreparationRetryTask = preparation;
      void preparation.then(() => {
        if (runtimePreparationRetryTask === preparation) runtimePreparationRetryTask = null;
      });
    }, options.runtimePreparationRetryMs ?? DEFAULT_RUNTIME_PREPARATION_RETRY_MS);
  };
  wsClient.on("error", (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    options.writeError(`${options.agentId}: ${detail}\n`);
    void recordConnectionStatus(options, false, detail).catch(() => undefined);
  });
  wsClient.on("close", ({ code, reason }: { code: number; reason: string }) => {
    options.writeError(`${options.agentId}: WebSocket closed ${code}: ${reason || "no reason"}\n`);
  });
  wsClient.on("state", (state: string) => {
    if (state === "connected") {
      void recordRuntimeConnectionStatus(true, null).catch(() => undefined);
      void inboundMessages
        .recover("direct")
        .catch((error) =>
          options.writeError(
            `${options.agentId}: direct inbound recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        );
      void recoverGroupMessages().catch((error) =>
        options.writeError(
          `${options.agentId}: group inbound recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
    } else if (state === "disconnected" && !runtimeClosing) {
      void recordRuntimeConnectionStatus(false, null).catch(() => undefined);
    }
  });
  try {
    try {
      await runtimeAdapters.prepare(binding);
    } catch (error) {
      const failure = workBuddyRuntimeFailure(error);
      if (!failure) throw error;
      runtimeStartupUnavailableDetail = failure.message;
      runtimePreparationRetryable = isRetryableWorkBuddyPreparationError(failure);
    }
    await wsClient.connect();
    void resolveSenderDisplayName(options.activation.ownerUserId)
      .then(async (ownerDisplayName) => {
        if (ownerDisplayName) {
          await options.stateStore.updateTranscriptSenderDisplayName(options.activation.ownerUserId, ownerDisplayName);
        }
      })
      .catch((error) =>
        options.writeError(
          `${options.agentId}: sender display name backfill failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
    void inboundMessages
      .recover("direct")
      .catch((error) =>
        options.writeError(
          `${options.agentId}: direct inbound recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
    await recordRuntimeConnectionStatus(true, null);
    if (runtimeStartupUnavailableDetail) {
      if (runtimePreparationRetryable) scheduleRuntimePreparationRetry();
    } else synchronizeRuntimeWorkspaces();
  } catch (error) {
    await shutdownBinding(error instanceof Error ? error.message : String(error));
    throw error;
  }
  return {
    agentId: options.agentId,
    websocketUrl: options.config.websocketUrl,
    deviceId: options.deviceId,
    enqueueClientTurn: async (sessionRef, prompt, media, selection, signal, turnId) =>
      await runtime.enqueueClientTurn(sessionRef, prompt, media, selection, signal, turnId),
    uploadClientMedia: async (file, filename) => await runtime.uploadClientMedia(file, filename),
    cancelClientTurn: async (sessionRef) => await runtime.cancelClientTurn(sessionRef),
    queuedClientTurns: (sessionRef) => runtime.queuedClientTurns(sessionRef),
    cancelQueuedClientTurn: (sessionRef, turnId) => runtime.cancelQueuedClientTurn(sessionRef, turnId),
    sessionActivity: async (sessionRef) => await runtime.sessionActivity(sessionRef),
    activeClientTurnId: (sessionRef) => runtime.activeClientTurnId(sessionRef),
    claimSessionLifecycle: async (sessionRef) => await runtime.claimSessionLifecycle(sessionRef),
    executeTool: async (toolName, input) => {
      const toolOptions = {
        baseUrl: options.config.baseUrl,
        deviceId: options.deviceId,
        activation: options.activation,
        wsClient,
      };
      if (isAgentLivewareOperation(toolName)) {
        const managedAppId =
          (await new ConnectBindingLivewarePublicationStateStore(options.stateStore).read(options.agentId))?.value
            .appId ?? null;
        return await executeAgentLiveware(toolName, input, {
          activation: options.activation,
          clawChatBaseUrl: options.config.baseUrl,
          configPath: options.configPath,
          deviceId: options.deviceId,
          registerApp: async (name, appId, url) =>
            await executeConnectTool("clawchat_register_app", { name, appId, url }, toolOptions),
          unregisterApp: async (appId) => await executeConnectTool("clawchat_unregister_app", { appId }, toolOptions),
          managedAppId,
        });
      }
      return await executeConnectTool(toolName, input, toolOptions);
    },
    async close() {
      await shutdownBinding(null);
    },
  };
}

class InboundMessageProcessor {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly deferredDuringRecovery = new Map<string, Promise<void>>();
  private readonly unknownRecoveryKeys = new Set<string>();
  private readonly recoveries = new Map<NormalizedInboundMessage["chatType"], Promise<void>>();
  private readonly recoveryRetryAttempts = new Map<NormalizedInboundMessage["chatType"], number>();
  private readonly recoveryRetryTimers = new Map<NormalizedInboundMessage["chatType"], unknown>();
  private accepting = true;

  constructor(
    private readonly options: BindingRuntimeOptions,
    private readonly wsClient: ConnectWsClient,
    private readonly runtime: ConnectRuntime,
    private readonly interactionRouter: RuntimeInteractionRouter,
    private readonly groupIntake: GroupIntakeCoordinator,
    private readonly sessionContinuity: SessionContinuity,
    private readonly runtimeAdapters: RuntimeAdapterRegistry,
  ) {}

  accept(message: NormalizedInboundMessage): "accepted" {
    if (!this.accepting) throw new Error("inbound message processor is closing");
    const key = inboundHandlingKey(message);
    if (this.unknownRecoveryKeys.has(key)) return "accepted";
    const activeRecovery = this.recoveries.get(message.chatType);
    if (activeRecovery) {
      if (this.deferredDuringRecovery.has(key)) return "accepted";
      const deferred = activeRecovery
        .then(async () => {
          if (!this.accepting || this.unknownRecoveryKeys.has(key)) return;
          const handled = await this.options.stateStore.hasHandledInboundMessage(
            this.options.agentId,
            message.messageId,
            message.raw,
          );
          if (!this.accepting || this.unknownRecoveryKeys.has(key) || handled) return;
          this.startProcessing(message, key);
        })
        .catch((error) =>
          this.options.writeError(
            `${this.options.agentId}: deferred inbound message remains pending: ${error instanceof Error ? error.message : String(error)}\n`,
          ),
        )
        .finally(() => this.deferredDuringRecovery.delete(key));
      this.deferredDuringRecovery.set(key, deferred);
      return "accepted";
    }
    this.startProcessing(message, key);
    return "accepted";
  }

  private startProcessing(message: NormalizedInboundMessage, key: string): void {
    if (!this.accepting || this.pending.has(key)) return;
    let markedHandled = false;
    const markHandled = async () => {
      if (markedHandled) return;
      await this.options.stateStore.markInboundMessageHandled(this.options.agentId, message.messageId, message.raw);
      markedHandled = true;
    };
    const work = (
      message.chatType === "group"
        ? this.groupIntake.accept(message)
        : dispatchInboundMessage({
            ...this.options,
            message,
            wsClient: this.wsClient,
            runtime: this.runtime,
            interactionRouter: this.interactionRouter,
            sessionContinuity: this.sessionContinuity,
            onTurnAccepted: markHandled,
          }).then(async (handledWithoutTurn) => {
            if (handledWithoutTurn) await markHandled();
          })
    )
      .catch((error) =>
        this.options.writeError(
          `${this.options.agentId}: inbound message remains pending: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      )
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
  }

  recover(chatType: NormalizedInboundMessage["chatType"], beforeRecovery?: () => Promise<void>): Promise<void> {
    const active = this.recoveries.get(chatType);
    if (active) return active;
    const recovery = (async () => {
      await beforeRecovery?.();
      await this.recoverOnce(chatType);
    })().finally(() => {
      if (this.recoveries.get(chatType) === recovery) this.recoveries.delete(chatType);
    });
    this.recoveries.set(chatType, recovery);
    return recovery;
  }

  private async recoverOnce(chatType: NormalizedInboundMessage["chatType"]): Promise<void> {
    if (!this.accepting) return;
    let hasUnknown = false;
    const receiptSnapshots = new Map<string, RuntimeInputReceiptSnapshot | null>();
    const unhandled = await this.options.stateStore.listUnhandledInboundMessages(this.options.agentId);
    if (!this.accepting) return;
    for (const raw of unhandled) {
      if (!this.accepting) return;
      const message = normalizeStoredInboundMessage(raw);
      if (!message || message.chatType !== chatType) continue;
      const key = inboundHandlingKey(message);
      this.unknownRecoveryKeys.add(key);
      if (
        await this.options.stateStore.hasHandledInboundMessage(this.options.agentId, message.messageId, message.raw)
      ) {
        this.unknownRecoveryKeys.delete(key);
        continue;
      }
      if (!this.accepting) return;
      if (isConnectControlMessage(message.text)) {
        this.unknownRecoveryKeys.delete(key);
        this.accept(message);
        continue;
      }
      const reconciliation = await this.reconcileInboundMessage(message, receiptSnapshots);
      if (!this.accepting) return;
      if (reconciliation.outcome === "accepted") {
        await this.options.stateStore.markReconciledInboundIdentity(this.options.agentId, reconciliation.identity);
        this.unknownRecoveryKeys.delete(key);
        continue;
      }
      if (reconciliation.outcome === "unknown") {
        this.unknownRecoveryKeys.add(key);
        hasUnknown = true;
        continue;
      }
      this.unknownRecoveryKeys.delete(key);
      this.accept(message);
    }
    if (hasUnknown) this.scheduleRecoveryRetry(chatType);
    else {
      this.recoveryRetryAttempts.delete(chatType);
      const timer = this.recoveryRetryTimers.get(chatType);
      if (timer !== undefined) {
        if (this.options.groupIntakeClock) this.options.groupIntakeClock.clearTimer(timer);
        else clearTimeout(timer as ReturnType<typeof setTimeout>);
        this.recoveryRetryTimers.delete(chatType);
      }
    }
  }

  private async reconcileInboundMessage(
    message: NormalizedInboundMessage,
    receiptSnapshots: Map<string, RuntimeInputReceiptSnapshot | null>,
  ) {
    const candidate = { messageId: message.messageId, contentDigest: inboundContentDigest(message.raw) };
    const sessions = await this.options.stateStore.listRuntimeSessions(message.chatId, this.options.agentId);
    const projectedRefs = new Set(
      await this.options.stateStore.listProjectedInboundSessionRefs(
        this.options.agentId,
        message.chatId,
        message.messageId,
      ),
    );
    sessions.sort(
      (left, right) => Number(projectedRefs.has(right.sessionRef)) - Number(projectedRefs.has(left.sessionRef)),
    );
    const materialized = sessions.filter((session) => session.runtimeSessionId);
    if (materialized.length === 0) return { outcome: "absent" } as const;
    const binding = getAgentBinding(this.options.config, this.options.agentId);
    let unknown = false;
    for (const session of materialized) {
      const runtimeSessionId = session.runtimeSessionId as string;
      const cached = receiptSnapshots.get(runtimeSessionId);
      if (receiptSnapshots.has(runtimeSessionId)) {
        if (!cached) {
          unknown = true;
          continue;
        }
        const identity = cached.identities.find((value) => runtimeInputIdentityContains(value, candidate));
        if (identity) return { outcome: "accepted", identity } as const;
        if (!cached.complete) unknown = true;
        continue;
      }
      const reconciliation = await this.runtimeAdapters.reconcileInput(binding, runtimeSessionId, candidate);
      if (reconciliation.receipts) receiptSnapshots.set(runtimeSessionId, reconciliation.receipts);
      else if (reconciliation.outcome === "unknown") receiptSnapshots.set(runtimeSessionId, null);
      if (reconciliation.outcome === "accepted") return reconciliation;
      if (reconciliation.outcome === "unknown") unknown = true;
    }
    return unknown ? ({ outcome: "unknown" } as const) : ({ outcome: "absent" } as const);
  }

  private scheduleRecoveryRetry(chatType: NormalizedInboundMessage["chatType"]): void {
    if (!this.accepting || this.recoveryRetryTimers.has(chatType)) return;
    const attempt = this.recoveryRetryAttempts.get(chatType) ?? 0;
    this.recoveryRetryAttempts.set(chatType, attempt + 1);
    const clock = this.options.groupIntakeClock;
    const callback = () => {
      this.recoveryRetryTimers.delete(chatType);
      void this.recover(chatType).catch((error) =>
        this.options.writeError(
          `${this.options.agentId}: inbound recovery retry failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
    };
    const delay = Math.min(250 * 2 ** Math.min(attempt, 5), 5_000);
    const timer = clock ? clock.setTimer(callback, delay) : setTimeout(callback, delay);
    this.recoveryRetryTimers.set(chatType, timer);
  }

  async close(): Promise<void> {
    this.accepting = false;
    for (const timer of this.recoveryRetryTimers.values()) {
      if (this.options.groupIntakeClock) this.options.groupIntakeClock.clearTimer(timer);
      else clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    this.recoveryRetryTimers.clear();
    await Promise.allSettled(this.recoveries.values());
    await Promise.allSettled(this.deferredDuringRecovery.values());
    await Promise.allSettled(this.pending.values());
  }
}

function normalizeStoredInboundMessage(raw: unknown): NormalizedInboundMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return normalizeInboundMessage(raw as Envelope);
}

function inboundHandlingKey(message: NormalizedInboundMessage): string {
  return `${message.messageId}:${inboundContentDigest(message.raw)}`;
}

async function dispatchProtocolEventHandler(
  options: BindingRuntimeOptions,
  type: BindingProtocolEventType,
  envelope: Envelope,
): Promise<void> {
  const handler = options.protocolEventHandlers?.[type] as
    | ((event: BindingProtocolEvent) => void | Promise<void>)
    | undefined;
  if (handler) await handler({ type, envelope } as BindingProtocolEvent);
}

function wireQuarantineEvents(wsClient: ConnectWsClient, options: BindingRuntimeOptions): void {
  wsClient.on("quarantined", (event: { envelope: Envelope; error: string }) => {
    options.writeError(
      `${options.agentId}: quarantined Protocol v2 ${event.envelope.event} dseq=${event.envelope.dseq ?? "?"}: ${event.error}\n`,
    );
    const handler = options.protocolEventHandlers?.quarantined;
    if (!handler) return;
    void Promise.resolve(handler({ type: "quarantined", ...event })).catch((error) =>
      options.writeError(
        `${options.agentId}: Protocol event handler failed: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );
  });
}

async function dispatchInboundMessage(
  params: BindingRuntimeOptions & {
    message: NormalizedInboundMessage;
    wsClient: ConnectWsClient;
    runtime: ConnectRuntime;
    interactionRouter: RuntimeInteractionRouter;
    sessionContinuity: SessionContinuity;
    onTurnAccepted: () => Promise<void>;
    groupDispatchMode?: GroupDispatchMode;
  },
): Promise<boolean> {
  const addressed =
    (params.message.groupBatch
      ? unaddressedGroupMessage(params.message)
      : addressInboundMessage(params.message, params.activation.userId)) ??
    (params.groupDispatchMode === "policy-eligible" && params.message.chatType === "group"
      ? unaddressedGroupMessage(params.message)
      : null);
  if (!addressed) return true;
  const message = addressed.message;
  const canRouteCommand = addressed.acceptsCommands || addressed.malformedLineBreakCommand;
  if (
    message.chatType === "group" &&
    addressed.hasAddressingMention &&
    !message.text.trim() &&
    !addressed.hasAttachment
  ) {
    await params.wsClient.sendMessageEnvelope(
      EVENT.MESSAGE_REPLY,
      message.chatId,
      buildReplyTextMessagePayload("Please include a message, attachment, or use @Agent /help.", message),
      { toType: message.chatType },
    );
    await params.onTurnAccepted();
    return true;
  }

  if (await params.interactionRouter.handleMessage(message)) {
    await params.onTurnAccepted();
    return true;
  }
  const routeCommand = async (): Promise<boolean> => {
    if (!canRouteCommand) return false;
    const command = await handleChatCommand({
      message,
      agentId: params.agentId,
      ownerUserId: params.activation.ownerUserId,
      config: params.config,
      stateStore: params.stateStore,
      workspaces: params.workspaces,
      sessionContinuity: params.sessionContinuity,
      closeRuntimeSession: (chatId) => params.runtime.closeSession(chatId),
      invalidateRuntimeSession: (chatId) => params.runtime.invalidateSession(chatId),
      cancelRuntimeTurn: (chatId) => params.runtime.cancelTurn(chatId),
      runtimeFamilyFor: (binding) => params.runtime.runtimeFamilyFor(binding),
      runtimeModesFor: (binding, selected) => params.runtime.runtimeModesFor(binding, selected),
      listRuntimeModels: (binding, selected) => params.runtime.listRuntimeModels(binding, selected),
      discoverRuntimeThreads: (chatId) => params.runtime.discoverRuntimeThreads(chatId),
      listRuntimeWorkspaces: () => params.runtime.listRuntimeWorkspaces(),
    });
    if (!command.handled) return false;
    if (command.text) {
      await params.wsClient.sendMessageEnvelope(
        EVENT.MESSAGE_REPLY,
        message.chatId,
        buildReplyTextMessagePayload(command.text, message),
        { toType: message.chatType },
      );
    }
    await params.onTurnAccepted();
    return true;
  };
  if (
    (canRouteCommand && message.text.trim().split(/\s+/u)[0] === "/cancel") ||
    (canRouteCommand &&
      isConnectControlMessage(message.text) &&
      (message.sender.id !== params.activation.ownerUserId || !requiresOrderedSessionControl(message.text)))
  ) {
    await routeCommand();
    return true;
  }
  await params.runtime.handleInboundMessage(
    message,
    routeCommand,
    canRouteCommand && requiresOrderedSessionControl(message.text),
    params.onTurnAccepted,
  );
  return false;
}

function unaddressedGroupMessage(message: NormalizedInboundMessage): AddressedInboundMessage {
  return {
    message,
    hasAddressingMention: false,
    acceptsCommands: false,
    hasAttachment: message.fragments.some((fragment) => ["image", "file", "audio", "video"].includes(fragment.kind)),
    malformedLineBreakCommand: false,
  };
}

async function recordConnectionStatus(
  options: BindingRuntimeOptions,
  websocketConnected: boolean,
  recentError: string | null,
): Promise<void> {
  await options.stateStore.setRuntimeConnectionStatus(options.agentId, websocketConnected, recentError);
}

async function resetRuntimeStatus(options: BindingRuntimeOptions): Promise<void> {
  await options.stateStore.upsertRuntimeStatus({
    websocketConnected: false,
    activeAgent: options.agentId,
    activeChats: 0,
    globalRunning: 0,
    globalQueued: 0,
    recentError: null,
  });
}
