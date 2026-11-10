import type { Context, Plugin } from "cordis";
import { TranscriptProjection } from "../client-interface/transcript-projection";
import type { ConnectExecutionCapabilities } from "../runtime/execution-capabilities";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import { RuntimeInteractionCoordinator } from "../runtime/runtime-interaction-coordinator";
import { SessionQueue, type SessionQueueOptions } from "../runtime/session-queue";
import { SessionTurnExecutor, type SessionTurnExecutorOptions } from "../runtime/session-turn-executor";
import type { ConnectConfig } from "../types";

interface SessionQueueModule {
  create(bindingId: string, options: SessionQueueOptions): SessionQueue;
  retainBindings(bindingIds: readonly string[]): void;
  quiesceBindings<T>(
    bindingIds: readonly string[],
    releaseRuntimeSessions: () => Promise<void>,
    criticalSection: () => Promise<T>,
  ): Promise<T>;
}

interface SessionTurnExecutorModule {
  create(options: Omit<SessionTurnExecutorOptions, "start">): SessionTurnExecutor;
  releaseBindings(bindingIds: readonly string[]): Promise<void>;
}

declare module "cordis" {
  interface Context {
    connectRuntimeAdapters: RuntimeAdapterRegistry;
    connectSessionQueue: SessionQueueModule;
    connectSessionTurnExecutor: SessionTurnExecutorModule;
    connectTranscriptProjection: TranscriptProjection;
    connectRuntimeInteractions: RuntimeInteractionCoordinator;
  }
}

/** Hold admission while an upgrade is prepared, with an explicit failure recovery path. */
export function createUpgradeQuiescence(queues: Pick<SessionQueueModule, "quiesceBindings">) {
  let operation: Promise<void> | undefined;
  let acquired: Promise<void> | undefined;
  let release: (() => void) | undefined;
  return {
    async suspend(bindingIds: readonly string[]): Promise<void> {
      if (!operation) {
        let ready!: () => void;
        let failed!: (error: unknown) => void;
        acquired = new Promise<void>((resolve, reject) => {
          ready = resolve;
          failed = reject;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        operation = queues.quiesceBindings(
          bindingIds,
          async () => undefined,
          async () => {
            ready();
            await released;
          },
        );
        void operation.catch(failed);
      }
      await acquired;
    },
    async resume(): Promise<void> {
      release?.();
      try {
        await operation;
      } finally {
        operation = undefined;
        acquired = undefined;
        release = undefined;
      }
    },
  };
}

export async function mountMandatoryExecutionModules(
  root: Context,
  config: ConnectConfig,
  createRuntimeAdapterRegistry: () => RuntimeAdapterRegistry,
  reportDisposalFailure: (error: unknown) => void,
): Promise<ConnectExecutionCapabilities> {
  let runtimeAdapters!: RuntimeAdapterRegistry;
  let sessionQueues!: SessionQueueModule;
  let sessionTurnExecutors!: SessionTurnExecutorModule;
  let transcriptProjection!: TranscriptProjection;
  let runtimeInteractions!: RuntimeInteractionCoordinator;

  const runtimeAdapterPlugin = {
    name: "connect-runtime-adapters",
    inject: ["connectAgentBindings"],
    provide: "connectRuntimeAdapters",
    apply: (ctx) => {
      runtimeAdapters = createRuntimeAdapterRegistry();
      ctx.provide("connectRuntimeAdapters", runtimeAdapters);
      return async () => {
        try {
          await runtimeAdapters.close();
        } catch (error) {
          reportDisposalFailure(error);
        }
      };
    },
  } satisfies Plugin;

  const sessionQueuePlugin = {
    name: "connect-session-queue",
    inject: ["connectPersistence", "connectSessionContinuity"],
    provide: "connectSessionQueue",
    apply: (ctx) => {
      type GatedQueueRelease = { bindingId: string; release: () => Promise<void> };
      const queuesByBinding = new Map<string, Set<SessionQueue>>();
      const activeGates = new Map<string, { lateAcquisitions: Array<Promise<GatedQueueRelease>> }>();
      const retiredBindings = new Set<string>();
      sessionQueues = {
        create: (bindingId, options) => {
          const queue = new SessionQueue(options);
          const queues = queuesByBinding.get(bindingId) ?? new Set<SessionQueue>();
          queues.add(queue);
          queuesByBinding.set(bindingId, queues);
          const activeGate = activeGates.get(bindingId);
          if (activeGate || retiredBindings.has(bindingId)) {
            const acquisition = queue
              .acquireBindingQuiescence(`Agent Binding ${bindingId}`)
              .then((release) => ({ bindingId, release }));
            if (activeGate) activeGate.lateAcquisitions.push(acquisition);
            else void acquisition.catch(reportDisposalFailure);
          }
          return queue;
        },
        retainBindings: (bindingIds) => {
          for (const bindingId of new Set(bindingIds)) {
            if (!activeGates.has(bindingId) && !retiredBindings.has(bindingId)) {
              throw new Error(`Agent Binding ${bindingId} is not quiescing`);
            }
            retiredBindings.add(bindingId);
          }
        },
        quiesceBindings: async (bindingIds, releaseRuntimeSessions, criticalSection) => {
          const dependentIds = [...new Set(bindingIds)].sort();
          for (const bindingId of dependentIds) {
            if (activeGates.has(bindingId)) {
              throw new Error(`Agent Binding ${bindingId} lifecycle operation is already in progress`);
            }
          }
          const gate = { lateAcquisitions: [] as Array<Promise<GatedQueueRelease>> };
          for (const bindingId of dependentIds) activeGates.set(bindingId, gate);
          const releases: GatedQueueRelease[] = [];
          let outcome: { ok: true; value: Awaited<ReturnType<typeof criticalSection>> } | { ok: false; error: unknown };
          try {
            const acquisitions: Array<Promise<GatedQueueRelease>> = [];
            for (const bindingId of dependentIds) {
              if (retiredBindings.has(bindingId)) continue;
              for (const queue of queuesByBinding.get(bindingId) ?? []) {
                acquisitions.push(
                  queue
                    .acquireBindingQuiescence(`Agent Binding ${bindingId}`)
                    .then((release) => ({ bindingId, release })),
                );
              }
            }
            const acquired = await Promise.allSettled(acquisitions);
            for (const result of acquired) {
              if (result.status === "fulfilled") releases.push(result.value);
            }
            const acquisitionFailure = acquired.find(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (acquisitionFailure) throw acquisitionFailure.reason;
            await releaseRuntimeSessions();
            outcome = { ok: true, value: await criticalSection() };
          } catch (error) {
            outcome = { ok: false, error };
          }

          for (const bindingId of dependentIds) {
            if (activeGates.get(bindingId) === gate) activeGates.delete(bindingId);
          }
          const lateReleases = await Promise.allSettled(gate.lateAcquisitions);
          for (const result of lateReleases) {
            if (result.status === "fulfilled") releases.push(result.value);
          }
          const reopened = await Promise.allSettled(
            releases
              .filter(({ bindingId }) => !retiredBindings.has(bindingId))
              .reverse()
              .map(async ({ release }) => await release()),
          );
          const cleanupFailure =
            lateReleases.find((result): result is PromiseRejectedResult => result.status === "rejected") ??
            reopened.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (!outcome.ok) {
            if (cleanupFailure) {
              throw new AggregateError(
                [outcome.error, cleanupFailure.reason],
                "Binding lifecycle operation and queue cleanup both failed",
              );
            }
            throw outcome.error;
          }
          if (cleanupFailure) throw cleanupFailure.reason;
          return outcome.value;
        },
      };
      ctx.provide("connectSessionQueue", sessionQueues);
    },
  } satisfies Plugin;

  const sessionTurnExecutorPlugin = {
    name: "connect-session-turn-executor",
    inject: ["connectRuntimeAdapters", "connectSessionContinuity"],
    provide: "connectSessionTurnExecutor",
    apply: (ctx) => {
      const executors = new Set<SessionTurnExecutor>();
      sessionTurnExecutors = {
        create: (options) => {
          const executor = new SessionTurnExecutor({
            ...options,
            start: async (binding, context) => await ctx.connectRuntimeAdapters.start(binding, context),
          });
          executors.add(executor);
          return executor;
        },
        releaseBindings: async (bindingIds) => {
          const dependentIds = new Set(bindingIds);
          const results = await Promise.allSettled(
            [...executors].map(async (executor) => await executor.releaseBindings(dependentIds)),
          );
          const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failure) throw failure.reason;
        },
      };
      ctx.provide("connectSessionTurnExecutor", sessionTurnExecutors);
      return async () => {
        const results = await Promise.allSettled([...executors].map(async (executor) => await executor.close()));
        executors.clear();
        for (const result of results) {
          if (result.status === "rejected") reportDisposalFailure(result.reason);
        }
      };
    },
  } satisfies Plugin;

  const transcriptProjectionPlugin = {
    name: "connect-transcript-projection",
    inject: ["connectPersistence", "connectRuntimeAdapters"],
    provide: "connectTranscriptProjection",
    apply: (ctx) => {
      transcriptProjection = new TranscriptProjection({
        config,
        stateStore: ctx.connectPersistence.state,
        runtimeAdapters: ctx.connectRuntimeAdapters,
      });
      ctx.provide("connectTranscriptProjection", transcriptProjection);
    },
  } satisfies Plugin;

  const runtimeInteractionPlugin = {
    name: "connect-runtime-interactions",
    inject: ["connectTranscriptProjection"],
    provide: "connectRuntimeInteractions",
    apply: (ctx) => {
      runtimeInteractions = new RuntimeInteractionCoordinator(ctx.connectTranscriptProjection);
      ctx.provide("connectRuntimeInteractions", runtimeInteractions);
      return async () => {
        try {
          await runtimeInteractions.close();
        } catch (error) {
          reportDisposalFailure(error);
        }
      };
    },
  } satisfies Plugin;

  await Promise.all([root.plugin(runtimeAdapterPlugin), root.plugin(sessionQueuePlugin)]);
  await Promise.all([root.plugin(sessionTurnExecutorPlugin), root.plugin(transcriptProjectionPlugin)]);
  await root.plugin(runtimeInteractionPlugin);

  return {
    runtimeAdapters,
    transcriptProjection,
    runtimeInteractions,
    createSessionQueue: (bindingId, options) => sessionQueues.create(bindingId, options),
    createSessionTurnExecutor: (options) => sessionTurnExecutors.create(options),
    quiesceBindings: async (bindingIds, criticalSection) =>
      await sessionQueues.quiesceBindings(
        bindingIds,
        async () => await sessionTurnExecutors.releaseBindings(bindingIds),
        criticalSection,
      ),
  };
}
