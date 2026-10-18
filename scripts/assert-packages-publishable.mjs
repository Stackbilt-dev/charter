#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageGlobs = [
  "packages/types",
  "packages/core",
  "packages/adf",
  "packages/git",
  "packages/classify",
  "packages/validate",
  "packages/drift",
  "packages/blast",
  "packages/surface",
  "packages/policies",
  "packages/ci",
  "packages/cli",
  "packages/scaffold-core",
];
const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];
const forbiddenTarballPathPatterns = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /(^|\/)__fixtures__\//,
  /\.test\.(js|d\.ts|d\.ts\.map|js\.map)$/,
  /\.spec\.(js|d\.ts|d\.ts\.map|js\.map)$/,
];

const tempDir = mkdtempSync(join(tmpdir(), "charter-publish-check-"));
const failures = [];

// Under `pnpm run`, npm_execpath points at pnpm's JS entry point, which node can
// run directly on every platform. Otherwise use `pnpm` from PATH; on Windows
// that is `pnpm.cmd`, which Node can only start through a shell.
function pnpmCommand(args) {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath) && /\.[cm]?js$/i.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args], shell: false };
  }
  if (process.platform === "win32") {
    // Pass one pre-quoted command line: Node deprecates args arrays with shell.
    return { command: ["pnpm", ...args].map(quoteForCmd).join(" "), args: [], shell: true };
  }
  return { command: "pnpm", args, shell: false };
}

function quoteForCmd(arg) {
  return /^[\w\-.:/\\=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed in ${options.cwd}`,
        result.error ? `spawn error: ${result.error.message}` : "",
        result.status === null && result.signal ? `terminated by signal ${result.signal}` : "",
        (result.stdout ?? "").trim(),
        (result.stderr ?? "").trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout ?? "";
}

function runPnpm(args, options) {
  const invocation = pnpmCommand(args);
  return run(invocation.command, invocation.args, { ...options, shell: invocation.shell });
}

// Minimal reader for the gzipped ustar archives `pnpm pack` produces. Reading
// the tarball in-process avoids depending on a system `tar`, whose flavour and
// path handling vary by platform (GNU tar under Git Bash reads `C:/...` as a
// remote host).
function readTarball(tarball) {
  const data = gunzipSync(readFileSync(tarball));
  const entries = new Map();
  let offset = 0;
  let pendingPath = null;

  const field = (block, start, length) => {
    const raw = block.subarray(start, start + length);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
  };

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || offset + 512 + size > data.length) {
      throw new Error(`Malformed tar header at offset ${offset} in ${tarball}.`);
    }
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (match) pendingPath = match[1];
      continue;
    }
    if (type === "L") {
      pendingPath = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue;

    const name = field(header, 0, 100);
    const prefix = field(header, 257, 5) === "ustar" ? field(header, 345, 155) : "";
    const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;

    if (type === "0" || type === "7") {
      entries.set(path, body);
    }
  }

  return entries;
}

function packedPackageJson(entries, tarball) {
  const manifest = entries.get("package/package.json");
  if (!manifest) {
    throw new Error(`${tarball} has no package/package.json.`);
  }
  return JSON.parse(manifest.toString("utf8"));
}

function workspaceDependencyEntries(manifest) {
  const entries = [];

  for (const field of dependencyFields) {
    const dependencies = manifest[field] ?? {};
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        entries.push(`${field}.${name}=${specifier}`);
      }
    }
  }

  return entries;
}

function tarballsIn(directory) {
  return new Set(readdirSync(directory).filter((file) => file.endsWith(".tgz")));
}

function packedFilename(packageDir, output, beforePack) {
  if (output.trim().length > 0) {
    const packResult = JSON.parse(output);
    if (typeof packResult.filename === "string") {
      return packResult.filename;
    }
  }

  const createdTarballs = readdirSync(tempDir)
    .filter((file) => file.endsWith(".tgz") && !beforePack.has(file));

  if (createdTarballs.length !== 1) {
    throw new Error(
      `Expected one tarball from pnpm pack for ${packageDir}, found ${createdTarballs.length}.`,
    );
  }

  return join(tempDir, createdTarballs[0]);
}

try {
  for (const packageDir of packageGlobs) {
    const cwd = join(root, packageDir);
    readFileSync(join(cwd, "package.json"), "utf8");
    const beforePack = tarballsIn(tempDir);
    const output = runPnpm(["pack", "--json", "--pack-destination", tempDir], { cwd });
    const filename = packedFilename(packageDir, output, beforePack);
    const entries = readTarball(filename);
    const packedManifest = packedPackageJson(entries, filename);
    const workspaceEntries = workspaceDependencyEntries(packedManifest);
    const forbiddenFiles = [...entries.keys()].filter((file) =>
      forbiddenTarballPathPatterns.some((pattern) => pattern.test(file)),
    );

    if (workspaceEntries.length > 0) {
      failures.push(`${packedManifest.name}: ${workspaceEntries.join(", ")}`);
    }
    if (forbiddenFiles.length > 0) {
      failures.push(
        `${packedManifest.name}: packed test/build-only artifacts: ${forbiddenFiles.slice(0, 8).join(", ")}${forbiddenFiles.length > 8 ? `, ... +${forbiddenFiles.length - 8} more` : ""}`,
      );
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("Packed package artifacts are not publishable:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("Run pnpm run clean && pnpm run build, then publish with pnpm from the workspace root.");
  process.exit(1);
}

console.log("All packed package artifacts are publishable; no workspace: dependency specifiers or test artifacts found.");
