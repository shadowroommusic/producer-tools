/**
 * Bitwig 刀2-C 的「App 侧接线」端到端验收（Codex 接线，可重复跑）：
 * ① 未开放工程/无 clip 时事件不落字段（这里用真实通道，不测负例——负例由 StudioPage 的宽容校验兜）
 * ② 往 agent 桥（8788）POST 一条 `clip_modulate` 媒体事件 → App 吸收器 dispatch →
 *    StudioPage 写入 gainLfo（bpm 240 → 1bar = 1.00 Hz），片段右键菜单长出「泵感」条目
 * ③ localStorage 工程里 gainLfo 字段真实出现（写入不是只在菜单里）
 * ④ 截图留存 exports/clip-modulate-wire/
 *
 * 与 gain-lfo-acceptance.mjs 的分工：那条测 StudioPage 的接收器（直接 dispatch 事件），
 * 这条测 **桥 → App 吸收器 → 事件** 的完整链路——中间任何一跳断了这里就红。
 *
 * 前置：5173 dev server + 8788 agent 桥。用法：node tests/e2e/clip-modulate-wire-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = process.env.CLIPMOD_E2E_BASE ?? "http://localhost:5173";
const BRIDGE = process.env.CLIPMOD_E2E_BRIDGE ?? "http://127.0.0.1:8788";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/clip-modulate-wire";

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const listening = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return probe.stdout.trim() !== "";
};
if (!listening(5173) || !listening(8788)) {
  console.log(`FAIL  环境 — 5173/8788 未同时监听（5173=${listening(5173)} 8788=${listening(8788)}）`);
  process.exit(1);
}

const seed = {
  id: "proj-wire-e2e",
  name: "接线验收",
  updatedAt: 1,
  bpm: 240, // 1 bar = 1.00 Hz：期望值直接可读
  key: "",
  bars: 16,
  tracks: [
    {
      id: "trk-wire",
      name: "贝斯",
      muted: false,
      soloed: false,
      volume: 80,
      clips: [{ id: "clip-wire-b", name: "干净贝斯", start: 0, length: 2, source: "" }],
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
try {
  await page.addInitScript((project) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [project] }));
    window.localStorage.setItem("shadowroom.studio.open", project.id);
    window.localStorage.removeItem("shadowroom.orb.position");
  }, seed);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(".sr-clip").first().waitFor({ timeout: 15000 });

  // 首轮媒体轮询会把游标对齐到「此刻」——历史事件全部跳过。等对齐发生后再发事件。
  await page.waitForTimeout(4000);
  const posted = await fetch(`${BRIDGE}/api/agent/media-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      server: "shadow-music-generator",
      tool: "clip_modulate",
      ok: true,
      text: JSON.stringify({ clip_id: "clip-wire-b", rate: "1bar", depth: 0.7 }),
      args: { clip_id: "clip-wire-b", rate: "1bar", depth: 0.7 },
    }),
  }).then((response) => response.json());
  check("① 媒体事件进桥", typeof posted?.id === "number", `id=${posted?.id ?? "?"}`);

  // 轮询周期 2.5s（有回合时）/8s（空闲）——给足两轮。
  const row = page.locator('[data-modulation="gain_lfo"]');
  let seen = false;
  let rowText = "";
  for (let attempt = 0; attempt < 12 && !seen; attempt += 1) {
    const clip = page.locator(".sr-clip", { hasText: "干净贝斯" }).first();
    await clip.click({ button: "right" });
    await page.locator(".sr-clip-menu").waitFor({ timeout: 5000 });
    if ((await row.count()) === 1) {
      seen = true;
      rowText = (await row.innerText()).replace(/\n/g, " ");
      break;
    }
    await page.locator(".sr-menu-backdrop").last().dispatchEvent("pointerdown");
    await page.waitForTimeout(1200);
  }
  check("② 桥事件 → 吸收器 → 片段长出泵感条目（1bar@240bpm=1.00Hz×0.7）",
    seen && rowText.includes("1.00") && rowText.includes("0.7"), rowText || "条目一直没出现");

  const stored = await page.evaluate(() => {
    const raw = window.localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}";
    const parsed = JSON.parse(raw);
    const clip = parsed.projects?.[0]?.tracks?.[0]?.clips?.find((entry) => entry.id === "clip-wire-b");
    return clip?.gainLfo ?? null;
  });
  check("③ localStorage 里 gainLfo 字段真实落盘", stored !== null && Math.abs(stored.rateHz - 1) < 0.001,
    JSON.stringify(stored));

  await page.screenshot({ path: `${SHOTS}/clip-modulate-wire.png` });
  check("④ 截图留存", true, `${SHOTS}/clip-modulate-wire.png`);
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
