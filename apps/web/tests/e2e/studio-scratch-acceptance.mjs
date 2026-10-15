/**
 * #bitwig-adoption 第一刀（A 试凑区 + B 调性闭环）端到端验收（PASS/FAIL 逐条打印，可重复跑）：
 * ① 试凑区收起→展开的首帧增量 ≤50ms（裁决书 §④，实测打印）
 * ② 点格 = 下一小节边界起循环，启动误差 ≤30ms（window.__scratchProbe 实测打印）
 * ③ 连点 5 格 → 同时发声 ≤4，最旧的 sc-1 被顶掉（LRU 顶替在 UI 上可见）
 * ④ 4 循环发声中 fps ≥50（实测打印）
 * ⑤ 拖格进轨道：格离区、clip 落轨、它的循环同时停（孤儿循环不留）
 * ⑥ B 项：旋律 clip 调外徽标「调外 1」→ 钢琴卷帘「量化到调」→ 调外 0
 * ⑦ 截图留存 exports/scratch-e2e/scratch-pad.png
 *
 * 前置：5173 dev server（SCRATCH_E2E_BASE 可覆写）；桥不强制（音频播不出不影响断言，
 * 桥在时 <audio> 真发声）。种子工程 bpm=240 → 小节 1000ms，验收不等太久。
 * 用法：node tests/e2e/studio-scratch-acceptance.mjs   （HEADFUL=1 可开有头复跑）
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.SCRATCH_E2E_BASE ?? "http://localhost:5173";
const REPO = "/Users/lazora/Documents/ShadowRoom";
const SHOTS = `${REPO}/exports/scratch-e2e`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

// ---- 环境：dev server + 一段真能发声的 1 秒循环 WAV（440Hz 正弦，8kHz 单声道）
mkdirSync(SHOTS, { recursive: true });
const portFree = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return !probe.stdout.trim();
};
if (portFree(5173) && !process.env.SCRATCH_E2E_BASE) {
  console.log("FAIL  环境 — 5173 dev server 不在（先 pnpm dev）");
  process.exit(1);
}
const wav = (seconds, freq = 8000) => {
  const n = Math.floor(seconds * freq);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / freq) * 440 * 2 * Math.PI) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(freq, 24); header.writeUInt32LE(freq * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
const tmp = mkdtempSync(join(tmpdir(), "scratch-e2e-"));
const LOOP = join(tmp, "loop.wav");
writeFileSync(LOOP, wav(1));

const seed = {
  id: "proj-e2e-scratch",
  name: "试凑区验收",
  updatedAt: 1,
  bpm: 240, // 小节 = 1000ms：边界等待可预测
  key: "C",
  bars: 16,
  tracks: [
    {
      id: "trk-1", name: "和声", muted: false, soloed: false, volume: 80,
      clips: [
        {
          id: "clip-notes", name: "旋律", start: 0, length: 2,
          notes: [
            { id: "n1", start_ms: 0, end_ms: 250, midi: 60 },
            { id: "n2", start_ms: 250, end_ms: 500, midi: 61 }, // C#4：C 大调外
            { id: "n3", start_ms: 500, end_ms: 750, midi: 64 },
          ],
        },
      ],
    },
  ],
  scratch: [1, 2, 3, 4, 5].map((i) => ({
    id: `sc-${i}`, name: `候选 ${"ABCDE"[i - 1]}`, start: 0, length: 1, source: LOOP,
  })),
};

const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADFUL === undefined });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
try {
  await page.addInitScript((project) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
    window.localStorage.setItem("shadowroom.studio.open", project.id);
    window.localStorage.removeItem("shadowroom.orb.position");
  }, seed);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator(".sr-scratch-rail").waitFor({ timeout: 15000 });

  // ① 展开首帧增量（click → 双 rAF 上屏）
  const firstFrameMs = await page.evaluate(() => new Promise((resolve) => {
    const rail = document.querySelector(".sr-scratch-rail");
    if (!rail) { resolve(-1); return; }
    const t0 = performance.now();
    rail.click();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round((performance.now() - t0) * 10) / 10)));
  }));
  await page.locator(".sr-scratch-cell").first().waitFor({ timeout: 5000 });
  check("① 试凑区展开首帧增量 ≤50ms", firstFrameMs >= 0 && firstFrameMs <= 50, `实测 ${firstFrameMs}ms（5 格）`);

  const cellSel = (id) => `.sr-scratch-cell[data-clip-id="${id}"]`;
  const clickAndWaitStart = async (id) => {
    await page.locator(cellSel(id)).click();
    await page.waitForSelector(`${cellSel(id)}[data-playing]`, { timeout: 5000 });
  };

  // ② 循环启动误差（第一格，探针实测）
  await clickAndWaitStart("sc-1");
  const startError = await page.evaluate(() => window.__scratchProbe?.lastStartErrorMs ?? null);
  check(
    "② 循环启动误差 ≤30ms（小节量化）",
    startError !== null && Math.abs(startError) <= 30,
    startError === null ? "探针没写到" : `实测 ${Math.round(startError * 10) / 10}ms`,
  );

  // ③ 连点其余 4 格 → ≤4 同时发声，最旧的 sc-1 被顶
  for (const id of ["sc-2", "sc-3", "sc-4", "sc-5"]) await clickAndWaitStart(id);
  const playingAfter5 = await page.locator(".sr-scratch-cell[data-playing]").count();
  const sc1Playing = await page.locator(`${cellSel("sc-1")}[data-playing]`).count();
  check("③ 第 5 格顶掉最旧格（≤4 同时发声）", playingAfter5 === 4 && sc1Playing === 0, `发声 ${playingAfter5} 格，sc-1 ${sc1Playing ? "还在响" : "已停"}`);

  // ④ 4 循环发声中 fps
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames += 1;
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
      else resolve(Math.round(frames / ((performance.now() - t0) / 1000)));
    };
    requestAnimationFrame(tick);
  }));
  check("④ 循环发声中 fps ≥50", fps >= 50, `实测 ${fps}fps`);

  // ⑤ 拖 sc-3 进 trk-1（HTML5 DnD 手工派发）：格离区、clip 落轨、循环同步停
  const dragged = await page.evaluate(() => {
    const cell = document.querySelector('.sr-scratch-cell[data-clip-id="sc-3"]');
    const lane = document.querySelector('.sr-studio-lane[data-track-id="trk-1"]');
    if (!cell || !lane) return "missing";
    const dt = new DataTransfer();
    cell.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const box = lane.getBoundingClientRect();
    const point = { clientX: Math.round(box.left + 120), clientY: Math.round(box.top + 10) };
    lane.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, ...point }));
    lane.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, ...point }));
    return "ok";
  });
  await page.waitForTimeout(500);
  const cellGone = (await page.locator(cellSel("sc-3")).count()) === 0;
  const clipLanded = (await page.locator('.sr-clip[aria-label="候选 C"]').count()) === 1;
  const playingAfterDrag = await page.locator(".sr-scratch-cell[data-playing]").count();
  check("⑤ 拖格进轨道（离区 + 落轨 + 循环停）", dragged === "ok" && cellGone && clipLanded && playingAfterDrag === 3,
    `drag=${dragged}，格离区=${cellGone}，落轨=${clipLanded}，剩余发声 ${playingAfterDrag}`);

  // ⑥ B 项：调外徽标 → 钢琴卷帘量化到调
  const badge = (await page.locator('.sr-clip[aria-label="旋律"] .sr-clip-badge--offkey').textContent().catch(() => "")) ?? "";
  check("⑥a 旋律 clip 调外徽标", badge.includes("调外 1"), badge.replace(/\s+/g, " ").trim() || "(无徽标)");
  await page.locator('.sr-clip[aria-label="旋律"]').dblclick();
  await page.locator(".sr-roll").waitFor({ timeout: 5000 });
  const offBefore = await page.locator(".sr-roll-note[data-offkey]").count();
  await page.getByRole("button", { name: "量化到调" }).click();
  await page.waitForTimeout(400);
  const offAfter = await page.locator(".sr-roll-note[data-offkey]").count();
  const meta = (await page.locator(".sr-roll-meta").textContent().catch(() => "")) ?? "";
  check("⑥b 量化到调后调外 0", offBefore === 1 && offAfter === 0 && !meta.includes("调外"),
    `量化前调外 ${offBefore} → 后 ${offAfter}，meta=${meta.replace(/\s+/g, " ").trim()}`);

  await page.screenshot({ path: `${SHOTS}/scratch-pad.png` });
  console.log(`SHOT  ${SHOTS}/scratch-pad.png`);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `，${failed} 条 FAIL` : ""}`);
process.exit(failed ? 1 : 0);
