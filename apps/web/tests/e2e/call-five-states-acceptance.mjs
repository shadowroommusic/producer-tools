/**
 * 通话五态验收（F-1，Codex 2026-10-16）：真通话路径 + 假麦克风 + 桩化 STT。
 *
 * 为什么这么测：unclear/offline 只在**回合制（桥式）STT**下才可能发生——端点检测收回合、
 * 请求转写、转写回空或报错。所以这里：真起通话（点击悬浮球 → 真麦克风采集 → 真端点检测），
 * 只把 POST /api/agent/providers/stt 换成桩：回空串 = 没听清；回 500 = 断线。
 * 不走真模型、不花 token、不碰网络。
 *
 * 覆盖（Kimi F-1 验收判据）：
 *  ① unclear 出现：data-mode=unclear + 字幕「没听清，再说一遍？」+ 状态点 unclear + 有「改成打字」
 *  ② unclear 自动回退：2.5s 后回 listening（不是一闪而过的 notice；实测落在 2.0–3.2s 窗里）
 *  ③ 点球重说：unclear 里点球 → ≤300ms 回 listening，且回退闹钟已清（O-5）
 *  ④ offline：转写报错 → 1s 内不再显示「在听」，字幕 ≤12 字，点球重连 ≤300ms 回 listening
 *  ⑤ 四条退出路径的定时器：unclear 里走「结束通话」→ 闹钟立即清、3s 后球仍 idle（不偷跑）
 *  ⑥ 「改成打字」：挂断 + 聚焦对话栏输入框（非语音 fallback，deepseek O-3）
 *
 * 前置：5173 dev server 在跑（SOUNDS 同款）。用法：node tests/e2e/call-five-states-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.CALL5_E2E_BASE ?? "http://localhost:5173";
const SHOTS = "/Users/lazora/Documents/ShadowRoom/exports/call-states";
const UNCLEAR_HOLD_MS = 2500;

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

mkdirSync(SHOTS, { recursive: true });

/**
 * 假麦克风音频：0–0.9s 一个 440Hz 的响音（RMS≈0.42 > 端点阈值 0.1），之后一路静音。
 * 文件循环播放，但一整个循环 12s——每个用例在第二次爆发之前就断言完，互不干扰。
 */
function burstWav(seconds = 12, rate = 44100) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < Math.floor(0.9 * rate); i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 19660), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const tmp = mkdtempSync(join(tmpdir(), "call5-e2e-"));
const MIC = join(tmp, "burst.wav");
writeFileSync(MIC, burstWav());

/** 与 call-live-acceptance 同形：STT 角色配在 MiniMax 上，协议走「按端点认家」。 */
const settings = {
  version: 3,
  providers: [
    {
      id: "minimax",
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.com/v1",
      credentialRef: "miniamx",
      endpointFormat: "chat_completions",
      enabled: true,
      presetSource: "minimax",
      models: ["MiniMax-M3"],
      modelProfiles: {},
      capabilities: {
        stt: { protocol: "custom_endpoint", baseUrl: "https://api.minimaxi.com", models: ["asr-1.0"] },
        tts: { protocol: "custom_endpoint", baseUrl: "https://api.minimaxi.com", models: ["speech-2.8-hd"] },
      },
    },
  ],
  roles: {
    agent: null,
    tts: { providerId: "minimax", capability: "tts", model: "speech-2.8-hd" },
    voice_clone: null,
    stt: { providerId: "minimax", capability: "stt", model: "asr-1.0" },
    image: null,
    music: null,
  },
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${MIC}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** 每个用例一个新页面：假麦克风的爆发在「采集开始」那一刻，重开页面才拿得到干净的第一回合。 */
async function freshPage() {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] })).newPage();
  await page.addInitScript((seed) => {
    window.localStorage.setItem("shadowroom.view", "studio");
    window.localStorage.setItem("shadowroom.models.v1", JSON.stringify(seed));
    window.localStorage.removeItem("shadowroom.studio.open");
  }, settings);
  return page;
}

let stub = { kind: "empty" };
const sttCalls = [];

async function armStub(page) {
  await page.route("**/api/agent/providers/stt", async (route) => {
    sttCalls.push(stub.kind);
    if (stub.kind === "empty") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "" }) });
      return;
    }
    if (stub.kind === "error") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "识别失败（HTTP 500）" }) });
      return;
    }
    await route.abort("failed");
  });
}

/** 点球开始通话，等「第一个回合被识别处理完」——即某个异常态或回到聆听。 */
async function startCallAndReach(page, want, timeoutMs = 12000) {
  await page.locator(".sr-orb-ball").click();
  await page.waitForFunction(
    (target) => document.querySelector(".sr-orb")?.getAttribute("data-mode") === target,
    want,
    { timeout: timeoutMs },
  ).catch(() => undefined);
  return page.locator(".sr-orb").getAttribute("data-mode");
}

const mode = (page) => page.locator(".sr-orb").getAttribute("data-mode");
const caption = (page) => page.locator("[data-call-caption]").innerText().catch(() => "");

try {
  // ======================= ① 没听清（unclear）出现 =======================
  {
    stub = { kind: "empty" };
    const page = await freshPage();
    await armStub(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
    const reached = await startCallAndReach(page, "unclear");
    const detail = await page.evaluate(() => ({
      mode: document.querySelector(".sr-orb")?.getAttribute("data-mode"),
      dot: document.querySelector(".sr-orb-caption-dot")?.getAttribute("data-state"),
      text: document.querySelector("[data-call-caption]")?.textContent ?? "",
      action: document.querySelector("[data-caption-action]")?.textContent ?? null,
    }));
    check(
      "① 转写回空 → unclear（琥珀晃 + 字幕 + 「改成打字」）",
      reached === "unclear" && detail.dot === "unclear" && detail.text.includes("没听清") && detail.action === "改成打字",
      `data-mode=${reached} 点=${detail.dot} 字幕=「${detail.text.trim()}」 按钮=${detail.action}（stt 调用 ${sttCalls.length} 次）`,
    );
    await page.screenshot({ path: `${SHOTS}/unclear.png` });
    await page.context().close();
  }

  // ======================= ② unclear 自动回退（2.5s） =======================
  {
    stub = { kind: "empty" };
    const page = await freshPage();
    await armStub(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
    await startCallAndReach(page, "unclear");
    const t0 = Date.now();
    await page.waitForFunction(
      () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
      undefined,
      { timeout: UNCLEAR_HOLD_MS + 2000 },
    ).catch(() => undefined);
    const heldMs = Date.now() - t0;
    const armed = await page.evaluate(() => window.__callProbe?.unclearArmed() ?? null);
    check(
      "② unclear 2.5s 后自己回聆听（不是一闪而过）",
      (await mode(page)) === "listening" && heldMs >= 2000 && heldMs <= 3400 && armed === false,
      `停留 ${heldMs}ms（线 2500ms±900），回退后闹钟=${armed}`,
    );
    await page.context().close();
  }

  // ======================= ③ 点球 = 重说（≤300ms） =======================
  {
    stub = { kind: "empty" };
    const page = await freshPage();
    await armStub(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
    await startCallAndReach(page, "unclear");
    const t0 = Date.now();
    await page.locator(".sr-orb-ball").click();
    await page.waitForFunction(
      () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
      undefined,
      { timeout: 2000 },
    ).catch(() => undefined);
    const ms = Date.now() - t0;
    const armed = await page.evaluate(() => window.__callProbe?.unclearArmed() ?? null);
    check(
      "③ unclear 里点球 = 重说（≤300ms 且闹钟已清）",
      (await mode(page)) === "listening" && ms <= 300 && armed === false,
      `点球→聆听 ${ms}ms，闹钟=${armed}`,
    );
    await page.context().close();
  }

  // ======================= ④ 断线（offline）+ 点球重连 =======================
  {
    stub = { kind: "error" };
    const page = await freshPage();
    await armStub(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
    const reached = await startCallAndReach(page, "offline");
    const text = (await caption(page)).trim();
    const dot = await page.locator(".sr-orb-caption-dot").getAttribute("data-state").catch(() => null);
    await page.screenshot({ path: `${SHOTS}/offline.png` });
    const t0 = Date.now();
    await page.locator(".sr-orb-ball").click();
    await page.waitForFunction(
      () => document.querySelector(".sr-orb")?.getAttribute("data-mode") === "listening",
      undefined,
      { timeout: 2000 },
    ).catch(() => undefined);
    const ms = Date.now() - t0;
    const notice = await page.locator(".sr-voicebar-notice").count();
    check(
      "④ 转写报错 → offline（字幕 ≤12 字）→ 点球重连 ≤300ms",
      reached === "offline" && text.length <= 12 && dot === "offline" && (await mode(page)) === "listening" && ms <= 300 && notice === 0,
      `data-mode=${reached} 字幕=「${text}」(${text.length} 字) 点=${dot} 重连 ${ms}ms，重连后错误行 ${notice} 条`,
    );
    await page.context().close();
  }

  // ======================= ⑤ 挂断清闹钟（四条退出路径之①/②） =======================
  {
    stub = { kind: "empty" };
    const page = await freshPage();
    await armStub(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
    await startCallAndReach(page, "unclear");
    await page.locator(".sr-voicebar-end").click();
    const armed = await page.evaluate(() => window.__callProbe?.unclearArmed() ?? null);
    const idleNow = (await mode(page)) === "idle";
    await page.waitForTimeout(3000);
    const late = await page.evaluate(() => ({
      mode: document.querySelector(".sr-orb")?.getAttribute("data-mode"),
      armed: window.__callProbe?.unclearArmed() ?? null,
      caption: document.querySelector("[data-call-caption]")?.textContent ?? "",
    }));
    check(
      "⑤ unclear 里「结束通话」→ 闹钟立刻清、3s 后不偷跑、提示不残留",
      armed === false && idleNow && late.mode === "idle" && late.armed === false && late.caption.trim() === "",
      `挂断瞬间闹钟=${armed} 球=${idleNow ? "idle" : "非 idle"}；3s 后 mode=${late.mode} 闹钟=${late.armed} 字幕=「${late.caption.trim()}」`,
    );
    await page.context().close();
  }

  // ======================= ⑥ 改成打字（非语音出口） =======================
  {
    stub = { kind: "empty" };
    const page = await freshPage();
    await armStub(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator(".sr-orb-ball").waitFor({ timeout: 20000 });
    await startCallAndReach(page, "unclear");
    await page.locator("[data-caption-action]").click();
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      mode: document.querySelector(".sr-orb")?.getAttribute("data-mode"),
      focused: document.activeElement?.className ?? "",
      caption: document.querySelector("[data-call-caption]")?.textContent ?? "",
      armed: window.__callProbe?.unclearArmed() ?? null,
    }));
    check(
      "⑥「改成打字」→ 挂断 + 聚焦对话栏输入框",
      after.mode === "idle" && after.focused.includes("sr-composer-input") && after.armed === false && !after.caption.includes("没听清"),
      `球=${after.mode} 焦点=${after.focused || "(无)"} 闹钟=${after.armed}`,
    );
    await page.context().close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} ${failed === 0 ? "PASS" : "FAIL"}`);
process.exit(failed === 0 ? 0 : 1);
