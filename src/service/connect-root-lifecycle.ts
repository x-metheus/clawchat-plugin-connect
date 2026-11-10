import { Context } from "cordis";
import type { PersistenceService } from "../persistence/service";
import { type ConnectPluginHost, mountMandatoryPluginHost } from "../plugin/host";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { ConnectConfig } from "../types";
import { createBindingRuntimeLifecycle } from "./binding-runtime-lifecycle";
import { mountMandatoryDurableModules } from "./connect-durable-modules";
import { createUpgradeQuiescence, mountMandatoryExecutionModules } from "./connect-execution-modules";
import {
  type ConnectSurfaceDependencies,
  type ConnectSurfaceOptions,
  type ConnectSurfaceResult,
  mountMandatorySurfaceModules,
} from "./connect-surface-modules";
import { type CoreControlHandle, startCoreControl } from "./core-control";

interface ConnectRootLifecycleOptions {
  persistence: PersistenceService;
  config: ConnectConfig;
  configPath: string;
  surfaceOptions: Omit<ConnectSurfaceOptions, "config" | "configPath">;
  surfaceDependencies: ConnectSurfaceDependencies;
  createRuntimeAdapterRegistry(): RuntimeAdapterRegistry;
  waitUntilShutdown(): Promise<void>;
  reportPluginFailure(pluginId: string, error: unknown): void;
  reportDisposalFailure(error: unknown): void;
}

/**
 * Owns the one private Cordis root and every mandatory Connect module in the
 * service process. Root-owned surface fibers are disposed before their
 * execution and durable dependencies.
 */
export async function runConnectRootLifecycle(options: ConnectRootLifecycleOptions): Promise<ConnectSurfaceResult> {
  const root = new Context();
  const bindingRuntimeLifecycle = createBindingRuntimeLifecycle();
  let disposeSurfaces: (() => Promise<void>) | undefined;
  let pluginHost: ConnectPluginHost | undefined;
  let coreControl: CoreControlHandle | undefined;
  const preservePublicationsOnShutdown = process.env.CLAWCHAT_PRESERVE_PUBLICATIONS_ON_SHUTDOWN === "1";
  let upgradePrepared = false;

  try {
    await mountMandatoryDurableModules(root, options.persistence, options.reportDisposalFailure);
    await mountMandatoryExecutionModules(
      root,
      options.config,
      options.createRuntimeAdapterRegistry,
      options.reportDisposalFailure,
    );
    pluginHost = await mountMandatoryPluginHost(
      root,
      options.configPath,
      options.config,
      options.reportPluginFailure,
      bindingRuntimeLifecycle.retireBindings,
    );
    const surfaces = await mountMandatorySurfaceModules(
      root,
      {
        ...options.surfaceOptions,
        config: options.config,
        configPath: options.configPath,
      },
      options.surfaceDependencies,
      options.reportDisposalFailure,
      bindingRuntimeLifecycle,
    );
    disposeSurfaces = surfaces.dispose;
    const upgrade = createUpgradeQuiescence(root.connectSessionQueue);
    coreControl = await startCoreControl(
      options.configPath,
      pluginHost,
      undefined,
      bindingRuntimeLifecycle.retireBindings,
      async (bindingIds) => {
        const expected = Object.keys(options.config.agents).sort();
        if (JSON.stringify([...bindingIds].sort()) !== JSON.stringify(expected))
          throw new Error("Upgrade must quiesce every configured binding");
        await upgrade.suspend(bindingIds);
        pluginHost?.preserveOnShutdown(true);
        upgradePrepared = true;
      },
      async () => {
        await upgrade.resume();
        pluginHost?.preserveOnShutdown(false);
        upgradePrepared = false;
      },
    );
    await options.waitUntilShutdown();
    return surfaces.result;
  } finally {
    if (preservePublicationsOnShutdown) pluginHost?.preserveOnShutdown(true);
    try {
      await coreControl?.stop();
    } catch (error) {
      options.reportDisposalFailure(error);
    }
    try {
      if (!upgradePrepared && !preservePublicationsOnShutdown) await pluginHost?.retireManagedResources();
    } catch (error) {
      options.reportDisposalFailure(error);
    }
    try {
      await disposeSurfaces?.();
    } catch (error) {
      options.reportDisposalFailure(error);
    }
    try {
      if (!upgradePrepared && !preservePublicationsOnShutdown)
        await pluginHost?.retireBindings(Object.keys(options.config.agents));
    } catch (error) {
      options.reportDisposalFailure(error);
    }
    try {
      await root.fiber.dispose();
    } catch (error) {
      options.reportDisposalFailure(error);
    }
  }
}
