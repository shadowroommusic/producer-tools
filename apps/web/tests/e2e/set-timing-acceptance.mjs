import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";
const OVERLAP_S = 4;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function callTool(server, tool, args) {
  const response = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
  const payload = await response.json();
  if (payload.isError) throw new Error(`${server}.${tool}: ${String(payload.result).slice(0, 200)}`);
  return typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
}

const parseClock = (text) => {
  const parts = text.trim().split(":").map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
};

// ── 准备：3 首带 in/out cue 的曲目（cue 用 cues_set 唯一写路径）
const library = await callTool("library", "list_tracks", { limit: 200 });
const eligible = library.tracks.filter((t) => (t.duration_ms ?? 0) >= 20000 && t.title);
const picked = eligible.slice(0, 3);
if (picked.length < 3) throw new Error("库里不够 3 首 ≥20 秒的曲目");

const expectedSegments = [];
for (const track of picked) {
  const duration = track.duration_ms;
  const inMs = Math.round(duration * 0.05);
  const outMs = Math.round(duration * 0.95);
  await callTool("library", "cues_set", {
    track_id: track.id,
    cues: [
      { position_ms: inMs, role: "in", slot: 0, name: "in" },
      { position_ms: outMs, role: "out", slot: 1, name: "out" },
    ],
  });
  expectedSegments.push({ id: track.id, title: track.title, duration, inMs, outMs, segment: outMs - inMs });
}
const handSum = expectedSegments.reduce((total, row) => total + row.segment, 0);
const handSaved = OVERLAP_S * 1000 * (expectedSegments.length - 1);
const handTotal = handSum - handSaved;
console.log(`手算：段合计 ${handSum}ms（${expectedSegments.map((r) => Math.round(r.segment / 1000) + "s").join(" + ")}）· 省 ${handSaved}ms · 总 ${handTotal}ms`);

// ── 页面
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "dj");
  if (!window.sessionStorage.getItem("__s3_cleared")) {
    window.localStorage.removeItem("shadowroom.setdraft");
    window.sessionStorage.setItem("__s3_cleared", "1");
  }
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.waitForTimeout(2000);

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const row of expectedSegments) {
  const libraryRow = page
    .locator(".sr-dj-library .sr-dj-row")
    .filter({ has: page.locator(".sr-dj-row-title", { hasText: new RegExp(`^${escaped(row.title)}$`) }) })
    .first();
  await libraryRow.locator("button", { hasText: "加入" }).click();
  await page.waitForTimeout(700);
}
await page.getByLabel("默认 overlap（秒）").fill(String(OVERLAP_S));
await page.waitForTimeout(2500); // 300ms 防抖 + plan_set 往返

// ① 三读数 vs 手算
const timingText = await page.locator(".sr-dj-timing").innerText();
const numbers = timingText.match(/(\d+(?::\d{2}){1,2})/g) ?? [];
const [shownSum, shownSaved, shownTotal] = numbers.map(parseClock);
const near = (a, b) => Math.abs(a - b) <= 1; // 读数按秒显示，允许 1 秒取整
check(
  "① 顶栏三读数 = 手算（段合计 / overlap 节省 / 总时长）",
  numbers.length === 3 && near(shownSum, handSum / 1000) && near(shownSaved, handSaved / 1000) && near(shownTotal, handTotal / 1000),
  `读数「${timingText}」 → ${shownSum}/${shownSaved}/${shownTotal}s；手算 ${handSum / 1000}/${handSaved / 1000}/${handTotal / 1000}s`,
);

// ② AI 排序 = order_set 输出
const planPayload = {
  tracks: expectedSegments.map((row) => ({
    id: String(row.id), title: row.title, bpm: null, key: null, energy: null, duration_ms: row.duration,
    cues: [{ position_ms: row.inMs, role: "in" }, { position_ms: row.outMs, role: "out" }],
  })),
};
const ordered = await callTool("planner", "order_set", { set: planPayload });
const expectedOrder = (ordered.ordered_ids ?? ordered.order ?? []).map((x) => (typeof x === "string" ? x : x.id));
await page.locator("button", { hasText: "AI 排序" }).first().click();
await page.waitForTimeout(3500);
const boardTitles = (await page.locator(".sr-dj-board .sr-dj-row-title").allTextContents()).map((t) => t.trim());
const titleById = new Map(expectedSegments.map((row) => [String(row.id), row.title]));
const expectedTitles = expectedOrder.map((id) => titleById.get(String(id)));
check(
  "② AI 排序应用后 = order_set 的 ordered_ids",
  JSON.stringify(boardTitles) === JSON.stringify(expectedTitles) && expectedTitles.length === 3,
  `order_set 顺序 ${expectedTitles.join(" → ")}；看板 ${boardTitles.join(" → ")}`,
);

// ③ 撤销排序按钮出现（可回退）
const undoVisible = await page.locator("button", { hasText: "撤销排序" }).count();
check("③ 排序后可撤销（撤销排序按钮出现）", undoVisible > 0, `撤销排序按钮 ${undoVisible} 个`);

check("④ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "没有 error/pageerror");

// 收尾：清掉这次写进去的 cue（保持库干净）
for (const row of expectedSegments) await callTool("library", "cues_set", { track_id: row.id, cues: [] });

console.log(`\n汇总: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
