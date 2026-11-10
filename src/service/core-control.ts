import type { ConfigurePluginOptions, ConnectPluginHost, ManagePluginOptions } from "../plugin/host";
import type { ManagedWebAppLease } from "../plugin/managed-web-app-registry";
import { CONNECT_CLIENT_MANAGED_WEB_APP_REF } from "../plugin/official/connect-client-manifest";
import type { ManagedWebAppGenerationReference } from "../plugin/sdk";

export const CORE_CONTROL_HOST = "127.0.0.1" as const;
export const CORE_CONTROL_PORT = 47_822 as const;
export const CORE_CONTROL_ORIGIN = `http://${CORE_CONTROL_HOST}:${CORE_CONTROL_PORT}` as const;
export const CORE_CONTROL_CONFIG_HEADER = "X-ClawChat-Connect-Core-Config-Path" as const;
export const CORE_BINDING_RESUME_PATH = "/core/v1/bindings/resume" as const;
export const CORE_BINDING_QUIESCE_PATH = "/core/v1/bindings/quiesce" as const;
export const CORE_BINDING_RETIRE_PATH = "/core/v1/bindings/retire" as const;
const CORE_PLUGIN_PATH = "/core/v1/plugins" as const;
const CORE_STATUS_PATH = "/core/v1/status" as const;
export const CORE_CLIENT_PATH = "/core/v1/client" as const;

interface CoreControlRequestContext {
  requestIP(request: Request): { address: string } | null;
}

export interface CoreControlServerHandle {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface CoreControlServerFactoryOptions {
  hostname: typeof CORE_CONTROL_HOST;
  port: typeof CORE_CONTROL_PORT;
  idleTimeout: number;
  fetch(request: Request, server: CoreControlRequestContext): Response | Promise<Response>;
}

export interface CoreControlHandle {
  stop(): Promise<void>;
}

export async function startCoreControl(
  configPath: string,
  pluginHost: ConnectPluginHost,
  serverFactory: (options: CoreControlServerFactoryOptions) => CoreControlServerHandle = (options) =>
    Bun.serve(options),
  retireRuntimeBindings: (bindingIds: readonly string[]) => Promise<void> = async () => undefined,
  quiesceRuntimeBindings: (bindingIds: readonly string[]) => Promise<void> = async () => {
    throw new Error("Runtime quiescence is unavailable");
  },
  resumeRuntimeBindings: () => Promise<void> = async () => {
    throw new Error("Runtime resumption is unavailable");
  },
): Promise<CoreControlHandle> {
  const clientLeases = new Map<string, ManagedWebAppLease>();
  const retireClientLeases = async (reference: ManagedWebAppGenerationReference): Promise<void> => {
    for (const [bindingId, lease] of clientLeases) {
      if (
        lease.selection.pluginId !== reference.pluginId ||
        lease.selection.capabilityId !== reference.capabilityId ||
        lease.selection.activationGeneration !== reference.activationGeneration
      ) {
        continue;
      }
      await lease.release();
      clientLeases.delete(bindingId);
    }
  };
  const retireBindingClientLeases = async (bindingIds: readonly string[]): Promise<void> => {
    for (const bindingId of bindingIds) {
      const lease = clientLeases.get(bindingId);
      if (!lease) continue;
      await lease.release();
      clientLeases.delete(bindingId);
    }
  };
  const server = serverFactory({
    hostname: CORE_CONTROL_HOST,
    port: CORE_CONTROL_PORT,
    idleTimeout: 0,
    fetch: async (request, context) => {
      try {
        const peer = context.requestIP(request)?.address;
        if (peer !== "127.0.0.1" && peer !== "::1") return jsonError(403, "Core control is loopback-only");
        if (request.headers.get(CORE_CONTROL_CONFIG_HEADER) !== configPath) {
          return jsonError(403, "Core control configuration scope does not match");
        }
        const url = new URL(request.url);
        if (
          url.origin !== CORE_CONTROL_ORIGIN ||
          (url.pathname !== CORE_STATUS_PATH &&
            url.pathname !== CORE_CLIENT_PATH &&
            url.pathname !== CORE_BINDING_RETIRE_PATH &&
            url.pathname !== CORE_BINDING_QUIESCE_PATH &&
            url.pathname !== CORE_BINDING_RESUME_PATH &&
            !url.pathname.startsWith(CORE_PLUGIN_PATH))
        ) {
          return jsonError(404, "Core control endpoint was not found");
        }
        if (url.pathname === CORE_STATUS_PATH && request.method === "GET") {
          const bindingId = url.searchParams.get("bindingId");
          if (!bindingId) return jsonError(400, "Core status requires an Agent Binding identity");
          return json(pluginHost.managedWebAppStatus(bindingId));
        }
        if (url.pathname === CORE_CLIENT_PATH && request.method === "POST") {
          const body = await readJson<{ bindingId?: unknown }>(request);
          if (typeof body.bindingId !== "string" || !body.bindingId.trim()) {
            return jsonError(400, "Connect Client acquisition requires an Agent Binding identity");
          }
          let lease = clientLeases.get(body.bindingId);
          if (lease) {
            try {
              lease.health();
            } catch {
              clientLeases.delete(body.bindingId);
              await lease.release().catch(() => undefined);
              lease = undefined;
            }
          }
          if (!lease) {
            lease =
              (await pluginHost.acquireManagedWebApp(body.bindingId, CONNECT_CLIENT_MANAGED_WEB_APP_REF)) ?? undefined;
            if (!lease) {
              return jsonError(404, `No active Connect Client supports Agent Binding ${body.bindingId}`);
            }
            clientLeases.set(body.bindingId, lease);
          }
          return json({ origin: lease.upstream });
        }
        if (url.pathname === CORE_BINDING_RESUME_PATH && request.method === "POST") {
          await resumeRuntimeBindings();
          return json({ resumed: true });
        }
        if (url.pathname === CORE_BINDING_QUIESCE_PATH && request.method === "POST") {
          const body = await readJson<{ bindingIds?: unknown }>(request);
          if (
            !Array.isArray(body.bindingIds) ||
            body.bindingIds.length === 0 ||
            body.bindingIds.some((id) => typeof id !== "string" || !id.trim())
          )
            return jsonError(400, "Quiescence requires exact Agent Binding identities");
          const bindingIds = [...new Set(body.bindingIds as string[])].sort();
          await quiesceRuntimeBindings(bindingIds);
          return json({ quiescedBindingIds: bindingIds });
        }
        if (url.pathname === CORE_BINDING_RETIRE_PATH && request.method === "POST") {
          const body = await readJson<{ bindingIds?: unknown }>(request);
          if (
            !Array.isArray(body.bindingIds) ||
            body.bindingIds.length === 0 ||
            body.bindingIds.some((bindingId) => typeof bindingId !== "string" || !bindingId.trim())
          ) {
            return jsonError(400, "Binding retirement requires exact Agent Binding identities");
          }
          const bindingIds = [...new Set(body.bindingIds as string[])].sort();
          await pluginHost.retireBindings(bindingIds);
          await retireBindingClientLeases(bindingIds);
          await retireRuntimeBindings(bindingIds);
          return json({ retiredBindingIds: bindingIds });
        }
        return await routePluginRequest(pluginHost, request, url);
      } catch (error) {
        return jsonError(400, error instanceof Error ? error.message : String(error));
      }
    },
  });
  const unregisterLeaseRetirer = pluginHost.registerManagedWebAppLeaseRetirer(retireClientLeases);
  return {
    stop: async () => {
      const releases = await Promise.allSettled(
        [...clientLeases].map(async ([bindingId, lease]) => {
          await lease.release();
          clientLeases.delete(bindingId);
        }),
      );
      const failures = releases.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Core control could not release every local Connect Client lease",
        );
      }
      unregisterLeaseRetirer();
      await server.stop(true);
    },
  };
}

async function routePluginRequest(host: ConnectPluginHost, request: Request, url: URL): Promise<Response> {
  const suffix = url.pathname.slice(CORE_PLUGIN_PATH.length);
  if (suffix === "" && request.method === "GET") return json(await host.list());
  if (suffix === "" && request.method === "POST") {
    return json(await host.install(await readJson<ManagePluginOptions>(request)));
  }
  if (suffix === "/official" && request.method === "GET") return json(await host.discoverOfficial());
  if (suffix === "/official/setup" && request.method === "POST") {
    const body = await readJson<{ pluginIds?: unknown }>(request);
    if (!Array.isArray(body.pluginIds) || body.pluginIds.some((id) => typeof id !== "string")) {
      throw new Error("Official Plugin setup requires exact Plugin identities");
    }
    return json(await host.installOfficial(body.pluginIds as string[]));
  }
  const segments = suffix.split("/").filter(Boolean).map(decodeURIComponent);
  const pluginId = segments[0];
  if (!pluginId || segments.length > 2) return jsonError(404, "Core control endpoint was not found");
  const action = segments[1];
  if (!action && request.method === "DELETE")
    return json(await host.remove(pluginId, url.searchParams.get("force") === "1"));
  if (request.method !== "POST" || !action) return jsonError(404, "Core control endpoint was not found");
  if (action === "update")
    return json(await host.update(pluginId, await readJson<Partial<ManagePluginOptions>>(request)));
  if (action === "replace") return json(await host.replace(pluginId, await readJson<ManagePluginOptions>(request)));
  if (action === "configure")
    return json(await host.configure(pluginId, await readJson<ConfigurePluginOptions>(request)));
  if (action === "enable") return json(await host.enable(pluginId));
  if (action === "disable") return json(await host.disable(pluginId));
  if (action === "select") {
    const body = await readJson<{ version?: unknown; integrity?: unknown }>(request);
    if (typeof body.version !== "string") throw new Error("Plugin selection requires a retained version");
    if (body.integrity !== undefined && typeof body.integrity !== "string") {
      throw new Error("Plugin selection integrity must be text");
    }
    return json(await host.select(pluginId, body.version, body.integrity as string | undefined));
  }
  return jsonError(404, "Core control endpoint was not found");
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("Core control requests require application/json");
  }
  return (await request.json()) as T;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function jsonError(status: number, message: string): Response {
  return json({ error: { message } }, status);
}
