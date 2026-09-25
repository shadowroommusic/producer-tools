// 单片段分轨探针：右键第一个音频片段后，量「分轨（…」菜单项的真实状态——
// disabled？被谁挡？stable？——并尝试点击，抓完整错误。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const WAV = "/Users/lazora/Documents/ShadowRoom/recordings/deep-house-128.wav";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text().slice(0, 160)); });
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

const inspect = async (label) => {
  const info = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    const item = items.find((el) => el.textContent?.includes("分轨（"));
    if (!item) return { found: false, menuItems: items.map((el) => el.textContent?.slice(0, 12)) };
    const r = item.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const cls = typeof hit?.className === "string" ? hit.className : (hit?.className?.baseVal ?? "none");
    return {
      found: true,
      disabled: item.disabled,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hit: { tag: hit?.tagName, cls, isSelf: hit === item || item.contains(hit) },
      menuRect: (() => { const m = document.querySelector('[role="menu"]')?.getBoundingClientRect(); return m && { x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.width), h: Math.round(m.height) }; })(),
    };
  });
  console.log(label, JSON.stringify(info));
  return info;
};

await page.locator(".sr-clip").first().click({ button: "right" });
await sleep(400);
await inspect("S1 基线（新工程首片段）：");
try {
  await page.locator('[role="menu"] [role="menuitem"]', { hasText: "分轨（" }).first().click({ timeout: 5000 });
  console.log("S2 基线点击 = 成功");
} catch (e) {
  console.log("S2 基线点击失败：", e.message.split("\n").slice(0, 10).join(" | "));
}
await sleep(1000);
// 分轨跑起来后菜单应已关闭；等徽标（最多 240s）
let badge = 0;
for (let i = 0; i < 240 && badge === 0; i += 1) {
  await sleep(1000);
  badge = await page.locator(".sr-clip-badge--stems").count();
  if (i === 30) console.log("S3 30s：徽标 =", badge);
}
console.log("S4 已分轨徽标 =", badge);
await browser.close();
