/**
 * F-3 音量滑杆的 DOM 断言补仓（#383，测试债：99f8af2 当时的 7 条断言没随 commit 进仓）。
 *
 * 口径：与 dj-page-layout-acceptance.mjs 同一套启动（BASE=:5173，localStorage 进 DJ 页）。
 * 钉的是 99f8af2 的交付承诺——滑杆不再伪装进度条：
 *   ① 滑杆本体固定 96px（不再 flex:1 撑满整行），group 高 28px 与播放键同高；
 *     group 实测 120px（input 96 + 喇叭 16 + 间距），≤128px 封顶防"撑满"回潮——
 *     #383 原文「group ≤96px」按构造不成立（96px 是 input 的承诺），已按实测钉数并上报 Codex；
 *   ② 前置喇叭图标：svg[aria-hidden=true] 且紧挨在 input 前；
 *   ③ input[type=range][aria-label=音量] 保留；
 *   ④ 悬停气泡 ≤300ms 出现（O-5；实测 transition 0.1s）；
 *   ⑤ data-vol 与 input.value 同步（拖到 0.42 → 气泡 42%，aria-valuetext 跟上）；
 *   ⑥ 键盘档：blur 后气泡消失、:focus-within 气泡重现 ≤300ms；
 *   ⑦ 99f8af2 的回归钉：拖动后快照即时 emit，input 不弹回 100%、data-vol 不写回 100%。
 *
 * 前置：vite :5173 + 桥 :8787（曲库行取自桥；没有真音频输出，只动 DOM）。
 * 用法：node apps/web/tests/e2e/f3-volume-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "dj");
  if (!window.sessionStorage.getItem("__s2b")) {
    window.localStorage.removeItem("shadowroom.setdraft");
    window.sessionStorage.setItem("__s2b", "1");
  }
});
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30000 });
await page.locator(".sr-dj-library .sr-dj-row").first().click();
await page.waitForFunction(() => {
  const button = document.querySelector(".sr-dj-deck button[aria-label^='播放']");
  return button instanceof HTMLButtonElement && !button.disabled;
}, null, { timeout: 30000 });
await page.waitForTimeout(400);

const group = page.locator(".sr-dj-vol-group").first();
const input = group.locator("input");

// ① 96px 是滑杆本体的承诺（99f8af2 原文），group 是 input+喇叭+间距的实测量
const geo = await group.evaluate((node) => {
  const input = node.querySelector("input");
  return {
    inputW: Math.round(input.getBoundingClientRect().width),
    groupW: Math.round(node.getBoundingClientRect().width),
    groupH: Math.round(node.getBoundingClientRect().height),
  };
});
check(
  "① 滑杆本体 96px（不撑满整行），group ≤128px 封顶、高 28px",
  geo.inputW === 96 && geo.groupW <= 128 && geo.groupH === 28,
  `input=${geo.inputW}px group=${geo.groupW}px 高=${geo.groupH}px（实测口径：input 96+svg 16+间距=120）`,
);

// ② 前置喇叭图标：svg + aria-hidden，且紧挨在 input 之前
const icon = await group.evaluate((node) => {
  const svg = node.querySelector("svg");
  const input = node.querySelector("input");
  return {
    has: Boolean(svg),
    ariaHidden: svg?.getAttribute("aria-hidden"),
    adjacent: Boolean(svg && input) && svg.nextElementSibling === input,
  };
});
check(
  "② 前置喇叭图标 svg[aria-hidden=true]，紧挨 input 前",
  icon.has && icon.ariaHidden === "true" && icon.adjacent,
  `svg=${icon.has} aria-hidden=${icon.ariaHidden} 相邻=${icon.adjacent}`,
);

// ③ aria-label=音量 的 range 保留
const a11y = await input.evaluate((node) => ({
  type: node.type,
  label: node.getAttribute("aria-label"),
}));
check(
  "③ input[type=range][aria-label=音量] 保留",
  a11y.type === "range" && a11y.label === "音量",
  `type=${a11y.type} aria-label=${a11y.label}`,
);

// 气泡显隐的公共量法：::after opacity
const bubbleOpacity = () =>
  page.evaluate(() => Number(getComputedStyle(document.querySelector(".sr-dj-vol-group"), "::after").opacity));
const waitBubbleShown = async (deadlineMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if ((await bubbleOpacity()) >= 1) return Date.now() - t0;
    await page.waitForTimeout(20);
  }
  return -1;
};

// ④ 悬停 ≤300ms 出气泡（O-5）
await group.hover();
const hoverMs = await waitBubbleShown(300);
check(
  "④ 悬停气泡 ≤300ms 出现",
  hoverMs >= 0,
  hoverMs >= 0 ? `${hoverMs}ms 出现（opacity 0→1）` : "300ms 内未出现",
);

// ⑤ 拖到 0.42 → data-vol / aria-valuetext 同步 42%
await input.fill("0.42");
await page.waitForTimeout(150);
const sync = await group.evaluate((node) => {
  const input = node.querySelector("input");
  return {
    dataVol: node.getAttribute("data-vol"),
    value: input.value,
    ariaValuetext: input.getAttribute("aria-valuetext"),
  };
});
check(
  "⑤ 拖到 0.42 → 气泡 data-vol=42% 与 input.value 同步",
  sync.value === "0.42" && sync.dataVol === "42%" && sync.ariaValuetext === "42%",
  `value=${sync.value} data-vol=${sync.dataVol} aria-valuetext=${sync.ariaValuetext}`,
);

// ⑥ 键盘档：blur 后气泡消失，:focus-within 重现 ≤300ms
// （fill() 会把焦点留在 input 上，先 blur 才能测"消失"）
await input.evaluate((node) => node.blur());
await page.mouse.move(8, 8);
await page.waitForTimeout(250);
const opHidden = await bubbleOpacity();
await input.focus();
const focusMs = await waitBubbleShown(300);
check(
  "⑥ blur 气泡消失、键盘聚焦气泡重现 ≤300ms",
  opHidden === 0 && focusMs >= 0,
  `blur 后 opacity=${opHidden}，focus ${focusMs >= 0 ? `${focusMs}ms` : "未"}出现`,
);

// ⑦ 99f8af2 的回归钉：拖动后快照即时 emit，滑块不弹回 100%
// （病根：Deck.setVolume 只推 gain 不 emit，React 拿不到新值，拖完总回满格）
await page.waitForTimeout(600);
const noSnap = await group.evaluate((node) => {
  const input = node.querySelector("input");
  return { value: input.value, dataVol: node.getAttribute("data-vol") };
});
check(
  "⑦ 拖动后不弹回：input 与 data-vol 都停在 42%",
  noSnap.value === "0.42" && noSnap.dataVol === "42%",
  `settled 600ms 后 value=${noSnap.value} data-vol=${noSnap.dataVol}（坏路径=1/100%）`,
);

check("⑧ 零 console error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | ") || "没有 error/pageerror");

console.log(`\n汇总: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
