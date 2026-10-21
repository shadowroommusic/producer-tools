/**
 * Studio waveform fallback for audio that has no stored library peaks (FLAC in the real library).
 * The browser must decode the file itself and still draw a playable waveform instead of a black box.
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const fixtureDir = mkdtempSync(join(tmpdir(), "shadowroom-wave-fallback-"));
const fixturePath = join(fixtureDir, "fallback.wav");
const seconds = 4;
const sampleRate = 44100;
const samples = seconds * sampleRate;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples * 2, 40);
for (let index = 0; index < samples; index += 1) {
  const envelope = 0.35 + 0.3 * Math.sin((2 * Math.PI * index) / sampleRate);
  wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 32767 * envelope), 44 + index * 2);
}
writeFileSync(fixturePath, wav);

const BPM = 128;
const barMs = (60000 / BPM) * 4;
const durationMs = seconds * 1000;
const bars = Math.max(4, Math.ceil(durationMs / barMs) + 2);
const project = {
  id: "project-wave-fallback",
  name: "无库 peaks 波形回退验收",
  updatedAt: Date.now(),
  bpm: BPM,
  key: "8A",
  bars,
  tracks: [
    {
      id: "track-wave-fallback",
      name: "Audio",
      muted: false,
      soloed: false,
      volume: 80,
      type: "audio",
      color: 0,
      clips: [
        {
          id: "clip-wave-fallback",
          name: "fallback.wav",
          start: 0,
          length: Math.max(1, durationMs / barMs),
          source: fixturePath,
          duration_ms: durationMs,
        },
      ],
    },
  ],
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
await page.addInitScript(
  ({ projectJson }) => {
    window.__decodeCount = 0;
    const original = window.AudioContext.prototype.decodeAudioData;
    window.AudioContext.prototype.decodeAudioData = function (...args) {
      window.__decodeCount += 1;
      return original.apply(this, args);
    };
    localStorage.setItem("shadowroom.view", "studio");
    localStorage.setItem("shadowroom.studio.projects.v1", projectJson);
    localStorage.setItem("shadowroom.studio.open", "project-wave-fallback");
    localStorage.removeItem("shadowroom.dock");
  },
  { projectJson: JSON.stringify({ projects: [project] }) },
);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-clip-wave i", { timeout: 30000 });
await page.waitForTimeout(500);

const barsRendered = await page.locator(".sr-clip-wave i").count();
const decodeCount = await page.evaluate(() => window.__decodeCount);
check(
  "① 没有库 peaks 时走浏览器解码回退",
  barsRendered === 96 && decodeCount > 0,
  `bars=${barsRendered}, decodeAudioData=${decodeCount}, file=${fixturePath}`,
);
check("② 波形回退零 Console error", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

await browser.close();
rmSync(fixtureDir, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
