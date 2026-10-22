#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = resolve(
  valueAfter("--root") ?? process.env.SHADOWROOM_HOME ?? resolve(here, "../.."),
);
const pythonOverride = valueAfter("--python") ?? process.env.SHADOWROOM_PYTHON;
const allowMissing = args.includes("--allow-missing");
const manifest = JSON.parse(readFileSync(resolve(here, "../mcp/manifest.json"), "utf8"));

const interpreterFor = (repo) => {
  if (pythonOverride) return pythonOverride;
  const candidates =
    process.platform === "win32"
      ? [
          join(root, "_venvs", repo, "Scripts", "python.exe"),
          join(root, "_venvs", ".core", "Scripts", "python.exe"),
          join(root, repo, ".venv", "Scripts", "python.exe"),
        ]
      : [
          join(root, "_venvs", repo, "bin", "python"),
          join(root, "_venvs", ".core", "bin", "python"),
          join(root, repo, ".venv", "bin", "python"),
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? (process.platform === "win32" ? "python" : "python3");
};

const mcpServers = {};
const missing = [];
for (const server of manifest.servers) {
  const cwd = resolve(root, server.repo);
  const entrypoint = resolve(cwd, server.entrypoint);
  if (!allowMissing && (!existsSync(entrypoint) || !statSync(entrypoint).isFile())) {
    missing.push(entrypoint);
    continue;
  }
  mcpServers[`shadowroom-${server.id}`] = {
    command: interpreterFor(server.repo),
    args: [entrypoint],
    cwd,
    env: {
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    },
  };
}

if (missing.length > 0) {
  console.error("Missing ShadowRoom MCP repositories. Clone them first with:");
  console.error("  node tools/bootstrap-ecosystem.mjs");
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ mcpServers }, null, 2)}\n`);
