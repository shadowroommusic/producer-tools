/**
 * Studio's product promise, end to end with real services:
 * an empty project becomes a playable multi-part arrangement from one natural-language sentence,
 * then one spoken-style edit changes only the named part.
 *
 * This intentionally uses the live 5173/8788/8787 stack and a real model. It writes only a throwaway
 * browser project; audio outputs stay in the normal recordings directory as the generator intends.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.STUDIO_NL_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/studio-natural-language";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const project = {
  id: "project-natural-language",
  name: "自然语言多轨生成验收",
  updatedAt: 1,
  bpm: 120,
  key: "8A",
  bars: 8,
  tracks: [],
  sections: [],
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text().slice(0, 240));
});

await page.addInitScript((seed) => {
  localStorage.setItem("shadowroom.view", "studio");
  localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({ projects: [seed] }));
  localStorage.setItem("shadowroom.studio.open", seed.id);
  localStorage.setItem(
    "shadowroom.dock.by-view.v1",
    JSON.stringify({ workbench: false, studio: true, dj: false, library: false }),
  );
  localStorage.removeItem("shadowroom.orb.position");
}, project);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-studio-grid", { timeout: 20_000 });
if ((await page.locator(".sr-dock").count()) === 0) await page.locator(".sr-dock-rail-btn").click();
await page.locator(".sr-dock .sr-composer-input").waitFor({ timeout: 10_000 });

const readProject = () =>
  page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}");
    return store.projects?.find((entry) => entry.id === "project-natural-language") ?? null;
  });

const expansionPrompt =
  "在这个空工程里生成一段 4 小节、122 BPM 的 tech house demo。" +
  "至少要有 Drums、Bass、Chords 三个声部，每个声部都要真实渲染成音频放到时间线；" +
  "用一次 render_song 完成，并返回实际轨道和片段。";
await page.locator(".sr-dock .sr-composer-input").fill(expansionPrompt);
await page.locator(".sr-dock .sr-composer-input").press("Enter");
await page.waitForFunction(
  () => document.querySelector(".sr-dock .sr-send")?.getAttribute("aria-label") === "停止这一轮",
  undefined,
  { timeout: 20_000 },
);
await page.waitForFunction(
  () => {
    const store = JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}");
    const project = store.projects?.find((entry) => entry.id === "project-natural-language");
    const clips = (project?.tracks ?? []).flatMap((track) => track.clips ?? []);
    return project && (project.tracks?.length ?? 0) >= 3 && clips.filter((clip) => clip.source).length >= 3;
  },
  undefined,
  { timeout: 240_000 },
);
await page.waitForFunction(
  () => document.querySelector(".sr-dock .sr-send")?.getAttribute("aria-label") === "发送",
  undefined,
  { timeout: 60_000 },
);

const created = await readProject();
const tracks = created?.tracks ?? [];
const names = tracks.map((track) => track.name);
const audioClips = tracks.flatMap((track) => track.clips ?? []).filter((clip) => typeof clip.source === "string" && clip.source !== "");
const expandPaths = audioClips.map((clip) =>
  clip.source.startsWith("~/") ? join(homedir(), clip.source.slice(2)) : clip.source,
);
check(
  "① 一句自然语言从空工程生成 Drums/Bass/Chords 多轨工程",
  created?.bpm === 122 &&
    tracks.length >= 3 &&
    ["Drums", "Bass", "Chords"].every((name) => names.includes(name)) &&
    audioClips.length >= 3,
  JSON.stringify({ bpm: created?.bpm, bars: created?.bars, names, audioClips: audioClips.length }),
);
check(
  "② 三个声部都指向真实存在的音频文件",
  expandPaths.length >= 3 && expandPaths.slice(0, 3).every((path) => existsSync(path)),
  JSON.stringify(expandPaths.slice(0, 3)),
);

await page.locator(".sr-transport-play").click();
await page.waitForTimeout(800);
const playing = (await page.locator(".sr-transport-play").getAttribute("aria-label")) === "暂停";
check(
  "③ 生成后的多轨工程可以直接播放",
  playing,
  `transport=${await page.locator(".sr-transport-play").getAttribute("aria-label")}`,
);
await page.locator(".sr-transport-play").click();

const before = new Map(
  tracks.map((track) => [track.name, track.clips?.find((clip) => clip.source)?.source ?? ""]),
);
const editPrompt =
  "只修改 Bass 这一轨：把 cutoff 调低让音色更暗，gain 稍微加重；" +
  "调用 regenerate_part 重渲染 Bass，保留其余轨道和它们的位置，别重做整首歌。";
await page.locator(".sr-dock .sr-composer-input").fill(editPrompt);
await page.locator(".sr-dock .sr-composer-input").press("Enter");
await page.waitForFunction(
  () => document.querySelector(".sr-dock .sr-send")?.getAttribute("aria-label") === "停止这一轮",
  undefined,
  { timeout: 20_000 },
);
await page.waitForFunction(
  (oldBass) => {
    const store = JSON.parse(localStorage.getItem("shadowroom.studio.projects.v1") ?? "{}");
    const project = store.projects?.find((entry) => entry.id === "project-natural-language");
    const bass = project?.tracks?.find((track) => track.name === "Bass");
    const source = bass?.clips?.find((clip) => clip.source)?.source ?? "";
    return source !== "" && source !== oldBass;
  },
  before.get("Bass") ?? "",
  { timeout: 240_000 },
);
await page.waitForFunction(
  () => document.querySelector(".sr-dock .sr-send")?.getAttribute("aria-label") === "发送",
  undefined,
  { timeout: 60_000 },
);

const edited = await readProject();
const editedTracks = edited?.tracks ?? [];
const after = new Map(
  editedTracks.map((track) => [track.name, track.clips?.find((clip) => clip.source)?.source ?? ""]),
);
check(
  "④ 自然语言只重渲染 Bass，Drums/Chords 和轨道集合保持不动",
  editedTracks.length === tracks.length &&
    after.get("Bass") !== before.get("Bass") &&
    after.get("Drums") === before.get("Drums") &&
    after.get("Chords") === before.get("Chords"),
  JSON.stringify({
    before: Object.fromEntries(before),
    after: Object.fromEntries(after),
  }),
);

const notices = await page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("shadowroom.sessions.v1") ?? "{}");
  return (store.sessions ?? [])
    .filter((entry) => entry.kind === "studio")
    .flatMap((entry) => entry.messages ?? [])
    .filter((message) => message.role === "notice")
    .map((message) => `${message.title}: ${message.text}`);
});
check(
  "⑤ 自然语言操作没有失败通知，Console error 为 0",
  notices.every((line) => !/失败|没成功|出错/.test(line)) && errors.length === 0,
  JSON.stringify({ notices: notices.slice(-4), errors: errors.slice(0, 3) }),
);

await page.screenshot({ path: `${SHOTS}/natural-language-project.png` });
console.log(
  JSON.stringify(
    {
      projectId: edited?.id,
      bpm: edited?.bpm,
      bars: edited?.bars,
      tracks: editedTracks.map((track) => ({
        name: track.name,
        clips: track.clips.length,
        source: track.clips.find((clip) => clip.source)?.source ?? null,
      })),
    },
    null,
    2,
  ),
);

await browser.close();
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
