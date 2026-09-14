#!/usr/bin/env node
/**
 * Agent bridge: drives `codex app-server` and streams its events to the UI.
 *
 * The app-server speaks JSON-RPC over stdio; the browser cannot. This server owns that link and
 * exposes three endpoints:
 *
 *   GET  /api/agent/health   → is the core up, which model/sandbox/cwd it runs with
 *   POST /api/agent/send     → { sessionId, text } → an SSE stream of the turn's events
 *   POST /api/agent/interrupt→ { sessionId }
 *
 * One UI session maps to one Codex thread, created on the first message. Every thread is started
 * with the four ShadowRoom MCP servers injected, so the agent can drive the same tools the sidebar
 * panels call by hand.
 *
 * Configuration (all optional):
 *   SHADOWROOM_CODEX           path to the codex binary (default: the one inside the Codex app)
 *   SHADOWROOM_HOME            plugin checkouts (default ~/Documents/ShadowRoom)
 *   SHADOWROOM_AGENT_CWD       working directory threads start in (default: SHADOWROOM_HOME)
 *   SHADOWROOM_AGENT_SANDBOX   read-only | workspace-write | danger-full-access (default workspace-write)
 *   SHADOWROOM_AGENT_APPROVAL  untrusted | on-request | never (default never)
 *   SHADOWROOM_AGENT_PORT      default 8788
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const HOST = process.env.SHADOWROOM_AGENT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SHADOWROOM_AGENT_PORT ?? 8788);
const HOME = homedir();
const WORKSPACES = process.env.SHADOWROOM_HOME ?? join(HOME, "Documents", "ShadowRoom");
const AGENT_CWD = process.env.SHADOWROOM_AGENT_CWD ?? WORKSPACES;
const SANDBOX = process.env.SHADOWROOM_AGENT_SANDBOX ?? "workspace-write";
const APPROVAL = process.env.SHADOWROOM_AGENT_APPROVAL ?? "on-request";
const PYTHON = process.env.SHADOWROOM_PYTHON ?? "python3";
const CODEX =
  process.env.SHADOWROOM_CODEX ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const INIT_TIMEOUT_MS = Number(process.env.SHADOWROOM_AGENT_INIT_TIMEOUT_MS ?? 60_000);
/** Where audio the browser records (voice turns, hummed melodies) is written. */
const RECORDINGS_DIR = process.env.SHADOWROOM_RECORDINGS_DIR ?? join(WORKSPACES, "recordings");

/** The plugins, injected into every thread so the agent has the same tools as the sidebar. */
const PLUGIN_REPOS = [
  "rekordbox-serato-bridge",
  "audio-analysis-dedupe",
  "set-planner",
  "shadow-music-generator",
];

function mcpServers() {
  const servers = {};
  for (const repo of PLUGIN_REPOS) {
    const dir = resolve(WORKSPACES, repo);
    if (!existsSync(join(dir, "mcp_server.py"))) continue;
    servers[repo] = {
      command: PYTHON,
      args: ["mcp_server.py"],
      cwd: dir,
      // These four are first-party tools: their calls run without a prompt, while everything else
      // stays under the sandbox/approval policy above.
      default_tools_approval_mode: "approve",
    };
  }
  return servers;
}

/** One `codex app-server` child, plus the session → thread map. */
class Agent {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.threads = new Map(); // ui sessionId → codex threadId
    this.listeners = new Map(); // codex threadId → Set<listener>
    this.starting = null;
    this.stderr = [];
    this.info = { model: undefined, userAgent: undefined };
    this.approvals = new Map(); // bridge approval id → the app-server request waiting for a decision
    this.nextApprovalId = 1;
    this.models = null; // cached `model/list`
  }

  get connected() {
    return this.child !== null && !this.child.killed;
  }

  /** Start (or restart) the core and handshake with it. */
  async start() {
    if (this.connected) return this;
    this.starting ??= this.#boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #boot() {
    if (!existsSync(CODEX)) throw new Error(`codex binary not found: ${CODEX}`);
    const child = spawn(CODEX, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.child = child;
    this.threads.clear();
    this.stderr = [];

    child.on("exit", () => {
      this.child = null;
      for (const pending of this.pending.values()) pending.reject(new Error("agent core exited"));
      this.pending.clear();
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      this.stderr.push(String(chunk));
      if (this.stderr.length > 40) this.stderr.shift();
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const text = line.trim();
      if (text === "") return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        this.#serverRequest(message);
        return;
      }
      if (typeof message.method === "string") this.#notify(message);
    });

    const info = await this.request(
      "initialize",
      {
        clientInfo: { name: "shadow-producers", title: "Shadow Producers", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      INIT_TIMEOUT_MS,
    );
    this.info.userAgent = info?.userAgent;
    return this;
  }

  request(method, params, timeoutMs = 120_000) {
    const child = this.child;
    if (child === null) return Promise.reject(new Error("agent core is not running"));
    const id = this.nextId++;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve_(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #notify(message) {
    const threadId = message.params?.threadId;
    if (threadId === undefined) return;
    const listeners = this.listeners.get(threadId);
    if (listeners === undefined) return;
    for (const listener of listeners) listener(message);
  }

  /** Send a reply to a request the core made (approvals); nothing else is expected from us. */
  #respond(id, result, error) {
    const payload = error === undefined
      ? { jsonrpc: "2.0", id, result }
      : { jsonrpc: "2.0", id, error };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * The core asks the client for a decision. Both the legacy (`execCommandApproval`) and the v2
   * (`item/commandExecution/requestApproval`) shapes are accepted; unknown requests are refused so a
   * turn can never hang on us.
   */
  #serverRequest(message) {
    const params = message.params ?? {};
    const method = message.method;
    const threadId = params.threadId ?? params.conversationId;
    let request;
    if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") {
      const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
      request = {
        kind: "command",
        title: params.reason ?? "智能体想运行一条命令",
        detail: [command, params.cwd === undefined ? undefined : `cwd: ${params.cwd}`]
          .filter(Boolean)
          .join("\n"),
      };
    } else if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
      const files = Object.keys(params.fileChanges ?? {});
      request = {
        kind: "patch",
        title: params.reason ?? "智能体想修改文件",
        detail: files.join("\n") || params.grantRoot || "",
      };
    }
    if (request === undefined || threadId === undefined) {
      this.#respond(message.id, null, {
        code: -32601,
        message: `shadow-producers does not handle ${method}`,
      });
      return;
    }
    const approvalId = `ap-${this.nextApprovalId++}`;
    this.approvals.set(approvalId, {
      rpcId: message.id,
      method,
      threadId,
      createdAt: Date.now(),
    });
    const listeners = this.listeners.get(threadId);
    const sessionId = [...this.threads.entries()].find(([, id]) => id === threadId)?.[0];
    for (const listener of listeners ?? []) {
      listener({
        method: "shadowroom/approval",
        params: { threadId, sessionId, approvalId, kind: request.kind, title: request.title, detail: request.detail },
      });
    }
  }

  /** Answer a pending approval in the vocabulary the request came in with. */
  answer(approvalId, decision) {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) throw new Error(`unknown approval: ${approvalId}`);
    this.approvals.delete(approvalId);
    const legacy = pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
    const mapped = legacy
      ? decision === "allow"
        ? "approved"
        : decision === "allow_session"
          ? "approved_for_session"
          : { denied: { rejection: "用户在 Shadow Producers 里拒绝了这次操作" } }
      : decision === "allow"
        ? "accept"
        : decision === "allow_session"
          ? "acceptForSession"
          : "decline";
    this.#respond(pending.rpcId, { decision: mapped });
    return pending.threadId;
  }

  /** The Codex thread behind a UI session, created on first use. */
  async threadFor(sessionId) {
    const known = this.threads.get(sessionId);
    if (known !== undefined) return known;
    await this.start();
    const started = await this.request("thread/start", {
      cwd: AGENT_CWD,
      sandbox: SANDBOX,
      approvalPolicy: APPROVAL,
      config: { mcp_servers: mcpServers() },
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread id");
    this.threads.set(sessionId, threadId);
    this.info.model = started.model;
    return threadId;
  }

  /**
   * Start a turn and stream its events to `onEvent` until the turn ends.
   * @returns the Codex turn id.
   */
  async send(sessionId, text, onEvent, options = {}) {
    const threadId = await this.threadFor(sessionId);
    const listener = (message) => {
      const { method, params } = message;
      if (method === "item/agentMessage/delta") {
        onEvent({ type: "delta", text: params.delta });
        return;
      }
      if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
        onEvent({ type: "reasoning", itemId: params.itemId, text: params.delta });
        return;
      }
      if (method === "item/started" || method === "item/completed" || method === "item/updated") {
        onEvent({ type: "item", phase: method.split("/")[1], item: params.item });
        return;
      }
      if (method === "turn/completed") {
        onEvent({ type: "done", turn: params.turn });
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        onEvent({ type: "usage", turnId: params.turnId, usage: params.tokenUsage });
        return;
      }
      if (method === "error") {
        onEvent({ type: "error", message: params?.message ?? JSON.stringify(params) });
      }
      if (method === "shadowroom/approval") {
        onEvent({
          type: "approval",
          approvalId: params.approvalId,
          sessionId: params.sessionId,
          kind: params.kind,
          title: params.title,
          detail: params.detail,
        });
      }
    };
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    try {
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }, ...(options.input ?? [])],
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      });
      const turnId = started?.turn?.id;
      // The turn runs asynchronously; the SSE stream stays open until turn/completed arrives.
      onEvent({ type: "turn", threadId, turnId });
      return { threadId, turnId, listener, listeners };
    } catch (error) {
      listeners.delete(listener);
      throw error;
    }
  }

  release(threadId, listener, listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(threadId);
  }

  async interrupt(sessionId) {
    const threadId = this.threads.get(sessionId);
    if (threadId === undefined) throw new Error("no thread for this session yet");
    await this.request("turn/interrupt", { threadId });
  }
}

const agent = new Agent();

function sse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  return (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf-8");
  return text === "" ? {} : JSON.parse(text);
}

/** JSON body with a size ceiling; audio uploads are base64 in `data`. */
async function readJsonBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text === "" ? {} : JSON.parse(text);
}

function json(response, code, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

const http = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/agent/health") {
      // Booting is lazy, so the health check is what actually starts the core the first time: the UI
      // asks "can you run a turn?" and the answer has to be yes even before any thread exists.
      let bootError;
      try {
        await agent.start();
      } catch (error) {
        bootError = error instanceof Error ? error.message : String(error);
      }
      json(response, 200, {
        ok: agent.connected && bootError === undefined,
        threads: agent.threads.size,
        model: agent.info.model,
        userAgent: agent.info.userAgent,
        cwd: AGENT_CWD,
        sandbox: SANDBOX,
        approval: APPROVAL,
        pendingApprovals: agent.approvals.size,
        plugins: Object.keys(mcpServers()),
        error: bootError ?? (agent.connected ? undefined : agent.stderr.join("").slice(-400) || undefined),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/models") {
      await agent.start();
      if (agent.models === null) {
        const listed = await agent.request("model/list", {});
        agent.models = (listed?.data ?? []).map((model) => ({
          id: model.model ?? model.id,
          displayName: model.displayName ?? model.model ?? model.id,
          description: model.description ?? "",
          isDefault: model.isDefault === true,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({
            effort: option.reasoningEffort,
            description: option.description,
          })),
        }));
      }
      json(response, 200, { models: agent.models });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/interrupt") {
      const body = await readBody(request);
      await agent.interrupt(String(body.sessionId ?? ""));
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/approval") {
      const body = await readBody(request);
      const decision = String(body.decision ?? "");
      if (!["allow", "allow_session", "deny"].includes(decision)) {
        json(response, 400, { error: "decision must be allow, allow_session or deny" });
        return;
      }
      const threadId = agent.answer(String(body.approvalId ?? ""), decision);
      json(response, 200, { ok: true, threadId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/audio") {
      const body = await readJsonBody(request, 64 * 1024 * 1024);
      const data = typeof body.data === "string" ? body.data : "";
      if (data === "") {
        json(response, 400, { error: "missing base64 `data`" });
        return;
      }
      const rawName = typeof body.name === "string" && body.name !== "" ? body.name : "recording.wav";
      const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, "_");
      mkdirSync(RECORDINGS_DIR, { recursive: true });
      const target = join(RECORDINGS_DIR, safeName);
      writeFileSync(target, Buffer.from(data, "base64"));
      console.log(`[agent] audio saved: ${target}`);
      json(response, 200, { path: target, bytes: Buffer.byteLength(data, "base64") });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/send") {
      const body = await readBody(request);
      const sessionId = String(body.sessionId ?? "");
      const text = String(body.text ?? "");
      if (sessionId === "" || text.trim() === "") {
        json(response, 400, { error: "sessionId and text are required" });
        return;
      }
      const emit = sse(response);
      let handle = null;
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(guard);
        if (handle !== null) agent.release(handle.threadId, handle.listener, handle.listeners);
        response.end();
      };
      const guard = setTimeout(() => {
        emit({ type: "error", message: "这一轮超时了（agent 没有在预期时间内结束）" });
        finish();
      }, Number(process.env.SHADOWROOM_AGENT_TURN_TIMEOUT_MS ?? 900_000));

      try {
        handle = await agent.send(
          sessionId,
          text,
          (event) => {
            emit(event);
            if (event.type === "done" || event.type === "error") finish();
          },
          {
            model: typeof body.model === "string" && body.model !== "" ? body.model : undefined,
            effort: typeof body.effort === "string" && body.effort !== "" ? body.effort : undefined,
            input: Array.isArray(body.mentions)
              ? body.mentions
                  .filter((mention) => typeof mention?.name === "string" && typeof mention?.path === "string")
                  .map((mention) => ({ type: "mention", name: mention.name, path: mention.path }))
              : [],
          },
        );
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        finish();
        return;
      }
      // A client that navigates away must not leak the listener.
      request.on("close", finish);
      return;
    }

    json(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

http.listen(PORT, HOST, () => {
  console.log(`[agent] listening on http://${HOST}:${PORT}`);
  console.log(`[agent] core: ${CODEX}`);
  console.log(`[agent] cwd: ${AGENT_CWD} · sandbox: ${SANDBOX} · approval: ${APPROVAL}`);
  console.log(`[agent] plugins: ${Object.keys(mcpServers()).join(", ") || "(none found)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    agent.child?.kill("SIGTERM");
    http.close(() => process.exit(0));
  });
}
