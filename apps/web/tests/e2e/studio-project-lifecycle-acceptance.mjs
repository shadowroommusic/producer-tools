/**
 * Studio project lifecycle: the paths a producer uses before touching audio.
 *
 * This suite is isolated to a throwaway browser profile and mocks every bridge call. It checks
 * project list actions, project/track naming, per-project undo, track creation/deletion and the
 * zero-track project state without writing user projects or calling a model.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const BASE = process.env.STUDIO_LIFECYCLE_BASE ?? "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const track = (id, name) => ({
  id,
  name,
  muted: false,
  soloed: false,
  volume: 68,
  type: "instrument",
  color: 0,
  clips: [],
});
const project = (id, name, tracks = []) => ({
  id,
  name,
  updatedAt: id === "project-a" ? 2 : 1,
  bpm: 124,
  key: "8A",
  bars: 16,
  tracks,
  sections: [],
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "GET" && url.pathname === "/api/servers") {
    await route.fulfill({ json: { servers: [], home: "/tmp", workspaces: "/tmp" } });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/api/agent/health") {
    await route.fulfill({
      json: {
        ok: false,
        threads: 0,
        cwd: "/tmp",
        sandbox: "workspace-write",
        approval: "never",
        plugins: [],
      },
    });
    return;
  }
  await route.fulfill({ json: {} });
});

const seed = async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((projects) => {
    localStorage.setItem("shadowroom.view", "studio");
    localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects }));
    localStorage.setItem("shadowroom.studio.open", "");
    localStorage.setItem(
      "shadowroom.dock.by-view.v1",
      JSON.stringify({ workbench: false, studio: false, dj: false, library: false }),
    );
    localStorage.removeItem("shadowroom.orb.position");
  }, [
    project("project-a", "Project A", [track("track-a", "Lead A")]),
    project("project-b", "Project B", [track("track-b", "Lead B")]),
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sr-project-list");
};

const readProjects = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}").projects ?? []);

await seed();

check(
  "① 工程列表完整显示两个工程和可用动作",
  (await page.locator(".sr-project-row").count()) === 2 &&
    (await page.getByRole("button", { name: "另存快照 Project A" }).isEnabled()) &&
    (await page.getByRole("button", { name: "删除 Project A" }).isEnabled()),
  `rows=${await page.locator(".sr-project-row").count()}`,
);

await page.getByRole("button", { name: "另存快照 Project A" }).click();
await page.waitForTimeout(150);
let stored = await readProjects();
check(
  "② 另存快照复制工程与轨道且生成新 id",
  stored.length === 3 &&
    stored.some((entry) => entry.name.includes("Project A") && entry.id !== "project-a" && entry.tracks[0]?.name === "Lead A"),
  stored.map((entry) => `${entry.id}:${entry.name}`).join(" | "),
);

await page.getByRole("button", { name: /^Project A 124 BPM/ }).click();
await page.waitForSelector(".sr-studio-grid");
await page.getByRole("button", { name: "Project A", exact: true }).click();
const projectName = page.getByLabel("工程名");
await projectName.fill("Project A Renamed");
await projectName.press("Enter");
await page.waitForTimeout(150);
stored = await readProjects();
check(
  "③ 工程改名立即落盘",
  stored.find((entry) => entry.id === "project-a")?.name === "Project A Renamed",
  stored.find((entry) => entry.id === "project-a")?.name ?? "(missing)",
);

const keyInput = page.getByLabel("调性", { exact: true });
await keyInput.click();
await keyInput.press("Meta+A");
await keyInput.type("9B");
await page.locator("body").click({ position: { x: 700, y: 120 } });
await page.getByRole("button", { name: "撤销", exact: true }).click();
await page.waitForTimeout(150);
check(
  "③b 调性逐字输入只占一步撤销",
  (await page.getByLabel("调性", { exact: true }).inputValue()) === "8A",
  `key=${await page.getByLabel("调性", { exact: true }).inputValue()}`,
);

const trackName = page.getByLabel("音轨名称").first();
await trackName.click();
await trackName.press("Meta+A");
await trackName.type("Lead A Renamed");
await page.waitForTimeout(120);
await page.locator("body").click({ position: { x: 700, y: 120 } });
await page.getByRole("button", { name: "撤销", exact: true }).click();
await page.waitForTimeout(150);
check(
  "④ 轨道改名可撤销，且不把另一个工程一起吃回去",
  (await page.getByLabel("音轨名称").first().inputValue()) === "Lead A" &&
    (await readProjects()).find((entry) => entry.id === "project-b")?.name === "Project B",
  `track=${await page.getByLabel("音轨名称").first().inputValue()}`,
);

await page.getByRole("button", { name: "音轨", exact: true }).click();
await page.getByRole("menuitem", { name: /鼓/ }).click();
await page.waitForTimeout(150);
check(
  "⑤ 新建鼓轨后工程从 1 轨变为 2 轨",
  (await page.locator(".sr-track-head").count()) === 2 &&
    (await page.getByLabel("音轨名称").nth(1).inputValue()).includes("Drums"),
  `tracks=${await page.locator(".sr-track-head").count()}`,
);

const remove = page.getByRole("button", { name: /删除 Drums/ });
await remove.click();
const armed = await remove.getAttribute("data-armed");
await remove.click();
await page.waitForTimeout(150);
const afterDelete = await page.locator(".sr-track-head").count();
await page.getByRole("button", { name: "撤销", exact: true }).click();
await page.waitForTimeout(150);
check(
  "⑥ 轨道删除需要二次确认，撤销可完整恢复",
  armed !== null && afterDelete === 1 && (await page.locator(".sr-track-head").count()) === 2,
  `armed=${armed} afterDelete=${afterDelete} afterUndo=${await page.locator(".sr-track-head").count()}`,
);

await page.getByRole("button", { name: "‹ 工程", exact: true }).click();
await page.waitForSelector(".sr-project-list");
await page.getByRole("button", { name: "删除 Project B" }).click();
await page.waitForTimeout(150);
stored = await readProjects();
check(
  "⑦ 删除工程只移除目标工程",
  !stored.some((entry) => entry.id === "project-b") && stored.some((entry) => entry.id === "project-a"),
  stored.map((entry) => entry.name).join(" | "),
);

await page.locator(".sr-project-new").click();
await page.waitForSelector(".sr-studio-grid");
check(
  "⑧ 新建工程进入零轨工作区且仍显示空态入口",
  (await page.locator(".sr-track-head").count()) === 0 &&
    (await page.getByRole("button", { name: "让管家来做" }).count()) === 1,
  `tracks=${await page.locator(".sr-track-head").count()}`,
);

check("⑨ 零 Console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
