import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  advanceBetaChannel,
  advanceBetaChannelWithGh,
  compareBetaTags,
  publishBetaReleaseWithGh,
  publishImmutableBetaRelease,
} from "../scripts/release-beta";

const read = (path: string) => readFile(path, "utf8");
const betaReleaseAssetNames = ["CHANGELOG.md", "checksums.txt", "clawchat-connect-darwin-arm64.tar.gz", "install.sh"];
const betaReleaseAssets = betaReleaseAssetNames.map((name) => `build/release/${name}`);

test("beta tag comparison uses semantic version order", () => {
  expect(compareBetaTags("v0.1.0-beta.10", "v0.1.0-beta.2")).toBeGreaterThan(0);
  expect(compareBetaTags("v0.2.0-beta.1", "v0.1.99-beta.99")).toBeGreaterThan(0);
  expect(compareBetaTags("v1.0.0-beta.1", "v0.99.99-beta.99")).toBeGreaterThan(0);
  expect(compareBetaTags("v0.1.0-beta.2", "v0.1.0-beta.2")).toBe(0);
  expect(compareBetaTags("v0.1.0-beta.1", "v0.1.0-beta.2")).toBeLessThan(0);
});

test("beta tag comparison rejects non-beta channel values", () => {
  expect(() => compareBetaTags("v0.1.0", "v0.1.0-beta.1")).toThrow("beta release tag");
  expect(() => compareBetaTags("v0.1.0-beta.0", "v0.1.0-beta.1")).toThrow("beta release tag");
});

test("publication requires the exact four-file beta release inventory", async () => {
  let reads = 0;
  let creates = 0;
  await expect(
    publishImmutableBetaRelease(
      {
        tag: "v0.1.0-beta.1",
        notesFile: "build/release-notes.md",
        assets: betaReleaseAssets.slice(0, -1),
      },
      {
        readRelease: async () => {
          reads += 1;
          return null;
        },
        createRelease: async () => {
          creates += 1;
        },
      },
    ),
  ).rejects.toThrow("required release inventory");
  expect(reads).toBe(0);
  expect(creates).toBe(0);
});

test("a complete existing prerelease resumes publication without mutating it", async () => {
  let createCalls = 0;
  await publishImmutableBetaRelease(
    {
      tag: "v0.1.0-beta.1",
      notesFile: "build/release-notes.md",
      assets: betaReleaseAssets,
    },
    {
      readRelease: async () => ({
        tag: "v0.1.0-beta.1",
        prerelease: true,
        draft: false,
        assetNames: betaReleaseAssetNames,
      }),
      createRelease: async () => {
        createCalls += 1;
      },
    },
  );
  expect(createCalls).toBe(0);
});

test.each([
  [
    "non-prerelease state",
    { tag: "v0.1.0-beta.1", prerelease: false, draft: false, assetNames: betaReleaseAssetNames },
  ],
  ["draft state", { tag: "v0.1.0-beta.1", prerelease: true, draft: true, assetNames: betaReleaseAssetNames }],
  ["a wrong tag", { tag: "v0.1.0-beta.2", prerelease: true, draft: false, assetNames: betaReleaseAssetNames }],
  [
    "an incomplete asset set",
    { tag: "v0.1.0-beta.1", prerelease: true, draft: false, assetNames: betaReleaseAssetNames.slice(0, -1) },
  ],
  [
    "an unexpected asset",
    {
      tag: "v0.1.0-beta.1",
      prerelease: true,
      draft: false,
      assetNames: [...betaReleaseAssetNames, "unexpected.txt"],
    },
  ],
])("an existing release with %s fails closed without mutation", async (_case, existingRelease) => {
  let createCalls = 0;
  await expect(
    publishImmutableBetaRelease(
      {
        tag: "v0.1.0-beta.1",
        notesFile: "build/release-notes.md",
        assets: betaReleaseAssets,
      },
      {
        readRelease: async () => existingRelease,
        createRelease: async () => {
          createCalls += 1;
        },
      },
    ),
  ).rejects.toThrow("does not match the complete immutable prerelease");
  expect(createCalls).toBe(0);
});

test("the GitHub publication boundary accepts a complete existing prerelease without mutation", async () => {
  const commands: string[][] = [];
  await publishBetaReleaseWithGh(
    {
      repository: "owner/repository",
      tag: "v0.1.0-beta.1",
      notesFile: "build/release-notes.md",
      assets: betaReleaseAssets,
    },
    async (arguments_) => {
      commands.push([...arguments_]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          tagName: "v0.1.0-beta.1",
          isPrerelease: true,
          isDraft: false,
          assets: betaReleaseAssetNames.map((name) => ({ name })),
        }),
        stderr: "",
      };
    },
  );
  expect(commands).toEqual([
    ["release", "view", "v0.1.0-beta.1", "--repo", "owner/repository", "--json", "tagName,isPrerelease,isDraft,assets"],
  ]);
});

test("the GitHub publication boundary rejects a draft prerelease without mutation", async () => {
  const commands: string[][] = [];
  await expect(
    publishBetaReleaseWithGh(
      {
        repository: "owner/repository",
        tag: "v0.1.0-beta.1",
        notesFile: "build/release-notes.md",
        assets: betaReleaseAssets,
      },
      async (arguments_) => {
        commands.push([...arguments_]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            tagName: "v0.1.0-beta.1",
            isPrerelease: true,
            isDraft: true,
            assets: betaReleaseAssetNames.map((name) => ({ name })),
          }),
          stderr: "",
        };
      },
    ),
  ).rejects.toThrow("does not match the complete immutable prerelease");
  expect(commands).toEqual([
    ["release", "view", "v0.1.0-beta.1", "--repo", "owner/repository", "--json", "tagName,isPrerelease,isDraft,assets"],
  ]);
});

test.each([
  [
    "non-prerelease state",
    {
      tagName: "v0.1.0-beta.1",
      isPrerelease: false,
      isDraft: false,
      assets: betaReleaseAssetNames.map((name) => ({ name })),
    },
  ],
  [
    "a wrong tag",
    {
      tagName: "v0.1.0-beta.2",
      isPrerelease: true,
      isDraft: false,
      assets: betaReleaseAssetNames.map((name) => ({ name })),
    },
  ],
  [
    "an incomplete asset set",
    {
      tagName: "v0.1.0-beta.1",
      isPrerelease: true,
      isDraft: false,
      assets: betaReleaseAssetNames.slice(0, -1).map((name) => ({ name })),
    },
  ],
])("the GitHub publication boundary rejects an existing release with %s", async (_case, release) => {
  const commands: string[][] = [];
  await expect(
    publishBetaReleaseWithGh(
      {
        repository: "owner/repository",
        tag: "v0.1.0-beta.1",
        notesFile: "build/release-notes.md",
        assets: betaReleaseAssets,
      },
      async (arguments_) => {
        commands.push([...arguments_]);
        return { exitCode: 0, stdout: JSON.stringify(release), stderr: "" };
      },
    ),
  ).rejects.toThrow("does not match the complete immutable prerelease");
  expect(commands).toHaveLength(1);
});

test("a new tag creates one immutable prerelease with the prepared assets", async () => {
  const commands: string[][] = [];
  await publishBetaReleaseWithGh(
    {
      repository: "owner/repository",
      tag: "v0.1.0-beta.2",
      notesFile: "build/release-notes.md",
      assets: betaReleaseAssets,
    },
    async (arguments_) => {
      commands.push([...arguments_]);
      if (arguments_[1] === "view") return { exitCode: 1, stdout: "", stderr: "release not found" };
      return { exitCode: 0, stdout: "created", stderr: "" };
    },
  );
  expect(commands).toEqual([
    ["release", "view", "v0.1.0-beta.2", "--repo", "owner/repository", "--json", "tagName,isPrerelease,isDraft,assets"],
    [
      "release",
      "create",
      "v0.1.0-beta.2",
      ...betaReleaseAssets,
      "--repo",
      "owner/repository",
      "--verify-tag",
      "--prerelease",
      "--title",
      "ClawChat Connect v0.1.0-beta.2",
      "--notes-file",
      "build/release-notes.md",
    ],
  ]);
});

test.each([
  ["older", "v0.1.0-beta.2", "v0.1.0-beta.3"],
  ["equal", "v0.1.0-beta.3", "v0.1.0-beta.3"],
])("an %s beta never replaces the current channel pointer", async (_case, candidateTag, currentTag) => {
  let writes = 0;
  const result = await advanceBetaChannel(
    { candidateTag },
    {
      ensureChannelBranch: async () => undefined,
      readChannelPointer: async () => ({ tag: currentTag, sha: "current-sha" }),
      updateChannelPointer: async () => {
        writes += 1;
        return "updated";
      },
    },
  );
  expect(result).toEqual({ status: "unchanged", tag: currentTag, attempts: 1 });
  expect(writes).toBe(0);
});

test("a newer beta advances the channel with the observed blob SHA", async () => {
  const updates: Array<{ tag: string; expectedSha?: string }> = [];
  const result = await advanceBetaChannel(
    { candidateTag: "v0.1.0-beta.3" },
    {
      ensureChannelBranch: async () => undefined,
      readChannelPointer: async () => ({ tag: "v0.1.0-beta.2", sha: "beta-2-sha" }),
      updateChannelPointer: async (input) => {
        updates.push(input);
        return "updated";
      },
    },
  );
  expect(result).toEqual({ status: "advanced", tag: "v0.1.0-beta.3", attempts: 1 });
  expect(updates).toEqual([{ tag: "v0.1.0-beta.3", expectedSha: "beta-2-sha" }]);
});

test("a conflicting channel update refetches and cannot overwrite a concurrent newer beta", async () => {
  const pointers = [
    { tag: "v0.1.0-beta.2", sha: "beta-2-sha" },
    { tag: "v0.1.0-beta.4", sha: "beta-4-sha" },
  ];
  const updates: Array<{ tag: string; expectedSha?: string }> = [];
  let reads = 0;
  const result = await advanceBetaChannel(
    { candidateTag: "v0.1.0-beta.3" },
    {
      ensureChannelBranch: async () => undefined,
      readChannelPointer: async () => pointers[reads++] ?? { tag: "v0.1.0-beta.4", sha: "beta-4-sha" },
      updateChannelPointer: async (input) => {
        updates.push(input);
        return "conflict";
      },
    },
  );
  expect(result).toEqual({ status: "unchanged", tag: "v0.1.0-beta.4", attempts: 2 });
  expect(reads).toBe(2);
  expect(updates).toEqual([{ tag: "v0.1.0-beta.3", expectedSha: "beta-2-sha" }]);
});

test("channel advancement retries with the freshly observed SHA and stops at its bound", async () => {
  let reads = 0;
  const updates: Array<{ tag: string; expectedSha?: string }> = [];
  await expect(
    advanceBetaChannel(
      { candidateTag: "v0.1.0-beta.4", maxAttempts: 3 },
      {
        ensureChannelBranch: async () => undefined,
        readChannelPointer: async () => ({ tag: "v0.1.0-beta.1", sha: `observed-sha-${++reads}` }),
        updateChannelPointer: async (input) => {
          updates.push(input);
          return "conflict";
        },
      },
    ),
  ).rejects.toThrow("conflicted 3 times");
  expect(reads).toBe(3);
  expect(updates).toEqual([
    { tag: "v0.1.0-beta.4", expectedSha: "observed-sha-1" },
    { tag: "v0.1.0-beta.4", expectedSha: "observed-sha-2" },
    { tag: "v0.1.0-beta.4", expectedSha: "observed-sha-3" },
  ]);
});

test("the GitHub channel boundary retries a conflicted SHA update against fresh pointer state", async () => {
  const commands: string[][] = [];
  const currentPointers = [
    { sha: "beta-2-sha", content: Buffer.from("v0.1.0-beta.2\n").toString("base64") },
    { sha: "beta-4-sha", content: Buffer.from("v0.1.0-beta.4\n").toString("base64") },
  ];
  let pointerReads = 0;
  const result = await advanceBetaChannelWithGh(
    {
      repository: "owner/repository",
      candidateTag: "v0.1.0-beta.3",
      sourceSha: "release-commit-sha",
    },
    async (arguments_) => {
      commands.push([...arguments_]);
      const endpoint = arguments_.find((argument) => argument.startsWith("repos/")) ?? "";
      if (endpoint.includes("git/ref/heads/release-channel")) {
        return { exitCode: 0, stdout: '{"ref":"refs/heads/release-channel"}', stderr: "" };
      }
      if (arguments_.includes("PUT")) {
        return { exitCode: 1, stdout: "", stderr: "gh: conflict (HTTP 409)" };
      }
      return { exitCode: 0, stdout: JSON.stringify(currentPointers[pointerReads++]), stderr: "" };
    },
  );
  expect(result).toEqual({ status: "unchanged", tag: "v0.1.0-beta.4", attempts: 2 });
  expect(pointerReads).toBe(2);
  const update = commands.find((arguments_) => arguments_.includes("PUT"));
  expect(update).toContain("sha=beta-2-sha");
  expect(update).toContain("repos/owner/repository/contents/latest-beta.txt");
  expect(commands.flat().filter((argument) => argument.startsWith("repos/owner/repository/contents/"))).toEqual([
    "repos/owner/repository/contents/latest-beta.txt?ref=release-channel",
    "repos/owner/repository/contents/latest-beta.txt",
    "repos/owner/repository/contents/latest-beta.txt?ref=release-channel",
  ]);
  expect(commands.filter((arguments_) => arguments_.includes("PUT"))).toHaveLength(1);
});

test("beta workflow invokes the immutable release and monotonic channel behavior", async () => {
  const workflow = Bun.YAML.parse(await read(".github/workflows/release-beta.yml")) as {
    jobs: { release: { steps: Array<{ name?: string; run?: string; if?: string }> } };
  };
  const steps = workflow.jobs.release.steps;
  const publication = steps.find(({ name }) => name === "Publish GitHub prerelease");
  const advancement = steps.find(({ name }) => name === "Advance beta release channel");
  expect(publication?.run?.split("\n").map((line) => line.trim())).toContain(
    "bun scripts/release-beta.ts publish build/release-notes.md build/release/*",
  );
  expect(advancement?.run?.trim()).toBe("bun scripts/release-beta.ts advance-channel");
  expect(publication?.run).not.toContain("--clobber");
  expect(publication?.run).not.toContain("gh release upload");
  expect(publication?.run).not.toContain("gh release edit");
  expect(publication?.if).toBe("github.event_name == 'push'");
  expect(advancement?.if).toBe("github.event_name == 'push'");
});

test("beta workflow validates the exact tag before the Darwin arm64 release", async () => {
  const workflow = Bun.YAML.parse(await read(".github/workflows/release-beta.yml")) as {
    jobs: {
      validate: { steps: Array<{ name?: string; run?: string }> };
      release: { needs?: string | string[]; "runs-on"?: string; steps: Array<{ name?: string }> };
    };
  };
  const validation = workflow.jobs.validate.steps.find(({ name }) => name === "Verify beta version");
  const dollar = "$";
  expect(
    validation?.run
      ?.trim()
      .split("\n")
      .map((line) => line.trim()),
  ).toEqual([
    "set -euo pipefail",
    `package_version="$(bun -e 'console.log(require("./package.json").version)')"`,
    `if [[ ! "${dollar}{package_version}" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[1-9][0-9]*$ ]]; then`,
    'echo "Only beta versions may be released" >&2',
    "exit 1",
    "fi",
    `if [ "${dollar}{GITHUB_EVENT_NAME}" = "push" ]; then`,
    `test "${dollar}{GITHUB_REF_NAME}" = "v${dollar}{package_version}"`,
    "fi",
  ]);
  expect(workflow.jobs.release.needs).toBe("validate");
  expect(workflow.jobs.release["runs-on"]).toBe("macos-14");
  expect(workflow.jobs.release.steps.some(({ name }) => name === "Verify beta version")).toBe(false);
});

test("version metadata is synchronized at beta.9", async () => {
  const pkg = await Bun.file("package.json").json();
  const source = await read("src/service/version.ts");
  const manifest = await Bun.file("skills/manifest.json").json();
  expect(pkg.version).toBe("0.1.0-beta.9");
  expect(source).toContain('CONNECT_VERSION = "0.1.0-beta.9"');
  expect(manifest.connectVersion).toBe("0.1.0-beta.9");
});

test("the unversioned shell installer follows beta while Windows requires an explicit historical version", async () => {
  const shell = await read("install.sh");
  const powershell = await read("install.ps1");
  expect(shell).toContain("release-channel/latest-beta.txt");
  expect(shell).not.toContain("release-channel/latest-alpha.txt");
  expect(powershell).not.toContain("release-channel/latest-beta.txt");
  expect(powershell).toContain("Pass -Version only to install an explicitly selected historical Windows release");
});

async function runShellInstallerFixture(kernel: string, machine: string, translated = "0") {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-explicit-shell-"));
  const commandDirectory = join(directory, "commands");
  const requestsPath = join(directory, "requests.log");
  await mkdir(commandDirectory);
  const commands = {
    curl: [
      "#!/bin/sh",
      "url=",
      'for argument in "$@"; do',
      '  case "$argument" in http*) url="$argument" ;; esac',
      "done",
      'printf "%s\\n" "$url" >> "$CONNECT_INSTALL_REQUESTS"',
      "exit 17",
      "",
    ].join("\n"),
    uname:
      '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$CONNECT_INSTALL_KERNEL" ;; -m) printf "%s\\n" "$CONNECT_INSTALL_MACHINE" ;; *) exit 2 ;; esac\n',
    sysctl: '#!/bin/sh\nprintf "%s\\n" "$CONNECT_INSTALL_TRANSLATED"\n',
  };
  for (const [name, source] of Object.entries(commands)) {
    const path = join(commandDirectory, name);
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  const child = Bun.spawn(["sh", "install.sh", "v0.1.0-alpha.33"], {
    cwd: globalThis.process.cwd(),
    env: {
      ...globalThis.process.env,
      PATH: `${commandDirectory}${delimiter}${globalThis.process.env.PATH ?? ""}`,
      TMPDIR: directory,
      CLAWCHAT_CONNECT_REPOSITORY: "fixture-owner/fixture-repository",
      CLAWCHAT_CONNECT_INSTALL_DIR: join(directory, "install"),
      CONNECT_INSTALL_REQUESTS: requestsPath,
      CONNECT_INSTALL_KERNEL: kernel,
      CONNECT_INSTALL_MACHINE: machine,
      CONNECT_INSTALL_TRANSLATED: translated,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const requests = (await Bun.file(requestsPath).exists()) ? (await read(requestsPath)).trim().split("\n") : [];
  return { exitCode, stderr, requests };
}

test.each([
  ["arm64", "0"],
  ["x86_64", "1"],
])(
  "shell installer bypasses the beta channel for an explicit historical version on Darwin %s (translated=%s)",
  async (machine, translated) => {
    const installer = await read("install.sh");
    expect(installer).toContain('version="$' + "{1:-$" + '{CLAWCHAT_CONNECT_VERSION:-}}"');
    expect(installer).toContain('if [ -z "$version" ]; then');
    expect(installer).toContain('base_url="https://github.com/$' + "{repository}/releases/download/$" + '{version}"');
    if (globalThis.process.platform === "win32") return;

    const result = await runShellInstallerFixture("Darwin", machine, translated);
    expect(result.exitCode).toBe(17);
    expect(result.requests).toEqual([
      "https://github.com/fixture-owner/fixture-repository/releases/download/v0.1.0-alpha.33/clawchat-connect-darwin-arm64.tar.gz",
    ]);
    expect(result.stderr).not.toContain("current beta releases support only");
  },
);

test.each([
  ["Linux", "x86_64"],
  ["Darwin", "x86_64"],
])("shell installer rejects unsupported %s %s before downloading an archive", async (kernel, machine) => {
  if (globalThis.process.platform === "win32") return;
  const result = await runShellInstallerFixture(kernel, machine);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("current beta releases support only macOS on Apple silicon");
  expect(result.requests).toEqual([]);
});

test("PowerShell installer bypasses the beta channel for an explicit historical version", async () => {
  const powershell = await read("install.ps1");
  const executable = Bun.which("pwsh");
  if (!executable) {
    expect(powershell).toContain("[string]$Version");
    expect(powershell).toContain("Pass -Version only to install an explicitly selected historical Windows release");
    expect(powershell).toContain('$baseUrl = "https://github.com/$repository/releases/download/$Version"');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-explicit-powershell-"));
  const requestsPath = join(directory, "requests.log");
  const installDirectory = join(directory, "install");
  const licenseDirectory = join(directory, "licenses");
  const command = [
    `$env:CONNECT_INSTALL_REQUESTS = '${requestsPath}'`,
    "function Invoke-WebRequest {",
    "  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)",
    "  Add-Content -LiteralPath $env:CONNECT_INSTALL_REQUESTS -Value $Uri",
    "  throw 'intentional fixture stop'",
    "}",
    `& ./install.ps1 -Version v0.1.0-alpha.33 -InstallDirectory '${installDirectory}' -LicenseDirectory '${licenseDirectory}'`,
  ].join("\n");
  const process = Bun.spawn([executable, "-NoProfile", "-Command", command], {
    cwd: globalThis.process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).not.toBe(0);
  const requests = await read(requestsPath);
  expect(requests).toContain("/releases/download/v0.1.0-alpha.33/clawchat-connect-windows-");
  expect(requests).not.toContain("release-channel/latest-beta.txt");
}, 30_000);

test("beta workflow builds only the qualified Darwin arm64 release before publication", async () => {
  const workflow = Bun.YAML.parse(await read(".github/workflows/release-beta.yml")) as {
    on: { push: { tags: string[] }; workflow_dispatch: Record<string, never> };
    jobs: { release: { "runs-on": string; steps: Array<{ name?: string; run?: string }> } };
  };
  expect(workflow.on.push.tags).toEqual(["v*-beta.*"]);
  expect(workflow.on.workflow_dispatch).toEqual({});
  const steps = workflow.jobs.release.steps;
  const build = steps.find(({ name }) => name === "Build qualified Darwin arm64 release");
  expect(workflow.jobs.release["runs-on"]).toBe("macos-14");
  expect(build?.run?.trim()).toBe("bun run build:release");
  expect(await read(".github/workflows/release-beta.yml")).not.toMatch(/darwin-x64|linux-|windows-|install\\.ps1/iu);
  const publicationIndex = steps.findIndex(({ name }) => name === "Publish GitHub prerelease");
  const advancementIndex = steps.findIndex(({ name }) => name === "Advance beta release channel");
  expect(publicationIndex).toBeGreaterThan(-1);
  expect(advancementIndex).toBeGreaterThan(publicationIndex);
});
