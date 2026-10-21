/**
 * voice-conversation S6 · 真实主模型 3 轮（自起 worktree 桥 8897，真 codex app-server、
 * 真 [voice_turn] 注入 + VOICE_CALL_RULES，不 mock 回答）。
 *
 * 验收：①「你好」类 ≤2 句（brief 口径）；②「你为什么不说话」类 ≤2 句且不自报状态；
 * ③「详细说」后 ≥3 句（detail 口径）。口径 = lib/speech-text 的 speechSentences（同一套
 * 截断/清洗），即用户耳朵里真正会听到的句数。
 *
 * 写盘只在 /tmp fixture；模型消耗 3 个极短回合。用法：
 * node tests/e2e/voice-real-model-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { speechSentences } from "../../src/lib/speech-text.ts";

const PORT = 8897;
const BRIDGE = `http://127.0.0.1:${PORT}`;
const HOME = "/tmp/sr-voice-real/home";
const WS = "/tmp/sr-voice-real/ws";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(WS, { recursive: true });

const bridgeProc = spawn(process.execPath, ["tools/agent-bridge.mjs"], {
  cwd: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."),
  env: { ...process.env, SHADOWROOM_AGENT_PORT: String(PORT), SHADOWROOM_HOME: HOME, SHADOWROOM_AGENT_CWD: WS },
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridgeProc.stdout.on("data", (chunk) => (bridgeLog += chunk));
bridgeProc.stderr.on("data", (chunk) => (bridgeLog += chunk));
for (let i = 0; i < 90; i += 1) {
  try {
    const response = await fetch(`${BRIDGE}/api/agent/health`);
    if (response.ok && (await response.json()).ok === true) break;
  } catch {
    if (i > 0 && i % 15 === 0) console.log(`[wait] bridge 未起 (${i}s)\n${bridgeLog.slice(-300)}`);
    if (i > 0 && i % 15 === 0 && bridgeProc.exitCode !== null) {
      console.log(`[fatal] bridge 进程退出 code=${bridgeProc.exitCode}\n${bridgeLog.slice(-800)}`);
      process.exit(1);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

/** 与 App.submit 的语音注入同格式（S5 contract 的回放）。 */
const voiceTurnBlock = (mode) => [
  "",
  "[voice_turn]",
  `mode: ${mode}`,
  `budget: ${mode === "brief" ? "2 句 / 70 字" : "8 句 / 360 字"}`,
  "[/voice_turn]",
  "（语音通话回合：朗读版只取前 1–2 句口语结论；第一句直接给回答或结论；不播报页面、数量、切换历史；不自报职责边界；最多一个追问；屏幕上可以有完整内容。）",
].join("\n");

async function askTurn(sessionId, userText, mode) {
  const response = await fetch(`${BRIDGE}/api/agent/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      text: `${userText}${voiceTurnBlock(mode)}`,
      scope: "butler",
      settings: { access: "workspace-write" },
    }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).split("\n").find((entry) => entry.startsWith("data: "));
      if (line !== undefined) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "delta") text += event.text;
        } catch { /* skip */ }
      }
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
  }
  return text;
}

const clean = (text) => text.replace(/\s+/g, " ").slice(0, 90);

// ① 「你好」：brief ≤2 句。
const helloAnswer = await askTurn("voice-real-1", "你好", "brief");
const helloSentences = speechSentences(helloAnswer, "brief");
check(
  "M1 「你好」≤2 句（brief 口径）",
  helloSentences.length <= 2,
  `句=${helloSentences.length} 「${clean(helloSentences.join(" "))}」`,
);

// ② 「你为什么不说话」：≤2 句且不自报状态/职责。
const whyAnswer = await askTurn("voice-real-1", "刚才那轮你为什么不说话", "brief");
const whySentences = speechSentences(whyAnswer, "brief");
const selfReport = ["我只", "我不会", "职责", "我在：", "你正停在"].filter((mark) => whyAnswer.includes(mark));
check(
  "M2 「你为什么不说话」≤2 句且不自报状态",
  whySentences.length <= 2 && selfReport.length === 0,
  `句=${whySentences.length} 自报=${JSON.stringify(selfReport)} 「${clean(whySentences.join(" "))}」`,
);

// ③ 「详细说」：detail ≥3 句。
const detailAnswer = await askTurn("voice-real-1", "详细说说做一首歌你能帮我到哪一步", "detail");
const detailSentences = speechSentences(detailAnswer, "detail");
check(
  "M3 「详细说」后 ≥3 句（detail 口径）",
  detailSentences.length >= 3,
  `句=${detailSentences.length} 「${clean(detailSentences.join(" "))}」`,
);

bridgeProc.kill("SIGTERM");
rmSync(HOME, { recursive: true, force: true });
rmSync(WS, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL PASS (${results.length}/${results.length})` : `\nFAILED ${failed}/${results.length}${failed > 0 ? `\nbridge log:\n${bridgeLog.slice(-600)}` : ""}`);
process.exit(failed === 0 ? 0 : 1);
