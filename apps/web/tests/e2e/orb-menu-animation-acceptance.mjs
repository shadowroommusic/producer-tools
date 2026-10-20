/**
 * Voice-orb interaction acceptance:
 * - right-click never starts a call and opens a viewport-bounded menu;
 * - menu navigation, Esc, hide and restore are real;
 * - the call handshake has visible opening/closing phases rather than snapping 84↔124.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.ORB_MENU_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/orb-interaction-20261020";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
mkdirSync(SHOTS, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ["microphone"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(() => {
  localStorage.setItem("shadowroom.view", "workbench");
  if (!sessionStorage.getItem("__orb_menu_init")) {
    localStorage.removeItem("shadowroom.orb.position");
    localStorage.removeItem("shadowroom.orb.hidden.v1");
    sessionStorage.setItem("__orb_menu_init", "1");
  }
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb-ball canvas", { timeout: 20000 });

const ball = page.locator(".sr-orb-ball");
const openMenu = async () => {
  const box = await ball.boundingBox();
  if (box === null) throw new Error("orb has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForSelector(".sr-orb-menu", { timeout: 3000 });
};

{
  await openMenu();
  const menu = await page.evaluate(() => {
    const root = document.querySelector(".sr-orb-menu");
    const orb = document.querySelector(".sr-orb");
    if (!(root instanceof HTMLElement)) return null;
    const rect = root.getBoundingClientRect();
    return {
      mode: orb?.getAttribute("data-mode") ?? "",
      rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
      items: [...root.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? ""),
    };
  });
  check(
    "① 右键不启动通话，菜单在视口内",
    menu !== null &&
      menu.mode === "idle" &&
      menu.rect.x >= 0 &&
      menu.rect.y >= 0 &&
      menu.rect.right <= 1280 &&
      menu.rect.bottom <= 720 &&
      ["开始通话", "聊天记录", "新对话", "重置位置", "设置", "关闭悬浮球"].every((label) =>
        menu.items.some((item) => item.includes(label)),
      ),
    JSON.stringify(menu),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".sr-orb-menu") === null);

  // macOS 触控板的 Control+点击会发 pointerdown(button=0, ctrlKey) + contextmenu。
  const controlPoint = await page.locator(".sr-orb-ball").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.dispatchEvent(".sr-orb-ball", "pointerdown", {
    button: 0,
    buttons: 1,
    ctrlKey: true,
    clientX: controlPoint.x,
    clientY: controlPoint.y,
    pointerId: 41,
    pointerType: "mouse",
  });
  await page.dispatchEvent(".sr-orb-ball", "contextmenu", {
    button: 2,
    ctrlKey: true,
    clientX: controlPoint.x,
    clientY: controlPoint.y,
  });
  await page.dispatchEvent(".sr-orb-ball", "pointerup", {
    button: 0,
    buttons: 0,
    ctrlKey: true,
    clientX: controlPoint.x,
    clientY: controlPoint.y,
    pointerId: 41,
    pointerType: "mouse",
  });
  await page.waitForSelector(".sr-orb-menu", { timeout: 3000 });
  check(
    "①d macOS Control+点击只开菜单，不误触通话",
    (await page.locator(".sr-orb-menu").count()) === 1 &&
      (await page.locator(".sr-orb").getAttribute("data-mode")) === "idle",
    "菜单已打开，球仍为 idle",
  );
  await page.screenshot({ path: `${SHOTS}/context-menu.png` });
  await page.waitForTimeout(80);
  const focusedFirst = await page.evaluate(() => document.activeElement?.closest('[role="menuitem"]')?.textContent?.trim() ?? "");
  await page.keyboard.press("ArrowDown");
  const focusedSecond = await page.evaluate(() => document.activeElement?.closest('[role="menuitem"]')?.textContent?.trim() ?? "");
  check(
    "①b 菜单键盘焦点可移动",
    focusedFirst.includes("开始通话") && focusedSecond.includes("聊天记录"),
    `${focusedFirst} → ${focusedSecond}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".sr-orb-menu") === null);
}

{
  await page.evaluate(() => localStorage.setItem("shadowroom.orb.position", JSON.stringify({ x: 20, y: 300 })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-ball canvas", { timeout: 5000 });
  await openMenu();
  const edge = await page.evaluate(() => {
    const menu = document.querySelector(".sr-orb-menu");
    const orb = document.querySelector(".sr-orb");
    if (!(menu instanceof HTMLElement) || !(orb instanceof HTMLElement)) return null;
    const m = menu.getBoundingClientRect();
    const o = orb.getBoundingClientRect();
    return {
      menu: { x: m.x, y: m.y, right: m.right, bottom: m.bottom },
      orb: { x: o.x, y: o.y },
      vertical: menu.getAttribute("data-vertical"),
      horizontal: menu.getAttribute("data-horizontal"),
    };
  });
  check(
    "①c 贴角时菜单自动翻转且不出界",
      edge !== null &&
      edge.orb.x <= 21 &&
      edge.orb.y <= 301 &&
      edge.vertical === "above" &&
      edge.horizontal === "left" &&
      edge.menu.x >= 0 &&
      edge.menu.y >= 0 &&
      edge.menu.right <= 1280 &&
      edge.menu.bottom <= 720,
    JSON.stringify(edge),
  );
  await page.keyboard.press("Escape");
}

{
  await openMenu();
  await page.getByRole("menuitem", { name: "聊天记录" }).click();
  await page.waitForSelector(".sr-conversation", { timeout: 5000 });
  check("② 聊天记录进入全局对话页", (await page.locator(".sr-conversation").count()) === 1, "conversation visible");

  await openMenu();
  await page.getByRole("menuitem", { name: "设置" }).click();
  await page.waitForFunction(() => location.href.startsWith("http://localhost:5173") && document.body.innerText.includes("设置"));
  check("③ 设置动作可达", (await page.locator(".sr-settings").count()) === 1, "settings visible");
}

{
  await openMenu();
  await page.getByRole("menuitem", { name: "关闭悬浮球" }).click();
  check(
    "④ 关闭后留下原地恢复点",
    (await page.locator(".sr-orb").count()) === 0 && (await page.locator(".sr-orb-restore").count()) === 1,
    "orb hidden / restore visible",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-restore", { timeout: 5000 });
  check("⑤ 隐藏状态跨刷新保持", (await page.locator(".sr-orb").count()) === 0, "still hidden after reload");
  await page.screenshot({ path: `${SHOTS}/restore-point.png` });
  await page.locator(".sr-orb-restore").click();
  await page.waitForSelector(".sr-orb-ball canvas", { timeout: 5000 });
  check("⑥ 恢复点可重新显示球", (await page.locator(".sr-orb-restore").count()) === 0, "restore removed");
}

{
  const before = await page.locator(".sr-orb").boundingBox();
  const startAt = Date.now();
  await ball.click();
  await page.waitForFunction(() => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "opening");
  await page.waitForTimeout(260);
  const middle = await page.locator(".sr-orb").boundingBox();
  await page.screenshot({ path: `${SHOTS}/call-opening.png` });
  await page.waitForFunction(
    () => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "open",
    null,
    { timeout: 3000 },
  );
  const open = await page.locator(".sr-orb").boundingBox();
  await page.screenshot({ path: `${SHOTS}/call-open.png` });
  check(
    "⑦ 开始通话有可见慢入场",
    before !== null && middle !== null && open !== null &&
      before.width === 84 &&
      middle.width > 84 &&
      middle.width < 124 &&
      open.width >= 123 &&
      Date.now() - startAt >= 850,
    `84 → ${middle?.width.toFixed(1)} → ${open?.width.toFixed(1)}`,
  );

  await openMenu();
  check(
    "⑧ 通话中禁止隐藏，先要求结束",
    await page.getByRole("menuitem", { name: "关闭悬浮球" }).isDisabled(),
    "hide disabled",
  );
  await page.keyboard.press("Escape");
  await openMenu();
  await page.getByRole("menuitem", { name: "结束通话" }).click();
  await page.waitForFunction(() => document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "closing");
  await page.waitForTimeout(120);
  const closing = await page.locator(".sr-orb").boundingBox();
  await page.screenshot({ path: `${SHOTS}/call-closing.png` });
  await page.waitForFunction(
    () =>
      document.querySelector(".sr-orb")?.getAttribute("data-call-transition") === "idle" &&
      document.querySelector(".sr-orb")?.getAttribute("data-mode") === "idle",
    null,
    { timeout: 4000 },
  );
  const settled = await page.locator(".sr-orb").boundingBox();
  check(
    "⑨ 挂断有可见慢收束并回到 idle",
    closing !== null && settled !== null && closing.width > 84 && settled.width <= 85,
    `${open?.width.toFixed(1)} → ${closing?.width.toFixed(1)} → ${settled?.width.toFixed(1)}`,
  );
}

check("⑩ 零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
