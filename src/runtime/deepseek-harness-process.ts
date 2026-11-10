import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  DSH_BRIDGE_MAX_FRAME_BYTES,
  DSH_BRIDGE_PROTOCOL_MAJOR,
  type DshBridgeEvent,
  type DshBridgeFrame,
  type DshBridgeHello,
  type DshBridgeInteraction,
  DshBridgeRemoteError,
  type DshBridgeRequest,
  parseDshBridgeFrame,
} from "./deepseek-harness-protocol";

const MAX_STDERR_BYTES = 65_536;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface DshExecutableProbe {
  readonly path: string;
  readonly executableArguments?: readonly string[];
}

export interface DshBridgeClient {
  readonly hello: DshBridgeHello;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  onInteraction(listener: (interaction: DshBridgeInteraction) => void): () => void;
  onEvent(listener: (event: DshBridgeEvent) => void): () => void;
  close(): Promise<void>;
}

export interface StartDshBridgeOptions {
  executable: string;
  executableArguments?: readonly string[];
  home: string;
  profile?: string;
  cwd: string;
  bridgePath: string;
  bridgeBuild: string;
  env?: Readonly<Record<string, string>>;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export function requireDshExecutable(
  configuredPath: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): DshExecutableProbe {
  const configuredExecutable = configuredPath?.trim();
  if (configuredPath !== undefined && !configuredExecutable) {
    throw new Error("Configured DeepSeek Harness executable path must not be empty");
  }
  const path = env?.PATH ?? process.env.PATH;
  const executable = configuredExecutable ?? Bun.which("dsh", { PATH: path });
  if (executable) return { path: executable };
  return requireDshPackageCommand(env);
}

export function requireDshPackageCommand(env: Readonly<Record<string, string>> | undefined): DshExecutableProbe {
  const path = env?.PATH ?? process.env.PATH;
  const bunx = Bun.which("bunx", { PATH: path });
  if (bunx) {
    return {
      path: bunx,
      executableArguments: ["@deepseek-ai/dsh"],
    };
  }
  const npx = Bun.which("npx", { PATH: path });
  if (npx) {
    return {
      path: npx,
      executableArguments: ["--yes", "@deepseek-ai/dsh"],
    };
  }
  const pnpm = Bun.which("pnpm", { PATH: path });
  if (pnpm) {
    return {
      path: pnpm,
      executableArguments: ["dlx", "@deepseek-ai/dsh"],
    };
  }
  throw new Error("DeepSeek Harness package launcher was not found; install Bun, Node.js with npx, or pnpm");
}

export async function startDshBridge(options: StartDshBridgeOptions): Promise<DshBridgeClient> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "clawchat-connect-dsh-"));
  const overlayPath = join(temporaryDirectory, "bridge.patch.yml");
  await writeFile(
    overlayPath,
    [
      "- insert:",
      "    - id: clawchat-connect-bridge",
      `      name: ${JSON.stringify(options.bridgePath)}`,
      "      config:",
      `        build: ${JSON.stringify(options.bridgeBuild)}`,
      `        home: ${JSON.stringify(options.home)}`,
      `        profile: ${JSON.stringify(options.profile ?? null)}`,
      "",
    ].join("\n"),
  );

  let child: ChildProcess | undefined;
  try {
    child = spawn(
      options.executable,
      [
        ...(options.executableArguments ?? []),
        ...(options.profile ? ["--profile", options.profile] : []),
        "--patch",
        overlayPath,
      ],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          DSH_HOME: options.home,
          CONNECT_DSH_BRIDGE_FD_OUT: "3",
          CONNECT_DSH_BRIDGE_FD_IN: "4",
        },
        // SDK profiles shut down on stdin EOF; keep their host transport alive.
        stdio: ["pipe", "ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    return await SpawnedDshBridge.create(child, temporaryDirectory, options);
  } catch (error) {
    if (child) await terminateDshProcess(child, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

class SpawnedDshBridge implements DshBridgeClient {
  readonly hello: DshBridgeHello;
  private readonly listeners = new Set<(event: DshBridgeEvent) => void>();
  private readonly interactionListeners = new Set<(interaction: DshBridgeInteraction) => void>();
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly output: Writable;
  private readonly exited: Promise<void>;
  private requestSequence = 0;
  private closing = false;
  private failure: Error | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly temporaryDirectory: string,
    hello: DshBridgeHello,
    private readonly requestTimeoutMs: number,
    private readonly stopTimeoutMs: number,
    private readonly stderr: { text: string },
  ) {
    this.hello = hello;
    this.output = child.stdio[4] as Writable;
    this.exited = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        if (!this.closing) {
          const detail = this.stderr.text.trim();
          this.fail(
            new Error(
              `DeepSeek Harness process exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${
                detail ? `: ${detail}` : ""
              }`,
            ),
          );
        }
        resolve();
      });
    });
  }

  static async create(
    child: ChildProcess,
    temporaryDirectory: string,
    options: StartDshBridgeOptions,
  ): Promise<SpawnedDshBridge> {
    const input = child.stdio[3] as Readable;
    const stderrStream = child.stderr;
    if (!input || !stderrStream || !child.stdio[4])
      throw new Error("DeepSeek Harness inherited pipes were not created");
    const stderr = { text: "" };
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderr.text = `${stderr.text}${chunk}`.slice(-MAX_STDERR_BYTES);
    });

    let settleHello!: (hello: DshBridgeHello) => void;
    let rejectHello!: (error: Error) => void;
    const helloPromise = new Promise<DshBridgeHello>((resolve, reject) => {
      settleHello = resolve;
      rejectHello = reject;
    });
    let bridge: SpawnedDshBridge | undefined;
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) > DSH_BRIDGE_MAX_FRAME_BYTES) {
        const error = new Error("DeepSeek Harness Bridge emitted an oversized frame");
        bridge?.fail(error);
        rejectHello(error);
        child.kill("SIGTERM");
        return;
      }
      let frame: DshBridgeFrame;
      try {
        frame = parseDshBridgeFrame(line);
      } catch (cause) {
        const error = new Error("DeepSeek Harness Bridge emitted a malformed frame", { cause });
        bridge?.fail(error);
        rejectHello(error);
        child.kill("SIGTERM");
        return;
      }
      if (!bridge) {
        if (frame.type !== "hello") {
          rejectHello(new Error("DeepSeek Harness Bridge did not emit hello first"));
          child.kill("SIGTERM");
          return;
        }
        settleHello(frame);
        return;
      }
      bridge.receive(frame);
    });
    child.once("error", (cause) => {
      const error = new Error("DeepSeek Harness process could not be started", { cause });
      bridge?.fail(error);
      rejectHello(error);
    });
    child.once("close", (code, signal) => {
      if (bridge) return;
      const detail = stderr.text.trim();
      rejectHello(
        new Error(
          `DeepSeek Harness Profile boot failed (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    });

    let hello: DshBridgeHello;
    try {
      hello = await withTimeout(
        helloPromise,
        options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        "DeepSeek Harness Bridge handshake timed out",
      );
    } catch (cause) {
      const detail = stderr.text.trim();
      const missingProfileService =
        cause instanceof Error && cause.message === "DeepSeek Harness Bridge handshake timed out";
      throw new Error(
        missingProfileService
          ? "workspace-registry-missing: selected DeepSeek Harness Profile did not activate the Bridge's required services"
          : `DeepSeek Harness Bridge handshake failed${detail ? `: ${detail}` : ""}`,
        { cause },
      );
    }
    if (hello.protocol.major !== DSH_BRIDGE_PROTOCOL_MAJOR) {
      throw new Error(
        `DeepSeek Harness Bridge protocol major ${hello.protocol.major} is incompatible with ${DSH_BRIDGE_PROTOCOL_MAJOR}`,
      );
    }
    bridge = new SpawnedDshBridge(
      child,
      temporaryDirectory,
      hello,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      stderr,
    );
    return bridge;
  }

  async request<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.closing && method !== "shutdown") throw new Error("DeepSeek Harness Bridge is closing");
    const id = `connect-${++this.requestSequence}`;
    const frame: DshBridgeRequest = { type: "request", id, method, params };
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded) > DSH_BRIDGE_MAX_FRAME_BYTES) {
      throw new Error(`DeepSeek Harness Bridge request ${method} exceeds the frame limit`);
    }
    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DeepSeek Harness Bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    try {
      if (!this.output.write(encoded)) await new Promise<void>((resolve) => this.output.once("drain", resolve));
    } catch (cause) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
      }
      throw new Error(`DeepSeek Harness Bridge request could not be written: ${method}`, { cause });
    }
    return (await reply) as T;
  }

  onEvent(listener: (event: DshBridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onInteraction(listener: (interaction: DshBridgeInteraction) => void): () => void {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closing) return await this.exited;
    this.closing = true;
    try {
      if (this.child.exitCode === null && !this.failure) {
        await this.request("shutdown", {}, this.stopTimeoutMs).catch(() => undefined);
        this.output.end();
        this.child.stdin?.end();
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          await withTimeout(this.exited, this.stopTimeoutMs, "DSH shutdown timed out");
        } catch {
          await terminateDshProcess(this.child, this.stopTimeoutMs);
        }
      }
      await withTimeout(this.exited, this.stopTimeoutMs, "DSH process did not close");
    } finally {
      this.fail(new Error("DeepSeek Harness Bridge closed"));
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    }
  }

  private receive(frame: DshBridgeFrame): void {
    if (frame.type === "hello") {
      this.fail(new Error("DeepSeek Harness Bridge emitted more than one hello frame"));
      this.child.kill("SIGTERM");
      return;
    }
    if (frame.type === "event") {
      for (const listener of this.listeners) listener(frame);
      return;
    }
    if (frame.type === "interaction") {
      for (const listener of this.interactionListeners) listener(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new DshBridgeRemoteError(frame.error.code, frame.error.message));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }
}

async function terminateDshProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    try {
      await withTimeout(exited, timeoutMs, "DSH termination timed out");
    } catch {
      child.kill("SIGKILL");
      await withTimeout(exited, timeoutMs, "DSH process could not be reaped");
    }
  }
  // No protocol reader may keep a failed launch alive after its process exits.
  for (const stream of child.stdio) stream?.destroy();
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
