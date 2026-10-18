/**
 * 悬浮球 v6 收尾验收（题面 9 条，PASS/FAIL 逐条打印，可重复跑）：
 * ① 球可见且无「管家」文字（含展开面板的 placeholder/aria-label/title）
 * ② 全文档无「听话」按钮/开关
 * ③ 点球进入通话态（data-mode 变化）④ 再点/Esc 回 idle
 * ⑤ 拖动后位置改变且松手吸附（距某边缘 ≤12px）
 * ⑥ 刷新后位置保持（localStorage 生效）
 * ⑦ 球外点击穿透（被球容器盖住的下层按钮仍能收到 click，含容器四角 elementFromPoint）
 * ⑧ 五态截图两两像素差超阈值（qa-orb-force 强制态、qa-orb-progress 钉进度；
 *    同尺寸 128×128 PNG，完整包住 112px 通话态球，两两 mean-abs-diff ≥ 8/255）
 * ⑨ 说话态中心粒子确实聚合成动态声波：亮色粒子数有下限，两帧中心区域存在可见变化。
 *
 * 前置：5173 dev server（本脚本自己的分支起在 5174 时用 ORB_E2E_BASE=http://localhost:5174 覆盖）。
 * 五态截图落 exports/agent-bench-2026-10/orb-v5/zcode/。用法：node tests/e2e/orb-v5-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.ORB_E2E_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/agent-bench-2026-10/orb-v5/zcode";
const MODES = ["idle", "listening", "speaking", "thinking", "working"];
const DIFF_THRESHOLD = 8; // /255，mean abs diff

const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });
// 假麦克风：2026-10-16 起点球=真通话（App.startCall → getUserMedia），没有麦克风时
// 通话起不来、球当然停在 idle——那是环境不是回归。用 fake device 让「真通话」这条路可测。
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference", permissions: ["microphone"] });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-orb-ball canvas", { timeout: 20000 });
await page.waitForTimeout(800);

const orb = page.locator(".sr-orb");
const ball = page.locator(".sr-orb-ball");
const orbState = () =>
  page.evaluate(() => {
    const el = document.querySelector(".sr-orb");
    if (!el) return null;
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    const rect = el.getBoundingClientRect();
    return { mode: el.getAttribute("data-mode"), left, top, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  });
const dragOrbTo = async (targetX, targetY) => {
  // 拖球心到 (targetX, targetY)：分步 move 让 pointermove 逐帧进 React
  const b = await ball.boundingBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
};

// ① 球可见且无「管家」文字（折叠态 + 展开面板一起查）
{
  const box = await orb.boundingBox();
  let visible = box !== null && box.width >= 60 && box.height >= 60;
  const scanOrbText = () =>
    page.evaluate(() => {
      const root = document.querySelector(".sr-orb");
      if (!root) return ["(no .sr-orb)"];
      const texts = [root.textContent ?? ""];
      for (const el of root.querySelectorAll("[placeholder],[aria-label],[title]")) {
        for (const attr of ["placeholder", "aria-label", "title"]) {
          const value = el.getAttribute(attr);
          if (value) texts.push(value);
        }
      }
      for (const el of root.querySelectorAll("input,textarea")) texts.push(el.value ?? "");
      return texts.filter((t) => t.includes("管家"));
    });
  let violations = await scanOrbText();
  await ball.focus();
  await page.keyboard.press("Enter"); // 键盘展开面板（唯一展开路径）
  await page.waitForTimeout(300);
  violations = [...violations, ...(await scanOrbText())];
  await page.keyboard.press("Enter"); // 收回
  await page.waitForTimeout(200);
  check("① 球可见且无「管家」文字", visible && violations.length === 0, `boundingBox=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "null"}，违规=${JSON.stringify(violations)}`);
}

// ② 全文档无「听话」按钮
{
  const hits = await page.evaluate(() => {
    const found = [];
    for (const b of document.querySelectorAll("button, [role=button], [role=switch], input[type=checkbox], input[type=radio]")) {
      const label = [b.textContent, b.getAttribute("aria-label"), b.getAttribute("title"), b.getAttribute("placeholder")]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (label.includes("听话")) found.push(label.slice(0, 40));
    }
    return found;
  });
  check("② 全文档无「听话」按钮", hits.length === 0, `命中=${JSON.stringify(hits)}`);
}

// ③ 点球进入通话态
{
  const beforeState = await orbState();
  const before = beforeState?.mode;
  const b = await ball.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(600);
  const afterState = await orbState();
  const after = afterState?.mode;
  const canvas = await page.locator(".sr-orb-ball canvas").evaluate((el) => ({
    css: el.getBoundingClientRect().width,
    backing: el.width,
  }));
  const centerDelta =
    beforeState === null || afterState === null
      ? Infinity
      : Math.hypot(
          beforeState.rect.x + beforeState.rect.w / 2 - (afterState.rect.x + afterState.rect.w / 2),
          beforeState.rect.y + beforeState.rect.h / 2 - (afterState.rect.y + afterState.rect.h / 2),
        );
  const backingRatio = canvas.css > 0 ? canvas.backing / canvas.css : 0;
  /**
   * At the 12px bottom-right snap point, growing 72→112 must pull the centre inward by 20px on each
   * axis; preserving both centre and the 12px viewport gap is geometrically impossible. The contract
   * is therefore "small constrained shift + still fully inside", not an arbitrary <=12px.
   */
  const fullyInside =
    afterState !== null &&
    afterState.rect.x >= 11 &&
    afterState.rect.y >= 11 &&
    afterState.rect.x + afterState.rect.w <= 1429 &&
    afterState.rect.y + afterState.rect.h <= 889;
  check(
    "③ 点球进入通话态：72→112px、高清背板、中心不跳走",
    before === "idle" &&
      after === "listening" &&
      beforeState?.rect.w === 72 &&
      afterState?.rect.w === 112 &&
      backingRatio >= 2.5 &&
      centerDelta <= 30 &&
      fullyInside,
    `data-mode: ${before} → ${after}；尺寸 ${beforeState?.rect.w} → ${afterState?.rect.w}；canvas ${canvas.backing}/${canvas.css.toFixed(1)}px=${backingRatio.toFixed(2)}×；中心偏移 ${centerDelta.toFixed(1)}px`,
  );
}

// ④ 再点 / Esc 回 idle
{
  const b = await ball.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(300);
  const afterClick = (await orbState())?.mode;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // 先回 listening，再走 Esc 那条路
  // 起点球=真通话（2026-10-16）：startCall 里先 await getUserMedia 才 setVoiceMode(true)，
  // 点完立刻按 Esc 会落在「还没开麦」的缝里——等它真的进 listening 再按。
  for (let i = 0; i < 20; i += 1) {
    if ((await orbState())?.mode === "listening") break;
    await page.waitForTimeout(100);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterEsc = (await orbState())?.mode;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const settled = (await orbState())?.mode;
  check("④ 再点/Esc 回 idle", afterClick === "idle" && afterEsc === "idle" && settled === "idle", `再点→${afterClick}，Esc→${afterEsc}，收敛→${settled}`);
}

// ⑤ 拖动后位置改变且松手吸附（距某边缘 ≤12px）
{
  const before = await orbState();
  await dragOrbTo(80, 450); // 拖到左边：x 落在 <60 → 松手吸附左缘 12px
  const after = await orbState();
  const distLeft = after.rect.x;
  const distTop = after.rect.y;
  const distRight = 1440 - (after.rect.x + after.rect.w);
  const distBottom = 900 - (after.rect.y + after.rect.h);
  const minEdge = Math.min(distLeft, distTop, distRight, distBottom);
  const moved = Math.abs(after.left - before.left) > 50;
  check("⑤ 拖动后位置改变且松手吸附（距某边缘 ≤12px）", moved && minEdge <= 12, `left ${Math.round(before.left)} → ${Math.round(after.left)}，距最近边缘 ${minEdge.toFixed(1)}px`);
}

// ⑥ 刷新后位置保持
{
  const before = await orbState();
  const stored = await page.evaluate(() => localStorage.getItem("shadowroom.orb.position"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-ball canvas", { timeout: 20000 });
  await page.waitForTimeout(500);
  const after = await orbState();
  const kept = Math.abs(after.left - before.left) <= 1 && Math.abs(after.top - before.top) <= 1;
  check("⑥ 刷新后位置保持（localStorage 生效）", kept && stored !== null, `localStorage=${stored}，刷新前 (${before.left.toFixed(1)}, ${before.top.toFixed(1)}) → 后 (${after.left.toFixed(1)}, ${after.top.toFixed(1)})`);
}

// ⑦ 球外点击穿透：容器四角 elementFromPoint 不是球；被容器盖住的下层按钮真实收到 click
{
  const state = await orbState();
  const r = state.rect;
  const corners = [
    [r.x + 2, r.y + 2],
    [r.x + r.w - 2, r.y + 2],
    [r.x + 2, r.y + r.h - 2],
    [r.x + r.w - 2, r.y + r.h - 2],
  ];
  const cornerPass = await page.evaluate((points) => {
    return points.map(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el === null || !el.closest(".sr-orb");
    });
  }, corners);
  // 找一颗中屏按钮，把球拖过去盖住它（球心错开，按钮中心落在容器角区、不在 32px 命中圆内）
  const target = await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if (b.closest(".sr-orb")) continue;
      const rect = b.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (rect.width < 8 || rect.height < 8) continue;
      if (cx < 360 || cx > innerWidth - 360 || cy < 120 || cy > innerHeight - 220) continue;
      return { cx, cy, label: (b.textContent || b.getAttribute("aria-label") || "?").trim().slice(0, 24) };
    }
    return null;
  });
  let clickReceived = false;
  let targetInfo = "(no target button)";
  if (target !== null) {
    await dragOrbTo(target.cx - 26, target.cy + 26); // 容器角区盖住按钮中心：偏 (26,-26)，距球心 ≈36.8>32
    const covered = await page.evaluate((t) => {
      const el = document.elementFromPoint(t.cx, t.cy);
      return el !== null && el.closest("button") !== null && !el.closest(".sr-orb");
    }, target);
    if (covered) {
      await page.evaluate((t) => {
        const el = document.elementFromPoint(t.cx, t.cy).closest("button");
        el.addEventListener("click", () => {
          window.__orbPassThrough = (window.__orbPassThrough ?? 0) + 1;
        });
      }, target);
      await page.mouse.click(target.cx, target.cy);
      await page.waitForTimeout(200);
      clickReceived = (await page.evaluate(() => window.__orbPassThrough ?? 0)) === 1;
      targetInfo = `按钮「${target.label}」@(${Math.round(target.cx)},${Math.round(target.cy)})`;
    } else {
      targetInfo = `目标点未穿透到按钮（elementFromPoint 不在按钮上）`;
    }
  }
  check("⑦ 球外点击穿透（含容器四角）", cornerPass.every(Boolean) && clickReceived, `四角穿透=${cornerPass.every(Boolean)}，下层按钮收到 click=${clickReceived}（${targetInfo}）`);
}

// ⑧ 五态截图两两像素差 ≥ 8/255（qa-orb-force 强制、qa-orb-progress 钉 0.55）
{
  const shots = {};
  const CAPTURE = 128;
  for (const mode of MODES) {
    await page.evaluate((m) => {
      localStorage.setItem("qa-orb-force", m);
      localStorage.setItem("qa-orb-progress", "0.55");
    }, mode);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sr-orb-ball canvas", { timeout: 20000 });
    await page.waitForTimeout(1600); // 参数 morph ~0.4s + 稳定两帧
    const b = await ball.boundingBox();
    const clip = {
      x: b.x + b.width / 2 - CAPTURE / 2,
      y: b.y + b.height / 2 - CAPTURE / 2,
      width: CAPTURE,
      height: CAPTURE,
    };
    const buf = await page.screenshot({ clip });
    shots[mode] = buf;
    writeFileSync(`${SHOTS}/state-${mode}.png`, buf);
  }
  await page.evaluate(() => {
    localStorage.removeItem("qa-orb-force");
    localStorage.removeItem("qa-orb-progress");
  });
  const entries = MODES.map((m) => [m, shots[m].toString("base64")]);
  const pairs = await page.evaluate(async ({ modes, b64s, capture }) => {
    const imgs = {};
    await Promise.all(
      modes.map(
        (m) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              imgs[m] = img;
              resolve();
            };
            img.src = `data:image/png;base64,${b64s[m]}`;
          }),
      ),
    );
    const canvas = document.createElement("canvas");
    canvas.width = capture;
    canvas.height = capture;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = (img) => {
      ctx.clearRect(0, 0, capture, capture);
      ctx.drawImage(img, 0, 0, capture, capture);
      return ctx.getImageData(0, 0, 96, 96).data;
    };
    const out = [];
    for (let i = 0; i < modes.length; i += 1) {
      for (let j = i + 1; j < modes.length; j += 1) {
        const a = pixels(imgs[modes[i]]);
        const b = pixels(imgs[modes[j]]);
        let sum = 0;
        let count = 0;
        const radius = capture / 2;
        for (let p = 0; p < a.length; p += 4) {
          const pixel = p / 4;
          const x = pixel % capture;
          const y = Math.floor(pixel / capture);
          // Measure the orb disc, not the page texture in the four corners.
          if (Math.hypot(x + 0.5 - radius, y + 0.5 - radius) > radius) continue;
          sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
          count += 1;
        }
        out.push([modes[i], modes[j], sum / Math.max(1, count) / 3]);
      }
    }
    return out;
  }, { modes: MODES, b64s: Object.fromEntries(entries), capture: CAPTURE });
  const min = pairs.reduce((acc, [, , d]) => Math.min(acc, d), Infinity);
  check("⑧ 五态截图两两像素差 ≥ 8/255", min >= DIFF_THRESHOLD, `最小 mean-abs-diff=${min.toFixed(2)}/255；${pairs.map(([a, b, d]) => `${a}-${b}:${d.toFixed(1)}`).join(" ")}`);
  console.log(`      五态截图：${SHOTS}/state-{${MODES.join(",")}}.png`);
}

// ⑨ 说话态中心粒子声波：只截球心，避开外圈、字幕和页面内容。
{
  await page.evaluate(() => {
    localStorage.setItem("qa-orb-force", "speaking");
    localStorage.removeItem("qa-orb-progress");
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-orb-ball canvas", { timeout: 20000 });
  await page.waitForTimeout(1100);
  const b = await ball.boundingBox();
  const clip = { x: b.x + b.width / 2 - 38, y: b.y + b.height / 2 - 24, width: 76, height: 48 };
  const first = (await page.screenshot({ clip })).toString("base64");
  await page.waitForTimeout(360);
  const second = (await page.screenshot({ clip })).toString("base64");
  const wave = await page.evaluate(async ({ first, second }) => {
    const load = (base64) =>
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.src = `data:image/png;base64,${base64}`;
      });
    const [a, b] = await Promise.all([load(first), load(second)]);
    const canvas = document.createElement("canvas");
    canvas.width = 76;
    canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const read = (image) => {
      ctx.clearRect(0, 0, 76, 48);
      ctx.drawImage(image, 0, 0, 76, 48);
      return ctx.getImageData(0, 0, 76, 48).data;
    };
    const pa = read(a);
    const pb = read(b);
    let lit = 0;
    let motion = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (pa[i + 1] > 135 && pa[i + 1] > pa[i] * 1.14) lit += 1;
      motion += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    }
    return { lit, motionMean: motion / (pa.length / 4) / 3 };
  }, { first, second });
  check(
    "⑨ 说话态粒子聚合成动态声波",
    wave.lit >= 18 && wave.motionMean >= 0.4,
    `中心亮粒子 ${wave.lit}px，两帧平均变化 ${wave.motionMean.toFixed(2)}/255`,
  );
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `，${failed} FAIL` : ""}`);
process.exit(failed > 0 ? 1 : 0);
