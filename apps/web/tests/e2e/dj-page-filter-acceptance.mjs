import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const BRIDGE = "http://127.0.0.1:8787";
async function callTool(server, tool, args) {
  const r = await fetch(`${BRIDGE}/api/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server, tool, arguments: args }) });
  const d = await r.json();
  return typeof d.result === "string" ? JSON.parse(d.result) : d.result;
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
await page.addInitScript(() => window.localStorage.setItem("shadowroom.view", "dj"));
await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj", { timeout: 30000 });
await page.waitForTimeout(1800);
for (const query of ["lofi", "voice", "bass"]) {
  await page.getByLabel("搜索").fill(query);
  await page.waitForTimeout(900); // 250ms 防抖 + 查询
  // .sr-dj-count 现在有四处（set 看板/set 列表/曲目库/推荐）——范围锁到曲目库那一个
  const text = await page.locator(".sr-dj-library .sr-dj-count").innerText();
  const ui = Number((text.match(/共\s*(\d+)/) ?? [])[1]);
  const bridgeRows = (await callTool("library", "list_tracks", { query, limit: 200 })).tracks.length;
  console.log(`${ui === bridgeRows ? "PASS" : "FAIL"}  筛选「${query}」：UI ${text} vs bridge ${bridgeRows} 行`);
}
await browser.close();
