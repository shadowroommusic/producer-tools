/**
 * 悬浮球通话字幕的清晰度验收（Codex 2026-10-16，用户：「球看着还行但非常不清晰」）。
 *
 * 修之前实测的两条硬伤（本脚本就是钉这两个数）：
 *   ① 球吸附右边缘时字幕越界 21px（文字被视口切掉）；
 *   ② 球吸附上边缘时字幕整条在视口外（top:-21px，等于没有字幕）。
 * 交付标准（逐条断言）：
 *   ① 起手提示在字幕**一出现**就能读到（含「挂断」），~1.2s 后二读仍是合法通话文案（词表
 *      src/lib/call-words.ts：起手提示或五态之一），不空、不残影；四个吸附角都**完全在视口内**；
 *   ② 字号 ≥13px、与球不重叠、不接指针事件（点得穿）；
 *   ③ 状态只有一处（F-2 收敛）：球字幕带状态点，dock 通话条不再渲染状态点/状态位/状态词，
 *      字幕 [data-call-caption] 全屏唯一；
 *   ④ 浅色主题下字幕底色跟着主题变浅（不再恒定深色药丸）；
 *   ⑤ 挂断后字幕消失。
 *
 * 前置：vite :5173（本脚本用假麦克风 + 自造静音 WAV，**不触发 STT、不打真实 API**）。
 * 用法：node apps/web/tests/e2e/orb-caption-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.CAPTION_E2E_BASE ?? "http://localhost:5173";
const SHOTS = process.env.CAPTION_E2E_SHOTS ?? "/Users/lazora/Documents/ShadowRoom/exports/orb-caption";
const VIEWPORT = { width: 1440, height: 900 };
const EDGE = 8; // 字幕离视口边缘的最小留白（与 ButlerOrb 同口径）

/** 静音 WAV：假麦克风「一直在响但没人说话」，通话起得来、又不会真的进回合。 */
function silenceWav(path) {
  const rate = 16000;
  const seconds = 5;
  const data = Buffer.alloc(rate * seconds * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
const wav = silenceWav(join(tmpdir(), "shadowroom-caption-silence.wav"));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await (await browser.newContext({ viewport: VIEWPORT, permissions: ["microphone"], deviceScaleFactor: 2 })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

/** 字幕的几何 + 可读性读数（一个字面量对象，避免断言时再猜）。 */
const readCaption = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-call-caption]");
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const dot = el.querySelector(".sr-orb-caption-dot");
    const voicebar = document.querySelector(".sr-voicebar");
    const statusWords = ["在听…", "在想…", "在说…"];
    const voicebarText = voicebar?.textContent ?? "";
    const voicebarStatusWords = statusWords.reduce(
      (n, w) => n + voicebarText.split(w).length - 1,
      0,
    );
    const orb = document.querySelector(".sr-orb");
    const orbRect = orb === null ? null : orb.getBoundingClientRect();
    const bg = style.backgroundColor;
    // Chrome 对 color-mix 的结果报 `color(srgb 0.10 0.11 0.09 / 0.92)`：0–1 的浮点，不是 0–255。
    // 两套写法都要认，否则「浅色主题变浅了没有」会恒读成 0（第一版就踩了）。
    const nums = (bg.match(/[\d.]+/g) ?? []).map(Number);
    const scale = bg.startsWith("color(") ? 1 : 255;
    const lum = nums.length >= 3 ? (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / scale : null;
    const mid = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const under = document.elementFromPoint(mid.x, mid.y);
    return {
      text: el.textContent ?? "",
      rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, w: rect.width, h: rect.height },
      fontSize: parseFloat(style.fontSize),
      pointerEvents: style.pointerEvents,
      background: bg,
      backgroundLuma: lum,
      placement: el.getAttribute("data-placement"),
      dotState: dot === null ? null : dot.getAttribute("data-state"),
      dotColor: dot === null ? null : getComputedStyle(dot).backgroundColor,
      // F-2：dock 通话条里的状态渲染必须整体消失（0 个），字幕全屏只有一条。
      voiceDotCount: document.querySelectorAll(".sr-voicebar-dot").length,
      voiceStatusCount: document.querySelectorAll(".sr-voicebar-status").length,
      voicebarStatusWords,
      captionCount: document.querySelectorAll("[data-call-caption]").length,
      orb: orbRect === null ? null : { x: orbRect.x, y: orbRect.y, right: orbRect.right, bottom: orbRect.bottom },
      behindCaption: under === null ? null : under.closest("[data-call-caption]") !== null,
    };
  });

const dragTo = async (x, y) => {
  const box = await page.locator(".sr-orb-ball").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
};

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb-ball", { timeout: 20000 });
await page.waitForTimeout(1000);

// ① 起通话（假麦克风静音）：字幕一出现就抢读——起手提示必须说清怎么挂断。
// 为什么抢读、不固定等 1500ms：这台 Chrome 的识别会随机 ~1s 内报 network，F-1 会把字幕
// 合法迁到 offline 文案（不含「挂断」二字）；单点晚读等于跟这个时序抽奖（2026-10-16 全量扫
// 就这样红过一次，复跑 3/3 绿证明是竞争不是回归）。
await page.locator(".sr-orb-ball").click();
let first = null;
for (let waited = 0; waited <= 1000 && first === null; waited += 50) {
  const shot = await readCaption();
  if (shot !== null && shot.text.trim() !== "") first = shot;
  else await page.waitForTimeout(50);
}
check("① 通话中字幕出现", first !== null && first.text.trim() !== "", `text=${JSON.stringify(first?.text)}`);
check(
  "① 起手提示说清怎么挂断",
  first !== null && first.text.includes("挂断"),
  `text=${JSON.stringify(first?.text)}`,
);

// ①b 再等 ~1.2s 读第二次：不管识别这时已报错迁到哪个态，字幕都必须还是**合法通话文案**
// （词表 src/lib/call-words.ts 一处：CALL_START_HINT 含「挂断」、三态词 在听/在想/在说、
// unclear/offline 字幕含「没听清」/「断了」）。.mjs 不能直接 import 那份 .ts，按派单口径用
// 子串对齐；空文案或残影（字幕元素多于一条）都不许。
await page.waitForTimeout(1200);
const second = await readCaption();
const legalCaptionWords = ["挂断", "在听", "在想", "在说", "没听清", "断了"];
check(
  "① 1.2s 后字幕仍是合法通话文案（不空、不残影）",
  second !== null &&
    legalCaptionWords.some((w) => second.text.includes(w)) &&
    second.captionCount === 1,
  `text=${JSON.stringify(second?.text)} 字幕数=${second?.captionCount}（应为 1）`,
);

// ② 四个吸附角：字幕都得完整在视口内（修前右边缘越界 21px、上边缘整条出界）
const corners = [
  ["右下", 1439, 899],
  ["右上", 1439, 1],
  ["左上", 1, 1],
  ["左下", 1, 899],
];
for (const [name, x, y] of corners) {
  await dragTo(x, y);
  const shot = await readCaption();
  await page.screenshot({ path: `${SHOTS}/corner-${name}.png` });
  if (shot === null) {
    check(`② ${name}：字幕在`, false, "字幕不存在");
    continue;
  }
  const inside =
    shot.rect.x >= EDGE - 0.5 &&
    shot.rect.y >= EDGE - 0.5 &&
    shot.rect.right <= VIEWPORT.width - EDGE + 0.5 &&
    shot.rect.bottom <= VIEWPORT.height - EDGE + 0.5;
  check(
    `② ${name}：字幕完整在视口内`,
    inside,
    `rect=${JSON.stringify(shot.rect)} placement=${shot.placement}`,
  );
  const gap = shot.orb === null ? null : Math.min(Math.abs(shot.rect.bottom - shot.orb.y), Math.abs(shot.orb.bottom - shot.rect.y));
  check(`② ${name}：与球不重叠且留缝 ≥4px`, gap !== null && gap >= 4, `gap=${gap?.toFixed(1)}px`);
}

// ③ 可读性：字号 ≥13px、点得穿（pointer-events:none）、状态点与通话条同色同步
const readable = await readCaption();
check("③ 字号 ≥13px", readable !== null && readable.fontSize >= 13, `font-size=${readable?.fontSize}px`);
check(
  "③ 字幕不接指针事件（不挡点击）",
  readable !== null && readable.pointerEvents === "none" && readable.behindCaption === false,
  `pointer-events=${readable?.pointerEvents} 命中字幕=${readable?.behindCaption}`,
);
check(
  "③ 状态收敛一处：通话条不再渲染状态点/状态位",
  readable !== null &&
    readable.dotState !== null &&
    readable.voiceDotCount === 0 &&
    readable.voiceStatusCount === 0,
  `球字幕点=${readable?.dotState} 通话条状态点/状态位=${readable?.voiceDotCount}/${readable?.voiceStatusCount}（F-2 应为 0/0）`,
);
check(
  "③ 通话条零状态词，球字幕全屏唯一（F-2）",
  readable !== null && readable.captionCount === 1 && readable.voicebarStatusWords === 0,
  `字幕数=${readable?.captionCount} 通话条状态词出现 ${readable?.voicebarStatusWords} 次（都应为 1/0）`,
);

// ④ 浅色主题：字幕底色跟着主题（修前恒为深色药丸，因为写了一个不存在的 token）
const darkLuma = readable?.backgroundLuma ?? null;
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
await page.waitForTimeout(400);
const light = await readCaption();
await page.screenshot({ path: `${SHOTS}/theme-light.png` });
check(
  "④ 浅色主题下字幕底色变浅",
  light !== null && light.backgroundLuma !== null && darkLuma !== null && light.backgroundLuma > darkLuma + 0.3 && light.backgroundLuma > 0.5,
  `深色 ${darkLuma?.toFixed(3)} → 浅色 ${light?.backgroundLuma?.toFixed(3)}`,
);
await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
await page.waitForTimeout(300);

// ⑤ 挂断：球回 idle，字幕不留通话状态的残影（这台的浏览器识别连不上 Google，会留一条错误提示——
//    那是「为什么没反应」的解释文案，允许；「在听…」这种通话状态词不允许留下）。
//    挂断走 Esc 而不是点球：点球自 F-1 起是「按当前态」的动作（断了=重连、没听清=重说），
//    这台环境里浏览器识别必报 network → 通话停在 offline，点球会重连而不是挂断；Esc 永远挂断。
await page.keyboard.press("Escape");
await page.waitForTimeout(900);
const after = await readCaption();
const orbMode = await page.locator(".sr-orb").getAttribute("data-mode");
const statusWords = ["在听…", "在想…", "在说…"];
check(
  "⑤ 挂断后球回 idle 且字幕不留通话状态",
  orbMode === "idle" && (after === null || !statusWords.includes(after.text.trim())),
  `data-mode=${orbMode} caption=${after === null ? "null" : JSON.stringify(after.text.slice(0, 40))}`,
);
check("⑤ 无 console error", errors.length === 0, errors.length ? errors.join(" || ") : "none");

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} PASS`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
