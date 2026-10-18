// Studio 全路径自检：像用户一样走一遍 建工程 → 导入 → 播放 → 拖动/裁剪 → 右键（淡入淡出/
// 渐强/转 MIDI/生成钢琴轨/分轨）→ 钢琴卷帘 → 录音 → 导出（整首 + 分轨）。每步截图 + 输出
// 数字；发现会抱怨的点记到最后的「抱怨清单」，不在这里静默吞掉。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const OUT = process.argv[2] ?? "/Users/lazora/Documents/ShadowRoom/exports/studio-walk-20260925";
const WAV = "/Users/lazora/Documents/ShadowRoom/recordings/deep-house-128.wav";
mkdirSync(OUT, { recursive: true });

const errs = [];
const complaints = [];
const note = (step, text) => { console.log(`[${step}] ${text}`); };
const gripe = (step, text) => { complaints.push(`${step}：${text}`); console.log(`[${step}] ⚠ 抱怨点：${text}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "studio");
  window.localStorage.removeItem("shadowroom.studio.projects.v1");
  window.localStorage.removeItem("shadowroom.orb.position");
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await sleep(1500);
await page.screenshot({ path: `${OUT}/01-land.png` });

// ── 1 建工程 ────────────────────────────────────────────────
try {
  await page.getByText("新建工程").first().click({ timeout: 8000 });
  await sleep(2000);
  const empty = await page.locator(".sr-studio-hero").count();
  note("建工程", `空态引导可见 = ${empty > 0}`);
  if (empty === 0) gripe("建工程", "新工程没有 0 轨空态引导");
  await page.screenshot({ path: `${OUT}/02-new-project.png` });
} catch (e) { gripe("建工程", e.message.split("\n")[0]); }

// ── 2 导入 ──────────────────────────────────────────────────
try {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(WAV, { timeout: 20000 });
  await sleep(6000);
  const tracks = await page.locator(".sr-track-head").count();
  const clips = await page.locator(".sr-clip").count();
  note("导入", `轨道数 = ${tracks}，片段数 = ${clips}`);
  if (tracks !== 1 || clips !== 1) gripe("导入", `期望 1 轨 1 片段，实际 ${tracks}/${clips}`);
  await page.screenshot({ path: `${OUT}/03-imported.png` });
} catch (e) { gripe("导入", e.message.split("\n")[0]); }

// ── 3 播放 / 停止 ───────────────────────────────────────────
try {
  await page.getByRole("button", { name: "播放" }).first().click({ timeout: 5000 });
  await sleep(3000);
  await page.screenshot({ path: `${OUT}/04-playing.png` });
  const transport = await page.locator(".sr-studio-transport").first().innerText();
  note("播放", `走带 = ${JSON.stringify(transport.replace(/\n+/g, " ").slice(0, 90))}`);
  await page.locator('button[aria-label="停止"]').first().click({ timeout: 5000 });
  await sleep(500);
} catch (e) { gripe("播放", e.message.split("\n")[0]); }

// ── 4 拖动 + 边缘裁剪 ───────────────────────────────────────
const clipBox = async () => page.locator(".sr-clip").first().boundingBox();
try {
  const before = await clipBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 140, before.y + before.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(600);
  const after = await clipBox();
  const moved = Math.round(after.x - before.x);
  note("拖动", `片段位移 = ${moved}px`);
  if (Math.abs(moved) < 20) gripe("拖动", `拖动后片段几乎没动（${moved}px）`);
  // 右边缘裁剪（坐标竞态 flake 见过一次：手柄 box 拿到的是拖动前的旧坐标 → 重试一次）
  const edge = page.locator(".sr-clip-resize").first();
  const wBefore = (await clipBox()).width;
  const trimOnce = async () => {
    await edge.scrollIntoViewIfNeeded(); // 时间线可横滚后，手柄可能滚出视口
    const ebox = await edge.boundingBox();
    await page.mouse.move(ebox.x + ebox.width / 2, ebox.y + ebox.height / 2);
    await page.mouse.down();
    await page.mouse.move(ebox.x + ebox.width / 2 - 60, ebox.y + ebox.height / 2, { steps: 10 });
    await page.mouse.up();
    await sleep(600);
    return (await clipBox()).width;
  };
  let wAfter = await trimOnce();
  if (Math.abs(wAfter - wBefore) < 8) wAfter = await trimOnce();
  note("裁剪", `片段宽度 ${Math.round(wBefore)} → ${Math.round(wAfter)}px`);
  if (Math.abs(wAfter - wBefore) < 8) gripe("裁剪", "右边缘拖动没有改变片段长度");
  await page.screenshot({ path: `${OUT}/05-moved-trimmed.png` });
} catch (e) { gripe("拖动/裁剪", e.message.split("\n")[0]); }

// ── 5 右键：淡入淡出 + 渐强 ─────────────────────────────────
const menuDo = async (label) => {
  await page.locator(".sr-clip").first().click({ button: "right" });
  await sleep(400);
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: label }).first().click();
  await sleep(500);
};
try {
  await menuDo("淡入 0.5s");
  await menuDo("淡出 0.5s");
  await menuDo("渐强（0→1）");
  await page.screenshot({ path: `${OUT}/06-fades-ramp.png` });
  const meta = await page.locator(".sr-clip-meta").first().innerText();
  note("右键淡入/淡出/渐强", `片段注记 = ${JSON.stringify(meta)}`);
  const fadeMarks = await page.locator(".sr-clip-fade").count();
  const rampMark = await page.locator(".sr-clip-ramp").count();
  if (fadeMarks < 2) gripe("淡入淡出", `淡入淡出可视标记只有 ${fadeMarks} 个`);
  if (rampMark < 1) gripe("渐强", "渐强设置后片段上没有可视标记");
} catch (e) { gripe("右键菜单(淡入/渐强)", e.message.split("\n")[0]); }

// ── 6 在播放头分割 ──────────────────────────────────────────
try {
  const ruler = page.locator(".sr-studio-ruler").first();
  const lbox = await ruler.boundingBox();
  await page.mouse.click(lbox.x + 200, lbox.y + lbox.height / 2); // 标尺点一下 → 播放头落位
  await sleep(400);
  await menuDo("在播放头分割");
  await sleep(500);
  const clips = await page.locator(".sr-clip").count();
  note("分割", `分割后片段数 = ${clips}`);
  if (clips < 2) gripe("分割", "在播放头分割后片段数没变多");
  await page.screenshot({ path: `${OUT}/07-split.png` });
} catch (e) { gripe("分割", e.message.split("\n")[0]); }

// ── 7 转 MIDI → 生成钢琴轨 → 钢琴卷帘 ───────────────────────
/** 页面上可见的提示语（say 落到会话区）——失败原因从里面捞，不猜。 */
const sayText = async () => {
  const body = await page.evaluate(() => document.body.innerText);
  const lines = body.split("\n").filter((line) => line.includes("生成") || line.includes("没生成") || line.includes("分轨"));
  return lines.slice(0, 4).join(" | ");
};
try {
  await menuDo("转 MIDI");
  let midi = 0;
  for (let i = 0; i < 40 && midi === 0; i += 1) {
    await sleep(1000);
    midi = await page.locator(".sr-clip", { hasText: "· MIDI" }).count();
  }
  note("转 MIDI", `MIDI 片段出现 = ${midi > 0}`);
  if (midi === 0) gripe("转 MIDI", `40s 内没有出现 MIDI 片段；页面提示：${await sayText()}`);
  await page.screenshot({ path: `${OUT}/08-midi.png` });
} catch (e) { gripe("转 MIDI", e.message.split("\n")[0]); }
try {
  // 对 MIDI 片段右键 → 用这段生成钢琴轨
  const midiClip = page.locator(".sr-clip", { hasText: "· MIDI" }).first();
  await midiClip.scrollIntoViewIfNeeded();
  await midiClip.click({ button: "right" });
  await sleep(400);
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: "用这段生成" }).first().click();
  // 轨道名渲染在 input.sr-track-name 的 value 里，hasText 匹配不到 → 读 value；
  // 生成的钢琴轨上还会落「钢琴 · …」片段，两个信号任一成立即算成功。
  const pianoSeen = async () => {
    const names = await page.locator("input.sr-track-name").evaluateAll((els) => els.map((el) => el.value));
    return (names.some((name) => name.includes("钢琴")) ? 1 : 0)
      + (await page.locator(".sr-clip", { hasText: "钢琴 ·" }).count() > 0 ? 1 : 0);
  };
  let piano = 0;
  for (let i = 0; i < 90 && piano === 0; i += 1) {
    await sleep(1000);
    piano = await pianoSeen();
  }
  note("生成钢琴轨", `钢琴轨出现 = ${piano > 0}`);
  if (piano === 0) gripe("生成钢琴轨", `90s 内没有出现钢琴轨；页面提示：${await sayText()}`);
  await page.screenshot({ path: `${OUT}/09-piano-track.png` });
} catch (e) { gripe("生成钢琴轨", e.message.split("\n")[0]); }
try {
  // 钢琴卷帘：右键 MIDI 片段 → 编辑音符
  const midiClip = page.locator(".sr-clip", { hasText: "· MIDI" }).first();
  await midiClip.click({ button: "right" });
  await sleep(400);
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: "编辑音符" }).first().click();
  await sleep(1200);
  const roll = await page.locator(".sr-roll, [class*=roll]").count();
  note("钢琴卷帘", `卷帘元素数 = ${roll}`);
  if (roll === 0) gripe("钢琴卷帘", "编辑音符后卷帘没打开");
  await page.screenshot({ path: `${OUT}/10-piano-roll.png` });
  await page.keyboard.press("Escape");
  await sleep(500);
} catch (e) { gripe("钢琴卷帘", e.message.split("\n")[0]); }

// ── 8 录音（假麦克风）───────────────────────────────────────
try {
  // 录音落点：优先落进当前选中的 audio 轨（不新建轨也正确）→ 断言片段数增加，而不是轨道数。
  const clipsBefore = await page.locator(".sr-clip").count();
  await page.getByText("录音", { exact: true }).first().click({ timeout: 5000 });
  await sleep(3000);
  await page.screenshot({ path: `${OUT}/11-recording.png` });
  await page.locator(".sr-studio-record").click({ timeout: 5000 });
  await sleep(4000);
  const clipsAfter = await page.locator(".sr-clip").count();
  note("录音", `录音后片段数 ${clipsBefore} → ${clipsAfter}`);
  if (clipsAfter <= clipsBefore) gripe("录音", "录完没有落下新片段");
  await page.screenshot({ path: `${OUT}/12-recorded.png` });
} catch (e) { gripe("录音", e.message.split("\n")[0]); }

// ── 9 导出整首（WAV）────────────────────────────────────────
try {
  await page.getByText("导出音频", { exact: true }).first().click({ timeout: 5000 });
  await sleep(800);
  const pathInput = page.locator('input[aria-label="输出路径"]');
  const out = `${OUT}/mix.wav`;
  await pathInput.fill(out);
  await page.locator(".sr-studio-export-bar .sr-btn--accent").click();
  let done = false;
  for (let i = 0; i < 60 && !done; i += 1) {
    await sleep(1000);
    done = (await page.locator(".sr-studio-exported").count()) > 0;
  }
  const written = done ? await page.locator(".sr-studio-exported").first().innerText() : "（超时无回执）";
  note("导出整首", `界面回执 = ${written}`);
  if (!done) gripe("导出整首", "60s 内界面没有「已写入」回执");
  await page.screenshot({ path: `${OUT}/13-exported.png` });
  const size = execFileSync("stat", ["-f", "%z", out]).toString().trim();
  note("导出整首", `${out} 落盘 ${size} 字节`);
} catch (e) { gripe("导出整首", e.message.split("\n")[0]); }

// ── 10 导出分轨 ─────────────────────────────────────────────
try {
  await page.locator('select[aria-label="导出内容"]').selectOption("stems");
  await sleep(400);
  const dirInput = page.locator('input[aria-label="输出目录"]');
  await dirInput.fill(`${OUT}/stems`);
  await page.locator(".sr-studio-export-bar .sr-btn--accent").click();
  let done = false;
  for (let i = 0; i < 90 && !done; i += 1) {
    await sleep(1000);
    done = (await page.locator(".sr-studio-exported").count()) > 0;
  }
  const written = done ? await page.locator(".sr-studio-exported").first().innerText() : "（超时无回执）";
  note("导出分轨", `界面回执 = ${written}`);
  if (!done) gripe("导出分轨", "90s 内界面没有「已写入」回执");
  await page.screenshot({ path: `${OUT}/14-stems-exported.png` });
  const files = execFileSync("sh", ["-c", `ls ${OUT}/stems 2>/dev/null | wc -l`]).toString().trim();
  note("导出分轨", `${OUT}/stems 下文件数 = ${files}`);
} catch (e) { gripe("导出分轨", e.message.split("\n")[0]); }

// ── 11 单片段分轨（stem-splitter，尽力而为）─────────────────
try {
  // 步骤 9/10 把导出条开着——用户做完导出会把它收起来，脚本也一样，免得它挤占时间线视口。
  if ((await page.locator(".sr-studio-export-bar").count()) > 0) {
    await page.getByText("导出音频", { exact: true }).first().click();
    await sleep(400);
  }
  const audioClip = page.locator(".sr-clip").first();
  await audioClip.scrollIntoViewIfNeeded();
  try {
    await audioClip.click({ button: "right", timeout: 10000 });
  } catch (clickErr) {
    // 被遮挡时记录是谁挡的（intercepts pointer events 行），再 force 兜底，不让一步 flake 吞掉整段。
    gripe("单片段分轨", `右键被挡：${clickErr.message.split("\n").filter((l) => l.includes("intercepts") || l.includes("<")).slice(0, 3).join(" / ")}`);
    await audioClip.click({ button: "right", force: true });
  }
  await sleep(400);
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: "分轨（" }).first().click();
  const headsBefore = await page.locator(".sr-track-head").count();
  let doneBadge = 0;
  for (let i = 0; i < 240 && doneBadge === 0; i += 1) {
    await sleep(1000);
    doneBadge = await page.locator(".sr-clip-badge--stems").count();
    if (i === 60 || i === 120) await page.screenshot({ path: `${OUT}/15-splitting-${i}s.png` });
  }
  const headsAfter = await page.locator(".sr-track-head").count();
  note("单片段分轨", `「已分轨」徽标 = ${doneBadge > 0}，轨道数 ${headsBefore} → ${headsAfter}`);
  if (doneBadge === 0) gripe("单片段分轨", `240s 内没有「已分轨」徽标；页面提示：${await sayText()}`);
  await page.screenshot({ path: `${OUT}/16-split-done.png` });
} catch (e) { gripe("单片段分轨", e.message.split("\n").slice(0, 5).join(" | ")); }

// ── 收尾：悬浮球 + console errors ───────────────────────────
const orb = await page.evaluate(() => {
  const el = document.querySelector(".sr-orb");
  if (!el) return "无球";
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
console.log(JSON.stringify({ orb, consoleErrors: errs.length }, null, 2));
if (errs.length > 0) console.log("console errors:\n" + errs.slice(0, 8).join("\n"));
console.log(`\n抱怨清单（${complaints.length} 条）：`);
for (const c of complaints) console.log("  - " + c);
await browser.close();
