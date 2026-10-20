/**
 * DJ real-data acceptance:
 * - a stale draft id becomes a readable, removable missing row instead of a permanent request;
 * - removing it restores planner timing;
 * - FLAC files without library peaks still draw a client-decoded waveform;
 * - switching tracks cannot let an older decode overwrite the newer track's waveform.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.DJ_E2E_BASE ?? "http://localhost:5173";
const BRIDGE = process.env.DJ_E2E_BRIDGE ?? "http://127.0.0.1:8787";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/dj-wave-set-20261020";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function callTool(server, tool, args) {
  const response = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
  if (!response.ok) throw new Error(`bridge HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.isError === true) throw new Error(String(payload.result));
  return typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
}

const library = await callTool("library", "list_tracks", { limit: 200 });
const flac = (library.tracks ?? []).filter((track) => String(track.path ?? "").toLowerCase().endsWith(".flac"));
if (flac.length < 2) throw new Error(`need 2 FLAC tracks, found ${flac.length}`);
const first = flac[0];
const second = flac[1];

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
await page.addInitScript(({ id }) => {
  localStorage.setItem("shadowroom.view", "dj");
  localStorage.setItem("shadowroom.dock", "closed");
  localStorage.setItem(
    "shadowroom.setdraft",
    JSON.stringify({ id: "dj-wave-set-audit", name: "徐州930", trackIds: [999999, id], overlapMs: 16000 }),
  );
}, { id: first.id });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });

const missingRow = page.locator('.sr-dj-board .sr-dj-row[data-missing="true"][data-track-id="999999"]');
await missingRow.waitFor({ timeout: 5000 });
const missingText = (await missingRow.innerText()).trim();
check(
  "① 旧 Set ID 进入终态，不永久显示载入中",
  missingText.includes("曲目已不在库中") && !missingText.includes("载入中"),
  missingText.replace(/\s+/g, " / "),
);

const warning = (await page.locator(".sr-dj-board-warning").innerText()).trim();
const aiDisabled = await page.getByRole("button", { name: "AI 排序" }).isDisabled();
const totalBefore = (await page.locator(".sr-dj-hero-meta strong").nth(1).innerText()).trim();
check(
  "② 缺失状态有警告、AI 排序被阻止、总长不伪造",
  warning.includes("1 首已不在曲目库") && aiDisabled && totalBefore === "—",
  `warning=${warning.replace(/\s+/g, " / ")}；AI禁用=${aiDisabled}；总长=${totalBefore}`,
);

await page.getByRole("button", { name: "移出 已缺失曲目 999999" }).click();
await page.waitForFunction(() => {
  const draft = JSON.parse(localStorage.getItem("shadowroom.setdraft") ?? "null");
  return draft?.trackIds?.length === 1 && draft.trackIds[0] !== 999999;
});
await page.waitForFunction(() => {
  const total = document.querySelectorAll(".sr-dj-hero-meta strong")[1]?.textContent?.trim();
  return total !== undefined && total !== "—";
}, null, { timeout: 8000 });
const draftAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("shadowroom.setdraft")));
const warningAfter = await page.locator(".sr-dj-board-warning").count();
const totalAfter = (await page.locator(".sr-dj-hero-meta strong").nth(1).innerText()).trim();
check(
  "③ 移出失败项后草稿恢复，planner 重新计时",
  draftAfter.trackIds.length === 1 && warningAfter === 0 && totalAfter !== "—",
  `trackIds=${JSON.stringify(draftAfter.trackIds)}；警告=${warningAfter}；总长 ${totalBefore}→${totalAfter}`,
);

const waveformStartedAt = Date.now();
await page.locator('.sr-dj-board .sr-dj-row[data-track-id="' + first.id + '"]').click();
await page.waitForFunction(({ id }) => {
  const wave = document.querySelector(".sr-dj-wave-wrap");
  return wave?.getAttribute("data-track-id") === String(id) && wave.getAttribute("data-wave-state") === "ready";
}, { id: first.id }, { timeout: 20000 });
const waveformReadyMs = Date.now() - waveformStartedAt;
await page.waitForFunction(() => {
  const button = document.querySelector(".sr-dj-deck button[aria-label^='播放']");
  return button instanceof HTMLButtonElement && !button.disabled;
}, null, { timeout: 20000 });
const firstWave = await page.locator(".sr-dj-wave-wrap").evaluate((root) => {
  const canvas = root.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
  let colored = 0;
  if (pixels) {
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 45 && pixels[index + 1] > 50 && Math.abs(pixels[index] - pixels[index + 1]) < 45) colored += 1;
    }
  }
  return {
    bars: Number(root.getAttribute("data-wave-bars")),
    width: canvas.width,
    height: canvas.height,
    colored,
  };
});
check(
  "④ FLAC 无库内 peaks 也画出真实波形",
  firstWave !== null && firstWave.bars >= 200 && firstWave.width >= 1000 && firstWave.colored > 2000 && waveformReadyMs < 6000,
  `${JSON.stringify(firstWave)}；ready=${waveformReadyMs}ms`,
);

await page.locator('.sr-dj-library .sr-dj-row[data-track-id="' + first.id + '"]').click();
await page.waitForTimeout(30);
await page.locator('.sr-dj-library .sr-dj-row[data-track-id="' + second.id + '"]').click();
await page.waitForFunction(({ id }) => {
  const wave = document.querySelector(".sr-dj-wave-wrap");
  return wave?.getAttribute("data-track-id") === String(id) && wave.getAttribute("data-wave-state") === "ready";
}, { id: second.id }, { timeout: 20000 });
const switched = await page.locator(".sr-dj-wave-wrap").evaluate((root) => ({
  id: root.getAttribute("data-track-id"),
  state: root.getAttribute("data-wave-state"),
  bars: Number(root.getAttribute("data-wave-bars")),
}));
check(
  "⑤ 快速切歌后新波形胜出，旧解码不回写",
  switched.id === String(second.id) && switched.state === "ready" && switched.bars >= 200,
  JSON.stringify(switched),
);

await page.screenshot({ path: `${SHOTS}/flac-waveform-and-set.png`, fullPage: true });
check("⑥ 零 Console error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");
await browser.close();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
