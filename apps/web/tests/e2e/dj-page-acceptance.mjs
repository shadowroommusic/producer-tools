import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";

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
  const value = payload.result;
  return typeof value === "string" ? JSON.parse(value) : value;
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "dj");
  window.__curves = [];
  window.__starts = [];
  window.__contexts = [];
  const OriginalAudioContext = window.AudioContext;
  window.AudioContext = function (...args) {
    const context = new OriginalAudioContext(...args);
    window.__contexts.push(context);
    return context;
  };
  window.AudioContext.prototype = OriginalAudioContext.prototype;
  const originalCurve = AudioParam.prototype.setValueCurveAtTime;
  AudioParam.prototype.setValueCurveAtTime = function (values, when, duration) {
    window.__curves.push({ gainId: this.__ownerGainId ?? null, values: Array.from(values), duration, at: performance.now() });
    return originalCurve.apply(this, arguments);
  };
  let gainSeq = 0;
  const originalCreateGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function () {
    const node = originalCreateGain.apply(this, arguments);
    node.gain.__ownerGainId = ++gainSeq;
    return node;
  };
  const originalStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
    window.__starts.push({
      when: Number(when) || 0,
      offset: Number(offset) || 0,
      ctxTime: this.context.currentTime,
      at: performance.now(),
    });
    return originalStart.apply(this, arguments);
  };
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj", { timeout: 30000 });
await page.waitForTimeout(2000);

// ① 筛选条数 = 同条件 SQL count
const countText = await page.locator(".sr-dj-count").innerText();
const uiCount = Number((countText.match(/共\s*(\d+)/) ?? [])[1]);
const bridgeList = await callTool("library", "list_tracks", { limit: 200 });
check("① 筛选条数=同条件 SQL count", uiCount === bridgeList.tracks.length, `UI「${countText}」 vs bridge ${bridgeList.tracks.length} 行`);

// 选定一首 ≥ 90 秒的曲目装到 A（seek 60s 需要它够长）
// 挑一首 90–130 秒、且标题在全库里唯一的：够长能 seek 60s，行选择也不会撞名
const titleCounts = new Map();
for (const track of bridgeList.tracks) {
  const key = track.title ?? track.path.split("/").pop();
  titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
}
const candidates = bridgeList.tracks
  .filter((track) => (track.duration_ms ?? 0) >= 90000 && (track.duration_ms ?? 0) <= 130000)
  .filter((track) => titleCounts.get(track.title ?? track.path.split("/").pop()) === 1)
  .sort((a, b) => (a.duration_ms ?? 0) - (b.duration_ms ?? 0));
const target = candidates[0] ?? bridgeList.tracks.find((track) => (track.duration_ms ?? 0) > 60000) ?? bridgeList.tracks[0];
const targetTitle = target.title ?? target.path.split("/").pop();
const row = page
  .locator(".sr-dj-row")
  .filter({ has: page.locator(".sr-dj-row-title", { hasText: new RegExp(`^${targetTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
  .first();
await row.locator("button", { hasText: "装到 A" }).click();
const deck = page.locator(".sr-dj-deck").first();
const playButton = deck.getByRole("button", { name: /播放 deck A/ });
let loaded = true;
try {
  await playButton.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".sr-dj-deck button[aria-label^='播放 deck A']");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 45000 });
} catch (error) {
  loaded = false;
}
if (!loaded) {
  const notice = await deck.locator(".sr-dj-notice").innerText().catch(() => "(没有 notice)");
  const clock = await deck.locator(".sr-dj-clock").innerText().catch(() => "?");
  const total = await deck.locator(".sr-dj-clock-total").innerText().catch(() => "?");
  console.log(`装台失败诊断：notice=${notice} | clock=${clock} ${total}`);
}
const totalText = await deck.locator(".sr-dj-clock-total").innerText();
// 以“装上去的那首”为准（行匹配万一错了，后面的断言也不会张冠李戴）
const loadedPath = await deck.locator(".sr-dj-deck-title").getAttribute("title");
const loadedTrack = bridgeList.tracks.find((track) => track.path === loadedPath) ?? target;
const loadedId = loadedTrack.id;
const loadedDurationMs = loadedTrack.duration_ms ?? 0;
const loadedTitle = loadedTrack.title ?? loadedTrack.path.split("/").pop();
console.log(`装到 A 的是：id=${loadedId} ${loadedTitle} (${Math.round(loadedDurationMs / 1000)}s)`);
const loadingVisible = await deck.locator(".sr-dj-loading").count();
check("②-0 装到 A 后 decode 完成", loaded && loadedDurationMs === target.duration_ms && loadingVisible === 0 && /\/\s*\d+:\d\d/.test(totalText), `总时长 ${totalText}，loading 元素 ${loadingVisible} 个`);

// ② 播放 2 秒，用引擎真实 start() 的 offset + ctx.currentTime 量位置增量
await deck.getByRole("button", { name: /播放 deck A/ }).click();
await page.waitForTimeout(2200);
const positionMs = await page.evaluate(() => {
  const ctx = window.__contexts.at(-1);
  const last = window.__starts.at(-1);
  return last && ctx ? (last.offset + (ctx.currentTime - last.ctxTime)) * 1000 : null;
});
const clockAfter = await deck.locator(".sr-dj-clock").innerText();
check("② 播放 2s 后位置增量 ≥1500ms", positionMs !== null && positionMs >= 1500, `引擎位置 ${Math.round(positionMs)}ms（读数 ${clockAfter}）`);

// ③ seek 60.0s：点波形 60/duration 处
const durationMs = loadedDurationMs;
const wantSeconds = 60;
const wave = deck.locator(".sr-dj-wave");
const box = await wave.boundingBox();
await page.mouse.click(box.x + (wantSeconds * 1000 / durationMs) * box.width, box.y + box.height / 2);
await page.waitForTimeout(400);
// 量的是“刚 seek 完那一刻的 offset”，所以播放先停住，别让走带把数字带跑
const seekOffset = await page.evaluate(() => {
  const ctx = window.__contexts.at(-1);
  const last = window.__starts.at(-1);
  return last ? last.offset * 1000 : null;
});
const seekClock = await deck.locator(".sr-dj-clock").innerText();
check("③ seek 60.0s → 实测 ∈[59.5,60.5]", seekOffset !== null && seekOffset >= 59500 && seekOffset <= 60500, `引擎实测 ${Math.round(seekOffset)}ms（读数 ${seekClock}）`);
await deck.getByRole("button", { name: /暂停 deck A/ }).click();
await page.waitForTimeout(300);

// ④ 打 3 个 cue → 刷新后仍在
const cueAdd = deck.locator(".sr-dj-cue-add");
for (const fraction of [0.2, 0.4, 0.6]) {
  await page.mouse.click(box.x + fraction * box.width, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await cueAdd.click();
  await page.waitForTimeout(700);
}
const cuesBefore = await deck.locator(".sr-dj-cue").count();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj", { timeout: 30000 });
await page.waitForTimeout(2500);
const deckAfterReload = page.locator(".sr-dj-deck").first();
const cuesAfter = await deckAfterReload.locator(".sr-dj-cue").count();
check("④ 3 个 cue 刷新后仍在", cuesBefore === 3 && cuesAfter === 3, `刷新前 ${cuesBefore} → 刷新后 ${cuesAfter}`);

// ⑤ 改名 + 换色 → track_detail 一致
const firstCue = deckAfterReload.locator(".sr-dj-cue").first();
await firstCue.locator(".sr-dj-cue-edit").click();
const nameInput = deckAfterReload.getByLabel("cue 名称");
await nameInput.fill("验收点");
await nameInput.press("Enter"); // Enter 才是提交；Escape 是取消（第一次跑就是被我自己按掉的那个）
await page.waitForTimeout(600);
await firstCue.locator(".sr-dj-cue-edit").click();
await deckAfterReload.getByTitle("换一个颜色").click();
await page.waitForTimeout(900);
const detail = await callTool("library", "track_detail", { id: loadedId });
const named = (detail.cues ?? []).find((cue) => cue.name === "验收点");
check("⑤ 改名/配色后 track_detail 一致", Boolean(named) && /^#[0-9a-f]{6}$/i.test(named?.color ?? ""), `track_detail(track ${loadedId}) 里 ${named?.name} / ${named?.color}`);

// ⑥ crossfade 0 → 0.5 → 1：两路曲线是等功率（A 降 B 升）
const xfade = page.locator(".sr-dj-xfade");
const curvePairs = [];
for (const value of [0, 0.5, 1]) {
  const before = await page.evaluate(() => window.__curves.length);
  await xfade.fill(String(value));
  await page.waitForTimeout(700);
  const pushed = await page.evaluate((n) => window.__curves.slice(n).map((c) => ({ gainId: c.gainId, values: c.values })), before);
  const summaries = pushed.map(({ gainId, values }) => ({
    gainId,
    first: Number(values[0].toFixed(4)),
    mid: Number(values[Math.floor(values.length / 2)].toFixed(4)),
    last: Number(values[values.length - 1].toFixed(4)),
  }));
  curvePairs.push({ value, summaries });
}
// 曲线是「从当前值 30ms 渐变到目标值」，所以断言看**终点**：x=0 → (1,0)、x=0.5 → (0.7071,0.7071)、x=1 → (0,1)
const flat = (pair) => pair.summaries.map((s) => `${s.first}→${s.last}`).join(" & ");
const at = (value) => curvePairs.find((pair) => pair.value === value);
const ends = (value) => at(value).summaries.map((s) => s.last).sort((a, b) => a - b);
const close = (a, b) => Math.abs(a - b) < 0.001;
// 按 gain 节点身份把三档的终点归到两条通道上，再看它们是不是一条单调降、一条单调升
const byGain = new Map();
for (const value of [0, 0.5, 1]) {
  for (const summary of at(value).summaries) {
    if (summary.gainId === null) continue;
    if (!byGain.has(summary.gainId)) byGain.set(summary.gainId, []);
    byGain.get(summary.gainId).push(summary.last);
  }
}
const lanes = [...byGain.values()].filter((values) => values.length === 3);
const down = lanes.find((values) => close(values[0], 1) && close(values[1], 0.7071) && close(values[2], 0));
const up = lanes.find((values) => close(values[0], 0) && close(values[1], 0.7071) && close(values[2], 1));
const ok0 = ends(0).length >= 2 && close(ends(0)[0], 0) && close(ends(0)[1], 1);
const okHalf = ends(0.5).length >= 2 && ends(0.5).every((v) => close(v, 0.7071));
const ok1 = ends(1).length >= 2 && close(ends(1)[0], 0) && close(ends(1)[1], 1);
check(
  "⑥ crossfade 等功率（A 降 B 升）",
  ok0 && okHalf && ok1 && Boolean(down) && Boolean(up),
  `x=0: ${flat(at(0))} | x=0.5: ${flat(at(0.5))} | x=1: ${flat(at(1))} | 一条 ${down?.join(" → ")} / 另一条 ${up?.join(" → ")}`,
);

// ⑦ 零 console error
check("⑦ 零 console error", consoleErrors.length === 0, consoleErrors.length === 0 ? "没有 error/pageerror" : consoleErrors.slice(0, 3).join(" | "));

// 收尾：把这次验收写进去的 cue 清干净（cues_set 空数组 = 唯一写路径）
await callTool("library", "cues_set", { track_id: loadedId, cues: [] });
const cleaned = await callTool("library", "track_detail", { id: loadedId });
console.log(`\n收尾：track ${loadedId} 的 cue 已清空 → ${(cleaned.cues ?? []).length} 条`);
console.log(`目标曲目: id=${loadedId} ${loadedTitle} (${Math.round(durationMs / 1000)}s)`);
console.log(`\n汇总: ${results.filter((r) => r.ok).length}/${results.length} 通过`);

await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
