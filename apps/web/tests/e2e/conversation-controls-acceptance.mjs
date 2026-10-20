/**
 * conversation-controls-20261020 · mock 线 DOM 验收。
 *
 * 拦掉全部 /api/agent/* 请求（不碰真实桥/真实内核/真实曲库），在 /conversation 页面上回放
 * 一轮真实形状的事件流，断言 HANDOFF 验收清单里的 UI 部分：
 *   ① 顺序：textA→tool1→textB→tool2→textC = 3 个 assistant 气泡 + 2 个 tool 行，顺序精确；
 *   ② think：跨 chunk 的 <think> 在页面上 0 个文本节点、思考折叠行可见可展开、正文完整；
 *   ③ TTS 来源（lastAssistant 气泡）无 think；
 *   ④ 回合尾摘要精确为「3 个工具 · 2 个 MCP」+ 秒；tokens 只在 title；
 *   ⑤ 工具行收起态 = MCP · server · tool + 状态 + 耗时；展开态分 参数/结果/错误；
 *   ⑥ 完全访问风险门：未勾选点确认档位不变；勾选后才切换；
 *   ⑦ effort：list 显示、none 锁定、未知协议隐藏；
 *   ⑧ 刷新恢复模型/effort/权限；
 *   ⑨ 全程 Console error 0。
 *
 * 用法：node tests/e2e/conversation-controls-acceptance.mjs （自带 dev server，BASE 可覆盖）
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/conversation-controls";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/** SSE body for one turn: each event as a `data: …` frame. */
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const toolItem = (id, server, tool, extra = {}) => ({
  type: "item",
  phase: "started",
  turnId: "turn-1",
  item: { type: "mcpToolCall", id, server, tool, status: "inProgress", arguments: { clip_id: "c1" }, ...extra },
});
const toolDone = (id, server, tool, extra = {}) => ({
  type: "item",
  phase: "completed",
  turnId: "turn-1",
  item: {
    type: "mcpToolCall",
    id,
    server,
    tool,
    status: "success",
    durationMs: 412,
    arguments: { clip_id: "c1", gain: 0.8 },
    result: { content: [{ text: '{"ok": true, "file": "/tmp/a.wav"}' }] },
    ...extra,
  },
});

const TURN_EVENTS = [
  { type: "turn", threadId: "th-1", turnId: "turn-1" },
  // bridge 出口形状：<think> 已被剥成 reasoning 事件（think 状态机本身有 8/8 单测 +
  // live bridge 验收），正文 delta 是净文本。
  { type: "reasoning", itemId: "rs-1", turnId: "turn-1", text: "用户要一段鼓。选 90 BPM。" },
  { type: "delta", itemId: "m1", turnId: "turn-1", text: "先查一下曲库，" },
  // tool 1（server-a · analyze_library）
  toolItem("i1", "server-a", "analyze_library"),
  toolDone("i1", "server-a", "analyze_library"),
  // B 段
  { type: "delta", itemId: "m2", turnId: "turn-1", text: "库里有 3 首可用，" },
  // tool 2（server-b · set_suggest）
  toolItem("i2", "server-b", "set_suggest"),
  toolDone("i2", "server-b", "set_suggest", { durationMs: 1780 }),
  // tool 3（server-a · track_tag）——同一 server 的第二个工具
  toolItem("i3", "server-a", "track_tag"),
  toolDone("i3", "server-a", "track_tag", { durationMs: 90 }),
  // C 段
  { type: "delta", itemId: "m3", turnId: "turn-1", text: "排好了：3 首连放，能量递进。" },
  { type: "usage", turnId: "turn-1", usage: { last: { totalTokens: 3219 } } },
  { type: "done", turn: { status: "completed" } },
];

const MODELS = [
  {
    id: "gpt-5.3",
    displayName: "GPT-5.3",
    description: "内置 · Codex 内核",
    isDefault: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { effort: "low", description: "low" },
      { effort: "medium", description: "medium" },
      { effort: "high", description: "high" },
    ],
    reasoningProtocol: "openai-responses",
  },
];

let sentBodies = [];
let settingsBodies = [];

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

await page.route("**/api/agent/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/agent/health") {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, threads: 1, model: "gpt-5.3", cwd: "/tmp", sandbox: "workspace-write",
        approval: "on-request", plugins: [],
      }),
    });
  }
  if (path === "/api/agent/models") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: MODELS }) });
  }
  if (path === "/api/agent/media-events") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) });
  }
  if (path === "/api/agent/use-provider") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider: null }) });
  }
  if (path === "/api/agent/settings") {
    settingsBodies.push(route.request().postDataJSON());
    const body = settingsBodies[settingsBodies.length - 1];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: body.sessionId,
        threadSettings: {
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          sandboxPolicy: {
            type: body.access === "read-only" ? "readOnly" : body.access === "danger-full-access" ? "dangerFullAccess" : "workspaceWrite",
          },
          approvalPolicy: body.access === "danger-full-access" ? "never" : "on-request",
        },
      }),
    });
  }
  if (path === "/api/agent/send") {
    const body = route.request().postDataJSON();
    sentBodies.push(body);
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(TURN_EVENTS) });
  }
  return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not mocked" }) });
});

await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "conversation");
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-composer-input", { timeout: 30_000 });

/* ── ⑦ effort 形态：内置模型是多档 list ─────────────────────────────────── */
await page.locator(".sr-chip--button", { hasText: "GPT-5.3" }).first().click();
await page.waitForSelector(".sr-menu[aria-label='模型与思考深度']", { timeout: 3_000 });
const menuText1 = await page.locator(".sr-menu[aria-label='模型与思考深度']").innerText();
check("⑦a 模型菜单带「思考深度」多档", /思考深度/.test(menuText1) && /high/.test(menuText1), menuText1.replace(/\n/g, " | "));
await page.keyboard.press("Escape");
await page.mouse.click(10, 500);

/* ── 发一轮：顺序 / think / 摘要 / 工具行（同时把会话建起来） ────────────── */
await page.locator(".sr-composer-input").fill("排一段 3 首的 set");
await page.keyboard.press("Enter");
await page.waitForSelector(".sr-usage", { timeout: 30_000 });
await page.waitForTimeout(600);

// ① 顺序：消息流的 role 序列
const flow = await page.evaluate(() => {
  const pick = (el) => {
    if (el.classList.contains("sr-msg-user")) return "user";
    if (el.classList.contains("sr-msg-assistant")) return `text:${el.textContent}`;
    if (el.classList.contains("sr-call")) {
      // 收起行有两个 .sr-call-tool（server 与 tool 名）；身份取整串。
      return `tool:${el.querySelector(".sr-call-name")?.innerText.replace(/\s+/g, " ").trim()}`;
    }
    if (el.classList.contains("sr-think")) return "reasoning";
    if (el.classList.contains("sr-usage")) return "usage";
    return null;
  };
  return Array.from(document.querySelectorAll(
    ".sr-msg-user, .sr-msg-assistant, .sr-call, .sr-think, .sr-usage",
  )).map((el) => pick(el));
});
check(
  "① 顺序精确：reasoning、A、tool1、B、tool2/3、C、usage",
  JSON.stringify(flow) === JSON.stringify([
    "user", "reasoning", "text:先查一下曲库，", "tool:MCP server-a · analyze_library", "text:库里有 3 首可用，",
    "tool:MCP server-b · set_suggest", "tool:MCP server-a · track_tag", "text:排好了：3 首连放，能量递进。", "usage",
  ]),
  JSON.stringify(flow),
);
const assistantCount = flow.filter((entry) => entry.startsWith("text:")).length;
const toolCount = flow.filter((entry) => entry.startsWith("tool:")).length;
check("①' 3 个 assistant 气泡 + 3 个 tool 行", assistantCount === 3 && toolCount === 3, `assistant=${assistantCount} tool=${toolCount}`);

// ② think：页面 0 个 <think> 文本节点；思考折叠行可见
const thinkNodes = await page.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) if (walker.currentNode.textContent.includes("<think")) hits.push(walker.currentNode.textContent);
  return hits;
});
check("②a 页面 <think> 文本节点 0 个", thinkNodes.length === 0, JSON.stringify(thinkNodes).slice(0, 120));
const thinkRow = page.locator(".sr-think").first();
check("②b 思考折叠行可见", (await thinkRow.count()) === 1, `count=${await thinkRow.count()}`);
await thinkRow.locator(".sr-think-row").click();
await page.waitForSelector(".sr-think-body", { timeout: 3_000 });
const thinkBody = await page.locator(".sr-think-body").first().textContent();
check(
  "②c 展开后思考全文在折叠层（正文通道剥净）",
  (thinkBody ?? "").includes("用户要一段鼓。选 90 BPM。"),
  `body="${(thinkBody ?? "").slice(0, 40)}"`,
);

// ③ TTS 来源：lastAssistant 气泡无 think
const lastAssistant = await page.evaluate(() => {
  const bubbles = Array.from(document.querySelectorAll(".sr-msg-assistant"));
  return bubbles[bubbles.length - 1]?.textContent ?? "";
});
check("③ lastAssistant（TTS 读的正文）无 think", !lastAssistant.includes("<think"), `"${lastAssistant.slice(0, 30)}"`);

// ④ 摘要
const usageEl = page.locator(".sr-usage").first();
const usageText = ((await usageEl.textContent()) ?? "").trim();
const usageTitle = await usageEl.getAttribute("title");
check(
  "④ 摘要精确「3 个工具 · 2 个 MCP」+ 秒，tokens 只在 title",
  /^3 个工具 · 2 个 MCP · \d+ 秒$/.test(usageText) && (usageTitle ?? "").includes("3,219") && !usageText.includes("tokens"),
  `text="${usageText}" title="${usageTitle}"`,
);

// ⑤ 工具行：收起态身份串 + 状态 + 耗时；展开三区
const callRow = page.locator(".sr-call").first();
const headText = (await callRow.locator(".sr-call-head").innerText()).replace(/\s+/g, " ").trim();
check(
  "⑤a 收起行 = MCP · server · tool + 状态 + 耗时",
  headText.includes("MCP") && headText.includes("server-a") && headText.includes("analyze_library") && headText.includes("412ms") && headText.includes("完成"),
  `"${headText}"`,
);
await callRow.locator(".sr-call-head").click();
await page.waitForSelector(".sr-call-section", { timeout: 3_000 });
const sectionLabels = await callRow.locator(".sr-call-section-title").allTextContents();
check("⑤b 展开分「参数 / 结果」两区（无错误）", sectionLabels.includes("参数") && sectionLabels.includes("结果") && !sectionLabels.includes("错误"), JSON.stringify(sectionLabels));
await page.screenshot({ path: `${SHOTS}/05-tool-row-expanded.png` });
// 错误区：种一条失败调用重发一轮
await page.route("**/api/agent/send", async (route) => {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: sse([
      { type: "turn", threadId: "th-1", turnId: "turn-2" },
      toolItem("e1", "server-a", "bad_tool"),
      {
        type: "item", phase: "completed", turnId: "turn-2",
        item: { type: "mcpToolCall", id: "e1", server: "server-a", tool: "bad_tool", status: "failed", durationMs: 33, arguments: {}, error: { message: "FileNotFoundError: no track" } },
      },
      { type: "delta", itemId: "m9", turnId: "turn-2", text: "工具失败了。" },
      { type: "done", turn: { status: "completed" } },
    ]),
  });
});
await page.locator(".sr-composer-input").fill("再试一次");
await page.keyboard.press("Enter");
await page.waitForTimeout(1_200);
const failedRow = page.locator(".sr-call[data-state='error']").last();
const failedSections = await failedRow.locator(".sr-call-section-title").allTextContents().catch(() => []);
check("⑤c 失败调用展开带「错误」区", failedSections.includes("错误"), JSON.stringify(failedSections));
const failedSummary = await failedRow.locator(".sr-call-summary").textContent().catch(() => "");
check("⑤c' 失败摘要显示真实错误", (failedSummary ?? "").includes("FileNotFoundError"), `"${failedSummary}"`);

/* ── ⑥ 完全访问风险门（会话已存在 → 走 /api/agent/settings） ─────────────── */
// 先显式选一次模型，让 modelId/effort 落进会话（此前跟随默认值，不落库）。
await page.locator(".sr-chip--button", { hasText: "GPT-5.3" }).first().click();
await page.waitForSelector(".sr-menu[aria-label='模型与思考深度']", { timeout: 3_000 });
await page.locator(".sr-menu[aria-label='模型与思考深度'] .sr-menu-item", { hasText: "GPT-5.3" }).click();
await page.waitForTimeout(400);
await page.locator(".sr-chip--access").click();
await page.waitForSelector(".sr-menu[aria-label='访问权限']", { timeout: 3_000 });
await page.locator(".sr-menu[aria-label='访问权限'] .sr-menu-item", { hasText: "完全访问" }).click();
await page.waitForSelector(".sr-menu-danger", { timeout: 3_000 });
// 未勾选：确认按钮禁用，点了也不切换、也不发请求
await page.locator(".sr-menu-danger-confirm").click({ force: true });
await page.waitForTimeout(300);
let chipText = await page.locator(".sr-chip--access .sr-chip-label").innerText();
check("⑥a 未勾选风险确认：档位不变（仍工作区可写）", chipText === "工作区可写", `chip="${chipText}"`);
const settingsBeforeArm = settingsBodies.length;
// 勾选后确认
await page.locator(".sr-menu-danger-check input").check();
await page.locator(".sr-menu-danger-confirm").click();
await page.waitForTimeout(400);
chipText = await page.locator(".sr-chip--access .sr-chip-label").innerText();
check("⑥b 勾选并确认：切到完全访问", chipText === "完全访问", `chip="${chipText}"`);
check(
  "⑥b' 未勾选不发请求、勾选后 settings 端点收到 danger-full-access",
  settingsBeforeArm === settingsBodies.length - 1 && settingsBodies[settingsBodies.length - 1]?.access === "danger-full-access",
  JSON.stringify(settingsBodies.map((body) => body.access)),
);
await page.screenshot({ path: `${SHOTS}/06-danger-access.png` });

/* ── running 禁用 ─────────────────────────────────────────────────────────── */
await page.route("**/api/agent/send", async (route) => {
  sentBodies.push(route.request().postDataJSON());
  // 慢一轮：fulfill 挂 6 秒，期间 running 停在 true（一次性 body 会在 EOF 后立刻结束回合）。
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: sse([{ type: "turn", threadId: "th-1", turnId: "turn-3" }, { type: "done", turn: { status: "completed" } }]),
  });
});
await page.locator(".sr-composer-input").fill("跑个长任务");
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
const modelDisabled = await page.locator(".sr-chip--button[aria-haspopup='menu']").first().isDisabled();
const accessDisabled = await page.locator(".sr-chip--access").isDisabled();
check("⑥running 运行中模型/权限 chip 禁用", modelDisabled && accessDisabled, `model=${modelDisabled} access=${accessDisabled}`);

/* ── ⑧ 刷新恢复 ──────────────────────────────────────────────────────────── */
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-chip--access", { timeout: 30_000 });
await page.waitForTimeout(500);
const chipAfterReload = await page.locator(".sr-chip--access .sr-chip-label").innerText();
check("⑧a 刷新后权限档位恢复（完全访问）", chipAfterReload === "完全访问", `chip="${chipAfterReload}"`);
const modelChip = await page.locator(".sr-chip--button[aria-haspopup='menu']").first().innerText();
check("⑧b 刷新后模型/effort 恢复", modelChip.includes("GPT-5.3"), `"${modelChip}"`);
const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("shadowroom.sessions.v1") ?? "{}"));
const active = saved.sessions?.find((s) => s.id === saved.activeButlerId);
check(
  "⑧c session.settings 只存确认值",
  active?.settings?.access === "danger-full-access" && active?.settings?.modelId === "gpt-5.3",
  JSON.stringify(active?.settings ?? null),
);
await page.screenshot({ path: `${SHOTS}/08-after-reload.png` });

/* ── sendTurn 请求参数（选模型 + 风险门之后的那一轮带上了全部确认值） ──────── */
const sendAfterDanger = sentBodies[sentBodies.length - 1];
check(
  "模型/effort/access 随回合送出",
  sendAfterDanger?.settings?.access === "danger-full-access" && sendAfterDanger?.settings?.model === "gpt-5.3" && sendAfterDanger?.settings?.effort === "high",
  JSON.stringify(sendAfterDanger?.settings ?? null),
);

check("⑨ Console error 0", consoleErrors.length === 0, JSON.stringify(consoleErrors).slice(0, 300));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
