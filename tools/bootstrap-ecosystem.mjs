#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(here, "../mcp/manifest.json"), "utf8"));
const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = resolve(
  rootFlag >= 0 && args[rootFlag + 1]
    ? args[rootFlag + 1]
    : process.env.SHADOWROOM_HOME ?? resolve(here, "../.."),
);
const update = args.includes("--update");
let failed = 0;

for (const server of manifest.servers) {
  const destination = resolve(root, server.repo);
  if (!existsSync(destination)) {
    const clone = spawnSync("git", ["clone", server.repository, destination], { stdio: "inherit" });
    if (clone.status !== 0) failed += 1;
    continue;
  }
  if (!existsSync(resolve(destination, ".git"))) {
    console.error(`skip ${server.id}: ${destination} exists but is not a git checkout`);
    failed += 1;
    continue;
  }
  if (update) {
    const pull = spawnSync("git", ["-C", destination, "pull", "--ff-only"], { stdio: "inherit" });
    if (pull.status !== 0) failed += 1;
  }
}

if (failed > 0) process.exit(1);
console.log(`ShadowRoom MCP ecosystem ready at ${root}`);
console.log("Generate client configuration with: node tools/print-mcp-config.mjs");
