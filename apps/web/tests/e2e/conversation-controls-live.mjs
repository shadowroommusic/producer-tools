#!/usr/bin/env node
/**
 * conversation-controls-20261020 · live bridge 验收（自起实例，不碰常驻 8788、不碰真实数据）。
 *
 * 全链路真实验证（真 codex app-server + 真 thread settings + 真 sandbox 行为）：
 *   A. think 治理：fake chat provider（本地 SSE，think 标签故意跨 chunk）→ use-provider →
 *      send → SSE 断言 delta 无 <think>、带 itemId、reasoning 事件收思考全文。
 *   B. settings 下一轮生效：effort low→high、sandbox workspace-write→read-only，都以
 *      thread/settings/updated 的回读（HTTP 响应里的 threadSettings）为确认。
 *   C. 权限行为：read-only 拒写（文件不存在）；workspace-write 写工作区成功（文件存在）；
 *      工作区外写触发审批卡（approval 事件到达，deny 后文件不存在）。
 *   D. 审批三路径：deny / allow once / allow session（session 档第二条同类命令不再弹卡）。
 *
 * 模型消耗：A 走 fake provider（0 token）；B 不发回合（0 token）；C/D 用内置模型发 3–4 个
 * 极短回合（每回合几十 token）。写盘只发生在 /tmp fixture 与 deny-不执行的审批路径上。
 *
 * 用法：node tests/e2e/conversation-controls-live.mjs
 */
import { createServer } from "node:http";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BRIDGE_PORT = 8899;
const PROVIDER_PORT = 18999;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;
const HOME = "/tmp/sr-convctrl/home";
const WS = "/tmp/sr-convctrl/ws";
// 「工作区外」不能选 /tmp：Codex 的 workspaceWrite 沙箱把系统临时目录视为可写（实测
// /tmp 直写成功、零审批）。这个 fixture 在 $HOME/Documents/ShadowRoom 下自造、finally 整目录
// 清理；对沙箱而言（工作区 = /tmp/sr-convctrl/ws）它是真·工作区外。
const OUTSIDE = "/Users/lazora/Documents/ShadowRoom/_e2e-fixtures/conversation-controls/outside";
const PROBE_IN = `${WS}/probe.txt`;
const PROBE_OUT = `${OUTSIDE}/probe.txt`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/* ── fixtures ─────────────────────────────────────────────────────────────── */
rmSync(HOME, { recursive: true, force: true });
rmSync(WS, { recursive: true, force: true });
rmSync(OUTSIDE, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(WS, { recursive: true });

/** Fake OpenAI-compatible chat provider: streams one answer with think tags split across chunks. */
const provider = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    return;
  }
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const chunks = [
      "<th", // 开标签从中间断开
      "ink>Let me think about this carefully. The user said hi.",
      "</thi", // 闭标签同样跨 chunk 断开（注意：`</th`+`nk>` 拼不出合法闭标签，会把状态机留在 think 态）
      "nk>",
      "你好！这是一段没有 think 的正文。",
    ];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
    let delay = 0;
    for (const chunk of chunks) {
      delay += 30;
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
      }, delay);
    }
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end();
    }, delay + 30);
  });
});
await new Promise((resolve) => provider.listen(PROVIDER_PORT, "127.0.0.1", resolve));

/* ── the bridge under test（新代码、独立端口、fixture home） ───────────────── */
const bridgeProc = spawn(process.execPath, ["tools/agent-bridge.mjs"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."),
  env: {
    ...process.env,
    SHADOWROOM_AGENT_PORT: String(BRIDGE_PORT),
    SHADOWROOM_HOME: HOME,
    SHADOWROOM_AGENT_CWD: WS,
    SHADOWROOM_AGENT_SANDBOX: "workspace-write",
    SHADOWROOM_AGENT_APPROVAL: "on-request",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridgeProc.stdout.on("data", (chunk) => (bridgeLog += chunk));
bridgeProc.stderr.on("data", (chunk) => (bridgeLog += chunk));

const waitHealthy = async () => {
  for (let i = 0; i < 90; i += 1) {
    try {
      const response = await fetch(`${BRIDGE}/api/agent/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true) return health;
      }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`bridge not healthy after 90s\n${bridgeLog.slice(-2_000)}`);
};
const health = await waitHealthy();
check("bridge 自起实例健康（新代码）", health.ok === true, `model=${health.model} sandbox=${health.sandbox}`);

/** Read one turn's SSE stream to the end, collecting events. `timeoutMs` guards a hung turn. */
async function runTurn(sessionId, text, onApproval, { timeoutMs = 240_000, access = "workspace-write" } = {}) {
  const response = await fetch(`${BRIDGE}/api/agent/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text, scope: "butler", settings: { access } }),
  });
  if (!response.ok || response.body === null) throw new Error(`send failed: ${response.status}`);
  const events = [];
  const timer = setTimeout(() => {
    events.push({ type: "test-timeout" });
    response.body.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (line !== undefined) {
          try {
            const event = JSON.parse(line.slice(6));
            events.push(event);
            if (event.type === "approval" && onApproval !== undefined) onApproval(event);
          } catch { /* malformed */ }
        }
        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

const post = async (path, body) => {
  const response = await fetch(`${BRIDGE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

/* ── A. think 治理（fake provider，0 token） ──────────────────────────────── */
// use-provider 的 config 走 env_key：无凭据时 core 找不到环境变量直接报错（本地无 Key 服务
// 的既有限制）。fake provider 不校验 Key——注册一个哑凭据让链路通。
await post("/api/agent/credentials", { name: "convctrl-probe-key", value: "dummy-key-for-fake-provider" });
const useProvider = await post("/api/agent/use-provider", {
  provider: { id: "faketest", label: "Fake Provider", baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, model: "fake-model", credentialRef: "convctrl-probe-key", endpointFormat: "chat_completions" },
});
check("A0 切到 fake provider", useProvider.status === 200, JSON.stringify(useProvider.data));

const thinkEvents = await runTurn("live-think-1", "打个招呼");
const deltas = thinkEvents.filter((event) => event.type === "delta");
const reasonings = thinkEvents.filter((event) => event.type === "reasoning");
const joinedText = deltas.map((event) => event.text).join("");
const joinedReasoning = reasonings.map((event) => event.text).join("");
check("A1 delta 正文 0 个 think 标签", !joinedText.includes("<think") && !joinedText.includes("</think"), `"${joinedText}"`);
check("A2 思考全文走 reasoning 事件", joinedReasoning.includes("Let me think about this carefully"), `"${joinedReasoning.slice(0, 50)}"`);
check("A3 delta 带 itemId（分段可用）", deltas.length > 0 && deltas.every((event) => typeof event.itemId === "string" && event.itemId !== ""), `deltas=${deltas.length} first=${JSON.stringify(deltas[0] ?? null)}`);
check("A4 正文完整（跨 chunk 未丢字）", joinedText === "你好！这是一段没有 think 的正文。", `"${joinedText}"`);
if (deltas.length === 0) {
  console.log("A-debug 事件序列:", JSON.stringify(thinkEvents.map((event) => ({ type: event.type, text: (event.text ?? "").slice(0, 40), message: (event.message ?? "").slice(0, 120) }))).slice(0, 1_500));
}

/* 切回内置模型（后面的权限/审批测试用它） */
const back = await post("/api/agent/use-provider", { provider: null });
check("A5 切回内置模型", back.status === 200, JSON.stringify(back.data));

/* ── B. settings 下一轮生效（真 thread settings，0 token） ────────────────── */
const modelsResponse = await fetch(`${BRIDGE}/api/agent/models`);
const models = (await modelsResponse.json()).models ?? [];
const modelId = models.find((model) => model.isDefault)?.id ?? models[0]?.id;
check("B0 内核模型列表可用", typeof modelId === "string" && modelId !== "", `model=${modelId} (${models.length} 个)`);

const effortLow = await post("/api/agent/settings", { sessionId: "live-settings-1", model: modelId, effort: "low", access: "workspace-write" });
check(
  "B1 effort=low 经 thread/settings/updated 确认（精确回读）",
  effortLow.status === 200 && effortLow.data.threadSettings?.effort === "low",
  JSON.stringify(effortLow.data),
);
const effortHigh = await post("/api/agent/settings", { sessionId: "live-settings-1", model: modelId, effort: "high", access: "workspace-write" });
check(
  "B2 effort low→high 回读确认（精确回读）",
  effortHigh.status === 200 && effortHigh.data.threadSettings?.effort === "high",
  JSON.stringify(effortHigh.data.threadSettings ?? effortHigh.data),
);
const sandboxReadonly = await post("/api/agent/settings", { sessionId: "live-settings-1", model: modelId, effort: "high", access: "read-only" });
check(
  "B3 sandbox 切 read-only 回读确认",
  sandboxReadonly.status === 200 && sandboxReadonly.data.threadSettings?.sandboxPolicy?.type === "readOnly",
  JSON.stringify(sandboxReadonly.data.threadSettings ?? sandboxReadonly.data),
);

/* ── C. 权限行为（内置模型；写盘只在 /tmp fixture） ───────────────────────── */
// C1: read-only 下写工作区 → 审批卡（deny）→ 文件不出现
const denyAll = (event) => {
  readonlyApprovals.push(event);
  void post("/api/agent/approval", { approvalId: event.approvalId, decision: "deny" });
};
const readonlyApprovals = [];
// 会话先经 settings 端点确认成 read-only，回合再带同一档做兜底（与前端行为一致）。
await post("/api/agent/settings", { sessionId: "live-perm-1", access: "read-only" });
const readonlyEvents = await runTurn("live-perm-1", `Run exactly this shell command and nothing else: touch ${PROBE_IN} — then reply with just the word done.`, denyAll, { access: "read-only" });
await new Promise((resolve) => setTimeout(resolve, 500));
const readonlyWrote = existsSync(PROBE_IN);
check("C1 只读拒写（probe 不存在）", readonlyWrote === false, `exists=${readonlyWrote} approvals=${readonlyApprovals.length}`);

// C2: workspace-write 下写工作区 → 成功
await post("/api/agent/settings", { sessionId: "live-perm-2", access: "workspace-write" });
const writeEvents = await runTurn("live-perm-2", `Run exactly this shell command and nothing else: touch ${PROBE_IN} — then reply with just the word done.`);
await new Promise((resolve) => setTimeout(resolve, 500));
check("C2 工作区写成功（probe 存在）", existsSync(PROBE_IN) === true, `exists=${existsSync(PROBE_IN)}`);

// C3: 工作区外写 → 审批卡 → deny → 不落盘
mkdirSync(OUTSIDE, { recursive: true });
let approvalEvent = null;
const outsideEvents = await runTurn(
  "live-perm-3",
  `Run exactly this shell command and nothing else: touch ${PROBE_OUT} — then reply with just the word done.`,
  (event) => {
    approvalEvent = event;
    void post("/api/agent/approval", { approvalId: event.approvalId, decision: "deny" });
  },
);
check("C3 工作区外写触发审批卡", approvalEvent !== null, approvalEvent === null ? "no approval event" : `kind=${approvalEvent.kind} title=${approvalEvent.title}`);
await new Promise((resolve) => setTimeout(resolve, 800));
check("C3' deny 后文件不落盘", existsSync(PROBE_OUT) === false, `exists=${existsSync(PROBE_OUT)}`);

/* ── D. 审批三路径（同一条工作区外命令；allow 路径会真写 fixture，finally 清理） ─ */
// D-allow-once：弹卡 → allow → 命令执行
let approval2 = null;
await runTurn("live-approval-1", `Run exactly this shell command and nothing else: touch ${PROBE_OUT} — then reply with just the word done.`, (event) => {
  approval2 = event;
  if (approval2 !== null) {
    void post("/api/agent/approval", { approvalId: event.approvalId, decision: "allow" });
  }
});
await new Promise((resolve) => setTimeout(resolve, 1_000));
check("D1 allow once：审批后命令执行（文件出现）", approval2 !== null && existsSync(PROBE_OUT) === true, `approval=${approval2 !== null} exists=${existsSync(PROBE_OUT)}`);
rmSync(PROBE_OUT, { force: true });

// D-allow-session：**同一 session 的两次真实回合**。第一回合 allow_session，第二回合同类
// 命令必须不再弹卡（session 档语义）——两条命令塞进一次 exec 测不出这个。
let sessionApprovals = 0;
await runTurn(
  "live-approval-2",
  `Run exactly this shell command and nothing else: touch ${PROBE_OUT} — then reply with just the word done.`,
  (event) => {
    sessionApprovals += 1;
    if (sessionApprovals === 1) {
      void post("/api/agent/approval", { approvalId: event.approvalId, decision: "allow_session" });
    }
  },
);
await new Promise((resolve) => setTimeout(resolve, 1_000));
check(
  "D2a allow session：第一回合弹卡一次、allow_session 后命令执行",
  sessionApprovals === 1 && existsSync(PROBE_OUT) === true,
  `approvals=${sessionApprovals} exists=${existsSync(PROBE_OUT)}`,
);
rmSync(PROBE_OUT, { force: true });
await post("/api/agent/settings", { sessionId: "live-approval-2", access: "workspace-write" });
const secondRoundApprovals = sessionApprovals;
await runTurn(
  "live-approval-2",
  `Run exactly this shell command and nothing else: touch ${PROBE_OUT} — then reply with just the word done.`,
  (event) => {
    sessionApprovals += 1;
  },
);
await new Promise((resolve) => setTimeout(resolve, 1_000));
check(
  "D2b allow session：第二回合同类命令不再弹卡",
  sessionApprovals === secondRoundApprovals && existsSync(PROBE_OUT) === true,
  `approvalsBefore=${secondRoundApprovals} approvalsAfter=${sessionApprovals} exists=${existsSync(PROBE_OUT)}`,
);
rmSync(PROBE_OUT, { force: true });

/* ── cleanup（无论成败都清 fixture） ─────────────────────────────────────── */
const cleanup = () => {
  try { bridgeProc.kill("SIGTERM"); } catch { /* already gone */ }
  provider.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(WS, { recursive: true, force: true });
  rmSync("/Users/lazora/Documents/ShadowRoom/_e2e-fixtures/conversation-controls", { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
cleanup();

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
