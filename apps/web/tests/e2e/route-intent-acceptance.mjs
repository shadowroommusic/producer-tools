/**
 * Butler routing: safe, confident work executes directly in the chosen page worker; destructive or
 * ambiguous work remains a confirmation card. Execution keeps the original voice attachment.
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
const handedOffCalls = [];
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
    handedOffCalls.push(request.postDataJSON());
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
  if (!sessionStorage.getItem("route-e2e-seeded")) {
    sessionStorage.setItem("route-e2e-seeded", "1");
    localStorage.setItem("shadowroom.view", "workbench");
    localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
    localStorage.setItem("shadowroom.studio.open", project.id);
    localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
      sessions: [session],
      activeButlerId: session.id,
      activeWorkerIds: {},
    }));
    localStorage.removeItem("shadowroom.dock.by-view.v1");
  }
}, { session: butler, project: studioProject });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
for (let index = 0; index < 50 && handedOffCalls.length === 0; index += 1) {
  await page.waitForTimeout(100);
}
await page.waitForTimeout(250);
check(
  "① 高置信度安全路由无需点击，直接打开 Studio 并执行；ask_user 不生成确认卡",
  handedOffCalls.length === 1 && (await page.locator(".sr-route-card").count()) === 0,
  `handoffs=${handedOffCalls.length} cards=${await page.locator(".sr-route-card").count()}`,
);
const handedOff = handedOffCalls.at(-1);
const after = await page.evaluate(() => ({
  view: localStorage.getItem("shadowroom.view"),
  docks: JSON.parse(localStorage.getItem("shadowroom.dock.by-view.v1") ?? "{}"),
  studioWorker: JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}").sessions?.find((entry) => entry.kind === "studio")?.id,
}));
check(
  "② 自动切到 Studio worker、打开 dock，并恰好发起一次执行",
  after.view === "studio" &&
    after.docks.studio === true &&
    typeof after.studioWorker === "string" &&
    handedOff?.scope === "studio" &&
    handedOff?.sessionId === after.studioWorker &&
    handedOffCalls.length === 1,
  JSON.stringify({
    ...after,
    scope: handedOff?.scope,
    sessionId: handedOff?.sessionId,
    handoffs: handedOffCalls.length,
  }),
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
const persistedCommandId = await page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
  return store.sessions
    ?.find((entry) => entry.id === "butler-route")
    ?.calls?.find((call) => call.name === "route_intent" && call.routeSource)?.id;
});
await page.evaluate(({ mention, decision, text, commandId }) => {
  window.dispatchEvent(
    new CustomEvent("shadowroom:route-open", {
      detail: {
        ...decision,
        actionSummary: decision.action_summary,
        commandId,
        sourceText: text,
        sourceMentions: [mention],
        sourceSessionId: "butler-route",
      },
    }),
  );
}, { mention: sourceMention, decision: routeDecision, text: sourceText, commandId: persistedCommandId });
await page.waitForTimeout(250);
const consumed = await page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
  return store.sessions
    ?.find((entry) => entry.id === "butler-route")
    ?.calls?.find((call) => call.id === "route-1")?.routeConsumed === true;
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(350);
check(
  "⑤ 重复派发同一路由不执行第二次；处理标记落盘且刷新后不再触发",
  handedOffCalls.length === 1 && consumed === true && (await page.locator(".sr-route-card").count()) === 0,
  `handoffs=${handedOffCalls.length} consumed=${consumed} cards=${await page.locator(".sr-route-card").count()}`,
);
check("⑥ 路由确认流程零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await context.close();

/* ── Part B：live 链路 + 无打开工程。原始 bug 的正反面：
 *    语音/附件 Mention 在路由时丢失（hum_to_midi 拿不到 path），以及没有打开工程时只填草稿不执行。 ── */
{
  const liveContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const livePage = await liveContext.newPage();
  const liveErrors = [];
  const liveSends = [];
  const handoffOps = [];
  livePage.on("pageerror", (error) => liveErrors.push(String(error)));
  livePage.on("console", (message) => {
    if (message.type() === "error") liveErrors.push(message.text());
  });
  await livePage.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/servers") {
      await route.fulfill({ json: { servers: [], home: "/tmp", workspaces: "/tmp" } });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/agent/health") {
      await route.fulfill({
        json: { ok: true, threads: 0, cwd: "/tmp", sandbox: "workspace-write", approval: "never", plugins: [] },
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/agent/models") {
      await route.fulfill({ json: { models: [] } });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/agent/send") {
      const body = request.postDataJSON();
      liveSends.push(body);
      const stream =
        body.scope === "butler"
          ? `data: ${JSON.stringify({
              type: "item",
              phase: "completed",
              item: {
                type: "mcpToolCall",
                id: "route-live-1",
                server: "steward",
                tool: "route_intent",
                arguments: { target: "studio", action_summary: routeDecision.action_summary, confidence: 0.94 },
                result: { content: [{ type: "text", text: JSON.stringify(routeDecision) }] },
              },
            })}\n\n` +
            'data: {"type":"delta","text":"好的，去 Studio。","itemId":"answer"}\n\n' +
            'data: {"type":"done","turn":{"status":"completed"}}\n\n'
          : 'data: {"type":"delta","text":"已开始执行","itemId":"answer"}\n\n' +
            'data: {"type":"done","turn":{"status":"completed"}}\n\n';
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: stream });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/call") {
      const body = request.postDataJSON();
      if (body?.server === "steward" && String(body?.tool ?? "").startsWith("handoff_")) {
        handoffOps.push(body);
        const result =
          body.tool === "handoff_create"
            ? { handoff: { id: 9001, status: "pending" } }
            : body.tool === "handoff_claim"
              ? { handoff_id: 9001, claimed: true, status: "running" }
              : { handoff_id: 9001, ok: true, status: body.args?.status ?? "done" };
        await route.fulfill({ json: { result: JSON.stringify(result) } });
        return;
      }
      await route.fulfill({ json: { result: "{}" } });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await livePage.addInitScript(() => {
    localStorage.setItem("shadowroom.view", "conversation");
    // 一条历史消息让 composer 落底（空会话的 hero 居中会让「添加」菜单向上溢出视口）。
    localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
      sessions: [
        {
          id: "butler-live",
          kind: "butler",
          scope: { workspaceId: "butler" },
          title: "哼一段",
          createdAt: 1,
          lastActiveAt: 1,
          messages: [{ id: "m0", role: "user", text: "准备哼唱", at: 1 }],
          calls: [],
        },
      ],
      activeButlerId: "butler-live",
      activeWorkerIds: {},
    }));
    localStorage.removeItem("shadowroom.studio.projects.v1");
    localStorage.removeItem("shadowroom.studio.open");
    localStorage.removeItem("shadowroom.dock.by-view.v1");
  });
  await livePage.goto(BASE, { waitUntil: "domcontentloaded" });
  await livePage.waitForTimeout(400);

  // 附件走真实 UI 入口：+ → 文件和文件夹 → 粘贴路径。与语音回合写入的 Mention 同一形状，
  // 这一步正是原始 bug 的现场：录音 WAV 必须跟着回合走，而不是停在 composer 里。
  await livePage.locator('.sr-composer button[aria-label="添加"]').click();
  await livePage.getByRole("menuitem", { name: /文件和文件夹/ }).click();
  await livePage.locator(".sr-menu-input").fill(sourceMention.path);
  await livePage.locator(".sr-menu-input").press("Enter");
  check(
    "⑦ 录音路径作为 Mention 附在管家回合上",
    (await livePage.locator(".sr-ctx-chip").count()) === 1,
    `chips=${await livePage.locator(".sr-ctx-chip").count()}`,
  );

  await livePage.locator(".sr-composer-input").fill(sourceText);
  await livePage.locator(".sr-composer-input").press("Enter");
  for (let index = 0; index < 50 && liveSends.filter((entry) => entry.scope === "studio").length === 0; index += 1) {
    await livePage.waitForTimeout(100);
  }
  const butlerSend = liveSends.find((entry) => entry.scope === "butler");
  check(
    "⑧ 管家回合带着录音发出，安全 live 路由不要求确认卡",
    butlerSend?.mentions?.[0]?.path === sourceMention.path && (await livePage.locator(".sr-route-card").count()) === 0,
    JSON.stringify({ butlerMentions: butlerSend?.mentions, cards: await livePage.locator(".sr-route-card").count() }),
  );

  await livePage.evaluate((path) => {
    // 同 routeId 的重复派发（双击/事件重放）不得触发第二次 handoff。
    window.dispatchEvent(
      new CustomEvent("shadowroom:route-open", {
        detail: {
          target: "studio",
          actionSummary: "把哼唱转成 MIDI 并写进当前工程",
          confidence: 0.94,
          contextSatisfied: true,
          missingContext: [],
          commandId: "route-live-1",
          sourceText: "我给你哼一段，你帮我写进当前 Studio",
          sourceMentions: [{ name: "hum.wav", path, label: "这段语音" }],
          sourceSessionId: "duplicate-dispatch",
        },
      }),
    );
  }, sourceMention.path);
  await livePage.waitForTimeout(900);
  const studioSends = liveSends.filter((entry) => entry.scope === "studio");
  const liveAfter = await livePage.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
    const studio = store.sessions?.find((entry) => entry.kind === "studio");
    const projects = JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}").projects ?? [];
    return {
      view: localStorage.getItem("shadowroom.view"),
      notices: (studio?.messages ?? []).filter((message) => message.role === "notice").map((message) => message.title),
      projects: projects.length,
      openProject: localStorage.getItem("shadowroom.studio.open"),
    };
  });
  const studioSend = studioSends[0];
  check(
    "⑨ 无打开工程时自动建 Studio 工程并执行且恰好一次（重复派发被吸收）",
    liveAfter.view === "studio" && studioSends.length === 1 && liveAfter.projects === 1 && liveAfter.openProject !== null,
    JSON.stringify({ view: liveAfter.view, studioSends: studioSends.length, project: liveAfter.openProject }),
  );
  check(
    "⑩ live 捕获的录音 mention path 等于录音 path，路由契约随行",
    studioSend?.text?.includes(sourceText) &&
      studioSend?.text?.includes("[butler_route]") &&
      studioSend?.mentions?.[0]?.path === sourceMention.path,
    JSON.stringify({ text: studioSend?.text?.slice(0, 220), mentions: studioSend?.mentions }),
  );
  check(
    "⑪ 自动创建的工程已作为真实上下文交给 worker，不再要求用户先建工程",
    studioSend?.text?.includes("[arrangement_context]") &&
      !studioSend?.text?.includes("project_open: no") &&
      !liveAfter.notices.includes("工程未打开"),
    JSON.stringify({ arrangement: studioSend?.text?.includes("[arrangement_context]"), notices: liveAfter.notices }),
  );
  const create = handoffOps.find((entry) => entry.tool === "handoff_create");
  const claim = handoffOps.find((entry) => entry.tool === "handoff_claim");
  const finish = handoffOps.find((entry) => entry.tool === "handoff_finish");
  check(
    "⑫ steward 持久交接真实走 create→claim→finish，附件和幂等键完整",
    create?.arguments?.attachments?.[0]?.path === sourceMention.path &&
      create?.arguments?.idempotency_key === "butler-command:route-live-1" &&
      claim?.arguments?.handoff_id === 9001 &&
      finish?.arguments?.handoff_id === 9001 &&
      finish?.arguments?.status === "done",
    JSON.stringify(handoffOps.map((entry) => ({ tool: entry.tool, args: entry.arguments }))),
  );
  check("⑬ live 链路零 Console error", liveErrors.length === 0, liveErrors.slice(0, 3).join(" | ") || "clean");
  await liveContext.close();
}

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
