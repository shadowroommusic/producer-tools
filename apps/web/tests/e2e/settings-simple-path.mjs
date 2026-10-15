/**
 * F-8 设置页「基本 / 高级」端到端验收（规格 docs/ui-review-kimi.md 第 117-121 行）：
 *
 * ① 新配 MiniMax 简单路径：选预设后连接页**只 1 个输入框**（API Key 密码框）；
 *    「高级」默认折叠且**不渲染**（Base URL / 协议 / Credential 不在 DOM，首帧 0）。
 * ② 交互数 = 2 次点击：选 MiniMax 预设 → 粘 Key → 点「测试连接」；结果行就地出现。
 *    测试请求的形状钉死：baseUrl=api.minimaxi.com/v1、protocol=openai、capability=agent、model=MiniMax-M3。
 * ③ 点「高级」展开：名称=MiniMax、Base URL=api.minimaxi.com/v1、协议=chat_completions（预设默认值）。
 * ④ 「自定义」供应商仍默认全展开（没有高级开关，Base URL 直接可见）。
 * ⑤ 截图 exports/settings-f8/：settings-basic.png（基本态）+ settings-advanced.png（高级展开态）。
 *
 * 凭证与测试请求走 route mock —— 真桥会把 fake key 写进真实凭证库（覆盖用户的 minimax key），
 * 这条只验 UI 路径与请求形状；桥的真实契约由 call-live-acceptance 等真桥验收覆盖。
 *
 * 前置：5173 dev server（F8_E2E_BASE 可覆写）。
 * 用法：node tests/e2e/settings-simple-path.mjs   （HEADFUL=1 可开有头复跑）
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = process.env.F8_E2E_BASE ?? "http://localhost:5173";
const REPO = "/Users/lazora/Documents/ShadowRoom";
const SHOTS = `${REPO}/exports/settings-f8`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const portFree = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return !probe.stdout.trim();
};
if (portFree(5173) && !process.env.F8_E2E_BASE) {
  console.log("FAIL  环境 — 5173 dev server 不在（先 pnpm dev）");
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADFUL === undefined });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

/** mock 所见：凭证与测试请求体（形状断言用）。 */
const seen = { savedCredentials: [], testRequests: [] };
await page.route("**/api/agent/credentials**", async (route) => {
  const request = route.request();
  if (request.method() === "POST") {
    const body = request.postDataJSON();
    seen.savedCredentials.push(body);
    await route.fulfill({ json: { name: body.name, source: "file", masked: "sk-…f8e2" } });
    return;
  }
  if (request.method() === "DELETE") {
    await route.fulfill({ json: {} });
    return;
  }
  await route.fulfill({ json: { credentials: seen.savedCredentials.map((entry) => ({ name: entry.name, source: "file", masked: "sk-…f8e2" })) } });
});
await page.route("**/api/agent/providers/test", async (route) => {
  const body = route.request().postDataJSON();
  seen.testRequests.push(body);
  await route.fulfill({ json: { ok: true, detail: `${body.model} 连接正常（e2e mock）`, ms: 42 } });
});

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // 设置 → 供应商 → 添加供应商
  await page.locator('nav[aria-label="工作区"] .sr-panel-row', { hasText: "设置" }).click();
  await page.locator(".sr-settings-nav-item", { hasText: "供应商" }).click();
  await page.locator(".sr-settings-add").click();
  await page.locator('select[aria-label="服务商"]').waitFor({ timeout: 5000 });

  // 点击 ①：选 MiniMax 预设
  await page.locator('select[aria-label="服务商"]').selectOption("minimax");
  await page.locator(".sr-provider-editor h3", { hasText: "MiniMax" }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);

  // ① 基本态：只 1 个输入框（密码框）；高级层不渲染
  const editor = page.locator(".sr-provider-editor");
  const visibleInputs = await editor.locator("input:visible").count();
  const passwordCount = await editor.locator('input[type="password"]:visible').count();
  const toggle = editor.locator(".sr-advanced-toggle");
  const toggleCount = await toggle.count();
  const expanded = toggleCount === 1 ? await toggle.getAttribute("aria-expanded") : null;
  // 注意：toggle 按钮文案是「高级（名称 · Base URL · …）」，getByText 会误中——按 <label> 数才算字段没渲染。
  const baseUrlInDom = await editor.locator("label", { hasText: "Base URL" }).count();
  const advancedMounted = await editor.locator('input[value*="minimaxi"]').count();
  check(
    "① 选 MiniMax 后只 1 个输入框（API Key 密码框）",
    visibleInputs === 1 && passwordCount === 1,
    `可见 input=${visibleInputs}（password=${passwordCount}）`,
  );
  check(
    "①b 「高级」默认折叠且不渲染（首帧 0）",
    toggleCount === 1 && expanded === "false" && baseUrlInDom === 0 && advancedMounted === 0,
    `toggle=${toggleCount} aria-expanded=${expanded} BaseURL文本=${baseUrlInDom} 已挂载端点输入=${advancedMounted}`,
  );
  await page.screenshot({ path: `${SHOTS}/settings-basic.png` });

  // 粘 Key（打字，不计点击）→ 点击 ②：测试连接
  await editor.locator('input[type="password"]').fill("sk-e2e-f8-probe");
  await editor.locator("button", { hasText: "测试连接" }).click();
  const resultLine = editor.locator(".sr-role-test", { hasText: "连接正常" });
  await resultLine.waitFor({ timeout: 8000 });
  const resultOk = (await resultLine.getAttribute("data-ok")) === "true";
  const wire = seen.testRequests[0] ?? {};
  check(
    "② 粘 Key → 点测试连接 = 2 次点击，结果就地出现",
    resultOk && seen.savedCredentials.length === 1 && seen.savedCredentials[0].name === "minimax" && seen.testRequests.length === 1,
    `存 Key ${seen.savedCredentials.length} 次（name=${seen.savedCredentials[0]?.name}），测试 ${seen.testRequests.length} 次，结果 ✓`,
  );
  check(
    "②b 测试请求形状 = 预设默认值（端点/协议/首个模型）",
    wire.baseUrl === "https://api.minimaxi.com/v1" && wire.protocol === "openai" && wire.capability === "agent" && wire.model === "MiniMax-M3" && wire.credentialRef === "minimax",
    JSON.stringify(wire),
  );

  // ③ 高级展开：默认值来自预设
  await toggle.click();
  await editor.locator('input[value="https://api.minimaxi.com/v1"]').waitFor({ timeout: 5000 });
  // 基本层此时有两个表单：Key 表单与刚挂载的高级表单——按端点值定位高级那个。
  const advancedForm = editor.locator('.sr-provider-form:has(input[value="https://api.minimaxi.com/v1"])');
  const nameValue = await advancedForm.locator("input").first().inputValue();
  const protocolValue = await advancedForm.locator("select").first().inputValue();
  const expandedNow = await editor.locator(".sr-advanced-toggle").getAttribute("aria-expanded");
  check(
    "③ 高级展开：名称 / Base URL / 协议 = 预设默认值",
    expandedNow === "true" && nameValue === "MiniMax" && protocolValue === "chat_completions",
    `名称=${nameValue} BaseURL=https://api.minimaxi.com/v1 协议=${protocolValue} expanded=${expandedNow}`,
  );
  await page.screenshot({ path: `${SHOTS}/settings-advanced.png` });

  // ④ 自定义：全量默认展开，没有高级开关
  await editor.locator("button", { hasText: "返回" }).click();
  await page.locator(".sr-settings-add").click();
  await page.locator('select[aria-label="服务商"]').selectOption("__custom");
  await page.waitForTimeout(300);
  const customEditor = page.locator(".sr-provider-editor");
  const customInputs = await customEditor.locator("input:visible").count();
  const customToggle = await customEditor.locator(".sr-advanced-toggle").count();
  const customBaseUrl = await customEditor.locator("label", { hasText: "Base URL" }).count();
  const customSelects = await customEditor.locator("select:visible").count();
  check(
    "④ 自定义供应商默认全展开（无高级开关）",
    customToggle === 0 && customBaseUrl === 1 && customInputs === 4 && customSelects === 2,
    `可见 input=${customInputs}（名称/BaseURL/Credential/Key） select=${customSelects}（服务商/协议） 高级开关=${customToggle}`,
  );
} finally {
  await browser.close();
}

const failed = results.filter((entry) => !entry.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS，截图在 ${SHOTS}/`);
process.exit(failed === 0 ? 0 : 1);
