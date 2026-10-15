/**
 * F-5 思考行与 tokens 收敛 · DOM 验收（Kimi UI 评审 P-6）。
 *
 * 种一个含「想完的思考块 + 流式思考块 + usage 行」的会话进 localStorage，真开页面断言：
 * ① 折叠标题匹配 /^想了 \d+ 秒$/（起止相差 12.9s → 想了 13 秒）；流式中的是「在想…」；
 * ② 页面默认态（innerText）没有 "tokens" 字样，读数只挂在 .sr-usage 的 title 上；
 * ③ 点开思考行，英文原文在展开层完整可见。
 *
 * 不花模型 token（不发起真回合）。前置：dev server 在跑。
 * 用法：BASE=http://localhost:5173 node tests/e2e/reasoning-tokens-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/reasoning-tokens";
mkdirSync(SHOTS, { recursive: true });

const T0 = Date.now() - 60_000;
const SESSION_ID = "f5-acceptance";
const store = {
  sessions: [
    {
      id: SESSION_ID,
      title: "F-5 验收会话",
      createdAt: T0,
      calls: [],
      messages: [
        { id: "u1", role: "user", text: "帮我做一段两小节的鼓", at: T0 },
        {
          id: "r1",
          role: "reasoning",
          text: "The user wants a two-bar drum pattern at 120 BPM.\nKick on quarters, hats on eighths.",
          at: T0 + 100,
          streaming: false,
        },
        { id: "a1", role: "assistant", text: "好了，两小节的鼓在时间线上了。", at: T0 + 13_000 },
        {
          id: "r2",
          role: "reasoning",
          text: "Still weighing fills…",
          at: T0 + 14_000,
          streaming: true,
        },
        { id: "use1", role: "usage", text: "32,091 tokens · 13s", at: T0 + 13_500 },
      ],
    },
  ],
  activeId: SESSION_ID,
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript((seed) => {
  window.localStorage.setItem("shadowroom.sessions.v1", seed.store);
  window.localStorage.setItem("shadowroom.view", "conversation");
}, { store: JSON.stringify(store) });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-think", { timeout: 30_000 });
await page.waitForTimeout(500);

// ① 折叠标题：想完 =「想了 N 秒」，进行中 =「在想…」
const titles = await page.locator(".sr-think .sr-think-title").allTextContents();
check("①a 折叠标题=「想了 N 秒」", /^想了 \d+ 秒$/.test(titles[0] ?? ""), `titles=${JSON.stringify(titles)}`);
check("①a 数值正确（12.9s→13）", (titles[0] ?? "").trim() === "想了 13 秒", `title="${titles[0]}"`);
check("①b 流式中=「在想…」", (titles[1] ?? "").trim() === "在想…", `title="${titles[1]}"`);

// ② 默认态无 tokens 字样；读数只在 title 属性里
const bodyText = await page.evaluate(() => document.body.innerText);
check("②a 页面无 tokens 字样", !bodyText.includes("tokens"), `innerText 含 tokens: ${bodyText.includes("tokens")}`);
const usage = page.locator(".sr-usage").first();
const usageText = ((await usage.textContent()) ?? "").trim();
const usageTitle = await usage.getAttribute("title");
check(
  "②b 读数只在 hover title",
  usageText === "" && usageTitle === "32,091 tokens · 13s",
  `text="${usageText}" title="${usageTitle}"`,
);

// ③ 英文原文留在展开层
await page.locator(".sr-think-row").first().click();
await page.waitForSelector(".sr-think-body", { timeout: 3_000 });
const bodyText2 = await page.locator(".sr-think-body").first().textContent();
check(
  "③ 展开层有英文原文",
  (bodyText2 ?? "").includes("The user wants a two-bar drum pattern"),
  `body 前 40 字="${(bodyText2 ?? "").slice(0, 40)}"`,
);
await page.screenshot({ path: `${SHOTS}/expanded.png`, fullPage: false });
await page.locator(".sr-think-row").first().click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}/default.png`, fullPage: false });

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
