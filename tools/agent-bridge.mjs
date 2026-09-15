#!/usr/bin/env node
/**
 * Agent bridge: drives `codex app-server` and streams its events to the UI.
 *
 * The app-server speaks JSON-RPC over stdio; the browser cannot. This server owns that link and
 * exposes three endpoints:
 *
 *   GET  /api/agent/health   → is the core up, which model/sandbox/cwd it runs with
 *   POST /api/agent/send     → { sessionId, text } → an SSE stream of the turn's events
 *   POST /api/agent/interrupt→ { sessionId }
 *
 * One UI session maps to one Codex thread, created on the first message. Every thread is started
 * with the four ShadowRoom MCP servers injected, so the agent can drive the same tools the sidebar
 * panels call by hand.
 *
 * Configuration (all optional):
 *   SHADOWROOM_CODEX           path to the codex binary (default: the one inside the Codex app)
 *   SHADOWROOM_HOME            plugin checkouts (default ~/Documents/ShadowRoom)
 *   SHADOWROOM_AGENT_CWD       working directory threads start in (default: SHADOWROOM_HOME)
 *   SHADOWROOM_AGENT_SANDBOX   read-only | workspace-write | danger-full-access (default workspace-write)
 *   SHADOWROOM_AGENT_APPROVAL  untrusted | on-request | never (default never)
 *   SHADOWROOM_AGENT_PORT      default 8788
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const HOST = process.env.SHADOWROOM_AGENT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SHADOWROOM_AGENT_PORT ?? 8788);
const HOME = homedir();
const WORKSPACES = process.env.SHADOWROOM_HOME ?? join(HOME, "Documents", "ShadowRoom");
const AGENT_CWD = process.env.SHADOWROOM_AGENT_CWD ?? WORKSPACES;
const SANDBOX = process.env.SHADOWROOM_AGENT_SANDBOX ?? "workspace-write";
const APPROVAL = process.env.SHADOWROOM_AGENT_APPROVAL ?? "on-request";
const PYTHON = process.env.SHADOWROOM_PYTHON ?? "python3";
/** A plugin's own virtualenv, kept outside the checkouts: <WORKSPACES>/_venvs/<repo>. */
const VENVS = join(WORKSPACES, "_venvs");
/** Shared binaries (the imageio-ffmpeg symlink) that every plugin finds on PATH. */
const BIN = join(WORKSPACES, "bin");

/**
 * Which interpreter runs one plugin — the same rule as `tools/mcp-bridge.mjs`, so a plugin behaves
 * identically whether the panel or the agent calls it. Without this the separation model and the
 * downloader would have to share one interpreter with the four light plugins.
 */
function pythonFor(entry) {
  const override = process.env[`SHADOWROOM_PYTHON_${String(entry.id).toUpperCase()}`];
  if (override !== undefined && override !== "") return override;
  const candidates = [join(VENVS, entry.repo, "bin", "python"), join(resolve(WORKSPACES, entry.repo), ".venv", "bin", "python")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return PYTHON;
}

/** Environment for a plugin process: the shared `bin` first on PATH, plus unbuffered Python. */
function pluginEnv() {
  return {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH ?? ""}`,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}
const CODEX =
  process.env.SHADOWROOM_CODEX ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const INIT_TIMEOUT_MS = Number(process.env.SHADOWROOM_AGENT_INIT_TIMEOUT_MS ?? 60_000);
/** Where audio the browser records (voice turns, hummed melodies) is written. */
const RECORDINGS_DIR = process.env.SHADOWROOM_RECORDINGS_DIR ?? join(WORKSPACES, "recordings");
/** Where files the user drops into the studio are copied. */
const IMPORTS_DIR = process.env.SHADOWROOM_IMPORTS_DIR ?? join(WORKSPACES, "imports");
/** Uploads are read into memory as base64, so keep a ceiling: 512 MB of audio is a long DJ set. */
const MAX_IMPORT_BYTES = Number(process.env.SHADOWROOM_IMPORT_MAX_BYTES ?? 512 * 1024 * 1024);

/**
 * Where the studio looks for ffmpeg.
 *
 * The generator plugin installs one static binary at `<home>/bin/ffmpeg` (a symlink into the
 * imageio-ffmpeg wheel), which is why this is mostly a lookup rather than a dependency: recording is
 * the only thing the bridge itself needs an encoder for.
 */
function findFfmpeg() {
  if (process.env.SHADOWROOM_FFMPEG !== undefined && existsSync(process.env.SHADOWROOM_FFMPEG)) {
    return process.env.SHADOWROOM_FFMPEG;
  }
  const staged = join(WORKSPACES, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (existsSync(staged)) return staged;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory === "") continue;
    const candidate = join(directory, "ffmpeg");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `track.wav` → `track-2.wav` when the name is taken, so an import never overwrites a file. */
function uniqueName(directory, name) {
  if (!existsSync(join(directory, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existsSync(join(directory, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

/**
 * How long a WAV is, read from its own header.
 *
 * The bridge has no ffprobe (only the ffmpeg binary is staged), and after a conversion we control
 * exactly what was written — 16-bit PCM — so the byte rate and the data chunk size are all we need.
 * Returns 0 when the file is not a WAV we understand, which the caller reports as "unknown length"
 * rather than inventing a number.
 */
function wavDurationMs(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return 0;
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16) byteRate = buffer.readUInt32LE(body + 8);
    if (id === "data") {
      dataBytes = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (byteRate <= 0 || dataBytes <= 0) return 0;
  return Math.round((dataBytes / byteRate) * 1000);
}


/**
 * A local Responses→Chat adapter.
 *
 * This Codex build speaks only the Responses wire (`wire_api = "chat"` is rejected outright), while most
 * providers — MiniMax, DeepSeek, the whole OpenAI-compatible field — speak `/chat/completions`. So the
 * bridge runs a tiny server on loopback, points Codex at it, and translates in both directions:
 * Responses request → chat request, chat SSE deltas → Responses SSE events.
 *
 * Text and function calls both cross over: an agent that cannot call tools could not make music.
 */
async function startChatAdapter(provider, credential) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(credential === null ? {} : { authorization: `Bearer ${credential.value}` }), ...(provider.headers ?? {}) };
  const server = createServer(async (request, response) => {
    const send = (code, body, type = "application/json") => {
      response.writeHead(code, { "content-type": type });
      response.end(body);
    };
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        const answer = await fetch(`${base}/models`, { headers });
        send(answer.status, await answer.text());
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        send(404, JSON.stringify({ error: "adapter: only /v1/responses and /v1/models" }));
        return;
      }
      const body = JSON.parse((await readJsonBody(request, 8 * 1024 * 1024)) ?? "{}");
      /** Responses `input` items → chat messages. */
      const input = Array.isArray(body.input) ? body.input : [];
      const messages = [];
      if (typeof body.instructions === "string" && body.instructions !== "") messages.push({ role: "system", content: body.instructions });
      for (const item of input) {
        if (item?.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id, content: String(item.output ?? "") });
          continue;
        }
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = content.map((part) => part?.text ?? "").join("");
        if (item?.type === "function_call") {
          messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }] });
          continue;
        }
        messages.push({ role: item?.role === "assistant" ? "assistant" : "user", content: text });
      }
      const tools = Array.isArray(body.tools)
        ? body.tools
            .filter((tool) => tool?.type === "function")
            .map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } },
            }))
        : undefined;
      const chat = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: body.model,
          messages,
          stream: true,
          ...(tools === undefined || tools.length === 0 ? {} : { tools }),
          ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        }),
      });
      if (!chat.ok) {
        send(chat.status, await chat.text());
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const emit = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      const id = `resp-${Date.now().toString(36)}`;
      emit("response.created", { response: { id, model: body.model ?? "", status: "in_progress", output: [] } });
      let opened = false;
      let text = "";
      const calls = new Map();
      const reader = chat.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string" && delta.content !== "") {
            if (!opened) {
              opened = true;
              emit("response.output_item.added", { output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "in_progress", content: [] } });
            }
            text += delta.content;
            emit("response.output_text.delta", { item_id: "msg-1", output_index: 0, content_index: 0, delta: delta.content });
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            if (!calls.has(index)) {
              calls.set(index, { id: call.id ?? `call-${index}`, name: call.function?.name ?? "", arguments: "" });
              emit("response.output_item.added", { output_index: index + (opened ? 1 : 0), item: { id: call.id ?? `call-${index}`, type: "function_call", call_id: call.id ?? `call-${index}`, name: call.function?.name ?? "", arguments: "" } });
            }
            const state = calls.get(index);
            if (typeof call.function?.arguments === "string") {
              state.arguments += call.function.arguments;
              emit("response.function_call_arguments.delta", { item_id: state.id, output_index: index + (opened ? 1 : 0), delta: call.function.arguments });
            }
          }
        }
      }
      if (opened) {
        emit("response.output_text.done", { item_id: "msg-1", output_index: 0, content_index: 0, text });
        emit("response.output_item.done", { output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } });
      }
      for (const [index, call] of calls) {
        emit("response.output_item.done", { output_index: index + (opened ? 1 : 0), item: { id: call.id, type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments } });
      }
      emit("response.completed", { response: { id, model: body.model ?? "", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      response.end();
    } catch (error) {
      if (!response.headersSent) send(500, JSON.stringify({ error: String(error?.message ?? error) }));
      else response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  console.log(`[agent] chat adapter for ${provider.label} on http://127.0.0.1:${port}/v1`);
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

/**
 * A file name that is safe to write, without mangling the name.
 *
 * The first version replaced every non-ASCII character, so a recording called 「测试录音」 landed as
 * `_.wav` (measured). Path separators, control characters and the characters the Finder refuses are
 * the things worth removing — Chinese is not one of them.
 */
function safeFileName(name) {
  return name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
}

/**
 * Where model credentials live.
 *
 * Settings files (browser storage, project JSON) contain only the *name* of a credential. The value
 * lives here: one file only this OS user can read (`~/.shadowroom/credentials.json`, mode 0600, in a
 * 0700 directory), with an environment variable per credential winning over the file so a shell can
 * override without touching disk. The bridge is the only thing that ever reads a key — the browser
 * asks it to make the call instead of holding the secret itself.
 */
const CREDENTIALS_DIR = process.env.SHADOWROOM_CREDENTIALS_DIR ?? join(homedir(), ".shadowroom");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");

function credentialEnvName(reference) {
  return `SHADOWROOM_${reference.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function readCredentialFile() {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCredentialFile(map) {
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies the mode when it creates the file, so set it either way.
  chmodSync(CREDENTIALS_FILE, 0o600);
}

function masked(value) {
  return `••••••••${value.length > 4 ? value.slice(-4) : ""}`;
}

/** The stored credential for a reference, environment first. */
function resolveCredential(reference) {
  const env = credentialEnvName(reference);
  if (typeof process.env[env] === "string" && process.env[env] !== "") {
    return { value: process.env[env], source: "env", variable: env };
  }
  const stored = readCredentialFile()[reference];
  if (typeof stored === "string" && stored !== "") return { value: stored, source: "file" };
  return null;
}

const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One HTTP call to a provider, with the key attached the way that protocol expects. */
async function callProvider({ baseUrl, reference, protocol }, path, init) {
  const credential = reference === null || reference === undefined ? null : resolveCredential(reference);
  const headers = { ...(init?.headers ?? {}) };
  if (credential !== null && protocol !== "elevenlabs") headers.authorization = `Bearer ${credential.value}`;
  if (credential !== null && protocol === "elevenlabs") headers["xi-api-key"] = credential.value;
  const url = `${String(baseUrl).replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  return { response, credential };
}

/** Turn a failed provider response into a sentence the settings page can show as-is. */
async function providerFailure(response) {
  if (response.status === 401 || response.status === 403) return "Key 无效或没有权限";
  if (response.status === 404) return "端点或模型不存在";
  if (response.status === 429) return "请求太频繁（被限流了）";
  if (response.status >= 500) return "服务商那边出错了";
  const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
  return detail === "" ? `HTTP ${response.status}` : `HTTP ${response.status}：${detail}`;
}

/** Extensions the studio may stream into the browser (audio + MIDI, nothing executable). */
const STREAMABLE = new Map([
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".aif", "audio/aiff"],
  [".aiff", "audio/aiff"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".mid", "audio/midi"],
  [".midi", "audio/midi"],
]);

/** The plugins, injected into every thread so the agent has the same tools as the sidebar. */
const PLUGIN_REPOS = [
  "rekordbox-serato-bridge",
  "audio-analysis-dedupe",
  "set-planner",
  "shadow-music-generator",
  "stem-splitter",
  "ShadowMusicGrabber",
];

/**
 * House rules for every thread. The workbench is voice-first, so the agent has to know that a spoken
 * turn arrives with a recording and what to do with a hummed melody.
 */
const DEVELOPER_INSTRUCTIONS = [
  "你运行在 Shadow Producers 工作台里（给 DJ / 制作人用的桌面应用，界面以语音为主）。",
  "用户很可能用语音说话；每条语音消息会附带一段 WAV 录音的路径（作为附件给出）。",
  "当用户哼唱/唱一段旋律并想变成 MIDI 时：调用 audio-analysis-dedupe 的 hum_to_midi，path 就用那条录音路径。",
  "hum_to_midi 检测到的音符会自动变成 Studio 工程里的一个片段（带迷你钢琴卷），你只需用一句话说清你听到的音名和大致节奏。",
  "其它可用工具：set-planner（set 计时与下一首推荐）、shadow-music-generator（生成任务队列，默认 dry-run，不跑模型）、rekordbox-serato-bridge（Rekordbox ⇄ Serato 曲库、cue、颜色转换）。",
  "当用户想\"做一首歌 / 一段 beat / 一段 loop\"时，用 shadow-music-generator 的 render_song **真的渲染出音频**：out_path 放在 ~/Documents/ShadowRoom/recordings/<歌名>.wav，bpm 和 bars 按用户要求，parts 里每一项是一个声部 —— 鼓用 16 步 pattern（kick/clap/hat/openhat/snare，x 表示击打），bass/chords/lead/pad 用 notes（midi、start、length 都以拍为单位，wave 可选 saw/square/triangle/sine，bass 一般给 cutoff 0.3 左右）。",
  "鼓的 pattern 会自动按小节循环铺满整个 bars（一行 16 步 = 一小节，32 步 = 两小节，整块重复），不用把 16 步写 8 遍；写成的 notes 只有被 repeat（true = 铺满，或写次数）时才会重复，否则就停在写的位置。",
  "用户要\"一首歌\"而不是一段 loop 时，就写结构：给 render_song 一个 sections（例如 [{\"name\":\"intro\",\"bars\":8},{\"name\":\"drop\",\"bars\":16},{\"name\":\"break\",\"bars\":8},{\"name\":\"drop 2\",\"bars\":16}]，不传 bars 时总长就是它们之和），每个 part 用 segments 按同样的顺序分段，每段用 {\"bars\":n, ...} 覆盖这个声部的写法：break 里让鼓和贝斯 {\"bars\":8,\"gain\":0} 静音、intro 只留 hat、drop 再加上 kick/clap，就是真实的编曲动态。段落会自动出现在 Studio 的小节尺上，别只给用户一段 4 小节的循环。",
  "render_song 返回的每个 stem 会自动变成 Studio 里一条同名轨道上的片段（鼓 / 贝斯 / 和弦 / 主音 / 铺底）并立刻可以播放 —— 所以渲染完只需简短告诉用户你写了什么（速度、调性、几个声部），不要让他再操作。",
  "让声部更像成品：每个 part 都能加 pan（-1 全左 … +1 全右；铺底 pan -0.3、主音 +0.3 左右就能把画面分开）、reverb（湿润量 0–0.3，pad 给多一点）、delay（0–0.3，可配 delay_ms 与 delay_feedback，常给 lead 做回声）、gain（该声部整体音量，默认鼓 1 / 音高 0.7）、swing（把反拍八分往后推，house/techno 常给 0.1–0.25）、humanize_ms（10–25，鼓点不再死死对齐网格），音高乐器还能给 vibrato。用户说\"更像真的 / 别太机械 / 宽一点\"时调这些，而不是换音色。",
  "如果用户哼/敲了一段鼓点、想让这段节奏变成鼓轨：先用 audio-analysis-dedupe 的 groove_to_pattern（path 用那段录音，bpm 已知就传，不然它自己估）拿到 pattern，再把这个 pattern 交给 shadow-music-generator 的 render_song 渲染成鼓，鼓片会自动落到 Studio。",
  "用户问\"这首多少 BPM / 什么调\"时，用 audio-analysis-dedupe 的 detect_tempo 与 detect_key（任何格式都行），detect_key 会同时给 DJ 用的 Camelot 码（例如 8A）；置信度低就照实说不好判断，不要编。",
  "消息里带 [clip_context] 时，用户在钢琴卷帘里打开了那个片段：里面的 notes 就是当前音符，revision 是版本。要改音符（升高/降低、量化、约束到某个调、人性化、整体前后移、改力度）就调 shadow-music-generator 的 transform_notes，把 notes 原样传进去、operations 用 {\"op\":\"transpose\",\"semitones\":2} 这类写法、clip_id 和 revision 一起回传；**不要自己算音高**，也不要自己写新的音符数组。前端会把结果落到那个片段上（一步撤销），revision 对不上时它会拒绝并提醒用户重来一次。",
  "transform_notes 的可用操作：transpose（semitones）、quantise（grid_ms、strength）、set_scale（root、scale，例如 A + minor / minor_pentatonic）、humanise（timing_ms、velocity、seed）、shift（ms）、velocity（scale、add）；可以一次传多个 operations，按顺序执行。",
  "要改**结构**（\"加一个 8 小节的 breakdown\"\"再来一遍副歌\"\"把这段删掉\"）时，用 shadow-music-generator 的 arrange：把消息里 [structure_context] 的 bars/sections/tracks 原样传进去，operations 写 [{\"op\":\"insert_bars\",\"at_bar\":16,\"count\":8,\"name\":\"breakdown\"}] 或 [{\"op\":\"duplicate_section\",\"section\":\"drop\"}] 或 [{\"op\":\"remove_section\",\"section\":\"outro\"}] 或 [{\"op\":\"repeat_last_section\"}]，revision 回传。工具会算出每个片段的新位置（复制的片段带 copy_of），前端落盘并给受影响的片段标上「需重渲染」——**不要自己算位置，也不要顺手重渲染整首歌**。",
  "想让**某一条轨道的声音**变一点（\"鼓再重一点\"\"bass 更暗\"\"换成方波\"\"镲密一点\"\"去掉某些鼓\"）时，用 shadow-music-generator 的 regenerate_part：把消息里 render_spec 的 part 原样传成 part、bpm/bars/sections 一起传、**clip_id 必填**（就是消息里 clip_context 的 clip_id，前端靠它把结果落到那条轨；不传工具会报错），patch 只动你要改的那几个键——gain_db（-24…+6）、cutoff（0–1，正数更亮）、swing（+0.05 之类）、humanize_ms（+10 之类）、pan、reverb、delay、wave（sine/triangle/square/saw）、pattern（鼓：合并某些行）、remove_voices、transpose、velocity_scale。**只重渲染这一轨，其他轨不动**；不要把整份 spec 重写成新歌，也不要顺手改别的参数。",
  "regenerate_part 的新文件放在 ~/Documents/ShadowRoom/recordings/ 下、文件名带时间戳（例如 drums-v2-<时间戳>.wav），这样旧的 stem 还在，用户撤销时不用重新渲染。",
  "用户要把一首歌/一段成品拆开时（\"把这首歌分轨 / 拆出人声 / 只要鼓\"）：调用 stem-splitter 的 separate_stems（path 用那条音频路径），它立刻返回 job_id，然后每隔几秒用 stem_job_status 看一次（stage 会从 decode 走到 separate 再到 collect），拿到 status=ok 再回复。四条分轨（人声/鼓/贝斯/其它）会自动落到 Studio 的新轨道上，你不用自己写文件；一次分离在 CPU 上要几分钟，先告诉用户开始了。",
  "需要知道这台机器能不能分轨，用 stem_backends：它说没有后端时，把启用方法原样告诉用户（装 demucs 到 _venvs/stem-splitter，或设 STEM_SPLIT_COMMAND）。",
  "导出同样可以让我做：mix_arrangement 导出整首（out_path/.bpm/.bars/sample_rate/bit_depth/container + tracks），export_stems 导出分轨（out_dir + name），export_midi 导出 MIDI（out_path；音符来自 clip.notes，或指向 .mid 的 clip）。它们的 tracks 结构一致：{name, gain, clips:[{path, start(小节), bars, gain, notes?}]}。",
  "用户要这首歌的 MIDI 时，最省事的是渲染时就带上 midi_path（render_song 的另一个参数，例如 ~/Documents/ShadowRoom/recordings/<歌名>.mid）：它写出的不是从音频里猜出来的音符，而是刚才实际演奏的那份编曲（鼓在 MIDI 的鼓通道上），Studio 里会多出一条 MIDI 轨，导出对话框的 MIDI 也读它。",
  "一个可用的例子：{\"out_path\":\"~/Documents/ShadowRoom/recordings/night-drive.wav\",\"bpm\":124,\"bars\":8,\"parts\":[{\"part\":\"drums\",\"pattern\":{\"kick\":\"x...x...x...x...\",\"clap\":\"....x.......x...\",\"hat\":\"..x...x...x...x.\"}},{\"part\":\"bass\",\"wave\":\"saw\",\"cutoff\":0.32,\"notes\":[{\"midi\":33,\"start\":0,\"length\":0.75},{\"midi\":33,\"start\":1.5,\"length\":0.5},{\"midi\":36,\"start\":3,\"length\":1}]}]}",
  "带结构的例子（32 小节 tech house）：{\"out_path\":\"~/Documents/ShadowRoom/recordings/drive.wav\",\"bpm\":126,\"sections\":[{\"name\":\"intro\",\"bars\":8},{\"name\":\"drop\",\"bars\":16},{\"name\":\"outro\",\"bars\":8}],\"parts\":[{\"part\":\"drums\",\"swing\":0.14,\"humanize_ms\":16,\"segments\":[{\"bars\":8,\"pattern\":{\"hat\":\"..x...x...x...x.\"}},{\"bars\":16,\"pattern\":{\"kick\":\"x...x...x...x...\",\"clap\":\"....x.......x...\",\"hat\":\"..x...x...x...x.\"}},{\"bars\":8,\"pattern\":{\"kick\":\"x...x...x...x...\",\"hat\":\"..x...x...x...x.\"}}]},{\"part\":\"bass\",\"wave\":\"saw\",\"cutoff\":0.32,\"pan\":0,\"repeat\":true,\"segments\":[{\"bars\":8,\"gain\":0},{\"bars\":16,\"notes\":[{\"midi\":33,\"start\":0,\"length\":0.75},{\"midi\":33,\"start\":1.5,\"length\":0.5},{\"midi\":36,\"start\":3,\"length\":0.75}]},{\"bars\":8,\"gain\":0}]},{\"part\":\"chords\",\"wave\":\"triangle\",\"pan\":-0.3,\"reverb\":0.18,\"repeat\":true,\"segments\":[{\"bars\":8,\"gain\":0.4,\"notes\":[{\"midi\":57,\"start\":0,\"length\":4},{\"midi\":60,\"start\":0,\"length\":4},{\"midi\":64,\"start\":0,\"length\":4}]},{\"bars\":16,\"notes\":[{\"midi\":57,\"start\":0,\"length\":4},{\"midi\":60,\"start\":0,\"length\":4},{\"midi\":64,\"start\":0,\"length\":4}]},{\"bars\":8,\"gain\":0.4,\"notes\":[{\"midi\":57,\"start\":0,\"length\":4},{\"midi\":60,\"start\":0,\"length\":4},{\"midi\":64,\"start\":0,\"length\":4}]}]}]}",
  "回答尽量短、口语化，因为会被朗读出来；需要执行的操作直接调用工具，不要只描述。",
].join("\n");

function mcpServers() {
  const servers = {};
  for (const repo of PLUGIN_REPOS) {
    const dir = resolve(WORKSPACES, repo);
    if (!existsSync(join(dir, "mcp_server.py"))) continue;
    servers[repo] = {
      command: pythonFor({ id: repo, repo }),
      args: ["mcp_server.py"],
      cwd: dir,
      env: pluginEnv(),
      // These four are first-party tools: their calls run without a prompt, while everything else
      // stays under the sandbox/approval policy above.
      default_tools_approval_mode: "approve",
    };
  }
  return servers;
}

/** One `codex app-server` child, plus the session → thread map. */
class Agent {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.threads = new Map(); // ui sessionId → codex threadId
    this.listeners = new Map(); // codex threadId → Set<listener>
    this.starting = null;
    this.stderr = [];
    this.info = { model: undefined, userAgent: undefined };
    this.approvals = new Map(); // bridge approval id → the app-server request waiting for a decision
    this.nextApprovalId = 1;
    this.models = null; // cached `model/list`
    /** When set, the core runs with this CODEX_HOME (see `useProvider`). */
    this.codexHome = null;
    /** Extra environment for that core — the provider's key, never written to disk. */
    this.extraEnv = {};
    /** The loopback adapter currently serving the configured provider, if any. */
    this.adapter = null;
  }

  get connected() {
    return this.child !== null && !this.child.killed;
  }

  /** Start (or restart) the core and handshake with it. */
  async start() {
    if (this.connected) return this;
    this.starting ??= this.#boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Point every thread at a provider from Settings.
   *
   * The per-thread `config` route did not work — this Codex build ignored `model_providers` passed that
   * way and answered with its own backend (measured). Its *config file* is the documented route, so the
   * bridge writes one (`$CODEX_HOME/config.toml`), restarts the core with that `CODEX_HOME` and the key in
   * its environment. One provider at a time is enough while this is being proven; switching is a restart
   * of the core, about a second.
   */
  async useProvider(provider) {
    if (provider === null) {
      this.codexHome = null;
      this.extraEnv = {};
    } else {
      this.adapter?.close();
      this.adapter = null;
      const id = String(provider.id ?? "custom").replace(/[^a-zA-Z0-9_-]/g, "-");
      const home = join(CREDENTIALS_DIR, `codex-${id}`);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const envKey = `SHADOWROOM_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
      const credential = provider.credentialRef ? resolveCredential(provider.credentialRef) : null;
      /**
       * Every provider goes through the adapter: even a Responses-native one would have to be probed to
       * know otherwise, and the adapter is a loopback hop away. `base_url` in the config points at it.
       */
      const adapter = await startChatAdapter(provider, credential);
      this.adapter = adapter;
      const lines = [
        `model = ${JSON.stringify(provider.model ?? "")}`,
        `model_provider = ${JSON.stringify(id)}`,
        "",
        `[model_providers.${id}]`,
        `name = ${JSON.stringify(provider.label ?? id)}`,
        `base_url = ${JSON.stringify(adapter.baseUrl)}`,
        // This Codex build accepts only the Responses wire ("`wire_api = \"chat\"` is no longer
        // supported" — measured), so every provider is reached through the bridge's adapter below.
        `wire_api = "responses"`,
        `env_key = ${JSON.stringify(envKey)}`,
        "",
      ];
      writeFileSync(join(home, "config.toml"), lines.join("\n"), { mode: 0o600 });
      this.codexHome = home;
      this.extraEnv = credential === null ? {} : { [envKey]: credential.value };
      console.log(`[agent] provider → ${provider.label} (${provider.model}) · CODEX_HOME=${home}`);
    }
    const child = this.child;
    this.child = null;
    this.threads.clear();
    if (child !== null) child.kill();
    await this.start();
    return { provider: provider?.id ?? null, codexHome: this.codexHome };
  }

  async #boot() {
    if (!existsSync(CODEX)) throw new Error(`codex binary not found: ${CODEX}`);
    const child = spawn(CODEX, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.extraEnv ?? {}), ...(this.codexHome === null || this.codexHome === undefined ? {} : { CODEX_HOME: this.codexHome }) },
    });
    this.child = child;
    this.threads.clear();
    this.stderr = [];

    child.on("exit", () => {
      this.child = null;
      for (const pending of this.pending.values()) pending.reject(new Error("agent core exited"));
      this.pending.clear();
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      this.stderr.push(String(chunk));
      if (this.stderr.length > 40) this.stderr.shift();
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const text = line.trim();
      if (text === "") return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        this.#serverRequest(message);
        return;
      }
      if (typeof message.method === "string") this.#notify(message);
    });

    const info = await this.request(
      "initialize",
      {
        clientInfo: { name: "shadow-producers", title: "Shadow Producers", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      INIT_TIMEOUT_MS,
    );
    this.info.userAgent = info?.userAgent;
    return this;
  }

  request(method, params, timeoutMs = 120_000) {
    const child = this.child;
    if (child === null) return Promise.reject(new Error("agent core is not running"));
    const id = this.nextId++;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve_(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  #notify(message) {
    const threadId = message.params?.threadId;
    if (threadId === undefined) return;
    const listeners = this.listeners.get(threadId);
    if (listeners === undefined) return;
    for (const listener of listeners) listener(message);
  }

  /** Send a reply to a request the core made (approvals); nothing else is expected from us. */
  #respond(id, result, error) {
    const payload = error === undefined
      ? { jsonrpc: "2.0", id, result }
      : { jsonrpc: "2.0", id, error };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * The core asks the client for a decision. Both the legacy (`execCommandApproval`) and the v2
   * (`item/commandExecution/requestApproval`) shapes are accepted; unknown requests are refused so a
   * turn can never hang on us.
   */
  #serverRequest(message) {
    const params = message.params ?? {};
    const method = message.method;
    const threadId = params.threadId ?? params.conversationId;
    let request;
    if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") {
      const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
      request = {
        kind: "command",
        title: params.reason ?? "智能体想运行一条命令",
        detail: [command, params.cwd === undefined ? undefined : `cwd: ${params.cwd}`]
          .filter(Boolean)
          .join("\n"),
      };
    } else if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
      const files = Object.keys(params.fileChanges ?? {});
      request = {
        kind: "patch",
        title: params.reason ?? "智能体想修改文件",
        detail: files.join("\n") || params.grantRoot || "",
      };
    }
    if (request === undefined || threadId === undefined) {
      this.#respond(message.id, null, {
        code: -32601,
        message: `shadow-producers does not handle ${method}`,
      });
      return;
    }
    const approvalId = `ap-${this.nextApprovalId++}`;
    this.approvals.set(approvalId, {
      rpcId: message.id,
      method,
      threadId,
      createdAt: Date.now(),
    });
    const listeners = this.listeners.get(threadId);
    const sessionId = [...this.threads.entries()].find(([, id]) => id === threadId)?.[0];
    for (const listener of listeners ?? []) {
      listener({
        method: "shadowroom/approval",
        params: { threadId, sessionId, approvalId, kind: request.kind, title: request.title, detail: request.detail },
      });
    }
  }

  /** Answer a pending approval in the vocabulary the request came in with. */
  answer(approvalId, decision) {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) throw new Error(`unknown approval: ${approvalId}`);
    this.approvals.delete(approvalId);
    const legacy = pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
    const mapped = legacy
      ? decision === "allow"
        ? "approved"
        : decision === "allow_session"
          ? "approved_for_session"
          : { denied: { rejection: "用户在 Shadow Producers 里拒绝了这次操作" } }
      : decision === "allow"
        ? "accept"
        : decision === "allow_session"
          ? "acceptForSession"
          : "decline";
    this.#respond(pending.rpcId, { decision: mapped });
    return pending.threadId;
  }

  /** The Codex thread behind a UI session, created on first use. */
  async threadFor(sessionId, provider = null) {
    const known = this.threads.get(sessionId);
    if (known !== undefined) return known;
    await this.start();
    /**
     * A thread can run on a provider the user configured in Settings — an OpenAI-compatible endpoint
     * of their own. Codex supports this natively (`model_providers` in its config), so there is no
     * second agent loop to write: the same config object we already use for MCP servers carries it.
     *
     * The key travels in `experimental_bearer_token` rather than an environment variable: the bridge
     * builds the config per thread, so the secret never lands in a config file, and switching keys does
     * not require restarting the Codex process. Codex's own docs call this the programmatic path.
     */
    const config = { mcp_servers: mcpServers() };
    const params = {
      cwd: AGENT_CWD,
      sandbox: SANDBOX,
      approvalPolicy: APPROVAL,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      config,
    };
    if (provider !== null && provider.baseUrl && provider.model) {
      const key = provider.credentialRef ? resolveCredential(provider.credentialRef)?.value ?? "" : "";
      const id = `shadowroom-${String(provider.id ?? "custom").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const entry = {
        name: provider.label ?? id,
        base_url: provider.baseUrl,
        // Our providers are OpenAI-compatible endpoints; `chat` is the wire every one of them speaks.
        wire_api: provider.wireApi === "responses" ? "responses" : "chat",
        ...(key === "" ? {} : { experimental_bearer_token: key }),
        ...(provider.headers === undefined ? {} : { http_headers: provider.headers }),
      };
      /**
       * Both shapes: the app-server's config overrides are applied by *path* (its own tests write
       * `model_providers.openai.name`), so the dotted form is what a merge understands, while the nested
       * form is what a plain JSON read would see. Sending both costs nothing and removes the guesswork.
       */
      config.model_providers = { [id]: entry };
      for (const [field, value] of Object.entries(entry)) {
        config[`model_providers.${id}.${field}`] = value;
      }
      params.model = provider.model;
      params.model_provider = id;
    }
    const started = await this.request("thread/start", params);
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread id");
    this.threads.set(sessionId, threadId);
    this.info.model = started.model;
    return threadId;
  }

  /**
   * Start a turn and stream its events to `onEvent` until the turn ends.
   * @returns the Codex turn id.
   */
  async send(sessionId, text, onEvent, options = {}) {
    const threadId = await this.threadFor(sessionId, options.provider ?? null);
    const listener = (message) => {
      const { method, params } = message;
      if (method === "item/agentMessage/delta") {
        onEvent({ type: "delta", text: params.delta });
        return;
      }
      if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
        onEvent({ type: "reasoning", itemId: params.itemId, text: params.delta });
        return;
      }
      if (method === "item/started" || method === "item/completed" || method === "item/updated") {
        onEvent({ type: "item", phase: method.split("/")[1], item: params.item });
        return;
      }
      if (method === "turn/completed") {
        onEvent({ type: "done", turn: params.turn });
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        onEvent({ type: "usage", turnId: params.turnId, usage: params.tokenUsage });
        return;
      }
      if (method === "error") {
        onEvent({ type: "error", message: params?.message ?? JSON.stringify(params) });
      }
      if (method === "shadowroom/approval") {
        onEvent({
          type: "approval",
          approvalId: params.approvalId,
          sessionId: params.sessionId,
          kind: params.kind,
          title: params.title,
          detail: params.detail,
        });
      }
    };
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    try {
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }, ...(options.input ?? [])],
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      });
      const turnId = started?.turn?.id;
      // The turn runs asynchronously; the SSE stream stays open until turn/completed arrives.
      onEvent({ type: "turn", threadId, turnId });
      return { threadId, turnId, listener, listeners };
    } catch (error) {
      listeners.delete(listener);
      throw error;
    }
  }

  release(threadId, listener, listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(threadId);
  }

  async interrupt(sessionId) {
    const threadId = this.threads.get(sessionId);
    if (threadId === undefined) throw new Error("no thread for this session yet");
    await this.request("turn/interrupt", { threadId });
  }
}

const agent = new Agent();

function sse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  return (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf-8");
  return text === "" ? {} : JSON.parse(text);
}

/** JSON body with a size ceiling; audio uploads are base64 in `data`. */
async function readJsonBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text === "" ? {} : JSON.parse(text);
}

function json(response, code, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

const http = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/agent/health") {
      // Booting is lazy, so the health check is what actually starts the core the first time: the UI
      // asks "can you run a turn?" and the answer has to be yes even before any thread exists.
      let bootError;
      try {
        await agent.start();
      } catch (error) {
        bootError = error instanceof Error ? error.message : String(error);
      }
      json(response, 200, {
        ok: agent.connected && bootError === undefined,
        threads: agent.threads.size,
        model: agent.info.model,
        userAgent: agent.info.userAgent,
        cwd: AGENT_CWD,
        sandbox: SANDBOX,
        approval: APPROVAL,
        pendingApprovals: agent.approvals.size,
        plugins: Object.keys(mcpServers()),
        error: bootError ?? (agent.connected ? undefined : agent.stderr.join("").slice(-400) || undefined),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/models") {
      await agent.start();
      if (agent.models === null) {
        const listed = await agent.request("model/list", {});
        agent.models = (listed?.data ?? []).map((model) => ({
          id: model.model ?? model.id,
          displayName: model.displayName ?? model.model ?? model.id,
          description: model.description ?? "",
          isDefault: model.isDefault === true,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({
            effort: option.reasoningEffort,
            description: option.description,
          })),
        }));
      }
      json(response, 200, { models: agent.models });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/interrupt") {
      const body = await readBody(request);
      await agent.interrupt(String(body.sessionId ?? ""));
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/approval") {
      const body = await readBody(request);
      const decision = String(body.decision ?? "");
      if (!["allow", "allow_session", "deny"].includes(decision)) {
        json(response, 400, { error: "decision must be allow, allow_session or deny" });
        return;
      }
      const threadId = agent.answer(String(body.approvalId ?? ""), decision);
      json(response, 200, { ok: true, threadId });
      return;
    }

    /**
     * Which credentials exist — names, sources and masks. Never a value.
     */
    if (request.method === "GET" && url.pathname === "/api/agent/credentials") {
      const stored = readCredentialFile();
      const names = new Set(Object.keys(stored));
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith("SHADOWROOM_") && key.endsWith("_KEY") === false && typeof value === "string") {
          // SHADOWROOM_OPENAI → openai; the variable name is the name the settings page knows.
          names.add(key.slice("SHADOWROOM_".length).toLowerCase());
        }
      }
      const credentials = [...names].sort().map((name) => {
        const resolved = resolveCredential(name);
        return resolved === null
          ? { name, source: "missing", masked: "" }
          : { name, source: resolved.source, masked: masked(resolved.value), variable: resolved.variable ?? credentialEnvName(name) };
      });
      json(response, 200, { credentials, file: CREDENTIALS_FILE });
      return;
    }

    /** Store or replace one credential. */
    if (request.method === "POST" && url.pathname === "/api/agent/credentials") {
      const body = await readJsonBody(request, 64 * 1024);
      const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
      const value = typeof body.value === "string" ? body.value.trim() : "";
      if (!CREDENTIAL_NAME.test(name)) {
        json(response, 400, { error: "凭证名只能用小写字母、数字、点、下划线和横线" });
        return;
      }
      if (value === "") {
        json(response, 400, { error: "Key 不能是空的" });
        return;
      }
      const map = readCredentialFile();
      map[name] = value;
      writeCredentialFile(map);
      console.log(`[agent] credential stored: ${name}`);
      json(response, 200, { name, source: "file", masked: masked(value) });
      return;
    }

    if (request.method === "DELETE" && url.pathname === "/api/agent/credentials") {
      const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
      if (!CREDENTIAL_NAME.test(name)) {
        json(response, 400, { error: "凭证名不合法" });
        return;
      }
      const map = readCredentialFile();
      delete map[name];
      writeCredentialFile(map);
      json(response, 200, { name, removed: true });
      return;
    }

    /**
     * The model list a provider offers, asked for when the settings page opens a dropdown.
     *
     * Never fetched on save: probing a provider can cost money and can fail for providers without a
     * `/models` route, so the page falls back to typing a model name instead of refusing to continue.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/providers/models") {
      const body = await readJsonBody(request, 64 * 1024);
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      if (baseUrl === "") {
        json(response, 400, { error: "缺少 Base URL" });
        return;
      }
      try {
        const { response: answer } = await callProvider(
          { baseUrl, reference: body.credentialRef ?? null, protocol: body.protocol ?? "openai" },
          "/models",
          { method: "GET" },
        );
        if (!answer.ok) {
          json(response, 200, { models: [], error: await providerFailure(answer) });
          return;
        }
        const payload = await answer.json().catch(() => ({}));
        const models = Array.isArray(payload?.data)
          ? payload.data.map((entry) => String(entry?.id ?? entry?.name ?? "")).filter(Boolean)
          : Array.isArray(payload?.models)
            ? payload.models.map((entry) => String(entry?.name ?? entry?.id ?? entry)).filter(Boolean)
            : [];
        json(response, 200, { models });
      } catch (cause) {
        json(response, 200, { models: [], error: `连不上：${cause instanceof Error ? cause.message : String(cause)}` });
      }
      return;
    }

    /**
     * Run the agent on a provider the user configured (writes a CODEX_HOME and restarts the core).
     * `{provider: null}` goes back to the built-in one.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/use-provider") {
      const body = await readJsonBody(request, 64 * 1024);
      const provider =
        body.provider !== null && typeof body.provider === "object" && typeof body.provider.baseUrl === "string"
          ? {
              id: body.provider.id,
              label: body.provider.label,
              baseUrl: body.provider.baseUrl,
              model: String(body.provider.model ?? ""),
              credentialRef: body.provider.credentialRef ?? null,
              wireApi: body.provider.wireApi,
            }
          : null;
      try {
        json(response, 200, await agent.useProvider(provider));
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    /**
     * Synthesize speech through a configured provider and hand the audio back.
     *
     * The call used to speak through the system voice, which gave us neither the user's chosen voice
     * nor an audio stream to reason about (see DECISIONS ADR-019). Here the bridge makes the request
     * and returns the bytes, so the page can play them through WebAudio and know exactly when they
     * start and stop.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/providers/tts") {
      const body = await readJsonBody(request, 256 * 1024);
      const text = String(body.text ?? "").trim();
      const provider = {
        baseUrl: String(body.baseUrl ?? "").trim(),
        reference: body.credentialRef ?? null,
        protocol: body.protocol ?? "openai",
      };
      const model = String(body.model ?? "").trim();
      if (text === "" || provider.baseUrl === "" || model === "") {
        json(response, 400, { error: "缺少文本、端点或模型" });
        return;
      }
      const path = typeof body.endpointPath === "string" && body.endpointPath !== "" ? body.endpointPath : "/audio/speech";
      const voice = typeof body.voice === "string" && body.voice !== "" ? body.voice : "alloy";
      const format = typeof body.format === "string" && body.format !== "" ? body.format : "mp3";
      try {
        const { response: answer } = await callProvider(provider, path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            provider.protocol === "elevenlabs"
              ? { text, model_id: model, ...(body.options ?? {}) }
              : { model, input: text, voice, response_format: format, ...(body.options ?? {}) },
          ),
        });
        if (!answer.ok) {
          json(response, 200, { error: await providerFailure(answer) });
          return;
        }
        const bytes = Buffer.from(await answer.arrayBuffer());
        /**
         * Some endpoints answer JSON with base64 audio instead of raw bytes (MiniMax does); unwrap it
         * here so the caller always gets audio, whatever the provider's shape.
         */
        let audio = bytes;
        const contentType = answer.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = JSON.parse(bytes.toString("utf8"));
          const base64 =
            payload?.data?.audio ?? payload?.audio ?? payload?.data?.audio_file ?? payload?.audio_file ?? (typeof payload?.data === "string" ? payload.data : undefined);
          if (typeof base64 !== "string" || base64 === "") {
            json(response, 200, { error: `返回里没有音频：${JSON.stringify(payload).slice(0, 200)}` });
            return;
          }
          audio = Buffer.from(base64, "base64");
        }
        console.log(`[agent] tts ${model} → ${audio.length} bytes`);
        json(response, 200, { audio: audio.toString("base64"), contentType: contentType.includes("json") ? "audio/mpeg" : contentType, bytes: audio.length });
      } catch (cause) {
        json(response, 200, { error: `合成失败：${cause instanceof Error ? cause.message : String(cause)}` });
      }
      return;
    }

    /**
     * The smallest request that proves one role works: a 5-token chat, a two-word synthesis, a
     * 256×256 image. Small on purpose — a test button must not spend the user's credit.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/providers/test") {
      const body = await readJsonBody(request, 256 * 1024);
      const capability = String(body.capability ?? "");
      const model = String(body.model ?? "").trim();
      const provider = {
        baseUrl: String(body.baseUrl ?? "").trim(),
        reference: body.credentialRef ?? null,
        protocol: body.protocol ?? "openai",
      };
      if (provider.baseUrl === "" || model === "") {
        json(response, 400, { error: "先选好服务商和模型" });
        return;
      }
      const started = Date.now();
      try {
        if (capability === "agent") {
          const { response: answer } = await callProvider(provider, "/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
          });
          if (!answer.ok) {
            json(response, 200, { ok: false, detail: await providerFailure(answer) });
            return;
          }
          const payload = await answer.json().catch(() => ({}));
          const said = payload?.choices?.[0]?.message?.content ?? "";
          json(response, 200, {
            ok: typeof said === "string" && said.trim() !== "",
            detail: typeof said === "string" && said.trim() !== "" ? `回复：${said.trim().slice(0, 40)}` : "回复是空的",
            ms: Date.now() - started,
          });
          return;
        }
        if (capability === "tts") {
          const voice = typeof body.voice === "string" && body.voice !== "" ? body.voice : "alloy";
          const { response: answer } = await callProvider(provider, "/audio/speech", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, input: "测试", voice, response_format: "mp3" }),
          });
          if (!answer.ok) {
            json(response, 200, { ok: false, detail: await providerFailure(answer) });
            return;
          }
          const bytes = (await answer.arrayBuffer()).byteLength;
          json(response, 200, { ok: bytes > 1000, detail: `${bytes} 字节音频`, ms: Date.now() - started });
          return;
        }
        if (capability === "image") {
          const { response: answer } = await callProvider(provider, "/images/generations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, prompt: "a dot", size: "256x256", n: 1 }),
          });
          if (!answer.ok) {
            json(response, 200, { ok: false, detail: await providerFailure(answer) });
            return;
          }
          const payload = await answer.json().catch(() => ({}));
          const made = payload?.data?.[0];
          json(response, 200, {
            ok: made !== undefined,
            detail: made === undefined ? "没有返回图像" : "返回了 1 张图",
            ms: Date.now() - started,
          });
          return;
        }
        json(response, 200, { ok: false, detail: "这个角色还没有自动测试；先按保存，用的时候会报错就知道" });
      } catch (cause) {
        json(response, 200, { ok: false, detail: `连不上：${cause instanceof Error ? cause.message : String(cause)}` });
      }
      return;
    }

    /**
     * A recording from the studio's 录音 button: converted to WAV on the way in.
     *
     * MediaRecorder hands the browser webm/opus (Safari: mp4/aac), which the studio's own playback
     * and export paths would rather not special-case, and which cannot be decoded reliably by the
     * analyser. So the bytes land here and ffmpeg writes a 44.1 kHz 16-bit PCM WAV next to them —
     * one format from then on, and the length comes back measured rather than guessed.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/record") {
      const body = await readJsonBody(request, MAX_IMPORT_BYTES);
      const data = typeof body.data === "string" ? body.data : "";
      if (data === "") {
        json(response, 400, { error: "缺少录音内容（data）" });
        return;
      }
      const ffmpeg = findFfmpeg();
      if (ffmpeg === null) {
        json(response, 501, { error: "这台机器上没有 ffmpeg，录音无法转成 WAV。装好后重试，或用 SHADOWROOM_FFMPEG 指定路径。" });
        return;
      }
      const rawExtension = typeof body.extension === "string" && /^[a-z0-9]{1,5}$/i.test(body.extension) ? body.extension.toLowerCase() : "";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const rawName = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : `录音-${stamp}`;
      const base = safeFileName(rawName.replace(/\.(wav|webm|m4a|mp4|ogg|opus)$/i, "")) || `录音-${stamp}`;
      mkdirSync(RECORDINGS_DIR, { recursive: true });
      const targetName = uniqueName(RECORDINGS_DIR, `${base}.wav`);
      const target = join(RECORDINGS_DIR, targetName);
      const uploaded = Buffer.from(data, "base64");
      /**
       * Already a PCM WAV (the voice call encodes its own)? Then there is nothing to convert — copy it
       * and save the ffmpeg round trip. Everything else (webm/opus from MediaRecorder, mp4 from
       * Safari) goes through the converter.
       */
      const isWav = uploaded.length > 44 && uploaded.toString("ascii", 0, 4) === "RIFF" && uploaded.toString("ascii", 8, 12) === "WAVE";
      if (isWav) {
        writeFileSync(target, uploaded);
        const fastDuration = wavDurationMs(uploaded);
        console.log(`[agent] recorded ${targetName} (${(fastDuration / 1000).toFixed(2)}s, already wav)`);
        json(response, 200, { path: target, name: targetName, duration_ms: fastDuration, bytes: uploaded.length });
        return;
      }
      const temp = join(RECORDINGS_DIR, `.take-${stamp}${rawExtension === "" ? "" : `.${rawExtension}`}`);
      writeFileSync(temp, uploaded);
      try {
        const converted = spawnSync(
          ffmpeg,
          ["-v", "error", "-y", "-i", temp, "-ar", "44100", "-c:a", "pcm_s16le", target],
          { encoding: "utf8", timeout: 120_000 },
        );
        if (converted.status !== 0) {
          const detail = (converted.stderr || "").trim().split("\n").slice(-2).join(" ") || "ffmpeg 没有说明原因";
          json(response, 500, { error: `ffmpeg 转换失败：${detail}` });
          return;
        }
      } finally {
        rmSync(temp, { force: true });
      }
      const durationMs = wavDurationMs(readFileSync(target));
      console.log(`[agent] recorded ${targetName} (${(durationMs / 1000).toFixed(2)}s)`);
      json(response, 200, { path: target, name: targetName, duration_ms: durationMs, bytes: statSync(target).size });
      return;
    }

    /**
     * Import: a file the user dropped or picked in the browser, copied into the workspace.
     *
     * A browser cannot hand a local path to the audio server (the File object has no path), so the
     * bytes come up here and land in `imports/<date>/`; from then on the file behaves like anything
     * else in the project — it streams through /api/agent/file and exports go through the bridge.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/import") {
      const body = await readJsonBody(request, MAX_IMPORT_BYTES);
      const data = typeof body.data === "string" ? body.data : "";
      if (data === "") {
        json(response, 400, { error: "缺少文件内容（data）" });
        return;
      }
      const rawName = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : "";
      if (rawName === "") {
        json(response, 400, { error: "缺少文件名（name）" });
        return;
      }
      const extension = rawName.slice(rawName.lastIndexOf(".")).toLowerCase();
      if (!STREAMABLE.has(extension)) {
        json(response, 415, { error: `不支持的文件类型：${extension || rawName}` });
        return;
      }
      const day = new Date().toISOString().slice(0, 10);
      const directory = join(IMPORTS_DIR, day);
      mkdirSync(directory, { recursive: true });
      const safeName = uniqueName(directory, safeFileName(rawName) || `import-${Date.now()}`);
      const target = join(directory, safeName);
      const buffer = Buffer.from(data, "base64");
      writeFileSync(target, buffer);
      console.log(`[agent] imported ${buffer.length} bytes → ${target}`);
      json(response, 200, { path: target, name: safeName, bytes: buffer.length });
      return;
    }

    /**
     * A native "choose file…" dialog, for people who would rather reference a file in place (a DJ
     * library, a sample folder) than have it copied. macOS only; the UI falls back to the drag/drop
     * flow when this answers with an error.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/pick") {
      if (process.platform !== "darwin") {
        json(response, 501, { error: "原生文件对话框目前只在 macOS 上可用；拖拽或文件选择器一样可以导入" });
        return;
      }
      const body = await readJsonBody(request, 64 * 1024);
      const multiple = body.multiple === true;
      const prompt = multiple ? "选择音频文件（可多选）" : "选择音频文件";
      const script = [
        `set theFiles to choose file with prompt "${prompt}" of type {"public.audio", "public.midi-audio"}${multiple ? " with multiple selections allowed" : ""}`,
        "if class of theFiles is not list then set theFiles to {theFiles}",
        "set thePaths to {}",
        "repeat with theFile in theFiles",
        "set end of thePaths to POSIX path of theFile",
        "end repeat",
        "set AppleScript's text item delimiters to linefeed",
        "return thePaths as text",
      ].join("\n");
      const picked = await new Promise((resolve) => {
        const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
          out += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          err += String(chunk);
        });
        child.on("error", (cause) => resolve({ out: "", err: cause.message, code: -1 }));
        child.on("close", (code) => resolve({ out, err, code }));
      });
      // -128 is "the user cancelled": not an error, and not worth a red row in the UI.
      if (picked.code !== 0) {
        const cancelled = String(picked.err).includes("-128");
        if (cancelled) {
          json(response, 200, { paths: [] });
        } else {
          json(response, 500, { error: String(picked.err).trim() || "文件对话框打不开（试试拖拽或文件选择器）" });
        }
        return;
      }
      const paths = String(picked.out)
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      json(response, 200, { paths });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/file") {
      const target = url.searchParams.get("path");
      if (target === null || target === "") {
        json(response, 400, { error: "missing path" });
        return;
      }
      const resolved = resolve(target.replace(/^~(?=\/|$)/, HOME));
      const extension = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
      const contentType = STREAMABLE.get(extension);
      if (contentType === undefined) {
        json(response, 415, { error: `cannot stream ${extension || "this file"}` });
        return;
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        json(response, 404, { error: `no such file: ${resolved}` });
        return;
      }
      const size = statSync(resolved).size;
      // Range support: an audio element seeks constantly in a DAW, and 200-with-everything makes
      // scrubbing wait for the whole file.
      const range = request.headers.range;
      const match = typeof range === "string" ? /bytes=(\d*)-(\d*)/.exec(range) : null;
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (match !== null) {
        response.writeHead(206, {
          "content-type": contentType,
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          "access-control-allow-origin": "*",
        });
      } else {
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": size,
          "accept-ranges": "bytes",
          "access-control-allow-origin": "*",
        });
      }
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(resolved, { start, end }).pipe(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/send") {
      const body = await readBody(request);
      const sessionId = String(body.sessionId ?? "");
      const text = String(body.text ?? "");
      if (sessionId === "" || text.trim() === "") {
        json(response, 400, { error: "sessionId and text are required" });
        return;
      }
      const emit = sse(response);
      let handle = null;
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(guard);
        if (handle !== null) agent.release(handle.threadId, handle.listener, handle.listeners);
        response.end();
      };
      const guard = setTimeout(() => {
        emit({ type: "error", message: "这一轮超时了（agent 没有在预期时间内结束）" });
        finish();
      }, Number(process.env.SHADOWROOM_AGENT_TURN_TIMEOUT_MS ?? 900_000));

      try {
        handle = await agent.send(
          sessionId,
          text,
          (event) => {
            emit(event);
            if (event.type === "done" || event.type === "error") finish();
          },
          {
            model: typeof body.model === "string" && body.model !== "" ? body.model : undefined,
            provider:
              body.provider !== null && typeof body.provider === "object" && typeof body.provider.baseUrl === "string"
                ? {
                    id: String(body.provider.id ?? "custom"),
                    label: String(body.provider.label ?? "自定义"),
                    baseUrl: String(body.provider.baseUrl),
                    credentialRef: body.provider.credentialRef ?? null,
                    wireApi: body.provider.wireApi,
                    headers: body.provider.headers,
                  }
                : null,
            effort: typeof body.effort === "string" && body.effort !== "" ? body.effort : undefined,
            input: Array.isArray(body.mentions)
              ? body.mentions
                  .filter((mention) => typeof mention?.name === "string" && typeof mention?.path === "string")
                  .map((mention) => ({ type: "mention", name: mention.name, path: mention.path }))
              : [],
          },
        );
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        finish();
        return;
      }
      // A client that navigates away must not leak the listener.
      request.on("close", finish);
      return;
    }

    json(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

http.listen(PORT, HOST, () => {
  console.log(`[agent] listening on http://${HOST}:${PORT}`);
  console.log(`[agent] core: ${CODEX}`);
  console.log(`[agent] cwd: ${AGENT_CWD} · sandbox: ${SANDBOX} · approval: ${APPROVAL}`);
  console.log(`[agent] plugins: ${Object.keys(mcpServers()).join(", ") || "(none found)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    agent.child?.kill("SIGTERM");
    http.close(() => process.exit(0));
  });
}
