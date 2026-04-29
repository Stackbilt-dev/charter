#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

const usesWorkspaceProtocol = dependencyFields.some((field) =>
  Object.values(packageJson[field] ?? {}).some(
    (specifier) => typeof specifier === "string" && specifier.startsWith("workspace:"),
  ),
);

if (!usesWorkspaceProtocol) {
  process.exit(0);
}

const userAgent = process.env.npm_config_user_agent ?? "";
const execPath = process.env.npm_execpath ?? "";
const invokedByPnpm = userAgent.includes("pnpm/") || execPath.includes("pnpm");

if (!invokedByPnpm) {
  console.error(
    [
      `${packageJson.name} uses workspace: dependency specifiers in source package.json.`,
      "Direct npm publish can leak those specifiers into the public tarball.",
      "Publish with pnpm from the workspace root and run `pnpm run publish:check` before publishing.",
    ].join("\n"),
  );
  process.exit(1);
}
