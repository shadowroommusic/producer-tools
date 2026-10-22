import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const manifestPath = new URL("mcp/manifest.json", root);
const configTool = new URL("tools/print-mcp-config.mjs", root);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

test("MCP manifest exposes the complete public ShadowRoom ecosystem", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.transport, "stdio");
  assert.deepEqual(
    manifest.servers.map((server) => server.id),
    ["converter", "analysis", "planner", "generator", "splitter", "soundfont", "steward", "library", "grabber"],
  );
  assert.equal(new Set(manifest.servers.map((server) => server.id)).size, manifest.servers.length);
  for (const server of manifest.servers) {
    assert.match(server.repository, /^https:\/\/github\.com\/shadowroommusic\/[A-Za-z0-9._-]+$/);
    assert.equal(server.entrypoint, "mcp_server.py");
    assert.ok(server.description.length > 20);
  }
});

test("generic client config contains all nine servers and absolute entrypoints", () => {
  const run = spawnSync(
    process.execPath,
    [configTool.pathname, "--root", "/tmp/shadowroom-mcp-test", "--allow-missing"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const config = JSON.parse(run.stdout);
  assert.equal(Object.keys(config.mcpServers).length, 9);
  for (const [name, server] of Object.entries(config.mcpServers)) {
    assert.match(name, /^shadowroom-/);
    assert.equal(server.args.length, 1);
    assert.ok(server.args[0].endsWith("/mcp_server.py"));
    assert.ok(server.cwd.startsWith("/tmp/shadowroom-mcp-test/"));
  }
});
