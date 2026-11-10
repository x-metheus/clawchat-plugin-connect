import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { cac } from "cac";
import { type ActivateConnectResult, activateConnect as activateConnectDefault } from "../account/activation";
import {
  type RemoveAgentBindingResult,
  removeAgentBinding as removeAgentBindingDefault,
} from "../account/agent-binding-removal";
import {
  OWNER_RESET_CONFIRMATION_PHRASE,
  OWNER_RESET_PREVIEW,
  type ResetInstallationOwnerResult,
  resetInstallationOwner as resetInstallationOwnerDefault,
} from "../account/owner-reset";
import { type AccountProfilePatch, updateAccountProfile as updateAccountProfileDefault } from "../account/profile";
import {
  type AgentLivewareOperation,
  isAgentLivewareOperation,
  validateAgentLivewareInput,
} from "../agent/agent-liveware";
import { installManagedSkills, preflightManagedSkills, verifyInstalledSkills } from "../agent/skills";
import {
  CONNECT_TOOL_CATALOG,
  getConnectTool,
  recordToolInput,
  toolJsonSchema,
  validateToolInput,
} from "../agent/tool-catalog";
import {
  defaultConfig,
  defaultConfigPath,
  getAgentBinding,
  loadConfig,
  saveConfig,
  upsertAgentBinding,
} from "../config";
import { type ConnectStateStore, createStateStore, type ToolRequestRecord } from "../persistence/state";
import { createAgentBinding } from "../plugin/binding";
import { type ManagedWebAppControlStatus, validateInstalledRuntimeBinding } from "../plugin/host";
import { selectManagedWebApp } from "../plugin/managed-web-app-registry";
import {
  CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
  CONNECT_CLIENT_PLUGIN_ID,
} from "../plugin/official/connect-client-manifest";
import {
  type BundledOfficialPluginEntry,
  discoverOfficialPlugins,
  type OfficialPluginDiscovery,
  type OfficialPluginDiscoveryOptions,
  resolveBundledOfficialPlugin,
} from "../plugin/official-registry";
import { resolvePluginSource } from "../plugin/source";
import {
  type InstalledPluginLockEntry,
  installPluginBundle,
  listInstalledPlugins,
  pluginDependents,
  refreshOfficialPluginBundle,
  validatePluginConfiguration,
} from "../plugin/store";
import type { AgentBindingConfig, ConnectConfig, OutputVisibility } from "../types";
import { WorkspaceCatalog } from "../workspaces/workspaces";
import {
  BACKGROUND_SERVICE_PROCESS_ACTION,
  type BackgroundServiceAction,
  manageBackgroundService as manageBackgroundServiceDefault,
} from "./background-service";
import { startConnectService as startConnectServiceDefault } from "./connect-service";
import { CORE_CLIENT_PATH, CORE_CONTROL_CONFIG_HEADER, CORE_CONTROL_ORIGIN } from "./core-control";
import { updateConnect as updateConnectDefault } from "./update";
import { CONNECT_VERSION } from "./version";

export interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

type PluginManagementFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ConnectCliDeps extends Partial<CliIo> {
  activateConnect?: typeof activateConnectDefault;
  removeAgentBinding?: typeof removeAgentBindingDefault;
  resetInstallationOwner?: typeof resetInstallationOwnerDefault;
  updateAccountProfile?: typeof updateAccountProfileDefault;
  manageBackgroundService?: typeof manageBackgroundServiceDefault;
  startConnectService?: typeof startConnectServiceDefault;
  waitUntilShutdown?: () => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  updateConnect?: typeof updateConnectDefault;
  pluginManagementFetch?: PluginManagementFetch;
  pluginSourceOptions?: OfficialPluginDiscoveryOptions;
  createStateStore?: typeof createStateStore;
  readStdin?: () => Promise<string>;
  toolRequestWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface AgentCliOptions {
  plugin?: string;
  capability?: string;
  runtimeConfigJson?: string;
}

const HELP_TEXT = `${[
  "clawchat-connect <command>",
  "",
  "Commands:",
  "  init [--agent <id> --plugin <plugin-id> --capability <capability-id>] [--config <path>]",
  "  agent add <id> --plugin <plugin-id> --capability <capability-id> [--runtime-config-json <object>] [--config <path>]",
  "  agent remove <id> --yes [--config <path>]",
  "  owner reset [--yes-reset-owner] [--config <path>]",
  "  plugin install <local-path|npm:package[@version]|github:owner/repo[@release]> [--installation-config-json <object>] [--capability-config-json <object>] [--config <path>]",
  "  plugin update <id> [source] [--installation-config-json <object>] [--capability-config-json <object>] [--config <path>]",
  "  plugin replace <id> <local-path|npm:package[@version]|github:owner/repo[@release]> [--installation-config-json <object>] [--capability-config-json <object>] [--config <path>]",
  "  plugin setup [--non-interactive --select <id,id>] [--deselect <id,id>] [--config <path>]",
  "  plugin enable|disable <id> [--config <path>]",
  "  plugin remove <id> [--force] [--config <path>]",
  "  plugin select <id> <version> [--integrity <sri>] [--config <path>]",
  "  plugin list [--config <path>]",
  "  workspace add <binding-id> <absolute-path> [--config <path>]",
  "  workspace list <binding-id> [--config <path>]",
  "  workspace remove <binding-id> <workspace-ref> [--config <path>]",
  "  activate <agentId> <code> [--config <path>]",
  "  profile update [--agent <id>] [--nickname <text>] [--avatar-url <url>] [--bio <text>] [--config <path>]",
  "  tool list",
  "  tool describe <tool-name>",
  "  tool call <tool-name> --input-json <json-or-> [--request-id <id>] [--agent <id>] [--config <path>]",
  "  liveware app list|inspect|create|access|delete [options]",
  "  liveware tunnel bind|unbind [options]",
  "  skills install",
  "  service install|start|stop|restart|status [--config <path>]",
  "  service logs [--lines <count>] [--follow] [--config <path>]",
  "  web [--no-open] [--config <path>]",
  "  status [--agent <agentId>] [--config <path>]",
  "  config get [key] [--config <path>]",
  "  config set <key> <value> [--config <path>]",
  "  doctor [--config <path>]",
  "  update [--version <release>] [--config <path>]",
].join("\n")}\n`;

const defaultIo: CliIo = {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

export async function runConnectCli(argv: string[], deps: ConnectCliDeps = {}): Promise<number> {
  const io: CliIo = {
    writeStdout: deps.writeStdout ?? defaultIo.writeStdout,
    writeStderr: deps.writeStderr ?? defaultIo.writeStderr,
  };
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    io.writeStdout(`clawchat-connect v${CONNECT_VERSION}\n`);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    io.writeStdout(HELP_TEXT);
    return 0;
  }
  const nestedAgentResult = await maybeRunNestedAgentCommand(
    argv,
    io,
    deps.removeAgentBinding ?? removeAgentBindingDefault,
  );
  if (nestedAgentResult !== null) return nestedAgentResult;
  const ownerResult = await maybeRunOwnerCommand(argv, io, deps);
  if (ownerResult !== null) return ownerResult;
  const pluginResult = await maybeRunPluginCommand(
    argv,
    io,
    deps.pluginManagementFetch ?? fetch,
    deps.readStdin ?? readStdinDefault,
    deps.pluginSourceOptions,
  );
  if (pluginResult !== null) return pluginResult;
  const nestedWorkspaceResult = await maybeRunNestedWorkspaceCommand(argv, io);
  if (nestedWorkspaceResult !== null) return nestedWorkspaceResult;
  const nestedProfileResult = await maybeRunNestedProfileCommand(
    argv,
    io,
    deps.updateAccountProfile ?? updateAccountProfileDefault,
  );
  if (nestedProfileResult !== null) return nestedProfileResult;
  const nestedToolResult = await maybeRunToolCommand(argv, io, deps);
  if (nestedToolResult !== null) return nestedToolResult;
  const livewareResult = await maybeRunAgentLivewareCommand(argv, io, deps);
  if (livewareResult !== null) return livewareResult;
  const skillsResult = await maybeRunSkillsCommand(argv, io);
  if (skillsResult !== null) return skillsResult;
  const serviceProcessResult = await maybeRunServiceProcessCommand(
    argv,
    io,
    deps.startConnectService ?? startConnectServiceDefault,
    deps.waitUntilShutdown,
  );
  if (serviceProcessResult !== null) return serviceProcessResult;
  const nestedServiceResult = await maybeRunNestedServiceCommand(
    argv,
    io,
    deps.manageBackgroundService ?? manageBackgroundServiceDefault,
  );
  if (nestedServiceResult !== null) return nestedServiceResult;
  const nestedConfigResult = await maybeRunNestedConfigCommand(argv, io);
  if (nestedConfigResult !== null) return nestedConfigResult;
  const webResult = await maybeRunWebCommand(
    argv,
    io,
    deps.openUrl ?? openUrlDefault,
    deps.pluginManagementFetch ?? fetch,
  );
  if (webResult !== null) return webResult;
  const updateResult = await maybeRunUpdateCommand(argv, io, deps.updateConnect ?? updateConnectDefault);
  if (updateResult !== null) return updateResult;

  const cli = cac("clawchat-connect");
  let commandRan = false;
  cli
    .command("init", "Create config")
    .option("--config <path>", "Config path")
    .option("--agent <id>", "Agent id")
    .option("--plugin <plugin-id>", "Installed Runtime Plugin ID")
    .option("--capability <capability-id>", "Runtime capability ID")
    .option("--runtime-config-json <object>", "Runtime capability configuration")
    .action(
      async (options: {
        config?: string;
        agent?: string;
        plugin?: string;
        capability?: string;
        runtimeConfigJson?: string;
      }) => {
        commandRan = true;
        let config = defaultConfig();
        if (options.agent || options.plugin || options.capability || options.runtimeConfigJson) {
          if (!options.agent) throw new Error("init requires --agent when Binding options are provided");
          const configPath = resolve(options.config ?? defaultConfigPath());
          config = upsertAgentBinding(config, options.agent, await validatedAgentBindingFromCli(options, configPath));
        }
        io.writeStdout(`Wrote config: ${await saveConfig(config, options.config)}\n`);
      },
    );

  cli
    .command("agent add <id>", "Add/update agent")
    .option("--config <path>", "Config path")
    .option("--plugin <plugin-id>", "Installed Runtime Plugin ID")
    .option("--capability <capability-id>", "Runtime capability ID")
    .option("--runtime-config-json <object>", "Runtime capability configuration")
    .action(
      async (
        id: string,
        options: { config?: string; plugin?: string; capability?: string; runtimeConfigJson?: string },
      ) => {
        commandRan = true;
        const configPath = resolve(options.config ?? defaultConfigPath());
        const config = upsertAgentBinding(
          await loadConfig(configPath),
          id,
          await validatedAgentBindingFromCli(options, configPath),
        );
        io.writeStdout(`Updated agent ${id}: ${await saveConfig(config, configPath)}\n`);
      },
    );

  cli
    .command("agent list", "List agents")
    .option("--config <path>", "Config path")
    .action(async (options: { config?: string }) => {
      commandRan = true;
      const configPath = resolve(options.config ?? defaultConfigPath());
      const config = await loadConfig(configPath);
      const installed = await listInstalledPlugins(configPath);
      const rows = Object.entries(config.agents).map(([id, agent]) =>
        formatAgentListRow(id, agent, id === config.defaultAgent, installed),
      );
      io.writeStdout(rows.length ? `${rows.join("\n")}\n` : "No agents configured.\n");
    });

  cli
    .command("agent remove <id>", "Remove agent")
    .option("--config <path>", "Config path")
    .option("--yes", "Confirm permanent Binding data deletion")
    .action(async (id: string, options: { config?: string; yes?: boolean }) => {
      commandRan = true;
      await runAgentBindingRemoval(id, options.config, options.yes ?? false, io, deps.removeAgentBinding);
    });

  cli
    .command("activate <agentId> <code>", "Activate agent")
    .option("--config <path>", "Config path")
    .action(async (agentId: string, code: string, options: { config?: string }) => {
      commandRan = true;
      const result = await (deps.activateConnect ?? activateConnectDefault)({
        agentId,
        code,
        configPath: options.config,
      });
      io.writeStdout(formatActivation(result));
    });

  cli
    .command("status", "Show status")
    .option("--config <path>", "Config path")
    .option("--agent <id>", "Agent id")
    .action(async (options: { config?: string; agent?: string }) => {
      commandRan = true;
      const configPath = resolve(options.config ?? defaultConfigPath());
      const config = await loadConfig(configPath);
      const agentId = options.agent ?? config.defaultAgent;
      const binding = agentId ? getAgentBinding(config, agentId) : undefined;
      const store = createStateStore({ dbPath: config.stateDbPath });
      const activation = agentId ? await store.getActivation(agentId) : null;
      const status = agentId ? await store.getRuntimeStatus(agentId) : null;
      const publications = agentId
        ? (await store.listPluginDurableState("clawling.exposure.liveware"))
            .filter((snapshot) => snapshot.namespace.instanceId === agentId)
            .sort((left, right) => right.namespace.activationGeneration - left.namespace.activationGeneration)
        : [];
      await store.close();
      const installed = await listInstalledPlugins(configPath);
      let managedWebApp: ManagedWebAppControlStatus | null = null;
      if (agentId) {
        try {
          const response = await (deps.pluginManagementFetch ?? fetch)(
            `${CORE_CONTROL_ORIGIN}/core/v1/status?bindingId=${encodeURIComponent(agentId)}`,
            { headers: { [CORE_CONTROL_CONFIG_HEADER]: configPath } },
          );
          if (response.ok) managedWebApp = (await response.json()) as ManagedWebAppControlStatus;
        } catch {
          managedWebApp = null;
        }
      }
      const publicationStatus = readPublicationControlStatus(publications[0]?.record.value);
      io.writeStdout(
        formatStatus(
          config,
          agentId,
          activation !== null,
          status,
          installed,
          binding,
          managedWebApp,
          publicationStatus,
        ),
      );
    });

  cli
    .command("doctor", "Check config")
    .option("--config <path>", "Config path")
    .action(async (options: { config?: string }) => {
      commandRan = true;
      const config = await loadConfig(options.config);
      const problems = [config.defaultAgent ? null : "defaultAgent is not set"].filter(Boolean);
      try {
        await verifyInstalledSkills();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      io.writeStdout(
        problems.length === 0
          ? "clawchat-connect doctor: ok\n"
          : `clawchat-connect doctor:\n- ${problems.join("\n- ")}\n`,
      );
    });

  try {
    cli.parse(["node", "clawchat-connect", ...argv], { run: false });
    await cli.runMatchedCommand();
    if (!commandRan) {
      io.writeStdout(HELP_TEXT);
      return 1;
    }
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunSkillsCommand(argv: string[], io: CliIo): Promise<number | null> {
  if (argv[0] !== "skills") return null;
  try {
    if (argv[1] === "preflight") {
      const result = await preflightManagedSkills();
      io.writeStdout(`${JSON.stringify({ ready: true, targetRoot: result.targetRoot })}\n`);
      return 0;
    }
    if (argv[1] !== "install") throw new Error("usage: clawchat-connect skills install|preflight");
    const result = await installManagedSkills();
    io.writeStdout(
      `${JSON.stringify({ installed: result.skills, targetRoot: result.targetRoot, forceOverwritten: true })}\n`,
    );
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunOwnerCommand(argv: string[], io: CliIo, deps: ConnectCliDeps): Promise<number | null> {
  if (argv[0] !== "owner") return null;
  try {
    if (argv[1] !== "reset") {
      throw new Error("owner action must be: reset");
    }
    io.writeStdout(OWNER_RESET_PREVIEW);
    if (!argv.includes("--yes-reset-owner")) {
      io.writeStdout(`Type ${OWNER_RESET_CONFIRMATION_PHRASE} to continue: `);
      const confirmation = (await (deps.readStdin ?? readStdinDefault)()).trim();
      if (confirmation !== OWNER_RESET_CONFIRMATION_PHRASE) {
        throw new Error("Owner Reset cancelled; confirmation phrase did not match");
      }
    }
    const result = await (deps.resetInstallationOwner ?? resetInstallationOwnerDefault)({
      configPath: optionValue(argv, "--config"),
    });
    io.writeStdout(formatOwnerReset(result));
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunAgentLivewareCommand(argv: string[], io: CliIo, deps: ConnectCliDeps): Promise<number | null> {
  if (argv[0] !== "liveware") return null;
  try {
    const area = argv[1];
    const action = argv[2];
    const operation = `${area === "tunnel" ? "liveware_tunnel" : "liveware_app"}_${action}` as AgentLivewareOperation;
    if (!isAgentLivewareOperation(operation))
      throw new Error("usage: clawchat-connect liveware app list|inspect|create|access|delete or tunnel bind|unbind");
    const input: Record<string, unknown> =
      operation === "liveware_app_list"
        ? {}
        : operation === "liveware_app_create"
          ? {
              name: requiredOption(argv, "--name"),
              policy: optionValue(argv, "--policy") ?? "private",
            }
          : operation === "liveware_app_access"
            ? {
                appId: requiredOption(argv, "--app-id"),
                policy: requiredOption(argv, "--policy"),
              }
            : operation === "liveware_tunnel_bind"
              ? {
                  appId: requiredOption(argv, "--app-id"),
                  upstream: requiredOption(argv, "--upstream"),
                }
              : { appId: requiredOption(argv, "--app-id") };
    const normalizedInput = validateAgentLivewareInput(operation, input);
    const config = await loadConfig(optionValue(argv, "--config"));
    const bindingId = optionValue(argv, "--agent") ?? process.env.CLAWCHAT_CONNECT_AGENT_ID ?? config.defaultAgent;
    if (!bindingId) throw new Error("no Agent Binding selected; pass --agent or configure defaultAgent");
    getAgentBinding(config, bindingId);
    const store = (deps.createStateStore ?? createStateStore)({ dbPath: config.stateDbPath });
    try {
      const requestId = optionValue(argv, "--request-id")?.trim() || randomUUID();
      let record = await store.submitToolRequest({
        requestId,
        bindingId,
        toolName: operation,
        normalizedInput,
        recordedInput: normalizedInput,
        timeoutMs: 120_000,
      });
      record = await waitForTerminalToolRequest(store, record, deps.toolRequestWaitMs ?? 121_000, deps.sleep);
      const success = record.state === "succeeded";
      io.writeStdout(
        `${JSON.stringify({
          requestId,
          operation,
          status: record.state,
          ...(success
            ? { result: record.result }
            : { error: record.error ?? "Connect Service did not settle the request before the deadline" }),
        })}\n`,
      );
      return success ? 0 : 1;
    } finally {
      await store.close();
    }
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function requiredOption(argv: string[], name: string): string {
  const value = optionValue(argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function maybeRunToolCommand(argv: string[], io: CliIo, deps: ConnectCliDeps): Promise<number | null> {
  if (argv[0] !== "tool") return null;
  try {
    if (argv[1] === "list") {
      io.writeStdout(
        `${JSON.stringify({ tools: CONNECT_TOOL_CATALOG.map(({ name, description, timeoutMs }) => ({ name, description, timeoutMs })) })}\n`,
      );
      return 0;
    }
    const toolName = argv[2] ?? "";
    const tool = getConnectTool(toolName);
    if (!tool) throw new Error(`unknown ClawChat tool: ${toolName || "(missing)"}`);
    if (argv[1] === "describe") {
      io.writeStdout(
        `${JSON.stringify({ name: tool.name, description: tool.description, timeoutMs: tool.timeoutMs, inputSchema: toolJsonSchema(tool) })}\n`,
      );
      return 0;
    }
    if (argv[1] !== "call") throw new Error("usage: clawchat-connect tool list|describe|call");
    const config = await loadConfig(optionValue(argv, "--config"));
    const bindingId = optionValue(argv, "--agent") ?? process.env.CLAWCHAT_CONNECT_AGENT_ID ?? config.defaultAgent;
    if (!bindingId) throw new Error("no Agent Binding selected; pass --agent or configure defaultAgent");
    getAgentBinding(config, bindingId);
    const inputOption = optionValue(argv, "--input-json");
    if (inputOption == null) throw new Error("tool call requires --input-json <json-or->");
    const inputText = inputOption === "-" ? await (deps.readStdin ?? readStdinDefault)() : inputOption;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputText);
    } catch (error) {
      throw new Error(`invalid --input-json: ${error instanceof Error ? error.message : String(error)}`);
    }
    const normalizedInput = validateToolInput(tool, parsed);
    const requestId = optionValue(argv, "--request-id")?.trim() || randomUUID();
    const store = (deps.createStateStore ?? createStateStore)({ dbPath: config.stateDbPath });
    try {
      let record = await store.submitToolRequest({
        requestId,
        bindingId,
        toolName,
        normalizedInput,
        recordedInput: recordToolInput(tool, normalizedInput),
        timeoutMs: tool.timeoutMs,
      });
      record = await waitForTerminalToolRequest(
        store,
        record,
        deps.toolRequestWaitMs ?? tool.timeoutMs + 1_000,
        deps.sleep,
      );
      const success = record.state === "succeeded";
      io.writeStdout(
        `${JSON.stringify({
          requestId,
          toolName,
          status: record.state,
          ...(success
            ? { result: record.result }
            : { error: record.error ?? "Connect Service did not settle the request before the deadline" }),
        })}\n`,
      );
      return success ? 0 : 1;
    } finally {
      await store.close();
    }
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function waitForTerminalToolRequest(
  store: ConnectStateStore,
  initial: ToolRequestRecord,
  waitMs: number,
  sleep: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<ToolRequestRecord> {
  let record = initial;
  const deadline = Date.now() + Math.max(0, waitMs);
  while (record.state === "pending" || record.state === "running") {
    if (Date.now() >= deadline) return (await store.expireToolRequest(record.requestId)) ?? record;
    await sleep(50);
    record = (await store.getToolRequest(record.requestId)) ?? record;
  }
  return record;
}

async function readStdinDefault(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function maybeRunUpdateCommand(
  argv: string[],
  io: CliIo,
  updateConnect: typeof updateConnectDefault,
): Promise<number | null> {
  if (argv[0] !== "update") return null;
  try {
    const result = await updateConnect({
      version: optionValue(argv, "--version"),
      configPath: optionValue(argv, "--config"),
    });
    io.writeStdout(`Updated ClawChat Connect to ${result.version}: ${result.executablePath}\n`);
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunNestedWorkspaceCommand(argv: string[], io: CliIo): Promise<number | null> {
  if (argv[0] !== "workspace") return null;
  const action = argv[1];
  const bindingId = argv[2];
  const configPath = optionValue(argv, "--config");
  let store: ConnectStateStore | null = null;
  try {
    const config = await loadConfig(configPath);
    if (!bindingId || !config.agents[bindingId]) throw new Error("workspace requires a valid Agent Binding ID");
    store = createStateStore({ dbPath: config.stateDbPath });
    const workspaces = new WorkspaceCatalog(store);
    if (action === "add") {
      const rootPath = argv[3];
      if (!rootPath || rootPath.startsWith("--")) throw new Error("workspace add requires an absolute path");
      const workspace = await workspaces.add(bindingId, rootPath);
      io.writeStdout(
        `Registered Workspace ${workspace.name} (${workspace.workspaceRef}) for ${bindingId} at ${workspace.rootPath}.\n`,
      );
      return 0;
    }
    if (action === "list") {
      const rows = (await workspaces.list(bindingId)).map(
        (workspace) => `- ${workspace.name} (${workspace.workspaceRef}): ${workspace.rootPath}`,
      );
      io.writeStdout(rows.length > 0 ? `${rows.join("\n")}\n` : "No Workspaces registered.\n");
      return 0;
    }
    if (action === "remove") {
      const workspaceRef = argv[3];
      if (!workspaceRef || workspaceRef.startsWith("--")) throw new Error("workspace remove requires a Workspace Ref");
      const workspace = await workspaces.remove(bindingId, workspaceRef);
      io.writeStdout(`Removed Workspace ${workspace.name}.\n`);
      return 0;
    }
    throw new Error("workspace action must be one of: add, list, remove");
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await store?.close();
  }
}

async function maybeRunWebCommand(
  argv: string[],
  io: CliIo,
  openUrl: (url: string) => Promise<void>,
  fetchTarget: PluginManagementFetch,
): Promise<number | null> {
  if (argv[0] !== "web") return null;
  const configPath = resolve(optionValue(argv, "--config") ?? defaultConfigPath());
  try {
    const installed = (await listInstalledPlugins(configPath)).find(
      (plugin) =>
        plugin.pluginId === CONNECT_CLIENT_PLUGIN_ID &&
        plugin.status === "active" &&
        plugin.manifest.capabilities.some(
          (capability) =>
            capability.type === "managed-web-app" && capability.id === CONNECT_CLIENT_MANAGED_WEB_APP_CAPABILITY_ID,
        ),
    );
    if (!installed) {
      throw new Error(
        "Connect Client is unavailable: install and enable the optional clawling.web.connect-client Plugin",
      );
    }
    const config = await loadConfig(configPath);
    const bindingIds = Object.keys(config.agents).sort();
    if (bindingIds.length === 0) {
      throw new Error("Connect Client is installed but no Agent Binding can acquire it");
    }
    let url: string | undefined;
    for (const bindingId of bindingIds) {
      let response: Response;
      try {
        response = await fetchTarget(`${CORE_CONTROL_ORIGIN}${CORE_CLIENT_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_CONTROL_CONFIG_HEADER]: configPath,
          },
          body: JSON.stringify({ bindingId }),
        });
      } catch (error) {
        throw new Error("Connect service is not running; start it before opening the Connect Client", {
          cause: error,
        });
      }
      if (response.status === 404) continue;
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(detail?.error?.message ?? `Connect Client acquisition failed (HTTP ${response.status})`);
      }
      const body = (await response.json()) as { origin?: unknown };
      if (typeof body.origin !== "string") {
        throw new Error("Connect service returned an invalid Connect Client origin");
      }
      const origin = new URL(body.origin);
      if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) {
        throw new Error("Connect service returned a non-local Connect Client origin");
      }
      url = `${origin.origin}/`;
      break;
    }
    if (!url) {
      throw new Error("Connect Client is installed but no configured Agent Binding supports it");
    }
    io.writeStdout(`Connect Client URL: ${url}\n`);
    if (!argv.includes("--no-open")) await openUrl(url);
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function openUrlDefault(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Could not open the browser; use the printed Connect Client URL (exit ${code})`);
}

class PluginManagerUnavailableError extends Error {}

async function maybeRunPluginCommand(
  argv: string[],
  io: CliIo,
  fetchPluginManager: PluginManagementFetch,
  readStdin: () => Promise<string>,
  sourceOptions: OfficialPluginDiscoveryOptions = {},
): Promise<number | null> {
  if (argv[0] !== "plugin") return null;
  const action = argv[1];
  const configPath = resolve(optionValue(argv, "--config") ?? defaultConfigPath());
  try {
    const config = await loadConfig(configPath);
    const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const origin = CORE_CONTROL_ORIGIN;
      let response: Response;
      try {
        response = await fetchPluginManager(`${origin}/core/v1/plugins${path}`, {
          method,
          headers: {
            Origin: origin,
            [CORE_CONTROL_CONFIG_HEADER]: configPath,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new PluginManagerUnavailableError("The running Connect Plugin manager is unavailable", { cause: error });
      }
      const value: unknown = await response.json();
      if (!response.ok) {
        const detail =
          value !== null &&
          typeof value === "object" &&
          "error" in value &&
          value.error !== null &&
          typeof value.error === "object" &&
          "message" in value.error &&
          typeof value.error.message === "string"
            ? value.error.message
            : undefined;
        throw new Error(detail || `Plugin management request failed with HTTP ${response.status}`);
      }
      return value as T;
    };
    const sourceConfiguration = (source?: string) => ({
      ...(source ? { source } : {}),
      installationConfiguration: parseJsonObjectOption(
        optionValue(argv, "--installation-config-json"),
        "--installation-config-json",
      ),
      capabilityConfigurations: parseJsonObjectOption(
        optionValue(argv, "--capability-config-json"),
        "--capability-config-json",
      ),
    });

    if (action === "install") {
      const sourceArgument = argv[2];
      if (!sourceArgument || sourceArgument.startsWith("--"))
        throw new Error("plugin install requires a Plugin source");
      const source = cliPluginSource(sourceArgument);
      let installed: InstalledPluginLockEntry;
      try {
        installed = await request("", "POST", sourceConfiguration(source));
      } catch (error) {
        if (!(error instanceof PluginManagerUnavailableError)) throw error;
        const resolved = await resolvePluginSource(source, sourceOptions);
        installed = await installPluginBundle({
          configPath,
          ...sourceConfiguration(),
          source: resolved.source,
          bundle: resolved.bundle,
          target: resolved.target,
        });
      }
      io.writeStdout(formatPluginOperation("Installed", installed));
      return 0;
    }
    if (action === "setup") {
      const offlineCandidates = new Map<string, BundledOfficialPluginEntry>();
      let discovery: OfficialPluginDiscovery;
      let installSelection: (pluginIds: readonly string[]) => Promise<InstalledPluginLockEntry[]>;
      try {
        discovery = await request<OfficialPluginDiscovery>("/official");
        installSelection = async (pluginIds) =>
          await request<InstalledPluginLockEntry[]>("/official/setup", "POST", { pluginIds });
      } catch (error) {
        if (!(error instanceof PluginManagerUnavailableError)) throw error;
        discovery = await discoverOfficialPlugins(sourceOptions, (entry) => {
          offlineCandidates.set(entry.pluginId, entry);
        });
        installSelection = async (pluginIds) => {
          const installed: InstalledPluginLockEntry[] = [];
          for (const pluginId of pluginIds) {
            const candidate = offlineCandidates.get(pluginId);
            if (!candidate) {
              throw new Error(`Official Plugin ${pluginId} is not in the latest staged discovery`);
            }
            const resolved = await resolveBundledOfficialPlugin(candidate, sourceOptions);
            installed.push(
              await refreshOfficialPluginBundle({
                configPath,
                stateDbPath: config.stateDbPath,
                source: resolved.source,
                bundle: resolved.bundle,
                target: resolved.target,
                installationConfiguration: candidate.installationConfiguration,
                capabilityConfigurations: candidate.capabilityConfigurations,
              }),
            );
          }
          return installed;
        };
      }
      for (const diagnostic of discovery.diagnostics) io.writeStderr(`${diagnostic}\n`);
      if (discovery.candidates.length === 0) {
        io.writeStdout(
          "No official Plugins are available; direct npm, GitHub, and local installation remain available.\n",
        );
        return 0;
      }
      const initiallySelected = new Set(
        discovery.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.pluginId),
      );
      io.writeStdout(
        `${discovery.candidates
          .map(
            (candidate) =>
              `${candidate.selected ? "[x]" : "[ ]"} ${candidate.pluginId}@${candidate.version} — ${
                candidate.diagnostic ??
                (candidate.detected ? "detected compatible runtime" : "not detected; selectable")
              }`,
          )
          .join("\n")}\n`,
      );
      let selected: Set<string>;
      const explicit = optionValue(argv, "--select");
      if (argv.includes("--non-interactive")) {
        if (explicit === undefined) throw new Error("plugin setup --non-interactive requires --select <id,id>");
        selected = commaSeparatedPluginIds(explicit);
      } else {
        io.writeStdout(
          `Select official Plugin IDs separated by commas (Enter keeps detected selections: ${[...initiallySelected].join(",") || "none"}): `,
        );
        const answer = (await readStdin()).trim();
        selected = answer ? commaSeparatedPluginIds(answer) : initiallySelected;
      }
      for (const pluginId of commaSeparatedPluginIds(optionValue(argv, "--deselect") ?? "")) selected.delete(pluginId);
      const available = new Set(discovery.candidates.map((candidate) => candidate.pluginId));
      const unknown = [...selected].filter((pluginId) => !available.has(pluginId));
      if (unknown.length > 0) {
        throw new Error(`Official Plugin selection is not in the bundled registry: ${unknown.join(", ")}`);
      }
      const installed = await installSelection([...selected]);
      for (const entry of installed) io.writeStdout(formatPluginOperation("Installed", entry));
      if (installed.length === 0) io.writeStdout("No official Plugins selected.\n");
      return 0;
    }
    if (action === "list") {
      let installed: InstalledPluginLockEntry[];
      try {
        installed = await request("");
      } catch (error) {
        if (!(error instanceof PluginManagerUnavailableError)) throw error;
        installed = await listInstalledPlugins(configPath);
      }
      if (installed.length === 0) {
        io.writeStdout("No Plugins installed.\n");
        return 0;
      }
      io.writeStdout(
        `${installed
          .map((plugin) => {
            const dependents = pluginDependents(config, plugin.pluginId);
            return [
              `- ${plugin.pluginId}@${plugin.version} [${plugin.status}]`,
              `  source: ${formatPluginSource(plugin.source)}`,
              `  target: ${plugin.target}`,
              `  integrity: ${plugin.integrity}`,
              `  capabilities: ${formatPluginCapabilities(plugin)}`,
              `  dependent Bindings: ${dependents.length > 0 ? dependents.join(", ") : "none"}`,
              `  retained versions: ${
                plugin.retainedVersions.length > 0
                  ? plugin.retainedVersions.map((version) => `${version.version} (${version.integrity})`).join(", ")
                  : "none"
              }`,
              ...(plugin.error ? [`  diagnostic: ${plugin.error}`] : []),
            ].join("\n");
          })
          .join("\n")}\n`,
      );
      return 0;
    }

    const pluginId = argv[2];
    if (!pluginId || pluginId.startsWith("--")) throw new Error(`plugin ${action ?? "operation"} requires a Plugin ID`);
    let managed: InstalledPluginLockEntry;
    if (action === "update") {
      const candidate = argv[3];
      const source = candidate && !candidate.startsWith("--") ? cliPluginSource(candidate) : undefined;
      managed = await request(`/${encodeURIComponent(pluginId)}/update`, "POST", sourceConfiguration(source));
      io.writeStdout(formatPluginOperation("Updated", managed));
      return 0;
    }
    if (action === "replace") {
      const candidate = argv[3];
      if (!candidate || candidate.startsWith("--")) throw new Error("plugin replace requires a Plugin source");
      managed = await request(
        `/${encodeURIComponent(pluginId)}/replace`,
        "POST",
        sourceConfiguration(cliPluginSource(candidate)),
      );
      io.writeStdout(formatPluginOperation("Replaced", managed));
      return 0;
    }

    if (action === "enable" || action === "disable") {
      managed = await request(`/${encodeURIComponent(pluginId)}/${action}`, "POST", {});
      io.writeStdout(formatPluginOperation(action === "enable" ? "Enabled" : "Disabled", managed));
      return 0;
    }
    if (action === "remove") {
      const force = argv.includes("--force");
      managed = await request(`/${encodeURIComponent(pluginId)}${force ? "?force=1" : ""}`, "DELETE");
      io.writeStdout(formatPluginOperation("Removed", managed));
      return 0;
    }
    if (action === "select") {
      const version = argv[3];
      if (!version || version.startsWith("--")) throw new Error("plugin select requires a retained version");
      managed = await request(`/${encodeURIComponent(pluginId)}/select`, "POST", {
        version,
        integrity: optionValue(argv, "--integrity"),
      });
      io.writeStdout(formatPluginOperation("Selected", managed));
      return 0;
    }
    throw new Error(
      "plugin action must be one of: install, update, replace, setup, enable, disable, remove, select, list",
    );
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function formatPluginOperation(verb: string, installed: InstalledPluginLockEntry): string {
  return [
    `${verb} Plugin ${installed.pluginId}@${installed.version}`,
    `Source: ${formatPluginSource(installed.source)}`,
    `Target: ${installed.target}`,
    `Integrity: ${installed.integrity}`,
    `Capabilities: ${formatPluginCapabilities(installed)}`,
    "",
  ].join("\n");
}

function cliPluginSource(value: string): string {
  if (value.startsWith("npm:") || value.startsWith("github:") || /^https:\/\/github\.com\//u.test(value)) return value;
  const path = resolve(value.startsWith("local:") ? value.slice(6) : value);
  return `local:${path}`;
}

function commaSeparatedPluginIds(value: string): Set<string> {
  const ids = value
    .split(",")
    .map((pluginId) => pluginId.trim())
    .filter(Boolean);
  return new Set(ids);
}

function formatPluginSource(source: InstalledPluginLockEntry["source"]): string {
  if (source.type === "local") return `local:${source.path}`;
  if (source.type === "npm") return `npm:${source.package}@${source.version} (${source.registry})`;
  return `github:${source.repository}@${source.release}`;
}

function formatPluginCapabilities(installed: InstalledPluginLockEntry): string {
  return installed.manifest.capabilities
    .map((capability) => {
      if (capability.type === "runtime") {
        return `${capability.id} (runtime:${capability.family})`;
      }
      if (capability.type === "exposure") return `${capability.id} (exposure)`;
      if (capability.type === "client-extension") {
        return `${capability.id} (client-extension for ${capability.managedWebApp.pluginId}/${capability.managedWebApp.capabilityId})`;
      }
      const native = capability.nativeRuntimeCapabilityIds.map(
        (capabilityId) => `${installed.pluginId}/${capabilityId}`,
      );
      const compatible = capability.compatibleRuntimes.map((runtime) => `${runtime.pluginId}/${runtime.capabilityId}`);
      return `${capability.id} (managed-web-app:${capability.displayName}; native: ${
        native.length > 0 ? native.join("|") : "none"
      }; compatible: ${compatible.length > 0 ? compatible.join("|") : "none"})`;
    })
    .join(", ");
}

async function maybeRunNestedAgentCommand(
  argv: string[],
  io: CliIo,
  removeAgentBinding: (options: { agentId: string; configPath?: string }) => Promise<RemoveAgentBindingResult>,
): Promise<number | null> {
  if (argv[0] !== "agent") return null;
  const action = argv[1];
  const id = argv[2];
  const configPath = resolve(optionValue(argv, "--config") ?? defaultConfigPath());
  try {
    if (action === "add") {
      if (!id) throw new Error("agent id is required");
      const binding = await validatedAgentBindingFromCli(
        {
          plugin: optionValue(argv, "--plugin"),
          capability: optionValue(argv, "--capability"),
          runtimeConfigJson: optionValue(argv, "--runtime-config-json"),
        },
        configPath,
      );
      const config = upsertAgentBinding(await loadConfig(configPath), id, binding);
      io.writeStdout(`Updated agent ${id}: ${await saveConfig(config, configPath)}\n`);
      return 0;
    }
    if (action === "list") {
      const config = await loadConfig(configPath);
      const installed = await listInstalledPlugins(configPath);
      const rows = Object.entries(config.agents).map(([agentId, agent]) =>
        formatAgentListRow(agentId, agent, agentId === config.defaultAgent, installed),
      );
      io.writeStdout(rows.length ? `${rows.join("\n")}\n` : "No agents configured.\n");
      return 0;
    }
    if (action === "remove") {
      if (!id) throw new Error("agent id is required");
      await runAgentBindingRemoval(id, configPath, argv.includes("--yes"), io, removeAgentBinding);
      return 0;
    }
    io.writeStdout(HELP_TEXT);
    return 1;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runAgentBindingRemoval(
  agentId: string,
  configPath: string | undefined,
  confirmed: boolean,
  io: CliIo,
  removeAgentBinding: typeof removeAgentBindingDefault = removeAgentBindingDefault,
): Promise<void> {
  if (!confirmed) {
    throw new Error(
      `Removing Agent Binding ${agentId} retires its Liveware Publication and permanently deletes its Sessions and Connect-owned Workspace records; Workspace files remain; repeat with --yes`,
    );
  }
  const result = await removeAgentBinding({ agentId, configPath });
  io.writeStdout(`Removed Agent Binding ${result.agentId}: ${result.configPath}\n`);
}

async function maybeRunNestedProfileCommand(
  argv: string[],
  io: CliIo,
  updateAccountProfile: typeof updateAccountProfileDefault,
): Promise<number | null> {
  if (argv[0] !== "profile") return null;
  if (argv[1] !== "update") {
    io.writeStdout(HELP_TEXT);
    return 1;
  }
  try {
    const patch: AccountProfilePatch = {};
    const nickname = optionValue(argv, "--nickname");
    const avatarUrl = optionValue(argv, "--avatar-url");
    const bio = optionValue(argv, "--bio");
    if (nickname !== undefined) patch.nickname = nickname;
    if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;
    if (bio !== undefined) patch.bio = bio;
    if (Object.keys(patch).length === 0)
      throw new Error("profile update requires at least one Profile field: nickname, avatar URL, or bio");
    const result = await updateAccountProfile({
      agentId: optionValue(argv, "--agent"),
      configPath: optionValue(argv, "--config"),
      patch,
    });
    io.writeStdout(`Updated ClawChat Profile for ${result.agentId}.\n`);
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunServiceProcessCommand(
  argv: string[],
  io: CliIo,
  startConnectService: typeof startConnectServiceDefault,
  waitUntilShutdown?: () => Promise<void>,
): Promise<number | null> {
  if (argv[0] !== "service" || argv[1] !== BACKGROUND_SERVICE_PROCESS_ACTION) return null;
  try {
    await startConnectService({
      configPath: optionValue(argv, "--config"),
      waitUntilShutdown,
      writeOutput: io.writeStdout,
      writeError: io.writeStderr,
    });
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunNestedServiceCommand(
  argv: string[],
  io: CliIo,
  manageBackgroundService: typeof manageBackgroundServiceDefault,
): Promise<number | null> {
  if (argv[0] !== "service") return null;
  try {
    const action = argv[1];
    if (!isBackgroundServiceAction(action)) {
      throw new Error("service action must be one of: install, start, stop, restart, status, logs");
    }
    if (argv.includes("--agent")) {
      throw new Error(
        "the Connect Service manages all activated Agent Bindings; service commands do not accept --agent",
      );
    }
    const configPath = resolve(optionValue(argv, "--config") ?? defaultConfigPath());
    if (action === "install" && Object.keys((await loadConfig(configPath)).agents).length === 0) {
      throw new Error("configure at least one Agent Binding before installing the Connect Service");
    }
    const linesValue = optionValue(argv, "--lines");
    const lines = linesValue === undefined ? undefined : Number(linesValue);
    const result = await manageBackgroundService({
      action,
      configPath,
      ...(lines !== undefined ? { lines } : {}),
      ...(argv.includes("--follow") ? { follow: true } : {}),
    });
    io.writeStdout(result.message);
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function maybeRunNestedConfigCommand(argv: string[], io: CliIo): Promise<number | null> {
  if (argv[0] !== "config") return null;
  const action = argv[1];
  const configPath = optionValue(argv, "--config");
  try {
    if (action === "get") {
      const key = argv[2]?.startsWith("--") ? undefined : argv[2];
      const config = await loadConfig(configPath);
      io.writeStdout(`${JSON.stringify(key ? readConfigValue(config, key) : config, null, 2)}\n`);
      return 0;
    }
    if (action === "set") {
      const key = argv[2];
      const value = argv[3];
      if (!key || value === undefined) throw new Error("config set requires a key and value");
      const config = await loadConfig(configPath);
      setConfigValue(config, key, value);
      io.writeStdout(`Updated config: ${await saveConfig(config, configPath)}\n`);
      return 0;
    }
    throw new Error("config action must be one of: get, set");
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isBackgroundServiceAction(value: string | undefined): value is BackgroundServiceAction {
  return (
    value === "install" ||
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "status" ||
    value === "logs"
  );
}

async function validatedAgentBindingFromCli(options: AgentCliOptions, configPath: string): Promise<AgentBindingConfig> {
  const binding = agentBindingFromCli(options);
  const installed = (await listInstalledPlugins(configPath)).find(
    (candidate) => candidate.pluginId === binding.runtime.pluginId,
  );
  if (!installed) throw new Error(`Plugin is not installed: ${binding.runtime.pluginId}`);
  if (installed.status !== "active") {
    const diagnostic = installed.error ? `: ${installed.error}` : "";
    throw new Error(`Plugin ${installed.pluginId} is not active (status: ${installed.status})${diagnostic}`);
  }
  const capability = installed.manifest.capabilities.find((candidate) => candidate.id === binding.runtime.capabilityId);
  if (!capability) {
    throw new Error(`Plugin ${installed.pluginId} has no capability ${binding.runtime.capabilityId}`);
  }
  if (capability.type !== "runtime") {
    throw new Error(
      `Plugin ${installed.pluginId} capability ${binding.runtime.capabilityId} is not a Runtime capability`,
    );
  }
  const validatedBinding = {
    ...binding,
    runtimeConfig: validatePluginConfiguration(
      capability.configurationSchema,
      binding.runtimeConfig,
      `Plugin ${installed.pluginId}/${capability.id} Runtime configuration`,
    ),
  };
  await validateInstalledRuntimeBinding(configPath, validatedBinding);
  return validatedBinding;
}

function agentBindingFromCli(options: AgentCliOptions): AgentBindingConfig {
  if (!options.plugin?.trim() || !options.capability?.trim()) {
    throw new Error("Agent Binding requires --plugin <plugin-id> and --capability <capability-id>");
  }
  let configuration: unknown = {};
  if (options.runtimeConfigJson) {
    try {
      configuration = JSON.parse(options.runtimeConfigJson) as unknown;
    } catch {
      throw new Error("--runtime-config-json must be a JSON object");
    }
  }
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("--runtime-config-json must be a JSON object");
  }
  return createAgentBinding({
    pluginId: options.plugin,
    capabilityId: options.capability,
    configuration: configuration as Record<string, unknown>,
  });
}

function formatAgentListRow(
  id: string,
  binding: AgentBindingConfig,
  isDefault: boolean,
  installed: readonly InstalledPluginLockEntry[],
): string {
  const selected = isDefault ? " (default)" : "";
  const family = runtimeFamilyFromManifest(binding, installed);
  return `- ${id}${selected}: ${family} (${binding.runtime.pluginId}/${binding.runtime.capabilityId})`;
}

function runtimeFamilyFromManifest(
  binding: AgentBindingConfig,
  installed: readonly InstalledPluginLockEntry[],
): string {
  const plugin = installed.find((candidate) => candidate.pluginId === binding.runtime.pluginId);
  const capability = plugin?.manifest.capabilities.find(
    (candidate) => candidate.id === binding.runtime.capabilityId && candidate.type === "runtime",
  );
  return capability?.type === "runtime" ? capability.family : "unavailable Runtime capability";
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseJsonObjectOption(value: string | undefined, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function formatOwnerReset(result: ResetInstallationOwnerResult): string {
  return `${[
    result.ownerUserId
      ? `Reset Installation Owner ${result.ownerUserId}.`
      : "Reset ambiguous legacy Installation Owner state.",
    `removed Agent Bindings: ${result.removedBindings.length > 0 ? result.removedBindings.join(", ") : "none"}`,
    `Connect is unowned: ${result.configPath}`,
  ].join("\n")}\n`;
}

function formatActivation(result: ActivateConnectResult): string {
  return `${[
    `ClawChat Connect agent \`${result.localAgentId}\` activated.`,
    `agent user: ${result.userId}`,
    `owner user: ${result.ownerUserId}`,
  ].join("\n")}\n`;
}

interface PublicationControlStatus {
  readonly status: string;
  readonly transition: string | null;
  readonly diagnostic: string | null;
}

function readPublicationControlStatus(value: unknown): PublicationControlStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "none", transition: null, diagnostic: null };
  }
  const record = value as Record<string, unknown>;
  return {
    status: typeof record.status === "string" ? record.status : "none",
    transition: typeof record.transition === "string" ? record.transition : null,
    diagnostic: typeof record.diagnostic === "string" ? secretSafeDiagnostic(record.diagnostic) : null,
  };
}

function secretSafeDiagnostic(value: string): string {
  return value
    .replace(/(authorization|credential|password|secret|token|api[-_ ]?key)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gu, "http://[redacted]@")
    .slice(0, 512);
}

function formatStatus(
  config: ConnectConfig,
  agentId: string | null,
  activated: boolean,
  status: Awaited<ReturnType<ConnectStateStore["getRuntimeStatus"]>>,
  installed: readonly InstalledPluginLockEntry[],
  binding: AgentBindingConfig | undefined,
  managedWebApp: ManagedWebAppControlStatus | null,
  publication: PublicationControlStatus,
): string {
  return `${[
    "ClawChat Connect status",
    `agent: ${agentId ?? "not selected"}`,
    ...(binding
      ? [
          `runtime capability: ${runtimeFamilyFromManifest(binding, installed)} (${binding.runtime.pluginId}/${binding.runtime.capabilityId})`,
        ]
      : []),
    `configured agents: ${Object.keys(config.agents).length}`,
    `activated: ${activated ? "yes" : "no"}`,
    `websocket: ${config.websocketUrl}`,
    `media upload: ${config.mediaUploadUrl}`,
    `runtime: ${status?.websocketConnected === true ? "connected" : status?.websocketConnected === false ? "disconnected" : "unknown"}`,
    `running: ${status?.globalRunning ?? 0}`,
    `queued: ${status?.globalQueued ?? 0}`,
    ...managedWebAppStatusLines(binding, installed, managedWebApp),
    `publication: ${publication.status}`,
    ...(publication.transition ? [`publication transition: ${publication.transition}`] : []),
    ...(publication.diagnostic ? [`publication diagnostic: ${publication.diagnostic}`] : []),
    ...(status?.recentError ? [`recent diagnostic: ${status.recentError}`] : []),
  ].join("\n")}\n`;
}

function managedWebAppStatusLines(
  binding: AgentBindingConfig | undefined,
  installed: readonly InstalledPluginLockEntry[],
  running: ManagedWebAppControlStatus | null,
): string[] {
  if (!binding) return ["managed app: absence (no eligible app)", "app instance: absence"];
  if (running?.selection) {
    const selection = running.selection;
    return [
      `managed app: ${selection.pluginId}/${selection.capabilityId}@${selection.activationGeneration} (${selection.kind})`,
      running.instance
        ? `app instance: ${running.instance.instanceKey} [${running.instance.health}], leases: ${running.instance.leaseCount}`
        : "app instance: [stopped], leases: 0",
      ...(running.instance?.diagnostic ? [`app diagnostic: ${secretSafeDiagnostic(running.instance.diagnostic)}`] : []),
    ];
  }
  const selected = selectManagedWebApp(
    binding.runtime,
    installed
      .filter((plugin) => plugin.status === "active")
      .flatMap((plugin) =>
        plugin.manifest.capabilities.flatMap((capability) =>
          capability.type === "managed-web-app"
            ? [
                {
                  pluginId: plugin.pluginId,
                  capabilityId: capability.id,
                  activationGeneration: plugin.activationGeneration,
                  manifest: capability,
                },
              ]
            : [],
        ),
      ),
  );
  if (!selected) return ["managed app: absence (no eligible app)", "app instance: absence"];
  return [
    `managed app: ${selected.pluginId}/${selected.capabilityId}@${selected.activationGeneration} (${selected.kind})`,
    "app instance: Core control unavailable",
  ];
}

function readConfigValue(config: ConnectConfig, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined),
      config,
    );
}

function setConfigValue(config: ConnectConfig, key: string, value: string): void {
  if (key === "baseUrl") {
    config.baseUrl = value;
    return;
  }
  if (key === "websocketUrl") {
    config.websocketUrl = value;
    return;
  }
  if (key === "mediaUploadUrl") {
    config.mediaUploadUrl = value;
    return;
  }
  if (key === "stateDbPath") {
    config.stateDbPath = value;
    return;
  }
  if (key === "defaultAgent") {
    config.defaultAgent = value;
    return;
  }
  if (key === "outputVisibility") {
    config.outputVisibility = parseOutputVisibility(value);
    return;
  }
  const match = key.match(/^agents\.([^.]+)\.([A-Za-z]+)$/u);
  if (!match) throw new Error(`Unsupported config key: ${key}`);
  const agentId = match[1];
  const field = match[2];
  if (!agentId || !field) throw new Error(`Unsupported config key: ${key}`);
  const binding = config.agents[agentId];
  if (!binding) throw new Error(`Unknown clawchat-connect agent: ${agentId}`);
  if (field === "displayName") {
    binding.displayName = value;
    return;
  }
  if (field === "model") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Agent Binding model must not be empty");
    if (!trimmed.startsWith("{")) {
      binding.model = { model: trimmed };
      return;
    }
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Agent Binding model must be a structured model selection");
    }
    const selection = parsed as Record<string, unknown>;
    if (typeof selection.model !== "string" || !selection.model.trim()) {
      throw new Error("Agent Binding model.model must not be empty");
    }
    if (selection.provider !== undefined && (typeof selection.provider !== "string" || !selection.provider.trim())) {
      throw new Error("Agent Binding model.provider must not be empty");
    }
    binding.model = {
      ...(typeof selection.provider === "string" ? { provider: selection.provider.trim() } : {}),
      model: selection.model.trim(),
    };
    return;
  }
  if (field === "modelReasoningEffort") {
    binding.modelReasoningEffort = value;
    return;
  }
  throw new Error(`Unsupported Agent Binding config key: ${key}`);
}

function parseOutputVisibility(value: string): OutputVisibility {
  const mode = value.trim().toLowerCase();
  if (mode === "minimal" || mode === "normal" || mode === "full") return mode;
  throw new Error("outputVisibility must be minimal, normal, or full");
}
