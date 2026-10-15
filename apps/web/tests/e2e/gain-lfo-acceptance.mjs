/**
 * #bitwig-adoption 刀2-C（泵感调制）端到端验收（PASS/FAIL 逐条打印，可重复跑）：
 * ① clip 检视器（右键菜单）列出 gain_lfo 调制条目（只读：rate Hz × depth）
 * ② agent updater 路径：`shadowroom:clip-modulate` 事件 → 干净 clip 长出条目（bpm 240 → 1bar = 1.00 Hz）
 * ③ 删除按钮 → 条目消失且 localStorage 工程里 gainLfo 字段真没了
 * ④ 导出 spec 带 gain_lfo（路由拦截 /api/call 抓请求体断言，桥不在也能跑）
 * ⑤ 截图留存 exports/gain-lfo-e2e/
 *
 * 前置：5173 dev server（GAINLFO_E2E_BASE 可覆写）。用法：node tests/e2e/gain-lfo-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.GAINLFO_E2E_BASE ?? "http://localhost:5173";
const REPO = "/Users/lazora/Documents/ShadowRoom";
const SHOTS = `${REPO}/exports/gain-lfo-e2e`;

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
if (portFree(5173) && !process.env.GAINLFO_E2E_BASE) {
  console.log("FAIL  环境 — 5173 dev server 不在（先起 dev server）");
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
const tmp = mkdtempSync(join(tmpdir(), "gainlfo-e2e-"));
const LOOP = join(tmp, "loop.wav");
writeFileSync(LOOP, wav(1));

const seed = {
  id: "proj-e2e-gainlfo",
  name: "泵感验收",
  updatedAt: 1,
  bpm: 240, // 1bar = 1Hz：事件换算的期望值直接可读
  key: "",
  bars: 16,
  tracks: [
    {
      id: "trk-1", name: "和声", muted: false, soloed: false, volume: 80,
      clips: [
        { id: "clip-a", name: "带泵感", start: 0, length: 2, source: LOOP,
          gainLfo: { rateHz: 0.5, depth: 0.7 } },
        { id: "clip-b", name: "干净", start: 4, length: 2, source: LOOP },
      ],
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("console", (message) => {
  if (message.type() === "error") console.log(`  [console.error] ${message.text().slice(0, 160)}`);
});
let exportBodies = [];
await page.route("**/api/call", async (route) => {
  exportBodies.push(route.request().postDataJSON());
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: "\"ok\"" }) });
});
try {
  await page.addInitScript((project) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
    window.localStorage.setItem("shadowroom.studio.open", project.id);
    window.localStorage.removeItem("shadowroom.orb.position");
  }, seed);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator(".sr-clip").first().waitFor({ timeout: 15000 });

  const clip = (name) => page.locator(".sr-clip", { hasText: name }).first();
  const closeMenu = async () => {
    if ((await page.locator(".sr-menu-backdrop").count()) > 0) {
      await page.locator(".sr-menu-backdrop").last().dispatchEvent("pointerdown");
      await page.waitForTimeout(150);
    }
  };
  const openMenu = async (name) => {
    await closeMenu();
    await clip(name).click({ button: "right" });
    await page.locator(".sr-clip-menu").waitFor({ timeout: 5000 });
  };
  const modulationRow = page.locator('[data-modulation="gain_lfo"]');

  // ① 带泵感的 clip：菜单列出条目（只读文本）
  await openMenu("带泵感");
  check("① 检视器列出调制条目（只读）", await modulationRow.count() === 1,
    await modulationRow.count() === 1 ? (await modulationRow.innerText()).replace(/\n/g, " ") : "条目缺失");
  await closeMenu();

  // ② agent updater 事件 → 干净 clip 长出条目（1bar @240bpm = 1.00 Hz）
  await openMenu("干净");
  check("②a 干净 clip 初始无条目", await modulationRow.count() === 0, "菜单无调制条目");
  await closeMenu();
  await page.evaluate((clipId) => {
    window.dispatchEvent(new CustomEvent("shadowroom:clip-modulate", { detail: { clipId, rate: "1bar", depth: 0.7 } }));
  }, "clip-b");
  await page.waitForTimeout(300);
  await openMenu("干净");
  const rowText = (await modulationRow.count()) === 1 ? await modulationRow.innerText() : "";
  check("②b 事件写入后长出条目（1bar@240bpm=1.00Hz×0.7）",
    await modulationRow.count() === 1 && rowText.includes("1.00") && rowText.includes("0.7"),
    rowText.replace(/\n/g, " ") || "条目缺失");

  // ③ 删除 → 条目消失 + 工程字段真没了
  await page.locator('[aria-label="删除泵感"]').click();
  await page.waitForTimeout(300);
  await openMenu("干净");
  const gone = (await modulationRow.count()) === 0;
  const stored = await page.evaluate(() => {
    const data = JSON.parse(window.localStorage.getItem("shadowroom.studio.projects.v1"));
    const b = data.projects[0].tracks[0].clips.find((c) => c.id === "clip-b");
    return b.gainLfo === undefined;
  });
  check("③ 删除生效（条目消失 + localStorage 字段删除）", gone && stored, `menu gone=${gone}, stored clean=${stored}`);
  await closeMenu();

  // ④ 导出 spec 带 gain_lfo（clip-a 有、clip-b 已删无）——「导出音频」开面板，面板内「导出」提交
  await closeMenu();
  await page.waitForTimeout(300);
  await page.locator("button.sr-studio-export").click();
  await page.locator(".sr-studio-export-bar").waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  const submit = page.locator(".sr-studio-export-bar button").filter({ hasText: "导出" }).last();
  await submit.click();
  await page.waitForTimeout(1000);
  const mixCall = exportBodies.map((body) => body).reverse()
    .find((body) => body?.server === "generator" && JSON.stringify(body?.arguments ?? {}).includes("tracks"));
  let specOk = false;
  let specDetail = `没抓到导出调用（捕获：${exportBodies.map((b) => `${b?.server}.${b?.tool}`).join(", ") || "无"}）`;
  if (mixCall) {
    const clips = mixCall.arguments.tracks.flatMap((track) => track.clips.map((c) => ({ path: c.path, gain_lfo: c.gain_lfo })));
    const a = clips.find((c) => c.path.includes("loop.wav") && c.gain_lfo !== undefined);
    const bCount = clips.filter((c) => c.gain_lfo !== undefined).length;
    specOk = a !== undefined && a.gain_lfo.rateHz === 0.5 && a.gain_lfo.depth === 0.7 && bCount === 1;
    specDetail = JSON.stringify(clips);
  }
  check("④ 导出 spec 带 gain_lfo（只有未删的那条）", specOk, specDetail);

  await page.screenshot({ path: `${SHOTS}/gain-lfo-studio.png` });
  check("⑤ 截图留存", true, `${SHOTS}/gain-lfo-studio.png`);
} catch (error) {
  check("脚本异常", false, String(error));
} finally {
  await browser.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
