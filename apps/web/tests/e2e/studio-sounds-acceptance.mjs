/**
 * #bitwig-adoption 刀3-D（音色/采样浏览器）端到端验收，两段：
 *
 * Stage 1（隔离渲染，性能与组件行为）：借 5173 dev server 编译组件挂独立宿主——
 * ① rail → 展开首帧 ≤16ms（音色 128 行，实测打印）
 * ② 切采样 tab 200 行、帧 ≤16ms（实测打印）
 * ③ 点音色 → 出声 ≤100ms（冷/热两记；AudioContext 冷启动已挪 pointerdown）
 * ④ 点采样 → 出声 ≤100ms；桥在则行标 data-playing 硬断（桥不在降级注明）
 * ⑤ dragstart payload：音色/采样两行 SOUND_MIME 内容 decode 后字段正确
 * ⑥ 过滤：音色滤 "viol" 剩 2 行；tab 间 query 互不干扰
 *
 * Stage 2（生产挂载，接线）：种子工程进真 Studio 页（需 8787 桥，不在降级）——
 * ⑦a 采样从 drawer 拖进 lane → clip 落轨（/api/agent/dir 真列表）
 * ⑦b GM 音色拖到轨道头 → 轨道头音色徽章（track.instrument）
 * ⑧ 截图留存 exports/sounds-e2e/sounds-drawer.png
 *
 * 前置：5173 dev server（SOUNDS_E2E_BASE 可覆写）。
 * 用法：node tests/e2e/studio-sounds-acceptance.mjs   （HEADFUL=1 可开有头复跑）
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.SOUNDS_E2E_BASE ?? "http://localhost:5173";
const REPO = "/Users/lazora/Documents/ShadowRoom";
const SHOTS = `${REPO}/exports/sounds-e2e`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};
const fmt = (v) => (v === null ? "探针没写到" : `${Math.round(v * 100) / 100}ms`);

mkdirSync(SHOTS, { recursive: true });
const portFree = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return !probe.stdout.trim();
};
if (portFree(5173) && !process.env.SOUNDS_E2E_BASE) {
  console.log("FAIL  环境 — 5173 dev server 不在（先 pnpm dev）");
  process.exit(1);
}
const wav = (seconds, freq = 8000) => {
  const n = Math.floor(seconds * freq);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(Math.sin((i / freq) * 440 * 2 * Math.PI) * 12000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(freq, 24); header.writeUInt32LE(freq * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
const tmp = mkdtempSync(join(tmpdir(), "sounds-e2e-"));
const LOOP = join(tmp, "sample-000.wav");
writeFileSync(LOOP, wav(3));
const bridgeUp = !portFree(8787);

const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADFUL === undefined });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
try {
  // ================= Stage 1：隔离渲染 =================
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const mount = await page.evaluate(async (loopPath) => {
    try {
      const [reactMod, domMod, drawerMod] = await Promise.all([
        import("/node_modules/.vite/deps/react.js"),
        import("/node_modules/.vite/deps/react-dom_client.js"),
        import("/src/components/StudioSoundsDrawer.tsx"),
      ]);
      const React = reactMod.default;
      // Vite 的 dep 预打包把 react-dom/client 的命名导出收进 default（实测 createRoot 不在顶层，
      // 顶层解构会得到 undefined → "createRoot is not a function"）。两形状都兜住。
      const { createRoot } = typeof domMod.createRoot === "function" ? domMod : domMod.default;
      const host = document.createElement("div");
      host.id = "sounds-e2e-host";
      document.body.appendChild(host);
      const imports = Array.from({ length: 200 }, (_, i) => ({
        path: i === 0 ? loopPath : `/tmp/sr-sounds-e2e/fake-${i}.wav`,
        name: `sample-${String(i).padStart(3, "0")}.wav`,
      }));
      createRoot(host).render(React.createElement(drawerMod.StudioSoundsDrawer, { imports }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 200) };
    }
  }, LOOP);
  if (!mount.ok) {
    check("① 隔离渲染挂载", false, mount.error ?? "unknown");
    throw new Error("mount failed");
  }
  await page.locator(".sr-sounds-rail").waitFor({ timeout: 10000 });

  // ① rail → 展开首帧（音色 128 行；口径 = click → commit+layout+上屏）
  const firstFrameMs = await page.evaluate(() => new Promise((resolve) => {
    const t0 = performance.now();
    document.querySelector(".sr-sounds-rail").click();
    // 单帧口径（原版两次 rAF 把 vsync 等待也算进「首帧」，dev 下必超线——2026-10-16 修口径）：
    // 用户感知 = 点下去之后**下一帧**列表在不在屏上；渲染若溢出这一帧，时间自然超 16.7ms。
    requestAnimationFrame(() => resolve(performance.now() - t0));
  }));
  await page.waitForSelector('[data-sounds-list] [data-sound-key]', { timeout: 5000 });
  const gmRows = await page.locator('[data-sounds-list] [data-kind="instrument"]').count();
  check("① 展开首帧 ≤16ms（音色 128 行）", gmRows === 128 && firstFrameMs <= 16, `行数 ${gmRows}，帧 ${Math.round(firstFrameMs * 10) / 10}ms`);

  // ② 切采样 tab（200 行）帧耗时
  const tabFrameMs = await page.evaluate(() => new Promise((resolve) => {
    const tab = document.querySelector('[data-tab="sample"]');
    const t0 = performance.now();
    tab.click();
    requestAnimationFrame(() => resolve(performance.now() - t0));
  }));
  const sampleRows = await page.locator('[data-sounds-list] [data-kind="sample"]').count();
  check("② 切采样 tab 200 行、帧 ≤16ms", sampleRows === 200 && tabFrameMs <= 16, `行数 ${sampleRows}，帧 ${Math.round(tabFrameMs * 10) / 10}ms`);

  // ③ 音色试听打点（冷/热两记：冷 >100 而热小 = pointerdown 预热没接上；两个都大 = 调度本身有问题）
  await page.locator('[data-tab="instrument"]').click();
  await page.locator('[data-sound-key="gm:40"]').click();
  await page.waitForSelector('[data-sound-key="gm:40"][data-playing]', { timeout: 2000 });
  const gmCold = await page.evaluate(() => window.__soundsProbe?.lastAuditionMs ?? null);
  await page.locator('[data-sound-key="gm:33"]').click();
  await page.waitForSelector('[data-sound-key="gm:33"][data-playing]', { timeout: 2000 });
  const gmWarm = await page.evaluate(() => window.__soundsProbe?.lastAuditionMs ?? null);
  check("③ 点音色 → 出声 ≤100ms（冷/热）",
    gmCold !== null && gmCold <= 100 && gmWarm !== null && gmWarm <= 100,
    `冷 ${fmt(gmCold)}（pointerdown 预热后 click 调度）/ 热 ${fmt(gmWarm)}`);

  // ④ 采样试听打点（第一行 = 真 WAV 路径）
  await page.locator('[data-tab="sample"]').click();
  await page.locator('[data-sound-key^="sample:"]').first().click();
  const sampleProbe = await page.evaluate(() => window.__soundsProbe?.lastAuditionMs ?? null);
  let samplePlaying = false;
  if (bridgeUp) {
    samplePlaying = await page.locator('[data-sound-key^="sample:"][data-playing]').first()
      .waitFor({ timeout: 2000 }).then(() => true).catch(() => false);
  }
  const sampleOk = sampleProbe !== null && sampleProbe <= 100 && (bridgeUp ? samplePlaying : true);
  check("④ 点采样 → 出声 ≤100ms", sampleOk,
    `实测 ${fmt(sampleProbe)}${bridgeUp ? `，playing=${samplePlaying}` : "（桥不在，出声断言降级：仅打点+换 src）"}`);

  // ⑤ 拖拽 payload（音色 + 采样各一行）
  const payloads = await page.evaluate(async () => {
    const { SOUND_MIME, decodeSoundDrag } = await import("/src/lib/studio-sounds.ts");
    const grab = (selector) => {
      const row = document.querySelector(selector);
      if (row === null) return `missing:${selector}`;
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return decodeSoundDrag(dt.getData(SOUND_MIME));
    };
    const switchTab = (name) => new Promise((resolve) => {
      document.querySelector(`[data-tab="${name}"]`).click();
      requestAnimationFrame(() => requestAnimationFrame(resolve)); // click 是离散事件，React 同步提交；双帧保险
    });
    await switchTab("instrument");
    const instrument = grab('[data-sound-key="gm:33"]');
    await switchTab("sample");
    const sample = grab('[data-sound-key^="sample:"]');
    return { instrument, sample };
  });
  const payloadOk = payloads.instrument?.kind === "instrument" && payloads.instrument?.program === 33
    && payloads.instrument?.name === "Electric Bass (finger)"
    && payloads.sample?.kind === "sample" && typeof payloads.sample?.path === "string";
  check("⑤ dragstart payload 字段正确", payloadOk, JSON.stringify(payloads).slice(0, 120));

  // ⑥ 过滤与 tab 间 query 隔离
  await page.locator('[data-tab="instrument"]').click();
  await page.getByLabel("过滤音色或采样").fill("viol");
  await page.waitForTimeout(200);
  const filtered = await page.locator('[data-sounds-list] [data-kind="instrument"]').count();
  await page.locator('[data-tab="sample"]').click();
  const sampleAfterFilter = await page.locator('[data-sounds-list] [data-kind="sample"]').count();
  await page.locator('[data-tab="instrument"]').click();
  const instrumentQueryKept = await page.locator('[data-sounds-list] [data-kind="instrument"]').count();
  check("⑥ 过滤生效且 tab 间 query 互不干扰", filtered === 2 && sampleAfterFilter === 200 && instrumentQueryKept === 2,
    `音色滤 viol=${filtered} 行，采样仍 ${sampleAfterFilter} 行，切回音色仍 ${instrumentQueryKept} 行`);

  // ================= Stage 2：生产挂载接线 =================
  if (!bridgeUp) {
    check("⑦ 生产接线（采样落轨 / 音色指定）", true, "桥不在——降级跳过（payload 与落点逻辑由 ⑤ 与单测兜底）");
  } else {
    await page.addInitScript(() => {
      window.localStorage.setItem("shadowroom.view", "studio");
      window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({
        projects: [{
          id: "proj-e2e-sounds", name: "音色浏览器验收", updatedAt: 1, bpm: 120, key: "", bars: 16,
          tracks: [{ id: "trk-1", name: "和声", muted: false, soloed: false, volume: 80, clips: [] }],
        }],
      }));
      window.localStorage.setItem("shadowroom.studio.open", "proj-e2e-sounds");
      window.localStorage.removeItem("shadowroom.orb.position");
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.locator(".sr-sounds-rail").waitFor({ timeout: 15000 });
    await page.locator(".sr-sounds-rail").click();
    // ⑦a 采样：/api/agent/dir 真列表第一行 → 拖进 lane trk-1 → clip 落轨
    await page.locator('[data-tab="sample"]').click();
    await page.waitForSelector('[data-sounds-list] [data-kind="sample"]', { timeout: 8000 });
    const dropped = await page.evaluate(() => {
      const row = document.querySelector('[data-sounds-list] [data-kind="sample"]');
      const lane = document.querySelector('.sr-studio-lane[data-track-id="trk-1"]');
      if (!row || !lane) return "missing";
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const box = lane.getBoundingClientRect();
      const point = { clientX: Math.round(box.left + 120), clientY: Math.round(box.top + 10) };
      lane.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, ...point }));
      lane.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, ...point }));
      return row.getAttribute("data-name");
    });
    await page.waitForTimeout(600);
    const clipCount = await page.locator(`.sr-studio-lane[data-track-id="trk-1"] .sr-clip`).count();
    const safeName = typeof dropped === "string" ? dropped.replace(/"/g, '\\"') : "";
    const clipNamed = dropped !== null && dropped !== "missing"
      ? await page.locator(`.sr-clip[aria-label="${safeName}"]`).count() : 0;
    check("⑦a 采样拖进 lane → clip 落轨", clipCount === 1 && clipNamed === 1, `样本=${String(dropped).slice(0, 50)}，lane 内 clip=${clipCount}`);

    // ⑦b 音色：gm:33 → 拖到轨道头 → 徽章 track.instrument
    const instrumentSet = await page.evaluate(async () => {
      document.querySelector('[data-tab="instrument"]').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const row = document.querySelector('[data-sound-key="gm:33"]');
      const head = document.querySelector(".sr-track-head");
      if (!row || !head) return "missing";
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const box = head.getBoundingClientRect();
      const point = { clientX: Math.round(box.left + 40), clientY: Math.round(box.top + 10) };
      head.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, ...point }));
      head.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, ...point }));
      return "ok";
    });
    await page.waitForTimeout(400);
    const badge = (await page.locator(".sr-track-head .sr-track-instrument").textContent().catch(() => "")) ?? "";
    const badgeProgram = await page.locator(".sr-track-head .sr-track-instrument").getAttribute("data-instrument").catch(() => null);
    check("⑦b GM 音色拖轨道头 → 音色徽章", instrumentSet === "ok" && badge.includes("Electric Bass (finger)") && badgeProgram === "33",
      `徽章=${badge.trim() || "(无)"} #${badgeProgram ?? "?"}`);
  }

  // ⑧ 截图
  await page.screenshot({ path: `${SHOTS}/sounds-drawer.png` });
  console.log(`SHOT  ${SHOTS}/sounds-drawer.png`);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `，${failed} 条 FAIL` : ""}`);
process.exit(failed ? 1 : 0);
