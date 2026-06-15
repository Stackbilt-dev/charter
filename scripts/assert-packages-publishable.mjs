#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed in ${options.cwd}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function packedPackageJson(tarball) {
  return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], { cwd: root }));
}

function packedFileList(tarball) {
  return run("tar", ["-tf", tarball], { cwd: root })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
    const output = run("pnpm", ["pack", "--json", "--pack-destination", tempDir], { cwd });
    const filename = packedFilename(packageDir, output, beforePack);
    const packedManifest = packedPackageJson(filename);
    const workspaceEntries = workspaceDependencyEntries(packedManifest);
    const forbiddenFiles = packedFileList(filename).filter((file) =>
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
