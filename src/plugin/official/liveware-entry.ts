import type {
  ConnectPluginDisposer,
  ConnectPluginEntry,
  ConnectPluginExposureActivation,
  ManagedWebAppGenerationReference,
  ManagedWebAppHealth,
} from "../sdk";
import { OFFICIAL_LIVEWARE_CAPABILITY_ID, type OfficialLivewareAccessPolicy } from "./liveware-manifest";
import {
  BindingLivewarePublicationLifecycle,
  type BindingLivewarePublicationTarget,
  type LivewarePublicationControlPlane,
  type LivewarePublicationRegistrationPort,
} from "./liveware-publication";
import {
  DeclaredBindingLivewarePublicationStateStore,
  resetBindingLivewarePublicationState,
  validateBindingLivewarePublicationState,
} from "./liveware-publication-state";

export interface OfficialLivewareManagedWebAppLease {
  readonly selection: Readonly<
    ManagedWebAppGenerationReference & {
      readonly displayName: string;
      readonly description: string;
    }
  >;
  readonly instanceKey: string;
  readonly upstream: string;
  health(): ManagedWebAppHealth;
  release(): Promise<void>;
}
export interface OfficialLivewareManagedDisposer extends ConnectPluginDisposer {
  preserveOnShutdown(preserve: boolean): void;
  retire(): Promise<void>;
  retireBindings(bindingIds: readonly string[]): Promise<void>;
  retireManagedWebApp(reference: ManagedWebAppGenerationReference): Promise<void>;
  reconcileManagedWebApps(): Promise<void>;
}

/**
 * Privileged Core services granted only to the release-pinned official
 * Liveware capability. This interface is intentionally absent from the public
 * Plugin SDK and contains no Binding credential or mutable Core domain object.
 */
export interface OfficialLivewareExposureServices {
  listBindings(): Promise<readonly BindingLivewarePublicationTarget[]>;
  readonly controlPlane: LivewarePublicationControlPlane;
  readonly registrations: LivewarePublicationRegistrationPort;
  acquireManagedWebApp(
    bindingId: string,
    activationGeneration: number,
  ): Promise<OfficialLivewareManagedWebAppLease | null>;
}

interface PrivilegedLivewareActivation extends ConnectPluginExposureActivation {
  readonly officialLiveware: OfficialLivewareExposureServices;
}

export function createOfficialLivewarePluginEntry(): ConnectPluginEntry {
  return {
    migrateDurableState(migration) {
      if (migration.capabilityId !== OFFICIAL_LIVEWARE_CAPABILITY_ID) return migration.value;
      const bindingId = migration.value.bindingId;
      const activationGeneration = migration.value.activationGeneration;
      if (typeof bindingId !== "string" || typeof activationGeneration !== "number") {
        throw new Error("Legacy Binding Liveware Publication state has no exact Binding generation identity");
      }
      return resetBindingLivewarePublicationState(bindingId, activationGeneration);
    },
    migrateDurableStateGeneration(migration) {
      if (migration.capabilityId !== OFFICIAL_LIVEWARE_CAPABILITY_ID) return migration.value;
      try {
        const publication = validateBindingLivewarePublicationState(migration.value, migration.capabilityInstanceId);
        return {
          ...publication,
          activationGeneration: migration.toActivationGeneration,
          ...(migration.reactivating
            ? {
                desired: "private" as const,
                status: publication.status === "retired" ? ("provisioning" as const) : publication.status,
                transition: null,
                diagnostic: null,
              }
            : {}),
        };
      } catch {
        return resetBindingLivewarePublicationState(migration.capabilityInstanceId, migration.toActivationGeneration);
      }
    },
    activate(context) {
      const exposures = context.hostCapabilities.get("exposure-provider");
      const state = new DeclaredBindingLivewarePublicationStateStore(
        context.hostCapabilities.get("durable-state"),
        OFFICIAL_LIVEWARE_CAPABILITY_ID,
        context.activationGeneration,
      );
      exposures.register({
        capabilityId: OFFICIAL_LIVEWARE_CAPABILITY_ID,
        async activate(publicActivation) {
          const activation = requirePrivilegedActivation(publicActivation);
          const accessPolicy = readAccessPolicy(activation.configuration);
          const initialTargets = await activation.officialLiveware.listBindings();
          const resources = new Map<
            string,
            { lease?: OfficialLivewareManagedWebAppLease; lifecycle: BindingLivewarePublicationLifecycle }
          >();
          const targets = new Map(initialTargets.map((target) => [target.bindingId, target]));
          const remainingBindings = new Set(targets.keys());
          const retiredBindings = new Set<string>();
          let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
          let reconciliation = Promise.resolve();
          let stopping = false;
          let preserveOnShutdown = false;

          const ensureResource = async (
            target: BindingLivewarePublicationTarget,
            acquireSelectedApp: boolean,
          ): Promise<
            | {
                lease?: OfficialLivewareManagedWebAppLease;
                lifecycle: BindingLivewarePublicationLifecycle;
              }
            | undefined
          > => {
            const current = resources.get(target.bindingId);
            if (current) return current;
            const lease = acquireSelectedApp
              ? ((await activation.officialLiveware.acquireManagedWebApp(
                  target.bindingId,
                  activation.activationGeneration,
                )) ?? undefined)
              : undefined;
            const publication = await state.read(target.bindingId);
            if (!lease && !publication) return undefined;
            try {
              const resource = {
                ...(lease ? { lease } : {}),
                lifecycle: new BindingLivewarePublicationLifecycle({
                  activationGeneration: activation.activationGeneration,
                  ...(lease
                    ? {
                        upstream: lease.upstream,
                        selectedApp: {
                          ...lease.selection,
                          instanceKey: lease.instanceKey,
                        },
                      }
                    : {}),
                  state,
                  controlPlane: activation.officialLiveware.controlPlane,
                  registrations: activation.officialLiveware.registrations,
                }),
              };
              resources.set(target.bindingId, resource);
              return resource;
            } catch (error) {
              await lease?.release().catch(() => undefined);
              throw error;
            }
          };
          const releaseResource = async (bindingId: string): Promise<void> => {
            const resource = resources.get(bindingId);
            if (!resource) return;
            await resource.lifecycle.dispose();
            await resource.lease?.release();
            resources.delete(bindingId);
          };
          const retireTarget = async (target: BindingLivewarePublicationTarget): Promise<void> => {
            const resource = await ensureResource(target, false);
            if (resource) {
              const publication = await state.read(target.bindingId);
              if (publication?.value.status !== "retired") await resource.lifecycle.retire(target);
            }
            await releaseResource(target.bindingId);
            remainingBindings.delete(target.bindingId);
            retiredBindings.add(target.bindingId);
          };
          const reactivateTarget = async (target: BindingLivewarePublicationTarget): Promise<void> => {
            const reactivating = retiredBindings.delete(target.bindingId);
            remainingBindings.add(target.bindingId);
            const publication = await state.read(target.bindingId);
            if (
              reactivating &&
              publication &&
              (publication.value.desired === "retired" ||
                publication.value.status === "retiring" ||
                publication.value.status === "retired")
            ) {
              await state.compareAndSwap(target.bindingId, publication.revision, {
                ...publication.value,
                desired: "private",
                status: "absent",
                transition: null,
                selectedApp: null,
                diagnostic: null,
              });
            }
            await reconcileTarget(target);
          };
          const releaseFailedLease = async (target: BindingLivewarePublicationTarget): Promise<boolean> => {
            const resource = resources.get(target.bindingId);
            if (!resource?.lease) return false;
            let health: ManagedWebAppHealth;
            try {
              health = resource.lease.health();
            } catch {
              health = "error";
            }
            if (health !== "error" && health !== "stopped") return false;
            await releaseResource(target.bindingId);
            return true;
          };
          async function reconcileTarget(target: BindingLivewarePublicationTarget): Promise<void> {
            const publication = await state.read(target.bindingId);
            if (
              accessPolicy === "private" &&
              (publication?.value.desired === "retired" ||
                publication?.value.status === "retiring" ||
                publication?.value.status === "retired")
            ) {
              return;
            }
            if (accessPolicy === "off") {
              await retireTarget(target);
              return;
            }
            if (await releaseFailedLease(target)) return;
            const resource = await ensureResource(target, true);
            if (!resource) return;
            if (!resource.lease) {
              await retireTarget(target);
              return;
            }
            try {
              await resource.lifecycle.ensurePrivate(target);
            } catch (error) {
              const current = await state.read(target.bindingId).catch(() => null);
              if (current) {
                const detail = error instanceof Error ? error.message : String(error);
                await state
                  .compareAndSwap(target.bindingId, current.revision, {
                    ...current.value,
                    status: "degraded",
                    diagnostic: `Publication reconciliation failed: ${detail}`,
                  })
                  .catch(() => undefined);
              }
              throw error;
            }
          }
          const reconcileBindings = async (): Promise<void> => {
            const listedTargets = await activation.officialLiveware.listBindings();
            const listedBindingIds = new Set(listedTargets.map((target) => target.bindingId));
            for (const bindingId of retiredBindings) {
              if (listedBindingIds.has(bindingId)) continue;
              retiredBindings.delete(bindingId);
              remainingBindings.delete(bindingId);
              targets.delete(bindingId);
            }
            const reconcilableTargets = listedTargets.filter((target) => !retiredBindings.has(target.bindingId));
            for (const target of reconcilableTargets) {
              targets.set(target.bindingId, target);
              remainingBindings.add(target.bindingId);
            }
            await Promise.allSettled(reconcilableTargets.map(reconcileTarget));
          };
          const scheduleReconciliation = (): void => {
            if (stopping || accessPolicy !== "private") return;
            reconcileTimer = setTimeout(() => {
              reconciliation = reconcileBindings()
                .catch(() => undefined)
                .finally(() => scheduleReconciliation());
            }, 1_000);
            reconcileTimer.unref();
          };
          const stopReconciliation = async (): Promise<void> => {
            stopping = true;
            clearTimeout(reconcileTimer);
            await reconciliation;
          };
          const retireAll = async (): Promise<void> => {
            await stopReconciliation();
            for (const target of targets.values()) {
              if (!remainingBindings.has(target.bindingId)) continue;
              await retireTarget(target);
            }
          };

          if (accessPolicy === "private") {
            await Promise.allSettled([...targets.values()].map(reconcileTarget));
            scheduleReconciliation();
          } else {
            for (const target of targets.values()) await reconcileTarget(target);
          }
          const dispose = Object.assign(
            async () => {
              if (preserveOnShutdown) {
                await stopReconciliation();
                for (const bindingId of [...resources.keys()]) await releaseResource(bindingId);
              } else await retireAll();
            },
            {
              preserveOnShutdown: (preserve: boolean) => {
                preserveOnShutdown = preserve;
              },
              retire: retireAll,
              retireBindings: async (bindingIds: readonly string[]) => {
                await reconciliation;
                const selected = new Set(bindingIds);
                for (const target of targets.values()) {
                  if (!selected.has(target.bindingId) || !remainingBindings.has(target.bindingId)) continue;
                  await retireTarget(target);
                }
              },
              retireManagedWebApp: async (reference: ManagedWebAppGenerationReference) => {
                await reconciliation;
                for (const [bindingId, resource] of resources) {
                  const selection = resource.lease?.selection;
                  if (!selection) continue;
                  if (
                    selection.pluginId !== reference.pluginId ||
                    selection.capabilityId !== reference.capabilityId ||
                    selection.activationGeneration !== reference.activationGeneration
                  ) {
                    continue;
                  }
                  const target = targets.get(bindingId);
                  if (target && remainingBindings.has(bindingId)) await retireTarget(target);
                }
              },
              reconcileManagedWebApps: async () => {
                await reconciliation;
                await Promise.allSettled([...targets.values()].map(async (target) => await reactivateTarget(target)));
              },
            },
          ) satisfies OfficialLivewareManagedDisposer;
          return dispose;
        },
      });
    },
  };
}

function requirePrivilegedActivation(activation: ConnectPluginExposureActivation): PrivilegedLivewareActivation {
  const privileged = activation as Partial<PrivilegedLivewareActivation>;
  const services = privileged.officialLiveware;
  if (
    !services ||
    typeof services.listBindings !== "function" ||
    typeof services.acquireManagedWebApp !== "function" ||
    !services.controlPlane ||
    !services.registrations
  ) {
    throw new Error("The official Liveware capability requires its release-pinned Core grant");
  }
  return privileged as PrivilegedLivewareActivation;
}

function readAccessPolicy(configuration: Readonly<Record<string, unknown>>): OfficialLivewareAccessPolicy {
  const value = configuration.accessPolicy ?? "private";
  if (value !== "private" && value !== "off") {
    throw new Error("Official Liveware accessPolicy must be private or off");
  }
  return value;
}

export {
  LIVEWARE_EXPOSURE_CONFIGURATION_SCHEMA,
  LIVEWARE_INSTALLATION_CONFIGURATION_SCHEMA,
  OFFICIAL_LIVEWARE_CAPABILITY_ID,
  OFFICIAL_LIVEWARE_PLUGIN_ID,
} from "./liveware-manifest";

export default createOfficialLivewarePluginEntry();
