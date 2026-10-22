/**
 * Black-box acceptance for the butler's typed app commands.
 *
 * The important assertion is not "the page changed"; it is the pair:
 * navigation -> target worker send count 0 / handoff count 0;
 * dispatch -> target worker send count exactly 1 / one durable handoff.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.APP_COMMAND_E2E_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const butler = {
  id: "butler-app-command",
  kind: "butler",
  scope: { workspaceId: "butler" },
  title: "App 命令验收",
  createdAt: 1,
  lastActiveAt: 1,
  messages: [],
  calls: [],
};

function appCommandFrame(payload) {
  const responses = Array.isArray(payload) ? payload : [payload];
  return responses
    .map(
      ({ id, result, reply }) =>
        `data: ${JSON.stringify({
          type: "item",
          phase: "completed",
          item: {
            type: "mcpToolCall",
            id,
            server: "steward",
            tool: "app_command",
            status: "completed",
            arguments: { op: result.op },
            result: { content: [{ type: "text", text: JSON.stringify(result) }] },
          },
          turnId: `turn-${id}`,
        })}\n\n` +
        `data: ${JSON.stringify({ type: "delta", text: reply, itemId: `answer-${id}`, turnId: `turn-${id}` })}\n\n`,
    )
    .join("") +
    `data: ${JSON.stringify({ type: "done", turn: { status: "completed" } })}\n\n`;
}

function dispatchResult(target, actionSummary, confidence = 0.94) {
  return {
    accept: true,
    op: "dispatch",
    reason: `交给 ${target}`,
    route: {
      accept: true,
      target,
      action_summary: actionSummary,
      required_context: [],
      confidence,
      context_satisfied: false,
      missing_context: target === "studio" ? ["studio", "projectId"] : [],
    },
  };
}

async function bootScenario(browser, { view, respond }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const traffic = {
    butlerSends: [],
    workerSends: [],
    handoffCreate: 0,
    handoffClaim: 0,
    handoffFinish: 0,
    focus: [],
  };
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
      const body = request.postDataJSON();
      if (body.scope === "butler") {
        traffic.butlerSends.push(body);
        const response = respond(String(body.text ?? ""));
        const stream =
          response === null
            ? 'data: {"type":"delta","text":"好。","itemId":"answer","turnId":"turn-answer"}\n\n' +
              'data: {"type":"done","turn":{"status":"completed"}}\n\n'
            : appCommandFrame(response);
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: stream });
        return;
      }
      traffic.workerSends.push(body);
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({ type: "delta", text: "已完成。", itemId: `answer-${body.scope}`, turnId: `turn-${body.scope}` })}\n\n` +
          `data: ${JSON.stringify({ type: "done", turn: { status: "completed" } })}\n\n`,
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/call") {
      const body = request.postDataJSON();
      if (body.server === "steward" && body.tool === "handoff_create") {
        traffic.handoffCreate += 1;
        await route.fulfill({ json: { result: JSON.stringify({ handoff: { id: 9101, status: "pending" } }) } });
        return;
      }
      if (body.server === "steward" && body.tool === "handoff_claim") {
        traffic.handoffClaim += 1;
        await route.fulfill({
          json: { result: JSON.stringify({ handoff_id: 9101, claimed: true, status: "running" }) },
        });
        return;
      }
      if (body.server === "steward" && body.tool === "handoff_finish") {
        traffic.handoffFinish += 1;
        await route.fulfill({
          json: { result: JSON.stringify({ handoff_id: 9101, ok: true, status: body.args?.status ?? "done" }) },
        });
        return;
      }
      if (body.server === "steward" && body.tool === "focus_change") {
        traffic.focus.push(body.arguments);
      }
      await route.fulfill({ json: { result: "{}" } });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.addInitScript(({ initialView, session }) => {
    if (!localStorage.getItem("shadowroom.sessions.v1")) {
      localStorage.setItem("shadowroom.view", initialView);
      localStorage.setItem("shadowroom.sessions.v1", JSON.stringify({
        sessions: [session],
        activeButlerId: session.id,
        activeWorkerIds: {},
      }));
      localStorage.removeItem("shadowroom.dock.by-view.v1");
      localStorage.removeItem("shadowroom.studio.projects.v1");
      localStorage.removeItem("shadowroom.studio.open");
    }
  }, { initialView: view, session: butler });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(250);
  return { context, page, traffic, errors };
}

async function sendButler(page, text) {
  if ((await page.locator(".sr-orb-panel").count()) === 0) {
    const ball = page.locator(".sr-orb-ball");
    await ball.focus();
    await ball.press("Enter");
  }
  const input = page.locator('.sr-orb-input .sr-input[aria-label="给悬浮球的一句话"]');
  await input.fill(text);
  // The orb's onSubmit closure reads App's draft state; give React one commit before Enter.
  await page.waitForTimeout(50);
  await input.press("Enter");
}

function workerMessages(page, kind) {
  return page.evaluate((wanted) => {
    const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
    const session = store.sessions?.find((entry) => entry.kind === wanted);
    return session?.messages?.filter((message) => message.role === "user") ?? [];
  }, kind);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

/* Navigation is a UI command, never a worker handoff. */
{
  const { context, page, traffic, errors } = await bootScenario(browser, {
    view: "dj",
    respond: (text) =>
      text.includes("去 DJ")
        ? {
            id: "nav-dj",
            result: { accept: true, op: "navigate", view: "dj", reason: "打开 DJ" },
            reply: "好，回 DJ。",
          }
        : text.includes("切到 Studio")
          ? {
              id: "nav-studio",
              result: { accept: true, op: "navigate", view: "studio", reason: "打开 Studio" },
              reply: "好，切到 Studio。",
            }
          : null,
  });
  await sendButler(page, "切到 Studio");
  await page.locator(".sr-page-title").filter({ hasText: "Studio" }).waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  const navState = await page.evaluate(() => localStorage.getItem("shadowroom.view"));
  const navigationProjects = await page.evaluate(
    () => JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}").projects?.length ?? 0,
  );
  check(
    "N1 纯导航：DJ → Studio 且不派 worker、不建 handoff/工程、不弹确认卡",
    navState === "studio" &&
      traffic.workerSends.length === 0 &&
      traffic.handoffCreate === 0 &&
      navigationProjects === 0 &&
      (await page.locator(".sr-route-card").count()) === 0,
    JSON.stringify({
      view: navState,
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
      projects: navigationProjects,
      cards: await page.locator(".sr-route-card").count(),
    }),
  );
  check(
    "N2 纯导航没有把管家自己的请求伪装成 Studio worker 消息",
    (await workerMessages(page, "studio")).length === 0 && traffic.butlerSends.length === 1,
    JSON.stringify({
      butlerSends: traffic.butlerSends.length,
      studioUserMessages: (await workerMessages(page, "studio")).length,
    }),
  );
  check(
    "N3 页面变化由 focus_change 留痕，handoff 仍为 0",
    traffic.focus.some((entry) => entry?.workspace === "studio") && traffic.handoffCreate === 0,
    JSON.stringify({ focus: traffic.focus.map((entry) => entry?.workspace), handoffCreate: traffic.handoffCreate }),
  );

  const beforeReload = { sends: traffic.workerSends.length, handoffs: traffic.handoffCreate };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(450);
  check(
    "N4 导航刷新后仍在 Studio，且不重放成 worker 任务",
    (await page.locator(".sr-page-title").filter({ hasText: "Studio" }).count()) === 1 &&
      traffic.workerSends.length === beforeReload.sends &&
      traffic.handoffCreate === beforeReload.handoffs,
    JSON.stringify({
      view: await page.evaluate(() => localStorage.getItem("shadowroom.view")),
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
    }),
  );

  await sendButler(page, "去 DJ 页面");
  await page.locator(".sr-dj").waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  check(
    "N5 反向导航 Studio → DJ 同样只换页面",
    (await page.evaluate(() => localStorage.getItem("shadowroom.view"))) === "dj" &&
      traffic.workerSends.length === 0 &&
      traffic.handoffCreate === 0,
    JSON.stringify({
      view: await page.evaluate(() => localStorage.getItem("shadowroom.view")),
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
    }),
  );
  check("N6 导航链路零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await context.close();
}

/* Dispatch reuses the existing durable handoff and worker execution path exactly once. */
{
  const sourceText = "去 Studio，做一段 4 小节的鼓";
  const { context, page, traffic, errors } = await bootScenario(browser, {
    view: "dj",
    respond: () => ({
      id: "dispatch-studio",
      result: dispatchResult("studio", "在当前 Studio 工程生成 4 小节鼓"),
      reply: "交给 Studio。",
    }),
  });
  await sendButler(page, sourceText);
  await page.locator(".sr-studio").waitFor({ state: "visible" });
  for (let index = 0; index < 40 && traffic.workerSends.length === 0; index += 1) {
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
  const studioMessages = await workerMessages(page, "studio");
  const workerSend = traffic.workerSends[0];
  check(
    "D1 安全 dispatch 自动切页并恰好提交一次 Studio worker",
    traffic.workerSends.length === 1 && workerSend?.scope === "studio" && (await page.locator(".sr-route-card").count()) === 0,
    JSON.stringify({
      sends: traffic.workerSends.length,
      scope: workerSend?.scope,
      cards: await page.locator(".sr-route-card").count(),
    }),
  );
  check(
    "D2 worker 收到原始正文和 typed route 契约，不是只有摘要",
    workerSend?.text?.includes(sourceText) &&
      workerSend?.text?.includes("[butler_route]") &&
      workerSend?.text?.includes("command_id") &&
      studioMessages.length === 1,
    JSON.stringify({
      text: workerSend?.text?.slice(0, 260),
      studioUserMessages: studioMessages.length,
    }),
  );
  check(
    "D3 dispatch 完整走 handoff create → claim → finish",
    traffic.handoffCreate === 1 && traffic.handoffClaim === 1 && traffic.handoffFinish === 1,
    JSON.stringify({
      create: traffic.handoffCreate,
      claim: traffic.handoffClaim,
      finish: traffic.handoffFinish,
    }),
  );
  check("D4 dispatch 链路零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await context.close();
}

/* One dispatch slot: a second dispatch in the same turn is rejected visibly, never dropped. */
{
  const { context, page, traffic, errors } = await bootScenario(browser, {
    view: "dj",
    respond: () => [
      {
        id: "dispatch-burst-1",
        result: dispatchResult("studio", "先生成一段鼓"),
        reply: "先交给 Studio。",
      },
      {
        id: "dispatch-burst-2",
        result: dispatchResult("dj", "再排下一首"),
        reply: "第二条稍后。",
      },
    ],
  });
  await sendButler(page, "先生成鼓，再帮我排下一首");
  await page.locator(".sr-studio").waitFor({ state: "visible" });
  for (let index = 0; index < 40 && traffic.workerSends.length === 0; index += 1) {
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(350);
  const notices = await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
    return store.sessions
      ?.find((entry) => entry.kind === "butler")
      ?.messages?.filter((message) => message.role === "notice")
      .map((message) => message.title) ?? [];
  });
  check(
    "Q1 同一轮第二条 dispatch 被明确拒绝，第一条仍恰好执行一次",
    traffic.workerSends.length === 1 &&
      traffic.handoffCreate === 1 &&
      notices.includes("管家命令未执行"),
    JSON.stringify({
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
      notices,
    }),
  );
  check("Q2 单槽拒绝链路零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await context.close();
}

/* Destructive work waits for the one explicit confirmation and does not pre-navigate. */
{
  const { context, page, traffic, errors } = await bootScenario(browser, {
    view: "dj",
    respond: () => ({
      id: "dispatch-delete",
      result: dispatchResult("studio", "删除当前 Studio 工程", 0.98),
      reply: "这条删除需要确认。",
    }),
  });
  await sendButler(page, "去 Studio 把当前工程删了");
  await page.locator(".sr-route-card").first().waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  check(
    "C1 破坏性 dispatch 确认前不切页、不派工、不建 handoff",
    (await page.evaluate(() => localStorage.getItem("shadowroom.view"))) === "dj" &&
      traffic.workerSends.length === 0 &&
      traffic.handoffCreate === 0 &&
      (await page.locator(".sr-route-card").count()) >= 1,
    JSON.stringify({
      view: await page.evaluate(() => localStorage.getItem("shadowroom.view")),
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
      cards: await page.locator(".sr-route-card").count(),
    }),
  );
  await page.getByRole("button", { name: /确认执行/ }).first().click();
  await page.locator(".sr-studio").waitFor({ state: "visible" });
  for (let index = 0; index < 40 && traffic.workerSends.length === 0; index += 1) {
    await page.waitForTimeout(100);
  }
  check(
    "C2 确认后才切到 Studio 并执行一次",
    traffic.workerSends.length === 1 &&
      traffic.workerSends[0]?.scope === "studio" &&
      traffic.handoffCreate === 1,
    JSON.stringify({
      sends: traffic.workerSends.length,
      scope: traffic.workerSends[0]?.scope,
      handoffCreate: traffic.handoffCreate,
    }),
  );
  check("C3 破坏性确认链路零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await context.close();
}

/* A malformed command is inert even if a buggy provider claims success. */
{
  const { context, page, traffic, errors } = await bootScenario(browser, {
    view: "dj",
    respond: () => ({
      id: "navigate-invalid",
      result: { accept: true, op: "navigate", view: "ableton", reason: "打开 Ableton" },
      reply: "好的。",
    }),
  });
  await sendButler(page, "去 Ableton");
  await page.waitForTimeout(450);
  const butlerNotices = await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
    return store.sessions
      ?.find((entry) => entry.kind === "butler")
      ?.messages?.filter((message) => message.role === "notice")
      .map((message) => message.title) ?? [];
  });
  check(
    "F1 未知 view fail-closed：页面、worker、handoff 全部不变",
    (await page.evaluate(() => localStorage.getItem("shadowroom.view"))) === "dj" &&
      traffic.workerSends.length === 0 &&
      traffic.handoffCreate === 0 &&
      butlerNotices.includes("管家命令未执行"),
    JSON.stringify({
      view: await page.evaluate(() => localStorage.getItem("shadowroom.view")),
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
      notices: butlerNotices,
    }),
  );
  check("F2 非法命令链路零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  await context.close();
}

/* A status question remains conversation, never a command. */
{
  const { context, page, traffic } = await bootScenario(browser, {
    view: "dj",
    respond: () => null,
  });
  await sendButler(page, "我现在在哪？");
  await page.waitForTimeout(350);
  check(
    "S1 状态询问不产生命令，页面不变且所有 worker send 为 0",
    (await page.evaluate(() => localStorage.getItem("shadowroom.view"))) === "dj" &&
      traffic.butlerSends.length === 1 &&
      traffic.workerSends.length === 0 &&
      traffic.handoffCreate === 0,
    JSON.stringify({
      view: await page.evaluate(() => localStorage.getItem("shadowroom.view")),
      butlerSends: traffic.butlerSends.length,
      workerSends: traffic.workerSends.length,
      handoffCreate: traffic.handoffCreate,
    }),
  );
  await context.close();
}

await browser.close();
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
