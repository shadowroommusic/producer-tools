// 裁剪 flake 探针：复现走查步骤 3→4 的精确序列（播放 3s → 停止 → 拖动 +140 → 右缘裁 -60），
// 每一步记录手柄 box、中心命中元素、片段 box，找出拖动后手柄抓不住的根因。
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const WAV = "/Users/lazora/Documents/ShadowRoom/recordings/deep-house-128.wav";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
const probe = async (label) => {
  const box = await clipBox();
  const handle = await page.locator(".sr-clip-resize").first().boundingBox();
  const hits = handle ? await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const cls = typeof el?.className === "string" ? el.className : (el?.className?.baseVal ?? "none");
    return { tag: el?.tagName, cls };
  }, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }) : null;
  console.log(label, JSON.stringify({ clip: box && { x: Math.round(box.x), w: Math.round(box.width) }, handle: handle && { x: Math.round(handle.x), y: Math.round(handle.y), w: handle.width, h: Math.round(handle.h ?? handle.height) }, hit: hits }));
  return { box, handle };
};

// 与走查一致：先播放 3s 再停止
await page.getByRole("button", { name: "播放" }).first().click();
await sleep(3000);
await page.locator('button[aria-label="停止"]').first().click();
await sleep(500);

await probe("T0 播放停止后：");
// 拖动 +140
const before = await clipBox();
await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
await page.mouse.down();
await page.mouse.move(before.x + before.width / 2 + 140, before.y + before.height / 2, { steps: 12 });
await page.mouse.up();
await sleep(600);
await probe("T1 拖动后：");

// 裁剪 -60，前后各探一次
const { handle } = await probe("T2 裁剪前：");
await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
await sleep(200);
await probe("T3 悬停手柄后：");
await page.mouse.down();
await page.mouse.move(handle.x + handle.width / 2 - 60, handle.y + handle.height / 2, { steps: 10 });
await page.mouse.up();
await sleep(600);
await probe("T4 裁剪后：");

// 对照：不播放、不拖动，直接裁
console.log("T5 说明：若 T4 宽度没变而 T3 命中不是 sr-clip-resize，则手柄被挡/未渲染。");
await browser.close();
