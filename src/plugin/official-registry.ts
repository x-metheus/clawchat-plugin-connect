import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OfficialPluginDescriptor } from "../../scripts/build-official-plugins";
import { OPENCODE_SEMANTIC_VERSION_PATTERN } from "../runtime/opencode-version";
import codexDescriptor from "./official/codex-descriptor";
import connectClientDescriptor from "./official/connect-client-descriptor";
import deepSeekHarnessDescriptor from "./official/deepseek-harness-descriptor";
import livewareDescriptor from "./official/liveware-descriptor";
import opencodeDescriptor from "./official/opencode-descriptor";
import workbuddyDescriptor from "./official/workbuddy-descriptor";
import { OFFICIAL_WORKBUDDY_DISTRIBUTIONS } from "./official/workbuddy-manifest";
import type { ConnectPluginBundleV1, ConnectPluginManifestV1, ConnectPluginSource } from "./sdk";
import { type PluginSourceResolverOptions, type ResolvedPluginSource, resolvePluginSource } from "./source";

export type OfficialPluginClassification = "runtime" | "managed-web-app" | "exposure";
export interface OfficialRuntimeDiscoveryRule {
  readonly executableNames: readonly string[];
  readonly versionCommand?: {
    readonly argv: readonly string[];
    readonly outputPattern: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
}

export interface OfficialDiscoveryCommandRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface BundledOfficialPluginEntry {
  pluginId: string;
  name: string;
  source: string;
  version: string;
  target: string;
  integrity: string;
  discovery?: OfficialRuntimeDiscoveryRule;
  classification: OfficialPluginClassification;
  manifest: ConnectPluginManifestV1;
  installationConfiguration?: Record<string, unknown>;
  capabilityConfigurations?: Record<string, unknown>;
}

export interface OfficialPluginDiscoveryOptions extends PluginSourceResolverOptions {
  officialPluginsDirectory?: string;
  findExecutable?: (command: string) => Promise<string | null>;
  runDiscoveryCommand?: (request: OfficialDiscoveryCommandRequest) => Promise<{ readonly stdout: string }>;
}

export interface BundledOfficialPluginRegistry {
  entries: BundledOfficialPluginEntry[];
  diagnostics: string[];
}

export interface OfficialRuntimeDiscoveryResult {
  readonly detected: boolean;
  readonly compatible: boolean;
  readonly executablePath?: string;
  readonly version?: string;
}

export interface OfficialPluginCandidate {
  pluginId: string;
  name: string;
  source: string;
  version: string;
  target: string;
  integrity: string;
  detected: boolean;
  compatible: boolean;
  selected: boolean;
  selectable: true;
  discovery: OfficialRuntimeDiscoveryResult | null;
  classification: OfficialPluginClassification;
  diagnostic: string | null;
  resolvedSource: ConnectPluginSource | null;
  manifest: ConnectPluginManifestV1;
  installationConfiguration: Record<string, unknown>;
  capabilityConfigurations: Record<string, unknown>;
}

export interface OfficialPluginDiscovery {
  candidates: OfficialPluginCandidate[];
  officialSource: "bundled" | null;
  diagnostics: string[];
}

interface BundledOfficialPluginDefinition {
  readonly descriptor: OfficialPluginDescriptor;
  readonly name: string;
  readonly artifactIntegrity: string;
  readonly assetIntegrities?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly discovery?: OfficialRuntimeDiscoveryRule;
  readonly capabilityConfigurations?: Record<string, unknown>;
  readonly classification: OfficialPluginClassification;
}

const BUNDLED_OFFICIAL_PLUGINS: readonly BundledOfficialPluginDefinition[] = [
  {
    descriptor: codexDescriptor,
    name: "Codex",
    artifactIntegrity: "sha256-dyK1QPCBAiiT64eNVWLHaW419gph+86Obggon9f3B1U=",
    classification: "runtime",
    discovery: {
      executableNames: ["codex"],
      versionCommand: {
        argv: ["--version"],
        outputPattern:
          "^codex-cli (?<version>(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)$",
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    },
  },
  {
    descriptor: opencodeDescriptor,
    name: "OpenCode",
    artifactIntegrity: "sha256-itXMxXtcad93+z2gleTKno4D/zAqRG6zJG3QykojEzM=",
    discovery: {
      executableNames: ["opencode"],
      versionCommand: {
        argv: ["--version"],
        outputPattern: `^(?:opencode\\s+)?(?<version>${OPENCODE_SEMANTIC_VERSION_PATTERN})$`,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    },
    classification: "runtime",
  },
  {
    descriptor: deepSeekHarnessDescriptor,
    name: "DeepSeek Harness",
    artifactIntegrity: "sha256-PnPNzfflNQ7Jw7dLcg6ozZUvEvogYQ/MJ8zdN+X3srs=",
    assetIntegrities: {
      "artifacts/deepseek-harness-bridge.mjs": {
        "darwin-arm64": "sha256-WVMoH4vsy4xZrnl71O/zoyMWK0cq4JS3pDRi5Y1W+mE=",
        "darwin-x64": "sha256-WVMoH4vsy4xZrnl71O/zoyMWK0cq4JS3pDRi5Y1W+mE=",
        "linux-arm64": "sha256-WVMoH4vsy4xZrnl71O/zoyMWK0cq4JS3pDRi5Y1W+mE=",
        "linux-x64": "sha256-WVMoH4vsy4xZrnl71O/zoyMWK0cq4JS3pDRi5Y1W+mE=",
        "win32-arm64": "sha256-WVMoH4vsy4xZrnl71O/zoyMWK0cq4JS3pDRi5Y1W+mE=",
        "win32-x64": "sha256-WVMoH4vsy4xZrnl71O/zoyMWK0cq4JS3pDRi5Y1W+mE=",
      },
      "artifacts/deepseek-harness-question-provider.mjs": {
        "darwin-arm64": "sha256-ImK5ZUR++PLAlt8R0UZFvwafYnUpKk+u5toQ5pDBQZA=",
        "darwin-x64": "sha256-ImK5ZUR++PLAlt8R0UZFvwafYnUpKk+u5toQ5pDBQZA=",
        "linux-arm64": "sha256-ImK5ZUR++PLAlt8R0UZFvwafYnUpKk+u5toQ5pDBQZA=",
        "linux-x64": "sha256-ImK5ZUR++PLAlt8R0UZFvwafYnUpKk+u5toQ5pDBQZA=",
        "win32-arm64": "sha256-ImK5ZUR++PLAlt8R0UZFvwafYnUpKk+u5toQ5pDBQZA=",
        "win32-x64": "sha256-ImK5ZUR++PLAlt8R0UZFvwafYnUpKk+u5toQ5pDBQZA=",
      },
      "artifacts/deepseek-harness-tool-policy.mjs": {
        "darwin-arm64": "sha256-RScaYs2inRkqjaPBMLiiIG9OjY95uSSbe+yO4nMnJ6A=",
        "darwin-x64": "sha256-RScaYs2inRkqjaPBMLiiIG9OjY95uSSbe+yO4nMnJ6A=",
        "linux-arm64": "sha256-RScaYs2inRkqjaPBMLiiIG9OjY95uSSbe+yO4nMnJ6A=",
        "linux-x64": "sha256-RScaYs2inRkqjaPBMLiiIG9OjY95uSSbe+yO4nMnJ6A=",
        "win32-arm64": "sha256-RScaYs2inRkqjaPBMLiiIG9OjY95uSSbe+yO4nMnJ6A=",
        "win32-x64": "sha256-RScaYs2inRkqjaPBMLiiIG9OjY95uSSbe+yO4nMnJ6A=",
      },
    },
    classification: "runtime",
    discovery: {
      executableNames: ["dsh"],
    },
  },
  {
    descriptor: workbuddyDescriptor,
    name: "WorkBuddy",
    artifactIntegrity: "sha256-nUppv5vBsmQXru8rgBdVfNNfNV59GXbcOzlWNXm6QfA=",
    classification: "runtime",
    discovery: {
      executableNames: OFFICIAL_WORKBUDDY_DISTRIBUTIONS.map(({ applicationPath }) => applicationPath),
    },
  },
  {
    descriptor: connectClientDescriptor,
    name: "Connect Client",
    artifactIntegrity: "sha256-AxHFtxaZkxsfWkRA4RjdXZqxiFhhcOBGE+jQdmcBtYc=",
    classification: "managed-web-app",
    assetIntegrities: {
      "client-assets.json": {
        "darwin-arm64": "sha256-51MyPp1DtMAZfCxP+GHwqgYM62Ljq/VLLP0HZp+fgqc=",
        "darwin-x64": "sha256-51MyPp1DtMAZfCxP+GHwqgYM62Ljq/VLLP0HZp+fgqc=",
        "linux-arm64": "sha256-51MyPp1DtMAZfCxP+GHwqgYM62Ljq/VLLP0HZp+fgqc=",
        "linux-x64": "sha256-51MyPp1DtMAZfCxP+GHwqgYM62Ljq/VLLP0HZp+fgqc=",
        "win32-arm64": "sha256-51MyPp1DtMAZfCxP+GHwqgYM62Ljq/VLLP0HZp+fgqc=",
        "win32-x64": "sha256-51MyPp1DtMAZfCxP+GHwqgYM62Ljq/VLLP0HZp+fgqc=",
      },
    },
  },
  {
    descriptor: livewareDescriptor,
    name: "Liveware",
    artifactIntegrity: "sha256-Wmjh5NedB8OFYAfd+2GcUzqrlEqWU16yxU6+RG9Y8Mw=",
    classification: "exposure",
    assetIntegrities: {
      "assets/liveware": {
        "darwin-arm64": "sha256-VvdovxnGns0nO7xvDeLbzuF0C+7w5OjL6mAiR8R8ozY=",
        "darwin-x64": "sha256-jKIIJaJz/2Dd4xe6dLM+2yinjhRvZGc02Nu1yB/htAA=",
        "linux-arm64": "sha256-E7JUiHiroNSzIxF08C0mXSEO9Hwmn1zA6V23RoxbANk=",
        "linux-x64": "sha256-dXp0+LGu6GynF9NbKsNEvl1GTQA3A9jA2vagM7yso0A=",
        "win32-arm64": "sha256-DPjXoma/+jLF+Ro0pcaiE5fQG7hafGez5IDj5g0qFjo=",
        "win32-x64": "sha256-mjvLq67uGSZw3C2zklBY4FTmoEXW6CZMzT6miSP5Zeg=",
      },
    },
    capabilityConfigurations: { liveware: { accessPolicy: "private" } },
  },
];

export async function loadBundledOfficialPlugins(
  options: OfficialPluginDiscoveryOptions = {},
): Promise<BundledOfficialPluginRegistry> {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const directories = options.officialPluginsDirectory
    ? [resolve(options.officialPluginsDirectory)]
    : [resolve(dirname(process.execPath), "official-plugins"), resolve(import.meta.dir, "../../dist/official-plugins")];
  const entries: BundledOfficialPluginEntry[] = [];
  for (const definition of BUNDLED_OFFICIAL_PLUGINS) {
    const { descriptor } = definition;
    if (descriptor.supportedTargets && !descriptor.supportedTargets.includes(target as never)) continue;
    const filename = `${sanitizeBundleIdentity(descriptor.manifest.pluginId)}-${sanitizeBundleIdentity(descriptor.manifest.version)}-${target}.connect-plugin`;
    let sourcePath: string | undefined;
    for (const directory of directories) {
      const candidate = resolve(directory, filename);
      try {
        await access(candidate, constants.R_OK);
        sourcePath = candidate;
        break;
      } catch {
        // A partial development build may omit official Bundles that were not built yet.
      }
    }
    if (!sourcePath) continue;
    entries.push({
      pluginId: descriptor.manifest.pluginId,
      name: definition.name,
      source: `local:${sourcePath}`,
      version: descriptor.manifest.version,
      target,
      integrity: definition.artifactIntegrity,
      classification: definition.classification,
      manifest: {
        ...structuredClone(descriptor.manifest),
        artifacts: [
          {
            target,
            entry: `artifacts/${target}.mjs`,
            integrity: definition.artifactIntegrity,
          },
        ],
      },
      ...(definition.discovery ? { discovery: definition.discovery } : {}),
      ...(definition.capabilityConfigurations
        ? { capabilityConfigurations: structuredClone(definition.capabilityConfigurations) }
        : {}),
    });
  }
  return { entries, diagnostics: [] };
}

export async function resolveBundledOfficialPlugin(
  entry: BundledOfficialPluginEntry,
  options: PluginSourceResolverOptions = {},
): Promise<ResolvedPluginSource> {
  const definition = BUNDLED_OFFICIAL_PLUGINS.find(
    ({ descriptor }) =>
      descriptor.manifest.pluginId === entry.pluginId && descriptor.manifest.version === entry.version,
  );
  if (!definition) throw new Error(`Official Plugin ${entry.pluginId}@${entry.version} is not release-registered`);
  const resolved = await resolvePluginSource(entry.source, { ...options, target: entry.target });
  assertBundledBundle(definition, resolved.bundle, entry.target);
  if (resolved.target !== entry.target || entry.integrity !== definition.artifactIntegrity) {
    throw new Error(`Official Plugin ${entry.pluginId} resolved artifact does not match its bundled registry lock`);
  }
  return resolved;
}

export async function discoverOfficialPlugins(
  options: OfficialPluginDiscoveryOptions = {},
  onCandidate?: (entry: BundledOfficialPluginEntry) => void | Promise<void>,
): Promise<OfficialPluginDiscovery> {
  const loaded = await loadBundledOfficialPlugins(options);
  const candidates: OfficialPluginCandidate[] = [];
  const findExecutable = options.findExecutable ?? findExecutableOnPath;
  const runCommand = options.runDiscoveryCommand ?? runDiscoveryCommand;
  for (const entry of loaded.entries) {
    await onCandidate?.(entry);
    const base = {
      pluginId: entry.pluginId,
      name: entry.name,
      source: entry.source,
      version: entry.version,
      target: entry.target,
      integrity: entry.integrity,
      classification: entry.classification,
      selectable: true as const,
      resolvedSource: null,
      manifest: structuredClone(entry.manifest),
      installationConfiguration: structuredClone(entry.installationConfiguration ?? {}),
      capabilityConfigurations: structuredClone(entry.capabilityConfigurations ?? {}),
    };
    if (!entry.discovery) {
      candidates.push({
        ...base,
        detected: false,
        compatible: false,
        selected: false,
        discovery: null,
        diagnostic: "Official Plugin has no declarative runtime discovery rule; it remains manually selectable",
      });
      continue;
    }
    try {
      let executablePath: string | null = null;
      for (const command of entry.discovery.executableNames) {
        executablePath = await findExecutable(command);
        if (executablePath) break;
      }
      if (!executablePath) {
        candidates.push({
          ...base,
          detected: false,
          compatible: false,
          selected: false,
          discovery: { detected: false, compatible: false },
          diagnostic: "Declared runtime executable was not found",
        });
        continue;
      }
      const versionCommand = entry.discovery.versionCommand;
      if (!versionCommand) {
        const discovery = { detected: true, compatible: true, executablePath } as const;
        candidates.push({ ...base, ...discovery, selected: true, discovery, diagnostic: null });
        continue;
      }
      const result = await withTimeout(
        runCommand({
          executable: executablePath,
          argv: versionCommand.argv,
          timeoutMs: versionCommand.timeoutMs,
          maxOutputBytes: versionCommand.maxOutputBytes,
        }),
        versionCommand.timeoutMs,
        `Official Plugin ${entry.pluginId} discovery command timed out after ${versionCommand.timeoutMs} ms`,
      );
      if (Buffer.byteLength(result.stdout) > versionCommand.maxOutputBytes) {
        throw new Error(
          `Official Plugin ${entry.pluginId} discovery command exceeded its ${versionCommand.maxOutputBytes}-byte output limit`,
        );
      }
      const match = new RegExp(versionCommand.outputPattern, "u").exec(result.stdout.trim());
      const compatible = match !== null;
      const version = match?.groups?.version;
      const discovery = {
        detected: true,
        compatible,
        executablePath,
        ...(version ? { version } : {}),
      };
      candidates.push({
        ...base,
        detected: true,
        compatible,
        selected: compatible,
        discovery,
        diagnostic: compatible ? null : "Detected runtime version output did not match the bundled compatibility rule",
      });
    } catch (error) {
      candidates.push({
        ...base,
        detected: true,
        compatible: false,
        selected: false,
        discovery: { detected: true, compatible: false },
        diagnostic: `Official Plugin discovery failed in isolation: ${errorMessage(error)}`,
      });
    }
  }
  return { candidates, officialSource: "bundled", diagnostics: loaded.diagnostics };
}

function sanitizeBundleIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function assertBundledBundle(
  definition: BundledOfficialPluginDefinition,
  bundle: ConnectPluginBundleV1,
  target: string,
): void {
  const { artifacts, ...actualDescriptorManifest } = bundle.manifest;
  if (!isDeepStrictEqual(actualDescriptorManifest, definition.descriptor.manifest)) {
    throw new Error("manifest does not match the embedded official Plugin descriptor");
  }
  const artifact = artifacts[0];
  if (artifacts.length !== 1 || artifact?.target !== target) {
    throw new Error(`manifest must contain exactly one ${target} artifact`);
  }
  if (artifact.integrity !== definition.artifactIntegrity) {
    throw new Error("entry artifact does not match the release-pinned integrity");
  }
  const expectedFiles = new Set<string>([artifact.entry]);
  for (const asset of definition.descriptor.assets ?? []) {
    expectedFiles.add(asset.entry);
    const expected = definition.assetIntegrities?.[asset.entry]?.[target];
    if (!expected) throw new Error(`has no release-pinned integrity for ${asset.entry} on ${target}`);
    const file = bundle.files[asset.entry];
    if (!file || fileIntegrity(file) !== expected) {
      throw new Error(`${asset.entry} does not match the release-pinned integrity`);
    }
  }
  for (const directory of definition.descriptor.assetDirectories ?? []) {
    const manifestEntry = directory.integrityManifestEntry;
    expectedFiles.add(manifestEntry);
    const expectedManifestIntegrity = definition.assetIntegrities?.[manifestEntry]?.[target];
    if (!expectedManifestIntegrity) {
      throw new Error(`has no release-pinned integrity for ${manifestEntry} on ${target}`);
    }
    const manifestFile = bundle.files[manifestEntry];
    if (!manifestFile || fileIntegrity(manifestFile) !== expectedManifestIntegrity) {
      throw new Error(`${manifestEntry} does not match the release-pinned integrity`);
    }
    const integrities = parseAssetIntegrityManifest(fileBytes(manifestFile), manifestEntry);
    const prefix = `${directory.entryPrefix.replace(/\/+$/u, "")}/`;
    const actualEntries = Object.keys(bundle.files)
      .filter((entry) => entry.startsWith(prefix))
      .sort();
    if (!isDeepStrictEqual(Object.keys(integrities).sort(), actualEntries)) {
      throw new Error(`${manifestEntry} does not describe the complete ${prefix} asset graph`);
    }
    for (const entry of actualEntries) {
      expectedFiles.add(entry);
      const file = bundle.files[entry];
      if (!file || fileIntegrity(file) !== integrities[entry]) {
        throw new Error(`${entry} does not match ${manifestEntry}`);
      }
    }
  }
  if (!isDeepStrictEqual(Object.keys(bundle.files).sort(), [...expectedFiles].sort())) {
    throw new Error("Bundle files do not match the embedded official Plugin descriptor");
  }
}

export async function isBundledOfficialPluginInstallation(installed: {
  readonly pluginId: string;
  readonly version: string;
  readonly target: string;
  readonly integrity: string;
  readonly activeArtifact: string;
}): Promise<boolean> {
  const definition = BUNDLED_OFFICIAL_PLUGINS.find(
    ({ descriptor }) =>
      descriptor.manifest.pluginId === installed.pluginId && descriptor.manifest.version === installed.version,
  );
  if (!definition || installed.integrity !== definition.artifactIntegrity) return false;
  try {
    if (bytesIntegrity(await readFile(installed.activeArtifact)) !== definition.artifactIntegrity) return false;
    const artifactRoot = resolve(dirname(installed.activeArtifact), "..");
    for (const asset of definition.descriptor.assets ?? []) {
      const expected = definition.assetIntegrities?.[asset.entry]?.[installed.target];
      if (!expected) return false;
      if (bytesIntegrity(await readFile(resolve(artifactRoot, asset.entry))) !== expected) return false;
    }
    for (const directory of definition.descriptor.assetDirectories ?? []) {
      const manifestEntry = directory.integrityManifestEntry;
      const expectedManifestIntegrity = definition.assetIntegrities?.[manifestEntry]?.[installed.target];
      if (!expectedManifestIntegrity) return false;
      const manifestBytes = await readFile(resolve(artifactRoot, manifestEntry));
      if (bytesIntegrity(manifestBytes) !== expectedManifestIntegrity) return false;
      const integrities = parseAssetIntegrityManifest(manifestBytes, manifestEntry);
      for (const [entry, integrity] of Object.entries(integrities)) {
        if (bytesIntegrity(await readFile(resolve(artifactRoot, entry))) !== integrity) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function fileIntegrity(file: ConnectPluginBundleV1["files"][string]): string {
  return bytesIntegrity(fileBytes(file));
}

function fileBytes(file: ConnectPluginBundleV1["files"][string]): Uint8Array {
  return file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content);
}

function parseAssetIntegrityManifest(bytes: Uint8Array, entry: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${entry} is not a valid UTF-8 JSON integrity manifest`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${entry} must be an integrity object`);
  }
  const integrities: Record<string, string> = {};
  for (const [path, integrity] of Object.entries(value)) {
    if (!path || typeof integrity !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(integrity)) {
      throw new Error(`${entry} contains an invalid asset integrity`);
    }
    integrities[path] = integrity;
  }
  if (Object.keys(integrities).length === 0) throw new Error(`${entry} must not be empty`);
  return integrities;
}

function bytesIntegrity(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

async function runDiscoveryCommand(request: OfficialDiscoveryCommandRequest): Promise<{ readonly stdout: string }> {
  const subprocess = Bun.spawn([request.executable, ...request.argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const [exitCode, stdout] = await Promise.all([
      withTimeout(subprocess.exited, request.timeoutMs, `Discovery command timed out after ${request.timeoutMs} ms`),
      readBoundedCommandOutput(subprocess.stdout, request.maxOutputBytes),
    ]);
    if (exitCode !== 0) throw new Error(`Discovery command exited with status ${exitCode}`);
    return { stdout };
  } catch (error) {
    subprocess.kill();
    throw error;
  }
}

async function readBoundedCommandOutput(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let observed = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      observed += next.value.byteLength;
      if (observed > maximumBytes) throw new Error(`Discovery command exceeded its ${maximumBytes}-byte output limit`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(observed);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  if (!command) throw new Error("Runtime discovery executable names must not be empty");
  if (isAbsolute(command)) {
    try {
      await access(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  if (command.includes("/") || command.includes("\\")) {
    throw new Error("Runtime discovery executable names must be bare commands or absolute release-compiled paths");
  }
  return Bun.which(command, { PATH: process.env.PATH });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
