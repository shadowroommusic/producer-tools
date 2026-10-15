/**
 * #bitwig-adoption 刀3-D 阶段一（音色/采样浏览器，未挂载 StudioPage）端到端验收：
 * 借 5173 dev server 的模块编译，把 StudioSoundsDrawer 隔离渲染到独立宿主 div（不碰主应用）——
 * ① 音色 tab 首挂 128 行、首帧 ≤16ms（flushSync commit + 双 rAF，实测打印）
 * ② 切采样 tab 200 行、帧 ≤16ms（实测打印）
 * ③ 点音色 → __soundsProbe ≤100ms 且行标 data-playing（合成器短琶音）
 * ④ 点采样 → __soundsProbe ≤100ms；桥在则行标 data-playing 硬断（桥不在降级注明）
 * ⑤ dragstart payload：音色/采样两行 SOUND_MIME 内容 decode 后字段正确
 * ⑥ 过滤：音色滤 "viol" 剩 2 行；切 tab query 互不干扰
 * ⑦ 截图留存 exports/sounds-e2e/sounds-drawer.png
 *
 * 前置：5173 dev server（SOUNDS_E2E_BASE 可覆写）；8787 桥不强制（影响 ④ 的断言强度）。
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

mkdirSync(SHOTS, { recursive: true });
const portFree = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return !probe.stdout.trim();
};
if (portFree(5173) && !process.env.SOUNDS_E2E_BASE) {
  console.log("FAIL  环境 — 5173 dev server 不在（先 pnpm dev）");
  process.exit(1);
}
// 真 WAV（440Hz 正弦 3 秒）：桥在时采样试听真出声
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
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // 隔离渲染：借 dev server 编译组件，挂到独立宿主（不动主应用）。200 个采样 fixture，
  // 第一个指向真 WAV（桥在时能播），其余是假路径（不点它们）。
  const mount = await page.evaluate(async (loopPath) => {
    try {
      const [reactMod, domMod, flushMod, drawerMod] = await Promise.all([
        import("/node_modules/.vite/deps/react.js"),
        import("/node_modules/.vite/deps/react-dom_client.js"),
        // flushSync 住在 react-dom（不是 react-dom/client）——原脚本从 client 解构，必然 undefined。
        import("/node_modules/.vite/deps/react-dom.js"),
        import("/src/components/StudioSoundsDrawer.tsx"),
      ]);
      const React = reactMod.default;
      // Vite 的 dep 预打包把 react-dom/client 的命名导出收进 default（实测 createRoot 不在顶层，
      // 顶层解构会得到 undefined → "createRoot is not a function"）。两形状都兜住。
      const { createRoot } = typeof domMod.createRoot === "function" ? domMod : domMod.default;
      const flushSync = flushMod.flushSync ?? flushMod.default?.flushSync;
      const host = document.createElement("div");
      host.id = "sounds-e2e-host";
      document.body.appendChild(host);
      const imports = Array.from({ length: 200 }, (_, i) => ({
        path: i === 0 ? loopPath : `/tmp/sr-sounds-e2e/fake-${i}.wav`,
        name: `sample-${String(i).padStart(3, "0")}.wav`,
      }));
      const root = createRoot(host);
      const t0 = performance.now();
      flushSync(() => root.render(React.createElement(drawerMod.StudioSoundsDrawer, { imports })));
      void host.offsetHeight; // 强制排版：首帧口径 = React commit + layout
      const commitMs = performance.now() - t0;
      window.__soundsE2E = { root, React, commitMs };
      return { ok: true, commitMs };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 200) };
    }
  }, LOOP);
  if (!mount.ok) {
    check("① 隔离渲染挂载", false, mount.error ?? "unknown");
    throw new Error("mount failed");
  }
  await page.waitForSelector("[data-sounds-list] [data-sound-key]", { timeout: 10000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const firstFrameMs = await page.evaluate(() => window.__soundsE2E.commitMs);
  const gmRows = await page.locator('[data-sounds-list] [data-kind="instrument"]').count();
  check("① 音色 tab 首挂 128 行、首帧 ≤16ms", gmRows === 128 && firstFrameMs <= 16, `行数 ${gmRows}，commit ${Math.round(firstFrameMs * 10) / 10}ms`);

  // ② 切采样 tab（200 行）帧耗时
  const tabFrameMs = await page.evaluate(() => new Promise((resolve) => {
    const tab = document.querySelector('[data-tab="sample"]');
    const t0 = performance.now();
    tab.click();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
  }));
  const sampleRows = await page.locator('[data-sounds-list] [data-kind="sample"]').count();
  check("② 切采样 tab 200 行、帧 ≤16ms", sampleRows === 200 && tabFrameMs <= 16, `行数 ${sampleRows}，帧 ${Math.round(tabFrameMs * 10) / 10}ms`);

  // ③ 音色试听打点（切回音色 tab 点 Violin）
  await page.locator('[data-tab="instrument"]').click();
  await page.locator('[data-sound-key="gm:40"]').click();
  await page.waitForSelector('[data-sound-key="gm:40"][data-playing]', { timeout: 2000 });
  const gmProbe = await page.evaluate(() => window.__soundsProbe?.lastAuditionMs ?? null);
  check("③ 点音色 → 出声 ≤100ms", gmProbe !== null && gmProbe <= 100, `实测 ${gmProbe === null ? "探针没写到" : `${Math.round(gmProbe * 100) / 100}ms`}（合成器短琶音）`);

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
    `实测 ${sampleProbe === null ? "探针没写到" : `${Math.round(sampleProbe * 100) / 100}ms`}${bridgeUp ? `，playing=${samplePlaying}` : "（桥不在，出声断言降级：仅打点+换 src）"}`);

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

  await page.screenshot({ path: `${SHOTS}/sounds-drawer.png` });
  console.log(`SHOT  ${SHOTS}/sounds-drawer.png`);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `，${failed} 条 FAIL` : ""}`);
process.exit(failed ? 1 : 0);
