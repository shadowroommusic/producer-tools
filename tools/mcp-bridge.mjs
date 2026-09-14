#!/usr/bin/env node
/**
 * MCP bridge for the Producer Tools UI.
 *
 * The web app cannot speak stdio JSON-RPC to a Python process, so this small server owns that:
 * it spawns each ShadowRoom MCP server lazily, performs the MCP handshake, caches the tool list,
 * and exposes two HTTP endpoints for the UI:
 *
 *   GET  /api/servers  → every configured server with its connection state and tools
 *   POST /api/call     → { server, tool, arguments } → the tool's text result
 *
 * Node builtins only — no dependencies, so `pnpm serve` works before `pnpm install`.
 *
 * Configuration (all optional):
 *   SHADOWROOM_HOME              directory holding the plugin checkouts (default ~/Documents/ShadowRoom)
 *   SHADOWROOM_PYTHON            interpreter used to run mcp_server.py (default python3)
 *   SHADOWROOM_BRIDGE_PORT       default 8787
 *   SHADOWROOM_CALL_TIMEOUT_MS   default 120000 (analysis and conversion jobs are slow)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const HOST = process.env.SHADOWROOM_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SHADOWROOM_BRIDGE_PORT ?? 8787);
const WORKSPACES = process.env.SHADOWROOM_HOME ?? join(homedir(), "Documents", "ShadowRoom");
const PYTHON = process.env.SHADOWROOM_PYTHON ?? "python3";
const PROTOCOL_VERSION = "2024-11-05";
const HANDSHAKE_TIMEOUT_MS = Number(process.env.SHADOWROOM_HANDSHAKE_TIMEOUT_MS ?? 8000);
const CALL_TIMEOUT_MS = Number(process.env.SHADOWROOM_CALL_TIMEOUT_MS ?? 120_000);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The four published ShadowRoom servers, in the order the sidebar lists them. */
const REGISTRY = [
  {
    id: "converter",
    repo: "rekordbox-serato-bridge",
    label: "Rekordbox ⇄ Serato",
    description: "Rekordbox ⇄ Serato library conversion (cues, loops, colours, playlists)",
  },
  {
    id: "analysis",
    repo: "audio-analysis-dedupe",
    label: "音频分析去重",
    description: "Audio analysis and duplicate detection",
  },
  {
    id: "planner",
    repo: "set-planner",
    label: "Set 编排",
    description: "Set timing and next-track suggestions",
  },
  {
    id: "generator",
    repo: "shadow-music-generator",
    label: "音乐生成队列",
    description: "Queue for local AI music-generation pipelines",
  },
];

/**
 * One MCP server over stdio.
 *
 * The Python servers frame messages as one JSON object per line (see `main()` in each
 * `mcp_server.py`), so stdout is read line by line and requests are matched by id.
 */
class McpServer {
  constructor(entry) {
    this.entry = entry;
    this.dir = resolve(WORKSPACES, entry.repo);
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.status = "idle";
    this.error = undefined;
    this.tools = [];
    this.stderr = [];
    this.starting = null;
  }

  get connected() {
    return this.status === "ready";
  }

  /** Idempotent boot: handshake, then cache the tool list. */
  async start() {
    if (this.status === "ready") return this;
    this.starting ??= this.#boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #boot() {
    const script = join(this.dir, "mcp_server.py");
    if (!existsSync(script)) {
      this.status = "unavailable";
      this.error = `not found: ${script}`;
      throw new Error(this.error);
    }
    this.status = "starting";
    this.error = undefined;
    this.stderr = [];

    const child = spawn(PYTHON, ["mcp_server.py"], {
      cwd: this.dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
    this.child = child;

    child.on("error", (cause) => {
      this.status = "error";
      this.error = `${PYTHON}: ${cause.message}`;
      this.#failPending(new Error(this.error));
    });
    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      this.child = null;
      if (this.status === "ready" || this.status === "starting") {
        this.status = "error";
        this.error = `${this.entry.repo} stopped (${reason})${this.#stderrTail()}`;
      }
      this.tools = [];
      this.#failPending(new Error(this.error ?? reason));
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      this.stderr.push(String(chunk));
      if (this.stderr.length > 20) this.stderr.shift();
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const text = line.trim();
      if (text === "") return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return; // a stray print() from a plugin is noise, not a protocol message
      }
      if (message.id === undefined) return; // notifications carry no reply
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    });

    try {
      const initialized = await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "shadow-producers", version: "0.0.0" },
        },
        HANDSHAKE_TIMEOUT_MS,
      );
      this.notify("notifications/initialized", {});
      const list = await this.request("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      this.tools = Array.isArray(list?.tools) ? list.tools : [];
      this.status = "ready";
      this.serverInfo = initialized?.serverInfo;
      return this;
    } catch (cause) {
      this.status = "error";
      this.error = `${cause.message}${this.#stderrTail()}`;
      this.#kill();
      throw new Error(this.error);
    }
  }

  /** Send a request and resolve with its result. */
  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const child = this.child;
    if (child === null || child.stdin.destroyed) {
      return Promise.reject(new Error(`${this.entry.repo} is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve_, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Send a notification (no reply expected). */
  notify(method, params) {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Call one tool; the caller decides what to do with `isError`. */
  async call(tool, args) {
    await this.start();
    const result = await this.request("tools/call", { name: tool, arguments: args });
    return {
      isError: result?.isError === true,
      content: result?.content ?? [],
      text: textOf(result?.content),
      raw: result,
    };
  }

  snapshot() {
    return {
      id: this.entry.id,
      repo: this.entry.repo,
      label: this.entry.label,
      description: this.entry.description,
      connected: this.connected,
      status: this.status,
      tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  stop() {
    this.#kill();
    this.status = "idle";
    this.tools = [];
  }

  #kill() {
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null) child.kill("SIGTERM");
    this.#failPending(new Error("bridge shutting down"));
  }

  #failPending(cause) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
  }

  #stderrTail() {
    const tail = this.stderr.join("").trim().split("\n").slice(-3).join(" / ");
    return tail === "" ? "" : ` — ${tail}`;
  }
}

/** MCP tool results carry content blocks; the UI wants the text. */
function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : JSON.stringify(block)))
    .join("\n");
}

const servers = new Map(REGISTRY.map((entry) => [entry.id, new McpServer(entry)]));

/** Boot every server at once; failures stay in the snapshot instead of rejecting. */
async function connectAll() {
  await Promise.allSettled([...servers.values()].map((server) => server.start()));
  return [...servers.values()].map((server) => server.snapshot());
}

function send(response, code, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text === "" ? {} : JSON.parse(text);
}

const http = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      send(response, 200, { ok: true, servers: [...servers.values()].map((server) => server.status) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/servers") {
      send(response, 200, { servers: await connectAll() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/call") {
      const body = await readBody(request);
      const server = servers.get(String(body.server ?? ""));
      if (server === undefined) {
        send(response, 404, { error: `unknown server: ${body.server}` });
        return;
      }
      const tool = String(body.tool ?? "");
      if (tool === "") {
        send(response, 400, { error: "missing tool name" });
        return;
      }
      const started = Date.now();
      try {
        const result = await server.call(tool, body.arguments ?? {});
        console.log(
          `[bridge] ${server.entry.id}.${tool} ${result.isError ? "failed" : "ok"} in ${Date.now() - started}ms`,
        );
        send(response, 200, { result: result.text, isError: result.isError, ms: Date.now() - started });
      } catch (cause) {
        send(response, 200, {
          result: `${tool} 调用失败：${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        });
      }
      return;
    }

    send(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
  } catch (cause) {
    send(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
  }
});

http.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] plugins from ${WORKSPACES} (interpreter: ${PYTHON})`);
  for (const entry of REGISTRY) console.log(`[bridge]   ${entry.id.padEnd(9)} ${entry.repo}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const server of servers.values()) server.stop();
    http.close(() => process.exit(0));
  });
}
