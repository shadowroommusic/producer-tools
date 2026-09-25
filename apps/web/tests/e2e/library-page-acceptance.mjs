/**
 * 曲目库页验收（可重复跑）：
 * ① 扫真实小目录（recordings 挑 8 首，软链进 /tmp/sp-lib-accept）→ stats 行数 +8 可对账、UI 行数对得上；
 * ② 筛选逐项生效（搜索 / BPM 区间 / Camelot / tag，行数与桥直查一致）；③ 详情抽屉有数据、cue 只读；
 * ④ 偏好看板有数字（瓦片/摘要/学习行/set 列表）、忘记偏好有二次确认（只验 arm，不真忘——不毁用户模型）；
 * ⑤ cue 写控件 count===0；⑥ 联动口径文案在；⑦ 零 console error。
 *
 * 自带前置清理与收尾清理：开头结尾都删掉 fixture 行（path LIKE '/tmp/sp-lib-accept/%'），
 * 库行数跑前跑后一致——所以「行数增长」每次跑都成立，也不污染 DJ 页。
 * 前置：5173（vite）+ 8787（mcp 桥）在跑。用法：node tests/e2e/library-page-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { execSync } from "node:child_process";
import { mkdirSync, symlinkSync, rmSync, existsSync } from "node:fs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";
const FIXTURE_DIR = "/tmp/sp-lib-accept";
const SHOTS = "/tmp/sp-shots/library-accept";
const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

// ---- 地面真值：桥直查
const call = async (tool, args) => {
  const res = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: "library", tool, arguments: args }),
  });
  const body = await res.json();
  if (body.isError) throw new Error(`${tool}: ${body.result}`);
  return typeof body.result === "string" ? JSON.parse(body.result) : body.result;
};
const cleanFixtureRows = () => {
  const db = execSync(
    `python3 -c "import json,urllib.request;req=urllib.request.Request('${BRIDGE}/api/call',data=json.dumps({'server':'library','tool':'stats','arguments':{}}).encode(),headers={'content-type':'application/json'});print(json.loads(json.load(urllib.request.urlopen(req))['result'])['db_path'])"`,
  ).toString().trim();
  execSync(`python3 -c "import sqlite3;db=sqlite3.connect('${db}');db.execute(\\"DELETE FROM tracks WHERE path LIKE '${FIXTURE_DIR}/%'\\");db.commit()"`);
};

// ---- fixture：recordings 里挑 8 首小 wav，软链成唯一前缀名（搜索断言用）
const SOURCES = [
  "录音 15-25-50.wav", "录音 15-26-58.wav", "录音 15-26-32.wav", "录音 15-27-15.wav",
  "录音 15-26-25.wav", "录音 15-55-18.wav", "录音 15-55-23.wav", "录音 15-27-08.wav",
];
rmSync(FIXTURE_DIR, { recursive: true, force: true });
mkdirSync(FIXTURE_DIR, { recursive: true });
SOURCES.forEach((name, i) => {
  const target = `/Users/lazora/Documents/ShadowRoom/recordings/${name}`;
  if (!existsSync(target)) throw new Error(`fixture 源文件不在：${target}`);
  symlinkSync(target, `${FIXTURE_DIR}/libaccept-0${i + 1}.wav`);
});
cleanFixtureRows();
const statsBefore = await call("stats", {});
const expected = {
  bpm: (await call("list_tracks", { bpm_min: 80, bpm_max: 90, limit: 300 })).tracks.length,
  camelot: (await call("list_tracks", { camelot: "8A", limit: 300 })).tracks.length,
  tag: (await call("list_tracks", { tags: ["house"], limit: 300 })).tracks.length,
};
console.log(`基线：库 ${statsBefore.tracks} 首；bpm80-90=${expected.bpm}、8A=${expected.camelot}、tag house=${expected.tag}`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "library");
});
mkdirSync(SHOTS, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-lib-topbar", { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll(".sr-lib-row").length > 0, null, { timeout: 15000 });
await page.screenshot({ path: `${SHOTS}/01-land.png` });

// ---- ① 扫描：行数增长对账（桥 stats + UI 行数两边对）
await page.locator(".sr-lib-scanpath").fill(FIXTURE_DIR);
await page.getByRole("button", { name: "扫描文件夹", exact: true }).click();
await page.waitForFunction(
  () => document.querySelector(".sr-lib-notice")?.textContent?.includes("新入库 8"),
  null,
  { timeout: 30000 },
);
const notice1 = await page.locator(".sr-lib-notice").textContent();
const statsAfter = await call("stats", {});
await page.waitForFunction(
  (want) => document.querySelectorAll(".sr-lib-row").length === want,
  statsAfter.tracks,
  { timeout: 15000 },
);
const uiRowsAfterScan = await page.locator(".sr-lib-row").count();
check(
  "① 扫描 8 首：stats 行数 +8、UI 行数 == stats",
  statsAfter.tracks === statsBefore.tracks + 8 && uiRowsAfterScan === statsAfter.tracks,
  `stats ${statsBefore.tracks}→${statsAfter.tracks}，UI ${uiRowsAfterScan} 行；notice：${notice1.trim()}`,
);
await page.screenshot({ path: `${SHOTS}/02-scanned.png` });

// ---- ② 筛选逐项（行数与桥直查一致）
const rowsNow = () => page.locator(".sr-lib-row").count();
await page.locator('.sr-lib-filters input[aria-label="搜索标题、艺人、专辑"]').fill("libaccept");
await page.waitForFunction(() => document.querySelectorAll(".sr-lib-row").length === 8, null, { timeout: 10000 });
const searchCount = await rowsNow();
await page.screenshot({ path: `${SHOTS}/03-filter-search.png` });
await page.locator('.sr-lib-filters input[aria-label="搜索标题、艺人、专辑"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="BPM 下限"]').fill("80");
await page.locator('.sr-lib-filters input[aria-label="BPM 上限"]').fill("90");
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, expected.bpm, { timeout: 10000 });
const bpmCount = await rowsNow();
await page.locator('.sr-lib-filters input[aria-label="BPM 下限"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="BPM 上限"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="Camelot 调性代码"]').fill("8a");
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, expected.camelot, { timeout: 10000 });
const camelotCount = await rowsNow();
await page.locator('.sr-lib-filters input[aria-label="Camelot 调性代码"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="genre tag"]').fill("house");
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, expected.tag, { timeout: 10000 });
const tagCount = await rowsNow();
await page.getByRole("button", { name: "清除筛选", exact: true }).click();
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, statsAfter.tracks, { timeout: 10000 });
check(
  "② 搜索/BPM/Camelot/tag 逐项生效且与桥直查一致",
  searchCount === 8 && bpmCount === expected.bpm && camelotCount === expected.camelot && tagCount === expected.tag,
  `搜索 libaccept=${searchCount}/8 · BPM80-90=${bpmCount}/${expected.bpm} · 8a=${camelotCount}/${expected.camelot} · house=${tagCount}/${expected.tag}`,
);

// ---- ③ 详情抽屉：fixture 行点进去有数据，cue 只读
await page.locator('.sr-lib-filters input[aria-label="搜索标题、艺人、专辑"]').fill("libaccept");
await page.waitForFunction(() => document.querySelectorAll(".sr-lib-row").length === 8, null, { timeout: 10000 });
await page.locator(".sr-lib-row").first().click();
await page.waitForSelector(".sr-lib-drawer .sr-lib-cues", { timeout: 10000 });
const drawerText = await page.locator(".sr-lib-drawer").textContent();
const drawerHas =
  drawerText.includes("libaccept-01") &&
  drawerText.includes("时长") &&
  drawerText.includes("缺 BPM") &&
  drawerText.includes("缺 调性") &&
  drawerText.includes("这首还没有 cue") &&
  drawerText.includes("在 DJ 页编辑");
await page.screenshot({ path: `${SHOTS}/04-drawer.png` });
check("③ 详情抽屉有元信息/缺口/cue 只读块", drawerHas, `标题/时长/缺口徽标/cue 来源句/只读说明 ${drawerHas ? "齐" : "缺"}`);

// ---- ⑤ cue 写控件 count===0
const cueWriteControls = await page.locator(".sr-lib-cues").locator("button, input, select, textarea, [contenteditable='true']").count();
const colorInputs = await page.locator(".sr-lib").locator("input[type='color']").count();
check("⑤ cue 写控件 count===0", cueWriteControls === 0 && colorInputs === 0, `.sr-lib-cues 内交互控件=${cueWriteControls}，页面 color input=${colorInputs}`);

// ---- Esc 关抽屉
await page.keyboard.press("Escape");
await page.waitForFunction(() => document.querySelector(".sr-lib-drawer") === null, null, { timeout: 5000 });

// ---- ④ 偏好看板：数字 + 学习 + 忘记二次确认（只验 arm 不真忘）
await page.locator('.sr-lib-filters input[aria-label="搜索标题、艺人、专辑"]').fill("");
await page.getByRole("button", { name: "统计与偏好", exact: true }).click();
await page.waitForSelector(".sr-lib-board", { timeout: 5000 });
await page.waitForFunction(() => document.querySelector(".sr-lib-pref-summary")?.textContent?.length > 10, null, { timeout: 10000 });
const tileText = await page.locator(".sr-lib-tiles").textContent();
const prefText = await page.locator(".sr-lib-pref-summary").textContent();
await page.getByRole("button", { name: "重新学习", exact: true }).click();
await page.waitForSelector(".sr-lib-pref-rows li", { timeout: 15000 });
const learnText = await page.locator(".sr-lib-pref-rows").textContent();
const setRows = await page.locator(".sr-lib-set-row").count();
await page.screenshot({ path: `${SHOTS}/05-board.png` });
check(
  "④ 看板数字齐：瓦片/摘要/学习行/set 列表",
  tileText.includes(String(statsAfter.tracks)) && prefText.length > 10 && learnText.includes("样本") && setRows >= 1,
  `瓦片含 ${statsAfter.tracks}=${tileText.includes(String(statsAfter.tracks))} · 摘要 ${prefText.trim().slice(0, 30)}… · 学习行「${learnText.trim().split("\n")[0]}」 · set ${setRows} 行`,
);
await page.getByRole("button", { name: "忘记偏好", exact: true }).click();
const armedText = await page.locator(".sr-lib-forget").textContent();
const armed = armedText.includes("再点一次确认忘记");
await page.waitForTimeout(5300);
const disarmedText = await page.locator(".sr-lib-forget").textContent();
check("④b 忘记偏好两次点击确认（不真忘）", armed && disarmedText.includes("忘记偏好"), `第一次点击→「${armedText.trim()}」，5 秒后回「${disarmedText.trim()}」`);

// ---- ⑥ 联动口径
const linkage = await page.locator(".sr-lib-linkage").textContent();
check("⑥ 联动口径文案在页面上", linkage.includes("推荐与排歌在 DJ 页") && linkage.includes("入库 / 可查 / 可学"), linkage.trim());

// ---- ⑦ 零 console error
check("⑦ 零 console error", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(" | ").slice(0, 200) : "clean");

await browser.close();
cleanFixtureRows();
const statsEnd = await call("stats", {});
console.log(`收尾：fixture 行已清，库 ${statsEnd.tracks} 首（跑前 ${statsBefore.tracks}）`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
