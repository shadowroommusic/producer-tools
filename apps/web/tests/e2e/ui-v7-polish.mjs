/**
 * UI v7 acceptance — the studio-glass redesign across the real app shell.
 *
 * This is a navigation/layout audit, not a mocked feature test. It uses the real local bridge for read-only
 * page data, keeps all state in a throwaway browser profile, and checks the two widths that have historically
 * squeezed the centre column: 1440 (dock open) and 1024 (narrow centre).
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.UI_V7_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/ui-redesign/acceptance";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

const shot = async (name) => {
  const path = `${SHOTS}/${name}.png`;
  writeFileSync(path, await page.screenshot());
  return path;
};

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(700);

const hero = page.locator(".sr-home-hero");
const heroActions = page.locator(".sr-home-action");
check(
  "① 工作台有创作入口与品牌层级",
  (await page.getByText("CREATIVE WORKSPACE", { exact: true }).count()) === 1 &&
    (await heroActions.count()) === 4 &&
    (await hero.locator(".sr-home-core").count()) === 1,
  `hero=${await hero.count()}，actions=${await heroActions.count()}`,
);
await shot("01-workbench");

await page.locator(".sr-home-action", { hasText: "曲目库" }).click();
await page.waitForTimeout(700);
check(
  "② 工作台「曲目库」入口可操作",
  (await page.getByText("SOUND LIBRARY", { exact: true }).count()) === 1,
  `heading=${await page.getByRole("heading", { name: "曲目库", exact: true }).count()}`,
);
await shot("02-library");

await page.getByRole("button", { name: "工作台", exact: true }).click();
await page.locator(".sr-home-action", { hasText: "排 DJ Set" }).click();
await page.waitForTimeout(700);
check(
  "③ 工作台「排 DJ Set」入口可操作",
  (await page.getByText("PERFORMANCE", { exact: true }).count()) === 1 &&
    (await page.locator(".sr-dj-topbar").count()) === 1,
  `topbar=${await page.locator(".sr-dj-topbar").count()}`,
);
await shot("03-dj");

await page.getByRole("button", { name: "工作台", exact: true }).click();
await page.locator(".sr-home-action", { hasText: "插件" }).click();
await page.waitForTimeout(600);
const pluginCount = await page.locator(".sr-plugin-card").count();
check(
  "④ 插件入口与插件卡可打开",
  pluginCount === 9 && (await page.getByText("MCP TOOLBOX", { exact: true }).count()) === 1,
  `cards=${pluginCount}`,
);
await page.locator(".sr-plugin-card").first().click();
await page.waitForTimeout(500);
check(
  "⑤ 插件详情页保留独立返回与工具层级",
  (await page.locator(".sr-plugin-page").count()) === 1 &&
    (await page.locator(".sr-plugin-page").getByText(/rekordbox-serato-bridge/).count()) >= 1,
  `pluginPage=${await page.locator(".sr-plugin-page").count()}`,
);
await shot("04-plugin-panel");

await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(450);
const settingsMetrics = await page.evaluate(() => {
  const settings = document.querySelector(".sr-settings");
  const body = document.querySelector(".sr-settings-body");
  const nav = document.querySelector(".sr-settings-nav");
  const role = document.querySelector(".sr-role-row");
  return {
    accent: getComputedStyle(document.documentElement).getPropertyValue("--sr-accent").trim(),
    navColumns: nav === null ? "" : getComputedStyle(nav).gridTemplateColumns,
    bodyColumns: body === null ? "" : getComputedStyle(body).gridTemplateColumns,
    overflow: settings === null ? -1 : settings.scrollWidth - settings.clientWidth,
    roleOverflow: role === null ? -1 : role.scrollWidth - role.clientWidth,
  };
});
check(
  "⑥ 设置页保持品牌色且没有内容溢出",
  settingsMetrics.accent === "#d9ff3d" && settingsMetrics.overflow <= 1 && settingsMetrics.roleOverflow <= 1,
  JSON.stringify(settingsMetrics),
);
await shot("05-settings");

await page.setViewportSize({ width: 1024, height: 800 });
await page.getByRole("button", { name: "工作台", exact: true }).click();
await page.waitForTimeout(500);
const narrowWorkbench = await page.evaluate(() => {
  const hero = document.querySelector(".sr-home-hero");
  const visual = document.querySelector(".sr-home-visual");
  const body = document.querySelector(".sr-page-body");
  return {
    heroHeight: hero?.getBoundingClientRect().height ?? 0,
    visualDisplay: visual === null ? "missing" : getComputedStyle(visual).display,
    overflow: body === null ? -1 : body.scrollWidth - body.clientWidth,
  };
});
check(
  "⑦ 1024 工作台：窄中栏改成可读单列",
  narrowWorkbench.heroHeight >= 300 && narrowWorkbench.visualDisplay === "none" && narrowWorkbench.overflow <= 1,
  JSON.stringify(narrowWorkbench),
);
await shot("06-workbench-1024");

await page.getByRole("button", { name: "设置", exact: true }).click();
await page.waitForTimeout(450);
const narrowSettings = await page.evaluate(() => {
  const settings = document.querySelector(".sr-settings");
  const body = document.querySelector(".sr-settings-body");
  const nav = document.querySelector(".sr-settings-nav");
  const role = document.querySelector(".sr-role-row");
  return {
    bodyColumns: body === null ? "" : getComputedStyle(body).gridTemplateColumns,
    navDisplay: nav === null ? "" : getComputedStyle(nav).display,
    overflow: settings === null ? -1 : settings.scrollWidth - settings.clientWidth,
    roleOverflow: role === null ? -1 : role.scrollWidth - role.clientWidth,
  };
});
check(
  "⑧ 1024 设置：分区横排、角色卡收成单列",
  narrowSettings.navDisplay === "grid" && narrowSettings.overflow <= 1 && narrowSettings.roleOverflow <= 1,
  JSON.stringify(narrowSettings),
);
await shot("07-settings-1024");

await page.getByRole("button", { name: "DJ", exact: true }).click();
await page.waitForTimeout(700);
const narrowDj = await page.evaluate(() => {
  const dj = document.querySelector(".sr-dj");
  const main = document.querySelector(".sr-dj-main");
  const library = document.querySelector(".sr-dj-library");
  return {
    columns: main === null ? "" : getComputedStyle(main).gridTemplateColumns,
    pageOverflow: dj === null ? -1 : dj.scrollWidth - dj.clientWidth,
    libraryOverflow: library === null ? -1 : library.scrollWidth - library.clientWidth,
  };
});
check(
  "⑨ 1024 DJ：库与 set 板改为纵向工作站",
  !narrowDj.columns.includes(" ") && narrowDj.pageOverflow <= 1 && narrowDj.libraryOverflow <= 1,
  JSON.stringify(narrowDj),
);
await shot("08-dj-1024");

await page.setViewportSize({ width: 900, height: 800 });
await page.getByRole("button", { name: "工作台", exact: true }).click();
await page.waitForTimeout(500);
const compactRail = await page.evaluate(() => {
  const sidebar = document.querySelector(".sr-frame-sidebar");
  const visual = document.querySelector(".sr-home-visual");
  const body = document.querySelector(".sr-page-body");
  return {
    sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
    visualDisplay: visual === null ? "missing" : getComputedStyle(visual).display,
    overflow: body === null ? -1 : body.scrollWidth - body.clientWidth,
  };
});
check(
  "⑩ 900 宽度自动切图标栏，创作页仍可读",
  compactRail.sidebarWidth === 56 && compactRail.visualDisplay === "none" && compactRail.overflow <= 1,
  JSON.stringify(compactRail),
);
await shot("09-workbench-900");

check("⑪ 全流程零 Console error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
