// Studio 走查四项失败的聚焦调试：裁剪 / 生成钢琴轨 / 录音 / 单片段分轨。
// 每项抓：网络请求（/api/call、/api/agent/audio）、say 文案、DOM 数字、截图。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const OUT = "/Users/lazora/Documents/ShadowRoom/exports/studio-walk-debug";
const WAV = "/Users/lazora/Documents/ShadowRoom/recordings/deep-house-128.wav";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
const calls = [];
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/api/call") || url.includes("/api/agent/audio")) calls.push({ method: req.method(), url, body: req.postData()?.slice(0, 160) });
});
page.on("response", async (res) => {
  const url = res.url();
  if (url.includes("/api/call") || url.includes("/api/agent/audio")) {
    const entry = calls.findLast((c) => c.url === url && c.status === undefined);
    if (entry) { entry.status = res.status(); entry.text = (await res.text().catch(() => "")).slice(0, 220); }
  }
});
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "studio");
  window.localStorage.removeItem("shadowroom.studio.projects.v1");
  window.localStorage.removeItem("shadowroom.orb.position");
});
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await sleep(1500);
await page.getByText("新建工程").first().click();
await sleep(2000);
await page.locator('input[type="file"]').first().setInputFiles(WAV);
await sleep(6000);

const clipBox = () => page.locator(".sr-clip").first().boundingBox();

// ── A 裁剪：先直接裁（无前置拖动），再移动后裁，对比 ──
const resizeBy = async (dx) => {
  const edge = await page.locator(".sr-clip-resize").first().boundingBox();
  const w0 = (await clipBox()).width;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + dx, edge.y + edge.height / 2, { steps: 10 });
  await page.mouse.up();
  await sleep(500);
  return { w0, w1: (await clipBox()).width };
};
console.log("A1 直接裁 -60px：", JSON.stringify(await resizeBy(-60)));
// 移动 140px 再裁
const box = await clipBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await sleep(500);
console.log("A2 移动 140px 后裁 -60px：", JSON.stringify(await resizeBy(-60)));
const at = await page.evaluate(() => {
  const el = document.querySelector(".sr-clip-resize");
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { handle: { x: Math.round(r.x), y: Math.round(r.y), w: r.width, h: Math.round(r.height) }, hitClass: hit?.className };
});
console.log("A3 手柄命中：", JSON.stringify(at));
await page.screenshot({ path: `${OUT}/a-trim.png` });

// ── B 转 MIDI → 生成钢琴轨（抓 /api/call 往返与 say 文案）──
const rightDo = async (locator, label) => {
  await locator.click({ button: "right" });
  await sleep(400);
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: label }).first().click();
  await sleep(500);
};
calls.length = 0;
await rightDo(page.locator(".sr-clip").first(), "转 MIDI");
let midi = 0;
for (let i = 0; i < 40 && midi === 0; i += 1) { await sleep(1000); midi = await page.locator(".sr-clip", { hasText: "· MIDI" }).count(); }
console.log("B1 MIDI 片段 =", midi, "；转 MIDI 的桥往返：", JSON.stringify(calls.filter((c) => c.text)));
calls.length = 0;
const midiClip = page.locator(".sr-clip", { hasText: "· MIDI" }).first();
await midiClip.click({ button: "right" });
await sleep(400);
const genItem = page.locator('[role="menu"] [role="menuitem"]', { hasText: "用这段生成" }).first();
console.log("B2 生成项 disabled =", await genItem.isDisabled());
await genItem.click();
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  if ((await page.locator(".sr-track-head", { hasText: "钢琴" }).count()) > 0) break;
}
console.log("B3 钢琴轨 =", await page.locator(".sr-track-head", { hasText: "钢琴" }).count(), "；生成轨的桥往返：", JSON.stringify(calls.filter((c) => c.status !== undefined)));
const bodyText = await page.evaluate(() => document.body.innerText);
console.log("B4 页面含「钢琴」的行：", JSON.stringify(bodyText.split("\n").filter((l) => l.includes("钢琴")).slice(0, 4)));
await page.screenshot({ path: `${OUT}/b-piano.png` });

// ── C 录音（抓上传往返 + 落点）──
calls.length = 0;
const headsBefore = await page.locator(".sr-track-head").count();
const clipsBefore = await page.locator(".sr-clip").count();
await page.getByText("录音", { exact: true }).first().click();
await sleep(3000);
const recLabel = await page.locator(".sr-studio-record").innerText();
console.log("C1 录音中按钮 =", JSON.stringify(recLabel));
await page.locator(".sr-studio-record").click();
await sleep(5000);
console.log("C2 轨道", headsBefore, "→", await page.locator(".sr-track-head").count(), "；片段", clipsBefore, "→", await page.locator(".sr-clip").count());
console.log("C3 录音的桥往返：", JSON.stringify(calls.filter((c) => c.url.includes("audio") || c.status !== undefined)));
const trackNames = await page.locator(".sr-track-head").allInnerTexts();
console.log("C4 轨道名 =", JSON.stringify(trackNames.map((t) => t.split("\n")[0])));
await page.screenshot({ path: `${OUT}/c-record.png` });

// ── D 单片段分轨入口：命中元素真实身份 + 右键尝试 ──
const first = page.locator(".sr-clip").first();
const fbox = await first.boundingBox();
const centerHit = fbox ? await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return "none";
  const cls = typeof el.className === "string" ? el.className : (el.className?.baseVal ?? "(svg)");
  return { tag: el.tagName, cls, id: el.id || undefined };
}, { x: fbox.x + fbox.width / 2, y: fbox.y + fbox.height / 2 }) : "no box";
console.log("D1 首片段 box =", JSON.stringify(fbox && { x: Math.round(fbox.x), y: Math.round(fbox.y), w: Math.round(fbox.width), h: Math.round(fbox.height) }), "中心命中 =", JSON.stringify(centerHit));
try {
  await first.click({ button: "right", timeout: 8000 });
  const menuVisible = await page.locator('[role="menu"]').count();
  console.log("D2 首片段右键 = 成功，菜单可见 =", menuVisible);
} catch (e) {
  console.log("D2 首片段右键失败：", e.message.split("\n").slice(0, 8).join(" | "));
}
await page.screenshot({ path: `${OUT}/d-state.png`, fullPage: false });

await browser.close();
