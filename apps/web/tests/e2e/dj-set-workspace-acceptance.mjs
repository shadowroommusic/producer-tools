/**
 * DJ new-set workspace acceptance.
 *
 * The set editor is an internal DjPage view, not a second mainView or a copied draft. This test
 * proves the focused surface opens, the sidebar remains on DJ, draft/view survive a round-trip and
 * refresh, and switching surfaces does not replace the player DOM node (therefore cannot stop audio).
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.DJ_SET_WORKSPACE_BASE ?? "http://127.0.0.1:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/dj-set-workspace-20261020";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  if (!sessionStorage.getItem("__dj_workspace_seeded")) {
    localStorage.setItem("shadowroom.view", "dj");
    localStorage.removeItem("shadowroom.setdraft");
    localStorage.removeItem("shadowroom.djview");
    localStorage.removeItem("shadowroom.orb.position");
    sessionStorage.setItem("__dj_workspace_seeded", "1");
  }
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.waitForTimeout(600);

const view = () => page.locator(".sr-dj").getAttribute("data-dj-view");
const rootBefore = await view();
const libraryBefore = await page.locator(".sr-dj-library").count();
const deckBefore = await page.locator(".sr-dj-deck").evaluate((element) => {
  element.dataset.acceptanceDeck = "same-node";
  return "same-node";
});
check(
  "① DJ 默认仍从总览进入",
  rootBefore === "overview" && libraryBefore === 1,
  `view=${rootBefore} library=${libraryBefore}`,
);

await page.getByRole("button", { name: "新建 set", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".sr-dj")?.getAttribute("data-dj-view") === "editor");
const afterNew = await page.evaluate(() => ({
  view: document.querySelector(".sr-dj")?.getAttribute("data-dj-view"),
  library: document.querySelectorAll(".sr-dj-library").length,
  board: document.querySelectorAll(".sr-dj-board").length,
  deck: document.querySelector(".sr-dj-deck")?.getAttribute("data-acceptance-deck"),
  draft: JSON.parse(localStorage.getItem("shadowroom.setdraft") ?? "null"),
  storedView: localStorage.getItem("shadowroom.djview"),
  djActive: document.querySelector(".sr-panel-row[aria-current='page']")?.textContent?.includes("DJ") ?? false,
  width: Math.round(document.querySelector(".sr-dj-board")?.getBoundingClientRect().width ?? 0),
}));
check(
  "② 新建 set 进入独立编辑面，侧栏仍高亮 DJ，deck 节点不替换",
  afterNew.view === "editor" &&
    afterNew.library === 0 &&
    afterNew.board === 1 &&
    afterNew.deck === deckBefore &&
    (afterNew.draft?.trackIds ?? []).length === 0 &&
    afterNew.storedView === "editor" &&
    afterNew.djActive &&
    afterNew.width >= 900,
  JSON.stringify(afterNew),
);

const nameInput = page.getByRole("textbox", { name: "set 名" });
await nameInput.fill("第二晚 Set");
await page.waitForTimeout(400);
const renamed = await page.evaluate(() => JSON.parse(localStorage.getItem("shadowroom.setdraft") ?? "null")?.name ?? "");
check("③ 编辑面改名立即写入同一份 draft", renamed === "第二晚 Set", `draft.name=${renamed}`);

await page.getByRole("button", { name: "← 返回总览", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".sr-dj")?.getAttribute("data-dj-view") === "overview");
const roundTrip = await page.evaluate(() => ({
  library: document.querySelectorAll(".sr-dj-library").length,
  name: (document.querySelector('input[aria-label="set 名"]')).value,
  deck: document.querySelector(".sr-dj-deck")?.getAttribute("data-acceptance-deck"),
}));
check(
  "④ 返回总览后草稿仍在、库回来、deck 仍是同一节点",
  roundTrip.library === 1 && roundTrip.name === "第二晚 Set" && roundTrip.deck === deckBefore,
  JSON.stringify(roundTrip),
);

await page.getByRole("button", { name: "编辑 set", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".sr-dj")?.getAttribute("data-dj-view") === "editor");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-deck", { timeout: 30000 });
await page.waitForTimeout(500);
const refreshed = await page.evaluate(() => ({
  view: document.querySelector(".sr-dj")?.getAttribute("data-dj-view"),
  name: (document.querySelector('input[aria-label="set 名"]')).value,
  draft: JSON.parse(localStorage.getItem("shadowroom.setdraft") ?? "null"),
}));
check(
  "⑤ 刷新后仍在编辑面且标题/草稿 100% 恢复",
  refreshed.view === "editor" &&
    refreshed.name === "第二晚 Set" &&
    refreshed.draft?.name === "第二晚 Set" &&
    Array.isArray(refreshed.draft?.trackIds),
  JSON.stringify(refreshed),
);

await page.screenshot({ path: `${SHOTS}/editor-1440.png`, fullPage: true });
await page.setViewportSize({ width: 1092, height: 605 });
await page.waitForTimeout(250);
const compact = await page.evaluate(() => {
  const root = document.querySelector(".sr-dj");
  const main = document.querySelector(".sr-dj-main--editor");
  const deck = document.querySelector(".sr-dj-deck");
  return {
    rootOverflow: root === null ? -1 : root.scrollWidth - root.clientWidth,
    mainOverflow: main === null ? -1 : main.scrollWidth - main.clientWidth,
    boardVisible: document.querySelector(".sr-dj-board")?.getBoundingClientRect().height ?? 0,
    deckVisible: deck instanceof HTMLElement && deck.getBoundingClientRect().height > 0,
  };
});
check(
  "⑥ 1092×605 独立编辑面不横向溢出，看板与 deck 均在场",
  compact.rootOverflow <= 1 && compact.mainOverflow <= 1 && compact.boardVisible >= 80 && compact.deckVisible,
  JSON.stringify(compact),
);
await page.screenshot({ path: `${SHOTS}/editor-1092.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(200);

await page.getByRole("button", { name: "← 返回总览", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".sr-dj")?.getAttribute("data-dj-view") === "overview");
const forfeit = page.locator(".sr-dj-library .sr-dj-row", { hasText: "FORFEIT" }).first();
await forfeit.click();
await page.waitForFunction(
  () => {
    const button = document.querySelector(".sr-dj-deck button[aria-label^='播放']");
    return button instanceof HTMLButtonElement && !button.disabled;
  },
  null,
  { timeout: 30000 },
);
await page.locator(".sr-dj-deck button[aria-label^='播放']").click();
await page.waitForFunction(() => document.querySelector(".sr-dj-deck")?.getAttribute("data-state") === "playing");
const playingDeck = await page.locator(".sr-dj-deck").evaluate((element) => {
  element.dataset.acceptancePlaying = "same-node";
  return element.getAttribute("data-acceptance-playing");
});
await page.getByRole("button", { name: "编辑 set", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".sr-dj")?.getAttribute("data-dj-view") === "editor");
const afterPlayingSwitch = await page.locator(".sr-dj-deck").evaluate((element) => ({
  marker: element.getAttribute("data-acceptance-playing"),
  state: element.getAttribute("data-state"),
}));
check(
  "⑦ 播放中切到 Set 编辑面，deck 节点与播放状态都不断",
  playingDeck === "same-node" &&
    afterPlayingSwitch.marker === "same-node" &&
    afterPlayingSwitch.state === "playing",
  JSON.stringify(afterPlayingSwitch),
);

check("⑧ 零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await context.close();
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
