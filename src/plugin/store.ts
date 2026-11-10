import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { createStateStore, MAX_PLUGIN_DURABLE_STATE_BYTES } from "../persistence/state";
import type { AgentBindingConfig } from "../types";
import type {
  ConnectPluginBundleV1,
  ConnectPluginCapabilityManifest,
  ConnectPluginHostCapabilityDependency,
  ConnectPluginManifestV1,
} from "./sdk";
import {
  CONNECT_CLIENT_EXTENSION_SLOT_CATALOG,
  CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_BUNDLE_FORMAT,
  CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
  CONNECT_PLUGIN_INTERFACE_VERSION,
  CONNECT_PLUGIN_MANIFEST_VERSION,
  type ConnectPluginArtifactManifest,
  type ConnectPluginConfiguration,
  type ConnectPluginDurableStateManifest,
  type ConnectPluginJsonSchema,
  type ConnectPluginSource,
} from "./sdk";

export const CONNECT_PLUGIN_LOCK_FORMAT = "clawchat-connect-plugin-lock-v1" as const;
export const MAX_PLUGIN_CONFIGURATION_BYTES = 256 * 1024;
const SUPPORTED_CONFIGURATION_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "title",
  "description",
  "default",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);
const SUPPORTED_CONFIGURATION_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);
const SECRET_CONFIGURATION_PROPERTY = /authorization|credential|password|secret|token|api.?key|access.?key/iu;

export type InstalledPluginStatus = "active" | "disabled" | "error";

export interface InstalledPluginVersion {
  source: ConnectPluginSource;
  version: string;
  target: string;
  integrity: string;
  activeArtifact: string;
  manifestPath: string;
  manifest: ConnectPluginManifestV1;
  installationConfiguration: ConnectPluginConfiguration;
  capabilityConfigurations: Readonly<Record<string, ConnectPluginConfiguration>>;
}

export interface InstalledPluginLockEntry extends InstalledPluginVersion {
  activationGeneration: number;
  pluginId: string;
  status: InstalledPluginStatus;
  error: string | null;
  retainedVersions: InstalledPluginVersion[];
}

export interface ConnectPluginLockfileV1 {
  format: typeof CONNECT_PLUGIN_LOCK_FORMAT;
  plugins: Record<string, InstalledPluginLockEntry>;
}

export interface InstallLocalPluginOptions {
  configPath: string;
  bundlePath: string;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  capabilityConfigurations?: Record<string, unknown>;
}
export interface StagePluginBundleOptions {
  configPath: string;
  source: ConnectPluginSource;
  bundle: ConnectPluginBundleV1;
  target?: string;
  installationConfiguration?: Record<string, unknown>;
  capabilityConfigurations?: Record<string, unknown>;
}

export interface PluginInstallationPaths {
  root: string;
  store: string;
  lockfile: string;
}

export interface StagedPlugin {
  readonly entry: InstalledPluginLockEntry;
  readonly artifactRoot: string;
  readonly createdArtifact: boolean;
}

export function currentConnectPluginTarget(): string {
  return `${process.platform}-${process.arch}`;
}

export function pluginInstallationPaths(configPath: string): PluginInstallationPaths {
  const root = dirname(resolve(configPath));
  return {
    root,
    store: resolve(root, "plugins"),
    lockfile: resolve(root, "plugins.lock.json"),
  };
}

export async function stageLocalPlugin(options: InstallLocalPluginOptions): Promise<StagedPlugin> {
  const sourcePath = resolve(options.bundlePath);
  return await stagePluginBundle({
    ...options,
    source: { type: "local", path: sourcePath },
    bundle: await readConnectPluginBundle(sourcePath),
  });
}

export async function stagePluginBundle(options: StagePluginBundleOptions): Promise<StagedPlugin> {
  const source = options.source;
  const bundle = validateBundle(options.bundle);
  if (source.type !== "local" && source.version !== bundle.manifest.version) {
    throw new Error(
      `Resolved ${source.type} source version ${source.version} does not match Bundle version ${bundle.manifest.version}`,
    );
  }
  const target = options.target ?? currentConnectPluginTarget();
  const artifact = selectArtifact(bundle.manifest, target);
  const installationConfiguration = validatePluginConfiguration(
    bundle.manifest.installationConfigurationSchema,
    options.installationConfiguration ?? {},
    `Plugin ${bundle.manifest.pluginId} installation configuration`,
  );
  const capabilityConfigurations = validateCapabilityConfigurations(
    bundle.manifest,
    options.capabilityConfigurations ?? {},
  );
  const entryBytes = connectPluginBundleFileBytes(bundle, artifact.entry);
  verifyConnectPluginIntegrity(entryBytes, artifact.integrity, `${bundle.manifest.pluginId} ${artifact.entry}`);
  for (const capability of bundle.manifest.capabilities) {
    if (capability.type !== "client-extension") continue;
    verifyConnectPluginIntegrity(
      connectPluginBundleFileBytes(bundle, capability.browser.entry),
      capability.browser.integrity,
      `${bundle.manifest.pluginId} ${capability.browser.entry}`,
    );
    for (const style of capability.browser.styles) {
      verifyConnectPluginIntegrity(
        connectPluginBundleFileBytes(bundle, style.entry),
        style.integrity,
        `${bundle.manifest.pluginId} ${style.entry}`,
      );
    }
  }

  const paths = pluginInstallationPaths(options.configPath);
  await mkdir(paths.store, { recursive: true, mode: 0o700 });
  const identitySegment = createHash("sha256").update(bundle.manifest.pluginId).digest("hex");
  const versionSegment = encodeURIComponent(bundle.manifest.version);
  const artifactSegment = bundleContentDigest(bundle.manifest, target, bundleContentSignatures(bundle));
  const installedRoot = resolve(paths.store, identitySegment, versionSegment, artifactSegment);
  assertWithin(paths.store, installedRoot, "Plugin artifact");
  const stagingRoot = resolve(paths.store, ".staging", randomUUID());
  const activeArtifact = resolve(installedRoot, artifact.entry);
  const manifestPath = resolve(installedRoot, "connect-plugin.json");
  const createdArtifact = !existsSync(installedRoot);

  try {
    if (createdArtifact) {
      await writeStagedBundle(stagingRoot, bundle);
      await mkdir(dirname(installedRoot), { recursive: true, mode: 0o700 });
      try {
        await rename(stagingRoot, installedRoot);
      } catch (error) {
        if (!existsSync(installedRoot)) throw error;
      }
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const selected = (await listInstalledPlugins(options.configPath)).find(
    (candidate) => candidate.pluginId === bundle.manifest.pluginId,
  );
  const entry: InstalledPluginLockEntry = {
    pluginId: bundle.manifest.pluginId,
    activationGeneration: (selected?.activationGeneration ?? 0) + 1,
    source,
    version: bundle.manifest.version,
    target,
    integrity: artifact.integrity,
    activeArtifact,
    manifestPath,
    manifest: structuredClone(bundle.manifest),
    installationConfiguration,
    capabilityConfigurations,
    status: "active",
    error: null,
    retainedVersions: [],
  };
  await revalidateInstalledPlugin(entry);
  return {
    artifactRoot: installedRoot,
    createdArtifact,
    entry,
  };
}
export async function installLocalPlugin(options: InstallLocalPluginOptions): Promise<InstalledPluginLockEntry> {
  const sourcePath = resolve(options.bundlePath);
  return await installPluginBundle({
    ...options,
    source: { type: "local", path: sourcePath },
    bundle: await readConnectPluginBundle(sourcePath),
  });
}

export async function installPluginBundle(options: StagePluginBundleOptions): Promise<InstalledPluginLockEntry> {
  const staged = await stagePluginBundle(options);
  try {
    return await commitStagedPlugin(options.configPath, staged, "install");
  } catch (error) {
    await discardStagedPlugin(options.configPath, staged).catch(() => undefined);
    throw error;
  }
}

// Only call after resolving and verifying a release-pinned official candidate.
export async function refreshOfficialPluginBundle(
  options: StagePluginBundleOptions & { stateDbPath?: string },
): Promise<InstalledPluginLockEntry> {
  const existing = (await listInstalledPlugins(options.configPath)).find(
    (entry) => entry.pluginId === options.bundle.manifest.pluginId,
  );
  const staged = await stagePluginBundle({
    ...options,
    installationConfiguration: existing?.installationConfiguration ?? options.installationConfiguration,
    capabilityConfigurations: existing?.capabilityConfigurations ?? options.capabilityConfigurations,
  });
  try {
    if (existing && existing.activeArtifact === staged.entry.activeArtifact) {
      await revalidateInstalledPlugin(existing);
      await discardStagedPlugin(options.configPath, staged);
      return existing;
    }
    if (existing) {
      const declarations = (manifest: ConnectPluginManifestV1) =>
        manifest.capabilities
          .filter((capability) => "durableState" in capability && capability.durableState)
          .map((capability) => ({
            id: capability.id,
            declaration: "durableState" in capability ? capability.durableState : undefined,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      const previous = declarations(existing.manifest);
      const next = declarations(staged.entry.manifest);
      if (!isDeepStrictEqual(previous, next))
        throw new Error("Offline official refresh requires unchanged Durable State declarations");
      if (previous.length) {
        if (!options.stateDbPath) throw new Error("Offline official refresh requires the configured state database");
        const state = createStateStore({ dbPath: options.stateDbPath });
        try {
          const snapshots = await state.listPluginDurableState(existing.pluginId, existing.activationGeneration);
          await state.commitPluginDurableStateMigrations(
            snapshots.map((snapshot) => ({
              ...snapshot.record,
              namespace: { ...snapshot.namespace, activationGeneration: staged.entry.activationGeneration },
            })),
          );
        } finally {
          await state.close();
        }
      }
    }
    return await commitStagedPlugin(options.configPath, staged, existing ? "official-refresh" : "install");
  } catch (error) {
    await discardStagedPlugin(options.configPath, staged).catch(() => undefined);
    throw error;
  }
}

export async function commitStagedPlugin(
  configPath: string,
  staged: StagedPlugin,
  operation:
    | "install"
    | "update"
    | "upload-replace"
    | "source-replace"
    | "official-replace"
    | "official-refresh"
    | "select",
): Promise<InstalledPluginLockEntry> {
  const paths = pluginInstallationPaths(configPath);
  let committed!: InstalledPluginLockEntry;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const existing = lockfile.plugins[staged.entry.pluginId];
    if (operation === "install" && existing) {
      throw new Error(`Plugin identity is already installed: ${staged.entry.pluginId}`);
    }
    if (operation !== "install" && !existing) {
      throw new Error(`Plugin is not installed: ${staged.entry.pluginId}`);
    }
    if (
      operation === "upload-replace" &&
      (staged.entry.source.type !== "local" ||
        !managedPluginUploadPath(managedPluginUploadRoot(configPath), staged.entry.source.path))
    ) {
      throw new Error(`Plugin ${staged.entry.pluginId} uploaded replacement source is not host-managed`);
    }
    if (
      operation === "update" &&
      existing &&
      pluginSourceIdentity(existing.source) !== pluginSourceIdentity(staged.entry.source)
    ) {
      throw new Error(`Plugin ${staged.entry.pluginId} source is immutable during update`);
    }
    const retained = existing
      ? deduplicateVersions([...existing.retainedVersions, installedVersion(existing)]).filter(
          (candidate) => !samePluginVersion(candidate, staged.entry),
        )
      : [];
    const activationGeneration = (existing?.activationGeneration ?? 0) + 1;
    if (staged.entry.activationGeneration !== activationGeneration) {
      throw new Error(
        `Plugin ${staged.entry.pluginId} Activation Generation changed during prepare: expected ${staged.entry.activationGeneration}, next is ${activationGeneration}`,
      );
    }
    committed = {
      ...staged.entry,
      activationGeneration,
      status: operation === "official-refresh" && existing?.status === "disabled" ? "disabled" : "active",
      error: null,
      retainedVersions: retained,
    };
    return { ...lockfile, plugins: { ...lockfile.plugins, [committed.pluginId]: committed } };
  });
  return committed;
}

export async function listInstalledPlugins(configPath: string): Promise<InstalledPluginLockEntry[]> {
  const paths = pluginInstallationPaths(configPath);
  const lockfile = await readPluginLockfile(paths.lockfile);
  return Object.values(lockfile.plugins)
    .map((entry) => validateLockEntry(entry, paths.store))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export async function removeInstalledPlugin(configPath: string, pluginId: string): Promise<InstalledPluginLockEntry> {
  const id = requireIdentity(pluginId, "Plugin ID");
  const paths = pluginInstallationPaths(configPath);
  let removed: InstalledPluginLockEntry | undefined;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    removed = lockfile.plugins[id];
    if (!removed) throw new Error(`Plugin is not installed: ${id}`);
    const plugins = { ...lockfile.plugins };
    delete plugins[id];
    return { ...lockfile, plugins };
  });
  return validateLockEntry(removed, paths.store);
}

export async function setInstalledPluginStatus(
  configPath: string,
  pluginId: string,
  status: InstalledPluginStatus,
  error: unknown = null,
  activationGeneration?: number,
): Promise<InstalledPluginLockEntry> {
  const paths = pluginInstallationPaths(configPath);
  let updated!: InstalledPluginLockEntry;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const installed = lockfile.plugins[pluginId];
    if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
    updated = {
      ...installed,
      status,
      error: error === null ? null : error instanceof Error ? error.message : String(error),
      activationGeneration: activationGeneration ?? installed.activationGeneration,
    };
    return { ...lockfile, plugins: { ...lockfile.plugins, [pluginId]: updated } };
  });
  return validateLockEntry(updated, paths.store);
}
export async function updateInstalledPluginConfiguration(
  configPath: string,
  pluginId: string,
  installationConfiguration: unknown,
  capabilityConfigurations: unknown,
): Promise<InstalledPluginLockEntry> {
  const paths = pluginInstallationPaths(configPath);
  let updated!: InstalledPluginLockEntry;
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const installed = lockfile.plugins[pluginId];
    if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
    const validatedInstallation = validatePluginConfiguration(
      installed.manifest.installationConfigurationSchema,
      installationConfiguration,
      `Plugin ${pluginId} installation configuration`,
    );
    const validatedCapabilities = validateCapabilityConfigurations(installed.manifest, capabilityConfigurations);
    updated = {
      ...installed,
      installationConfiguration: validatedInstallation,
      capabilityConfigurations: validatedCapabilities,
      activationGeneration: installed.activationGeneration + 1,
      error: null,
    };
    return { ...lockfile, plugins: { ...lockfile.plugins, [pluginId]: updated } };
  });
  return validateLockEntry(updated, paths.store);
}

export async function restoreInstalledPluginConfiguration(
  configPath: string,
  previous: InstalledPluginLockEntry,
): Promise<void> {
  const paths = pluginInstallationPaths(configPath);
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const current = lockfile.plugins[previous.pluginId];
    if (!current) throw new Error(`Plugin is not installed: ${previous.pluginId}`);
    return {
      ...lockfile,
      plugins: {
        ...lockfile.plugins,
        [previous.pluginId]: previous,
      },
    };
  });
}

export async function recordInstalledPluginError(
  configPath: string,
  pluginId: string,
  error: unknown,
  preserveActive = false,
): Promise<void> {
  const paths = pluginInstallationPaths(configPath);
  await updatePluginLockfile(paths.lockfile, (lockfile) => {
    const installed = lockfile.plugins[pluginId];
    if (!installed) return lockfile;
    return {
      ...lockfile,
      plugins: {
        ...lockfile.plugins,
        [pluginId]: {
          ...installed,
          status: preserveActive && installed.status === "active" ? "active" : "error",
          error: error instanceof Error ? error.message : String(error),
        },
      },
    };
  });
}

export async function selectInstalledPluginVersion(
  configPath: string,
  pluginId: string,
  version: string,
  integrity?: string,
): Promise<StagedPlugin> {
  const installed = (await listInstalledPlugins(configPath)).find((candidate) => candidate.pluginId === pluginId);
  if (!installed) throw new Error(`Plugin is not installed: ${pluginId}`);
  const selected = installed.retainedVersions.find(
    (candidate) => candidate.version === version && (!integrity || candidate.integrity === integrity),
  );
  if (!selected) {
    throw new Error(
      `Plugin ${pluginId} has no retained version ${version}${integrity ? ` with integrity ${integrity}` : ""}`,
    );
  }
  return {
    artifactRoot: dirname(selected.manifestPath),
    createdArtifact: false,
    entry: {
      pluginId,
      activationGeneration: installed.activationGeneration + 1,
      ...structuredClone(selected),
      status: "active",
      error: null,
      retainedVersions: [],
    },
  };
}

export async function revalidateInstalledPlugin(entry: InstalledPluginLockEntry): Promise<void> {
  const installedRoot = dirname(entry.manifestPath);
  const manifestValue = JSON.parse(await readFile(entry.manifestPath, "utf8")) as unknown;
  if (!isRecord(manifestValue)) throw new Error(`Installed Plugin ${entry.pluginId} manifest is malformed`);
  const manifest = validateManifest(manifestValue);
  if (
    manifest.pluginId !== entry.pluginId ||
    manifest.version !== entry.version ||
    canonicalJson(manifest) !== canonicalJson(entry.manifest)
  ) {
    throw new Error(`Installed Plugin ${entry.pluginId} manifest changed after installation`);
  }
  const files = await readInstalledBundleSignatures(installedRoot);
  const contentDigest = bundleContentDigest(manifest, entry.target, files);
  if (contentDigest !== basename(installedRoot)) {
    throw new Error(`Installed Plugin ${entry.pluginId} content changed after installation`);
  }
  const artifact = selectArtifact(manifest, entry.target);
  const artifactIntegrity = files.find(([path]) => path === artifact.entry)?.[1];
  if (!artifactIntegrity) throw new Error(`Installed Plugin ${entry.pluginId} artifact is missing`);
  verifyConnectPluginIntegrityValue(artifactIntegrity, entry.integrity, `${entry.pluginId} installed artifact`);
}

export async function discardStagedPlugin(configPath: string, staged: StagedPlugin): Promise<void> {
  if (!staged.createdArtifact) return;
  const installed = await listInstalledPlugins(configPath);
  const referenced = installed.some(
    (entry) =>
      entry.activeArtifact === staged.entry.activeArtifact ||
      entry.retainedVersions.some((candidate) => candidate.activeArtifact === staged.entry.activeArtifact),
  );
  if (!referenced) await rm(staged.artifactRoot, { recursive: true, force: true });
}

export async function removePluginArtifacts(configPath: string, pluginId: string): Promise<void> {
  const paths = pluginInstallationPaths(configPath);
  const identitySegment = createHash("sha256").update(pluginId).digest("hex");
  const identityRoot = resolve(paths.store, identitySegment);
  assertWithin(paths.store, identityRoot, "Plugin artifact");
  await rm(identityRoot, { recursive: true, force: true });
}
export function managedPluginUploadRoot(configPath: string): string {
  return resolve(pluginInstallationPaths(configPath).root, "plugin-uploads");
}

export async function removeUnreferencedManagedPluginUploads(configPath: string): Promise<void> {
  const uploadRoot = managedPluginUploadRoot(configPath);
  const rootDetails = await lstat(uploadRoot).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootDetails) return;
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`Managed Plugin upload root is not a directory: ${uploadRoot}`);
  }
  const referenced = new Set<string>();
  for (const entry of await listInstalledPlugins(configPath)) {
    for (const version of [entry, ...entry.retainedVersions]) {
      if (version.source.type !== "local") continue;
      const managedPath = managedPluginUploadPath(uploadRoot, version.source.path);
      if (managedPath) referenced.add(managedPath);
    }
  }
  const entries = await readdir(uploadRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.connect-plugin$/u.test(entry.name)) continue;
    const path = managedPluginUploadPath(uploadRoot, resolve(uploadRoot, entry.name));
    if (path && !referenced.has(path)) await rm(path, { force: true });
  }
}

function managedPluginUploadPath(uploadRoot: string, path: string): string | null {
  const candidate = resolve(path);
  const child = relative(uploadRoot, candidate);
  if (child !== basename(candidate) || !/^[0-9a-f]{64}\.connect-plugin$/u.test(child)) return null;
  assertWithin(uploadRoot, candidate, "Managed Plugin upload");
  return candidate;
}

export async function readConnectPluginBundle(path: string): Promise<ConnectPluginBundleV1> {
  try {
    return parseConnectPluginBundle(await readFile(path, "utf8"), path);
  } catch (error) {
    throw new Error(
      `Could not read Connect Plugin Bundle ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseConnectPluginBundle(value: string | Uint8Array, label = "source"): ConnectPluginBundleV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as unknown;
  } catch (error) {
    throw new Error(
      `Connect Plugin Bundle ${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateBundle(parsed);
}

async function writeStagedBundle(root: string, bundle: ConnectPluginBundleV1): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const path of Object.keys(bundle.files).sort()) {
    const outputPath = resolve(root, path);
    assertWithin(root, outputPath, "Bundle file");
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, connectPluginBundleFileBytes(bundle, path), { mode: 0o600 });
  }
  await writeFile(resolve(root, "connect-plugin.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

type BundleContentSignature = readonly [path: string, integrity: string];

function* bundleContentSignatures(bundle: ConnectPluginBundleV1): Iterable<BundleContentSignature> {
  for (const path of Object.keys(bundle.files)) {
    const bytes = connectPluginBundleFileBytes(bundle, path);
    yield [path, `sha256-${createHash("sha256").update(bytes).digest("base64")}`];
  }
}

async function readInstalledBundleSignatures(root: string): Promise<BundleContentSignature[]> {
  const files: BundleContentSignature[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      assertWithin(root, absolutePath, "Installed Bundle file");
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Installed Bundle contains unsupported file: ${relative(root, absolutePath)}`);
      }
      const path = relative(root, absolutePath).split(sep).join("/");
      if (path === "connect-plugin.json") continue;
      const bytes = await readFile(absolutePath);
      files.push([path, `sha256-${createHash("sha256").update(bytes).digest("base64")}`]);
    }
  };
  await visit(root);
  return files;
}

function bundleContentDigest(
  manifest: ConnectPluginManifestV1,
  target: string,
  files: Iterable<BundleContentSignature>,
): string {
  const content = [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256")
    .update(canonicalJson({ manifest, target, files: content }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value) as string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Bundle metadata must contain only finite JSON numbers");
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Bundle metadata contains unsupported JSON value: ${String(value)}`);
}

async function readPluginLockfile(path: string): Promise<ConnectPluginLockfileV1> {
  if (!existsSync(path)) return { format: CONNECT_PLUGIN_LOCK_FORMAT, plugins: {} };
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(value) || value.format !== CONNECT_PLUGIN_LOCK_FORMAT || !isRecord(value.plugins)) {
    throw new Error(`Unsupported or malformed Connect Plugin lockfile: ${path}`);
  }
  return value as unknown as ConnectPluginLockfileV1;
}

async function updatePluginLockfile(
  path: string,
  update: (lockfile: ConnectPluginLockfileV1) => ConnectPluginLockfileV1,
): Promise<void> {
  const next = update(await readPluginLockfile(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateBundle(value: unknown): ConnectPluginBundleV1 {
  if (!isRecord(value) || value.format !== CONNECT_PLUGIN_BUNDLE_FORMAT || !isRecord(value.manifest)) {
    throw new Error("Unsupported or malformed Connect Plugin Bundle");
  }
  const manifest = validateManifest(value.manifest);
  if (!isRecord(value.files)) throw new Error("Connect Plugin Bundle files are required");
  const files: ConnectPluginBundleV1["files"] = {};
  for (const [path, file] of Object.entries(value.files)) {
    requireBundlePath(path);
    if (path === "connect-plugin.json") {
      throw new Error("Connect Plugin Bundle file path is reserved: connect-plugin.json");
    }
    if (
      !isRecord(file) ||
      (file.encoding !== "utf8" && file.encoding !== "base64") ||
      typeof file.content !== "string"
    ) {
      throw new Error(`Connect Plugin Bundle file ${path} is malformed`);
    }
    files[path] = { encoding: file.encoding, content: file.content };
  }
  for (const artifact of manifest.artifacts) {
    if (!files[artifact.entry]) throw new Error(`Connect Plugin entry artifact is missing: ${artifact.entry}`);
  }
  return { format: CONNECT_PLUGIN_BUNDLE_FORMAT, manifest, files };
}

function validateManifest(value: Record<string, unknown>): ConnectPluginManifestV1 {
  assertOnlyKeys(
    value,
    [
      "manifestVersion",
      "interfaceVersion",
      "pluginId",
      "version",
      "dependencies",
      "installationConfigurationSchema",
      "capabilities",
      "artifacts",
    ],
    "Connect Plugin manifest",
  );
  if (value.manifestVersion !== CONNECT_PLUGIN_MANIFEST_VERSION) {
    throw new Error(`Unsupported Connect Plugin manifest version: ${String(value.manifestVersion)}`);
  }
  if (value.interfaceVersion !== CONNECT_PLUGIN_INTERFACE_VERSION) {
    throw new Error(`Unsupported Connect Plugin interface version: ${String(value.interfaceVersion)}`);
  }
  const pluginId = requireIdentity(value.pluginId, "Plugin ID");
  const version = requireText(value.version, "Plugin version");
  const installationConfigurationSchema = validateConfigurationSchema(
    value.installationConfigurationSchema,
    `Plugin ${pluginId} installation configuration schema`,
  );
  if (!Array.isArray(value.dependencies))
    throw new Error(`Plugin ${pluginId} Host Capability dependencies are required`);
  const dependencyIds = new Set<ConnectPluginHostCapabilityDependency["id"]>();
  const dependencies = value.dependencies.map((candidate): ConnectPluginHostCapabilityDependency => {
    if (!isRecord(candidate)) throw new Error(`Plugin ${pluginId} dependency is malformed`);
    if (candidate.type !== "host") {
      throw new Error(
        `Plugin ${pluginId} may depend only on Connect Host Capabilities; user-plugin dependencies are prohibited`,
      );
    }
    assertOnlyKeys(candidate, ["type", "id", "interfaceVersion"], `Plugin ${pluginId} Host Capability dependency`);
    if (
      candidate.id !== "runtime-provider" &&
      candidate.id !== "managed-web-app-provider" &&
      candidate.id !== "durable-state" &&
      candidate.id !== "exposure-provider"
    ) {
      throw new Error(`Plugin ${pluginId} requests unsupported Host Capability: ${String(candidate.id)}`);
    }
    if (candidate.interfaceVersion !== CONNECT_HOST_CAPABILITY_INTERFACE_VERSION) {
      throw new Error(
        `Plugin ${pluginId} requests unsupported ${candidate.id} Host Capability interface version: ${String(candidate.interfaceVersion)}`,
      );
    }
    if (dependencyIds.has(candidate.id)) {
      throw new Error(`Plugin ${pluginId} declares Host Capability ${candidate.id} more than once`);
    }
    dependencyIds.add(candidate.id);
    return {
      type: "host",
      id: candidate.id,
      interfaceVersion: CONNECT_HOST_CAPABILITY_INTERFACE_VERSION,
    };
  });
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error("Connect Plugin must declare at least one capability");
  }
  const capabilityIds = new Set<string>();
  const capabilities = value.capabilities.map((candidate): ConnectPluginCapabilityManifest => {
    if (!isRecord(candidate)) throw new Error(`Plugin ${pluginId} capability is malformed`);
    if (
      candidate.type !== "runtime" &&
      candidate.type !== "managed-web-app" &&
      candidate.type !== "exposure" &&
      candidate.type !== "client-extension"
    ) {
      throw new Error(`Plugin ${pluginId} declares unsupported capability type: ${String(candidate.type)}`);
    }
    assertOnlyKeys(
      candidate,
      candidate.type === "runtime"
        ? ["id", "type", "interfaceVersion", "family", "configurationSchema", "durableState"]
        : candidate.type === "managed-web-app"
          ? [
              "id",
              "type",
              "interfaceVersion",
              "configurationSchema",
              "displayName",
              "description",
              "nativeRuntimeCapabilityIds",
              "compatibleRuntimes",
            ]
          : candidate.type === "client-extension"
            ? ["id", "type", "interfaceVersion", "configurationSchema", "managedWebApp", "browser", "durableState"]
            : ["id", "type", "interfaceVersion", "configurationSchema", "durableState"],
      `Plugin ${pluginId} ${candidate.type} capability`,
    );
    const id = requireIdentity(candidate.id, "Capability ID");
    if (capabilityIds.has(id)) throw new Error(`Duplicate Plugin capability ID: ${id}`);
    capabilityIds.add(id);
    if (candidate.interfaceVersion !== CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION) {
      throw new Error(
        `Plugin ${pluginId}/${id} uses unsupported ${candidate.type} capability interface version: ${String(candidate.interfaceVersion)}`,
      );
    }
    const requiredHostCapability =
      candidate.type === "runtime"
        ? "runtime-provider"
        : candidate.type === "managed-web-app"
          ? "managed-web-app-provider"
          : candidate.type === "exposure"
            ? "exposure-provider"
            : undefined;
    if (requiredHostCapability && !dependencyIds.has(requiredHostCapability)) {
      throw new Error(`Plugin ${pluginId}/${id} must declare Host Capability ${requiredHostCapability}`);
    }
    const configurationSchema = validateConfigurationSchema(
      candidate.configurationSchema,
      `Plugin ${pluginId}/${id} configuration schema`,
    );
    const durableState =
      candidate.durableState === undefined
        ? undefined
        : validateDurableStateManifest(candidate.durableState, pluginId, id);
    if (candidate.type === "client-extension" && durableState) {
      throw new Error(`Plugin ${pluginId}/${id} Client Extension cannot declare Host Durable State`);
    }
    if (durableState && !dependencyIds.has("durable-state")) {
      throw new Error(`Plugin ${pluginId}/${id} must declare Host Capability durable-state`);
    }
    if (candidate.type === "runtime") {
      return {
        id,
        type: "runtime",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        family: requireIdentity(candidate.family, "Runtime family"),
        configurationSchema,
        ...(durableState ? { durableState } : {}),
      };
    }
    if (candidate.type === "managed-web-app") {
      if (!Array.isArray(candidate.nativeRuntimeCapabilityIds) || !Array.isArray(candidate.compatibleRuntimes)) {
        throw new Error(
          `Plugin ${pluginId}/${id} Managed Web App must declare nativeRuntimeCapabilityIds and compatibleRuntimes`,
        );
      }
      const nativeRuntimeCapabilityIds = candidate.nativeRuntimeCapabilityIds.map((runtimeId) =>
        requireIdentity(runtimeId, `Plugin ${pluginId}/${id} native Runtime capability ID`),
      );
      if (new Set(nativeRuntimeCapabilityIds).size !== nativeRuntimeCapabilityIds.length) {
        throw new Error(`Plugin ${pluginId}/${id} declares duplicate native Runtime capability IDs`);
      }
      const compatibleRuntimes = candidate.compatibleRuntimes.map((runtimeRef) => {
        if (!isRecord(runtimeRef)) {
          throw new Error(`Plugin ${pluginId}/${id} compatible Runtime reference is malformed`);
        }
        assertOnlyKeys(runtimeRef, ["pluginId", "capabilityId"], `Plugin ${pluginId}/${id} compatible Runtime`);
        const runtimePluginId = requireIdentity(runtimeRef.pluginId, "Compatible Runtime Plugin ID");
        const capabilityId = requireIdentity(runtimeRef.capabilityId, "Compatible Runtime capability ID");
        if (runtimePluginId === pluginId) {
          throw new Error(
            `Plugin ${pluginId}/${id} must declare same-Bundle Runtime ${capabilityId} as native, not compatible`,
          );
        }
        return { pluginId: runtimePluginId, capabilityId };
      });
      const compatibleIdentities = compatibleRuntimes.map((runtime) => `${runtime.pluginId}\0${runtime.capabilityId}`);
      if (new Set(compatibleIdentities).size !== compatibleIdentities.length) {
        throw new Error(`Plugin ${pluginId}/${id} declares duplicate compatible Runtime references`);
      }
      if (nativeRuntimeCapabilityIds.length === 0 && compatibleRuntimes.length === 0) {
        throw new Error(`Plugin ${pluginId}/${id} Managed Web App must support at least one exact Runtime`);
      }
      return {
        id,
        type: "managed-web-app",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        configurationSchema,
        displayName: requireText(candidate.displayName, `Plugin ${pluginId}/${id} Managed Web App display name`),
        description: requireText(candidate.description, `Plugin ${pluginId}/${id} Managed Web App description`),
        nativeRuntimeCapabilityIds,
        compatibleRuntimes,
      };
    }
    if (candidate.type === "client-extension") {
      if (!isRecord(candidate.managedWebApp)) {
        throw new Error(`Plugin ${pluginId}/${id} Client Extension Managed Web App reference is malformed`);
      }
      assertOnlyKeys(
        candidate.managedWebApp,
        ["pluginId", "capabilityId"],
        `Plugin ${pluginId}/${id} Client Extension Managed Web App`,
      );
      const managedWebApp = {
        pluginId: requireIdentity(
          candidate.managedWebApp.pluginId,
          `Plugin ${pluginId}/${id} Client Extension Managed Web App Plugin ID`,
        ),
        capabilityId: requireIdentity(
          candidate.managedWebApp.capabilityId,
          `Plugin ${pluginId}/${id} Client Extension Managed Web App capability ID`,
        ),
      };
      return {
        id,
        type: "client-extension",
        interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
        configurationSchema,
        managedWebApp,
        browser: validateClientExtensionBrowserManifest(candidate.browser, pluginId, id),
        ...(durableState ? { durableState } : {}),
      };
    }
    return {
      id,
      type: "exposure",
      interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
      configurationSchema,
      ...(durableState ? { durableState } : {}),
    };
  });
  const runtimeCapabilityIds = new Set(
    capabilities.filter((capability) => capability.type === "runtime").map((capability) => capability.id),
  );
  for (const capability of capabilities) {
    if (capability.type !== "managed-web-app") continue;
    for (const runtimeCapabilityId of capability.nativeRuntimeCapabilityIds) {
      if (!runtimeCapabilityIds.has(runtimeCapabilityId)) {
        throw new Error(
          `Plugin ${pluginId}/${capability.id} declares missing native Runtime capability ${runtimeCapabilityId}`,
        );
      }
    }
  }
  for (const capability of capabilities) {
    if (capability.type !== "client-extension" || capability.managedWebApp.pluginId !== pluginId) continue;
    const target = capabilities.find(
      (candidate) => candidate.id === capability.managedWebApp.capabilityId && candidate.type === "managed-web-app",
    );
    if (!target) {
      throw new Error(
        `Plugin ${pluginId}/${capability.id} targets missing same-Bundle Managed Web App ${capability.managedWebApp.capabilityId}`,
      );
    }
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    throw new Error("Connect Plugin must declare at least one target artifact");
  }
  const targets = new Set<string>();
  const artifacts = value.artifacts.map((candidate): ConnectPluginArtifactManifest => {
    if (!isRecord(candidate)) throw new Error("Connect Plugin artifact is malformed");
    assertOnlyKeys(candidate, ["target", "entry", "integrity"], `Plugin ${pluginId} artifact`);
    const target = requireIdentity(candidate.target, "Plugin target");
    if (targets.has(target)) throw new Error(`Duplicate Plugin target artifact: ${target}`);
    targets.add(target);
    const entry = requireBundlePath(candidate.entry);
    const integrity = requireSha256Integrity(candidate.integrity, "Plugin artifact integrity");
    return { target, entry, integrity };
  });
  return {
    manifestVersion: CONNECT_PLUGIN_MANIFEST_VERSION,
    interfaceVersion: CONNECT_PLUGIN_INTERFACE_VERSION,
    pluginId,
    version,
    dependencies,
    installationConfigurationSchema,
    capabilities,
    artifacts,
  };
}

function validateDurableStateManifest(
  value: unknown,
  pluginId: string,
  capabilityId: string,
): ConnectPluginDurableStateManifest {
  const label = `Plugin ${pluginId}/${capabilityId} Durable State`;
  if (!isRecord(value)) throw new Error(`${label} declaration is malformed`);
  assertOnlyKeys(value, ["schemaVersion", "lifetime", "schema", "migrations"], label);
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    throw new Error(`${label} schemaVersion must be a positive safe integer`);
  }
  if (value.lifetime !== "installation" && value.lifetime !== "owner" && value.lifetime !== "binding") {
    throw new Error(`${label} lifetime must be installation, owner, or binding`);
  }
  const schema = validateConfigurationSchema(value.schema, `${label} schema`);
  if (!Array.isArray(value.migrations)) throw new Error(`${label} migrations must be an array`);
  const seen = new Set<number>();
  const migrations = value.migrations.map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`${label} migration is malformed`);
    assertOnlyKeys(candidate, ["from", "to"], `${label} migration`);
    if (
      !Number.isSafeInteger(candidate.from) ||
      !Number.isSafeInteger(candidate.to) ||
      (candidate.from as number) < 1 ||
      candidate.to !== (candidate.from as number) + 1
    ) {
      throw new Error(`${label} migrations must advance one positive schema version`);
    }
    if (seen.has(candidate.from as number)) {
      throw new Error(`${label} declares more than one migration from version ${candidate.from}`);
    }
    seen.add(candidate.from as number);
    return Object.freeze({ from: candidate.from as number, to: candidate.to as number });
  });
  return Object.freeze({
    schemaVersion: value.schemaVersion as number,
    lifetime: value.lifetime,
    schema,
    migrations: Object.freeze(migrations),
  });
}

function validateClientExtensionBrowserManifest(
  value: unknown,
  pluginId: string,
  capabilityId: string,
): Extract<ConnectPluginCapabilityManifest, { type: "client-extension" }>["browser"] {
  const label = `Plugin ${pluginId}/${capabilityId} browser artifact`;
  if (!isRecord(value)) throw new Error(`${label} is malformed`);
  assertOnlyKeys(value, ["entry", "integrity", "styles", "slots"], label);
  if (!Array.isArray(value.styles)) throw new Error(`${label} styles must be an array`);
  if (!Array.isArray(value.slots) || value.slots.length === 0) {
    throw new Error(`${label} must declare at least one typed slot`);
  }
  const entry = requireBundlePath(value.entry);
  const integrity = requireSha256Integrity(value.integrity, `${label} integrity`);
  const styleEntries = new Set<string>();
  const styles = value.styles.map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`${label} style is malformed`);
    assertOnlyKeys(candidate, ["entry", "integrity"], `${label} style`);
    const styleEntry = requireBundlePath(candidate.entry);
    if (styleEntries.has(styleEntry)) throw new Error(`${label} declares duplicate style ${styleEntry}`);
    styleEntries.add(styleEntry);
    return {
      entry: styleEntry,
      integrity: requireSha256Integrity(candidate.integrity, `${label} style integrity`),
    };
  });
  const slotIds = new Set<string>();
  const slots = value.slots.map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`${label} slot is malformed`);
    assertOnlyKeys(candidate, ["id", "interfaceVersion", "priority"], `${label} slot`);
    const id = requireIdentity(candidate.id, "Client Extension slot ID");
    if (!Object.hasOwn(CONNECT_CLIENT_EXTENSION_SLOT_CATALOG, id)) {
      throw new Error(`${label} declares unsupported Client Extension slot ${id}`);
    }
    if (slotIds.has(id)) throw new Error(`${label} declares duplicate slot ${id}`);
    slotIds.add(id);
    if (candidate.interfaceVersion !== CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION) {
      throw new Error(`${label} slot ${id} uses unsupported interface version`);
    }
    if (!Number.isSafeInteger(candidate.priority)) throw new Error(`${label} slot ${id} priority must be an integer`);
    return {
      id: id as keyof typeof CONNECT_CLIENT_EXTENSION_SLOT_CATALOG,
      interfaceVersion: CONNECT_PLUGIN_CAPABILITY_INTERFACE_VERSION,
      priority: candidate.priority as number,
    };
  });
  return { entry, integrity, styles, slots };
}

function requireSha256Integrity(value: unknown, label: string): string {
  const integrity = requireText(value, label);
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/u.test(integrity)) {
    throw new Error(`${label} must be an exact sha256 SRI value`);
  }
  return integrity;
}

function selectArtifact(manifest: ConnectPluginManifestV1, target: string): ConnectPluginArtifactManifest {
  const artifact = manifest.artifacts.find((candidate) => candidate.target === target);
  if (!artifact) throw new Error(`Plugin ${manifest.pluginId} does not support Connect target ${target}`);
  return artifact;
}

export function connectPluginBundleFileBytes(bundle: ConnectPluginBundleV1, path: string): Uint8Array {
  const file = bundle.files[path];
  if (!file) throw new Error(`Connect Plugin Bundle file is missing: ${path}`);
  return file.encoding === "utf8" ? new TextEncoder().encode(file.content) : Buffer.from(file.content, "base64");
}

export function verifyConnectPluginIntegrity(bytes: Uint8Array, expected: string, label: string): void {
  const actual = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
  verifyConnectPluginIntegrityValue(actual, expected, label);
}

function verifyConnectPluginIntegrityValue(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} integrity mismatch: expected ${expected}, received ${actual}`);
}

function validateLockEntry(value: unknown, store: string): InstalledPluginLockEntry {
  if (!isRecord(value)) throw new Error("Malformed installed Plugin lock entry");
  const pluginId = requireIdentity(value.pluginId, "Installed Plugin ID");
  const active = validateInstalledVersion(value, store, pluginId);
  if (!Number.isSafeInteger(value.activationGeneration) || (value.activationGeneration as number) < 1) {
    throw new Error(`Installed Plugin ${pluginId} Activation Generation is malformed`);
  }
  if (value.status !== "active" && value.status !== "disabled" && value.status !== "error") {
    throw new Error(`Installed Plugin ${pluginId} status is malformed`);
  }
  if (value.error !== null && value.error !== undefined && typeof value.error !== "string") {
    throw new Error(`Installed Plugin ${pluginId} diagnostic is malformed`);
  }
  if (value.retainedVersions !== undefined && !Array.isArray(value.retainedVersions)) {
    throw new Error(`Installed Plugin ${pluginId} retained versions are malformed`);
  }
  const retainedVersions = (value.retainedVersions ?? []).map((candidate) =>
    validateInstalledVersion(candidate, store, pluginId),
  );
  return {
    pluginId,
    ...active,
    activationGeneration: value.activationGeneration as number,
    status: value.status,
    error: typeof value.error === "string" ? value.error : null,
    retainedVersions: deduplicateVersions(retainedVersions).filter(
      (candidate) => !samePluginVersion(candidate, active),
    ),
  };
}

function validateInstalledVersion(value: unknown, store: string, pluginId: string): InstalledPluginVersion {
  if (!isRecord(value)) throw new Error(`Installed Plugin ${pluginId} version is malformed`);
  const source = validatePluginSource(value.source, pluginId);
  if (typeof value.activeArtifact !== "string" || typeof value.manifestPath !== "string") {
    throw new Error(`Installed Plugin ${pluginId} artifact paths are malformed`);
  }
  if (!isAbsolute(value.activeArtifact) || !isAbsolute(value.manifestPath)) {
    throw new Error(`Installed Plugin ${pluginId} artifact paths must be absolute`);
  }
  assertWithin(store, value.activeArtifact, `Installed Plugin ${pluginId} artifact`);
  assertWithin(store, value.manifestPath, `Installed Plugin ${pluginId} manifest`);
  if (!isRecord(value.manifest)) throw new Error(`Installed Plugin ${pluginId} manifest is malformed`);
  const manifest = validateManifest(value.manifest);
  if (manifest.pluginId !== pluginId || manifest.version !== value.version) {
    throw new Error(`Installed Plugin ${pluginId} identity does not match its locked manifest`);
  }
  const installationConfiguration = validatePluginConfiguration(
    manifest.installationConfigurationSchema,
    value.installationConfiguration,
    `Installed Plugin ${pluginId} installation configuration`,
  );
  const capabilityConfigurations = validateCapabilityConfigurations(manifest, value.capabilityConfigurations);
  const selectedArtifact = selectArtifact(manifest, value.target as string);
  const expectedArtifactPath = resolve(dirname(value.manifestPath), selectedArtifact.entry);
  if (selectedArtifact.integrity !== value.integrity || expectedArtifactPath !== value.activeArtifact) {
    throw new Error(`Installed Plugin ${pluginId} locked artifact is not coherent with its manifest`);
  }
  if (typeof value.target !== "string" || typeof value.integrity !== "string") {
    throw new Error(`Installed Plugin ${pluginId} target or integrity is malformed`);
  }
  return {
    source,
    version: manifest.version,
    target: value.target,
    integrity: value.integrity,
    activeArtifact: value.activeArtifact,
    manifestPath: value.manifestPath,
    manifest,
    installationConfiguration,
    capabilityConfigurations,
  };
}

function validatePluginSource(value: unknown, pluginId: string): ConnectPluginSource {
  if (!isRecord(value)) throw new Error(`Installed Plugin ${pluginId} source is malformed`);
  if (value.type === "local" && typeof value.path === "string" && isAbsolute(value.path)) {
    return { type: "local", path: value.path };
  }
  if (
    value.type === "npm" &&
    typeof value.package === "string" &&
    typeof value.registry === "string" &&
    typeof value.version === "string" &&
    typeof value.tarball === "string"
  ) {
    return {
      type: "npm",
      package: value.package,
      registry: value.registry,
      version: value.version,
      tarball: value.tarball,
    };
  }
  if (
    value.type === "github" &&
    typeof value.repository === "string" &&
    typeof value.apiBase === "string" &&
    typeof value.version === "string" &&
    typeof value.release === "string" &&
    typeof value.asset === "string"
  ) {
    return {
      type: "github",
      repository: value.repository,
      apiBase: value.apiBase,
      version: value.version,
      release: value.release,
      asset: value.asset,
    };
  }
  throw new Error(`Installed Plugin ${pluginId} source is malformed`);
}

function installedVersion(entry: InstalledPluginLockEntry): InstalledPluginVersion {
  return {
    source: entry.source,
    version: entry.version,
    target: entry.target,
    integrity: entry.integrity,
    activeArtifact: entry.activeArtifact,
    manifestPath: entry.manifestPath,
    manifest: entry.manifest,
    installationConfiguration: entry.installationConfiguration,
    capabilityConfigurations: entry.capabilityConfigurations,
  };
}

function samePluginVersion(left: InstalledPluginVersion, right: InstalledPluginVersion): boolean {
  return left.activeArtifact === right.activeArtifact && left.integrity === right.integrity;
}

function deduplicateVersions(versions: InstalledPluginVersion[]): InstalledPluginVersion[] {
  const unique = new Map<string, InstalledPluginVersion>();
  for (const version of versions) unique.set(`${version.activeArtifact}\0${version.integrity}`, version);
  return [...unique.values()];
}

export function pluginSourceIdentity(source: ConnectPluginSource): string {
  if (source.type === "local") return `local:${source.path}`;
  if (source.type === "npm") return `npm:${source.registry}:${source.package}`;
  return `github:${source.apiBase}:${source.repository}`;
}

export type PluginConfigurationValidator = (value: unknown) => ConnectPluginConfiguration;

export function compilePluginConfigurationValidator(
  schema: ConnectPluginJsonSchema,
  label: string,
): PluginConfigurationValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate: ValidateFunction;
  try {
    validateConfigurationSchemaSubset(schema, label, "$", true);
    if (!ajv.validateSchema(schema)) {
      throw new Error(formatSchemaErrors(ajv.errors));
    }
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (value: unknown) => {
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    const configuration = structuredClone(value);
    if (!validate(configuration)) {
      throw new Error(`${label} is invalid: ${formatSchemaErrors(validate.errors)}`);
    }
    assertSerializedJsonSize(configuration, MAX_PLUGIN_CONFIGURATION_BYTES, `${label} exceeds 256 KiB`);
    return configuration;
  };
}

export type PluginDurableStateValidator = (value: unknown) => Readonly<Record<string, unknown>>;

export function compilePluginDurableStateValidator(
  schema: ConnectPluginJsonSchema,
  label: string,
): PluginDurableStateValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate: ValidateFunction;
  try {
    validateConfigurationSchemaSubset(schema, label, "$", true);
    if (!ajv.validateSchema(schema)) throw new Error(formatSchemaErrors(ajv.errors));
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (value: unknown) => {
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    const state = structuredClone(value);
    if (!validate(state)) throw new Error(`${label} is invalid: ${formatSchemaErrors(validate.errors)}`);
    assertSerializedJsonSize(state, MAX_PLUGIN_DURABLE_STATE_BYTES, `${label} exceeds 1 MiB`);
    return state;
  };
}

export function validatePluginConfiguration(
  schema: ConnectPluginJsonSchema,
  value: unknown,
  label: string,
): ConnectPluginConfiguration {
  return compilePluginConfigurationValidator(schema, label)(value);
}

function validateConfigurationSchemaSubset(schema: unknown, label: string, path: string, root = false): void {
  if (!isRecord(schema)) throw new Error(`${label} schema node ${path} must be an object`);
  const unsupported = Object.keys(schema).filter((keyword) => !SUPPORTED_CONFIGURATION_SCHEMA_KEYWORDS.has(keyword));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported JSON Schema keyword at ${path}: ${unsupported.sort().join(", ")}`);
  }
  const schemaType = normalizedSchemaType(schema.type, label, path);
  if (root && schemaType !== "object") throw new Error(`${label} root type must be object`);
  if (schemaType === "object") {
    if (schema.additionalProperties !== false) {
      throw new Error(`${label} object schema ${path} must declare additionalProperties: false`);
    }
    if (schema.properties !== undefined && !isRecord(schema.properties)) {
      throw new Error(`${label} properties at ${path} must be an object`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [property, child] of Object.entries(properties)) {
      if (SECRET_CONFIGURATION_PROPERTY.test(property)) {
        throw new Error(`${label} must remain secret-free; property ${path}.${property} is authorization-shaped`);
      }
      validateConfigurationSchemaSubset(child, label, `${path}.properties.${property}`);
    }
  } else if (
    schema.additionalProperties !== undefined ||
    schema.properties !== undefined ||
    schema.required !== undefined
  ) {
    throw new Error(`${label} schema node ${path} applies object keywords to ${schemaType}`);
  }
  if (schemaType === "array") {
    if (schema.items === undefined) throw new Error(`${label} array schema ${path} must declare items`);
    validateConfigurationSchemaSubset(schema.items, label, `${path}.items`);
  } else if (schema.items !== undefined) {
    throw new Error(`${label} schema node ${path} applies items to ${schemaType}`);
  }
}

function normalizedSchemaType(value: unknown, label: string, path: string): string {
  if (typeof value === "string" && SUPPORTED_CONFIGURATION_TYPES.has(value)) return value;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.includes("null") &&
    value.filter((candidate) => candidate !== "null").length === 1
  ) {
    const nonNull = value.find((candidate) => candidate !== "null");
    if (typeof nonNull === "string" && SUPPORTED_CONFIGURATION_TYPES.has(nonNull)) return nonNull;
  }
  throw new Error(`${label} schema node ${path} has unsupported or missing type`);
}

function assertSerializedJsonSize(value: unknown, maximumBytes: number, message: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${message}: value is not serializable JSON`, { cause: error });
  }
  if (Buffer.byteLength(serialized) > maximumBytes) throw new Error(message);
}

function validateConfigurationSchema(value: unknown, label: string): ConnectPluginJsonSchema {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON Schema object`);
  const schema = structuredClone(value);
  compilePluginConfigurationValidator(schema, label);
  return schema;
}

function validateCapabilityConfigurations(
  manifest: ConnectPluginManifestV1,
  value: unknown,
): Readonly<Record<string, ConnectPluginConfiguration>> {
  if (!isRecord(value)) throw new Error(`Plugin ${manifest.pluginId} capability configurations must be a JSON object`);
  const capabilities = manifest.capabilities.filter(
    (capability) =>
      capability.type === "managed-web-app" || capability.type === "exposure" || capability.type === "client-extension",
  );
  const declared = new Set(capabilities.map((capability) => capability.id));
  for (const capabilityId of Object.keys(value)) {
    if (!declared.has(capabilityId)) {
      throw new Error(`Plugin ${manifest.pluginId} has no installation-scoped capability ${capabilityId}`);
    }
  }
  return Object.fromEntries(
    capabilities.map((capability) => [
      capability.id,
      validatePluginConfiguration(
        capability.configurationSchema,
        value[capability.id] ?? {},
        `Plugin ${manifest.pluginId}/${capability.id} ${
          capability.type === "managed-web-app"
            ? "Managed Web App"
            : capability.type === "exposure"
              ? "Exposure"
              : "Client Extension"
        } configuration`,
      ),
    ]),
  );
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "unknown JSON Schema validation error";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported field: ${unsupported.sort().join(", ")}`);
}

function requireIdentity(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!/^[a-z0-9](?:[a-z0-9._@/-]*[a-z0-9])?$/u.test(text)) {
    throw new Error(`${label} must be a stable lowercase identifier`);
  }
  return text;
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requireBundlePath(value: unknown): string {
  const path = requireText(value, "Bundle path");
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Bundle path must be a normalized relative path: ${path}`);
  }
  return path;
}

function assertWithin(root: string, path: string, label: string): void {
  const offset = relative(resolve(root), resolve(path));
  if (!offset || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset))) return;
  throw new Error(`${label} escapes the installation Plugin store`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pluginDependents(config: { agents: Record<string, AgentBindingConfig> }, pluginId: string): string[] {
  return Object.entries(config.agents)
    .filter(([, binding]) => binding.runtime.pluginId === pluginId)
    .map(([bindingId]) => bindingId)
    .sort();
}
