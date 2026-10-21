/**
 * Global butler route-confirmation card: classification stays in the butler thread, execution lands
 * in the chosen page worker only after the user confirms.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.ROUTE_E2E_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const routeDecision = {
  accept: true,
  target: "studio",
  action_summary: "把哼唱转成 MIDI 并写进当前工程",
  required_context: ["projectId"],
  confidence: 0.94,
  context_satisfied: true,
  missing_context: [],
};
const sourceText = "我给你哼一段，你帮我写进当前 Studio";
const sourceMention = { name: "hum.wav", path: "/tmp/hum-acceptance.wav", label: "这段语音" };
const studioProject = {
  id: "project-route-hum",
  name: "哼唱落轨验收",
  updatedAt: 1,
  bpm: 128,
  key: "8A",
  bars: 16,
  tracks: [],
};
const butler = {
  id: "butler-route",
  kind: "butler",
  scope: { workspaceId: "butler" },
  title: "把哼唱写进工程",
  createdAt: 1,
  lastActiveAt: 1,
  messages: [
    { id: "u-route", role: "user", text: sourceText, at: 2 },
    { id: "tool-route", role: "tool", callId: "route-1", at: 3 },
    { id: "tool-ask", role: "tool", callId: "route-ask", at: 4 },
  ],
  calls: [
    {
      id: "route-1",
      server: "steward",
      name: "route_intent",
      status: "ok",
      summary: "94%",
      detail: JSON.stringify({
        arguments: { target: "studio", action_summary: routeDecision.action_summary, confidence: 0.94 },
        result: { content: [{ type: "text", text: JSON.stringify(routeDecision) }] },
      }),
      routeSource: { text: sourceText, mentions: [sourceMention], sessionId: "butler-route" },
    },
    {
      id: "route-ask",
      server: "steward",
      name: "route_intent",
      status: "ok",
      summary: "40%",
      detail: JSON.stringify({
        arguments: { target: "ask_user", action_summary: "补充问题里指的是哪件事", confidence: 0.4 },
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                accept: true,
                target: "ask_user",
                action_summary: "补充问题里指的是哪件事",
                required_context: [],
                confidence: 0.4,
                context_satisfied: true,
                missing_context: [],
              }),
            },
          ],
        },
      }),
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
let handedOff = null;
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "GET" && url.pathname === "/api/servers") {
    await route.fulfill({ json: { servers: [], home: "/tmp", workspaces: "/tmp" } });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/agent/health") {
    await route.fulfill({
      json: {
        ok: true,
        threads: 0,
        cwd: "/tmp",
        sandbox: "workspace-write",
        approval: "never",
        plugins: [],
      },
    });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/agent/models") {
    await route.fulfill({ json: { models: [] } });
    return;
  }
  if (request.method() === "POST" && url.pathname === "/api/agent/send") {
    handedOff = request.postDataJSON();
    const hum = {
      midi_path: "/tmp/route-hum.mid",
      notes: [
        { midi: 60, name: "C4", start_ms: 0, end_ms: 500 },
        { midi: 64, name: "E4", start_ms: 500, end_ms: 1000 },
      ],
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        `data: ${JSON.stringify({
          type: "item",
          phase: "completed",
          item: {
            type: "mcpToolCall",
            id: "hum-route",
            server: "audio-analysis-dedupe",
            tool: "hum_to_midi",
            status: "completed",
            arguments: { path: sourceMention.path },
            result: { content: [{ type: "text", text: JSON.stringify(hum) }] },
          },
          turnId: "turn-route",
        })}\n\n` +
        'data: {"type":"delta","text":"已经写进工程。","itemId":"answer","turnId":"turn-route"}\n\n' +
        'data: {"type":"done","turn":{"status":"completed"}}\n\n',
    });
    return;
  }
  if (request.method() === "POST" && url.pathname === "/api/call") {
    await route.fulfill({ json: { result: "{}" } });
    return;
  }
  await route.fulfill({ status: 204, body: "" });
});

await page.addInitScript(({ session, project }) => {
  localStorage.setItem("shadowroom.view", "workbench");
  localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
  localStorage.setItem("shadowroom.studio.open", project.id);
  localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
    sessions: [session],
    activeButlerId: session.id,
    activeWorkerIds: {},
  }));
  localStorage.removeItem("shadowroom.dock.by-view.v1");
}, { session: butler, project: studioProject });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
await page.locator(".sr-dock-rail-btn").click();
await page.waitForTimeout(300);

const card = page.locator(".sr-route-card");
const cardCount = await card.count();
const cardText = cardCount === 0 ? await page.locator("body").innerText() : await card.innerText();
if (cardCount === 0) {
  const stored = await page.evaluate(() => ({
    sessions: localStorage.getItem("shadowroom.sessions.v1"),
    view: localStorage.getItem("shadowroom.view"),
  }));
  console.log("DEBUG seed", JSON.stringify(stored).slice(0, 1200));
  await page.screenshot({ path: "/Users/lazora/Documents/ShadowRoom/exports/route-intent-failure.png" });
}
check(
  "① 只为可执行页面显示路由卡；ask_user 留在普通工具行",
  cardCount === 1 &&
    cardText.includes("Studio") &&
    cardText.includes("94%") &&
    !cardText.includes("需要补充信息"),
  cardText.replace(/\n+/g, " | ").slice(0, 500),
);

if (cardCount === 0) {
  await browser.close();
  process.exit(1);
}
await card.getByRole("button", { name: "打开并继续" }).click();
await page.waitForTimeout(450);
const after = await page.evaluate(() => ({
  view: localStorage.getItem("shadowroom.view"),
  docks: JSON.parse(localStorage.getItem("shadowroom.dock.by-view.v1") ?? "{}"),
  studioWorker: JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}").sessions?.find((entry) => entry.kind === "studio")?.id,
}));
check(
  "② 确认后才切到 Studio worker、打开 dock，并自动发起执行",
  after.view === "studio" &&
    after.docks.studio === true &&
    typeof after.studioWorker === "string" &&
    handedOff?.scope === "studio" &&
    handedOff?.sessionId === after.studioWorker,
  JSON.stringify({ ...after, scope: handedOff?.scope, sessionId: handedOff?.sessionId }),
);
check(
  "③ 原始哼唱与录音附件完整交给 Studio worker",
  handedOff?.text?.includes(sourceText) &&
    handedOff?.text?.includes("[butler_route]") &&
    handedOff?.text?.includes(routeDecision.action_summary) &&
    handedOff?.mentions?.[0]?.path === sourceMention.path,
  JSON.stringify({ text: handedOff?.text?.slice(0, 260), mentions: handedOff?.mentions }),
);
const projectAfter = await page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}");
  return store.projects?.find((entry) => entry.id === "project-route-hum");
});
check(
  "④ hum_to_midi 结果真实落成 Studio 片段，不停在路由卡",
  projectAfter?.tracks?.length === 1 &&
    projectAfter.tracks[0].clips?.length === 1 &&
    projectAfter.tracks[0].clips[0].notes?.length === 2 &&
    projectAfter.tracks[0].clips[0].source === "/tmp/route-hum.mid",
  JSON.stringify({
    tracks: projectAfter?.tracks?.length,
    clips: projectAfter?.tracks?.[0]?.clips?.length,
    notes: projectAfter?.tracks?.[0]?.clips?.[0]?.notes?.length,
    source: projectAfter?.tracks?.[0]?.clips?.[0]?.source,
  }),
);
check("⑤ 路由确认流程零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
