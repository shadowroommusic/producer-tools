/**
 * DJ real-media acceptance independent of the removable drive.
 *
 * Creates two short FLAC fixtures, indexes them through the real library bridge, then drives the
 * real DJ page: select a track, wait for a decoded waveform, play it, switch tracks, and verify that
 * the newer waveform wins. The fixture rows and files are removed on every exit path.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DJ_LOCAL_MEDIA_BASE ?? "http://127.0.0.1:5173";
const BRIDGE = process.env.DJ_LOCAL_MEDIA_BRIDGE ?? "http://127.0.0.1:8787";
const RECORDINGS = "/Users/lazora/Documents/ShadowRoom/recordings";
const DB = "/Users/lazora/Documents/ShadowRoom/_library/library.db";
const fixtureDir = mkdtempSync("/tmp/shadow-dj-local-media.");
let indexed = false;

process.once("exit", () => {
  if (indexed) {
    try {
      execFileSync("python3", [
        "-c",
        "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('DELETE FROM tracks WHERE path LIKE ?',(sys.argv[2]+'/%',)); db.commit()",
        DB,
        fixtureDir,
      ]);
    } catch {
      // The next normal scan can re-index a fixture; stale rows still keep the test diagnosable.
    }
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function callTool(server, tool, args) {
  const response = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
  if (!response.ok) throw new Error(`bridge HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.isError === true) throw new Error(String(payload.result));
  return typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
}

execFileSync("/usr/bin/afconvert", [
  "-f",
  "flac",
  "-d",
  "flac",
  join(RECORDINGS, "tech-house-demo-122-drums.wav"),
  join(fixtureDir, "local-drums.flac"),
]);
execFileSync("/usr/bin/afconvert", [
  "-f",
  "flac",
  "-d",
  "flac",
  join(RECORDINGS, "tech-house-demo-122-bass.wav"),
  join(fixtureDir, "local-bass.flac"),
]);

const start = await callTool("library", "scan_folder", { path: fixtureDir });
indexed = true;
let job = await callTool("library", "scan_job_detail", { job_id: start.job_id });
const deadline = Date.now() + 30_000;
while (job.status === "running" && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  job = await callTool("library", "scan_job_detail", { job_id: start.job_id });
}
if (job.status !== "completed") throw new Error(`fixture scan failed: ${job.status} ${job.error ?? ""}`);

const tracksResult = await callTool("library", "list_tracks", { limit: 300 });
const tracks = (tracksResult.tracks ?? []).filter((track) => String(track.path).startsWith(`${fixtureDir}/`));
if (tracks.length !== 2) throw new Error(`expected 2 local fixture tracks, got ${tracks.length}`);
const [first, second] = tracks;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("requestfailed", (request) => errors.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ""}`));
await page.addInitScript(
  ({ ids }) => {
    localStorage.setItem("shadowroom.view", "dj");
    localStorage.setItem("shadowroom.dock", "closed");
    localStorage.setItem("shadowroom.orb.position", JSON.stringify({ x: 20, y: 420 }));
    localStorage.setItem(
      "shadowroom.setdraft",
      JSON.stringify({ id: "dj-local-media", name: "本地介质验收", trackIds: ids, overlapMs: 16000 }),
    );
  },
  { ids: [first.id, second.id] },
);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-dj-board", { timeout: 30_000 });

const selectBoardTrack = async (track) => {
  await page.locator(`.sr-dj-board .sr-dj-row[data-track-id="${track.id}"]`).click();
  await page.waitForFunction(
    ({ id }) => {
      const wave = document.querySelector(".sr-dj-wave-wrap");
      return wave?.getAttribute("data-track-id") === String(id) && wave.getAttribute("data-wave-state") === "ready";
    },
    { id: track.id },
    { timeout: 20_000 },
  );
};

await selectBoardTrack(first);
const firstWave = await page.locator(".sr-dj-wave-wrap").evaluate((root) => {
  const canvas = root.querySelector("canvas");
  return {
    id: root.getAttribute("data-track-id"),
    state: root.getAttribute("data-wave-state"),
    bars: Number(root.getAttribute("data-wave-bars")),
    width: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
    height: canvas instanceof HTMLCanvasElement ? canvas.height : 0,
  };
});
check(
  "① 本地 FLAC 被真实扫描并以 512 段解码为波形",
  firstWave.id === String(first.id) &&
    firstWave.state === "ready" &&
    firstWave.bars === 512 &&
    firstWave.width >= 1000 &&
    firstWave.height >= 48,
  JSON.stringify(firstWave),
);

const play = page.locator(".sr-dj-deck button[aria-label^='播放']");
await play.waitFor({ timeout: 20_000 });
await play.click();
await page.waitForFunction(() => document.querySelector(".sr-dj-deck")?.getAttribute("data-state") === "playing", null, {
  timeout: 10_000,
});
await page.waitForTimeout(1500);
const progress = await page.locator(".sr-dj-clock").innerText();
check("② 本地 FLAC 可播放且时钟真实推进", /^0:0[1-9]$/.test(progress.trim()), `clock=${progress.trim()}`);

await page.keyboard.press("Escape");
await selectBoardTrack(second);
const switched = await page.locator(".sr-dj-wave-wrap").evaluate((root) => ({
  id: root.getAttribute("data-track-id"),
  state: root.getAttribute("data-wave-state"),
  bars: Number(root.getAttribute("data-wave-bars")),
}));
check(
  "③ 快速切歌后新波形胜出，旧解码不回写",
  switched.id === String(second.id) && switched.state === "ready" && switched.bars === 512,
  JSON.stringify(switched),
);
check("④ 全程 Console error 0", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
