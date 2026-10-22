#!/usr/bin/env node
/**
 * Agent bridge: drives `codex app-server` and streams its events to the UI.
 *
 * The app-server speaks JSON-RPC over stdio; the browser cannot. This server owns that link and
 * exposes these endpoints:
 *
 *   GET  /api/agent/health   → is the core up, which model/sandbox/cwd it runs with
 *   POST /api/agent/send     → { sessionId, text, settings? } → an SSE stream of the turn's events
 *   POST /api/agent/settings → { sessionId, model?, effort?, access } → confirmed thread settings
 *   POST /api/agent/interrupt→ { sessionId }
 *
 * One UI session maps to one Codex thread, created on the first message. Each thread receives only
 * the ShadowRoom MCP projection for its page scope (butler / studio / dj / library).
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
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { buildPickScript } from "./pick-script.mjs";
import { createThinkFilter, accessPreset } from "./think-stream.mjs";

const HOST = process.env.SHADOWROOM_AGENT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SHADOWROOM_AGENT_PORT ?? 8788);
/** The browser uses this to invalidate provider state that only exists inside this process. */
const BRIDGE_INSTANCE = `${process.pid}-${Date.now()}`;
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
 * 供应商的「媒体协议」适配层 —— 从用户自己的 Shadow 搬过来的请求形状
 * （`~/Desktop/shadow/shadow/src/adapters/tool/media-gen-speech-clients.ts`）。
 *
 * 为什么需要它：每家语音/音乐 API 的路径、请求体、返回编码都不一样。MiniMax 是
 * `POST {base}/v1/t2a_v2`（TTS）与 `POST {base}/v1/music_generation`（音乐），返回 **hex** 音频；
 * OpenAI 是 `/audio/speech` 返回裸字节。之前只实现了后者，所以 MiniMax 一律 404 —— 通话没声音的根因。
 */
const MCP_BRIDGE_URL = process.env.SHADOWROOM_MCP_URL ?? "http://127.0.0.1:8787";
/** 适配器内部执行过的媒体工具调用（Studio 轮询它来落地轨道）。 */
const MEDIA_EVENTS = [];
/**
 * Codex cannot execute the plugin calls this adapter makes on a chat-only provider's behalf. Replaying
 * them as Responses `function_call` items makes Codex run them a second time and fail with
 * `unsupported call`. This side channel carries the execution as an app-server-shaped tool item to the
 * open turn without asking Codex to execute it again.
 */
const ADAPTER_TOOL_LISTENERS = new Set();
let adapterToolEventId = 0;
const OWNER_BLOCK_RE = /\[shadowroom_owner\]\s*([\s\S]*?)\s*\[\/shadowroom_owner\]/g;

/** Per-turn ownership travels in the input because this Codex build ignores per-thread adapter headers. */
function ownerBlock(owner) {
  const safe = {
    sessionId: owner.sessionId ?? null,
    scope: owner.scope ?? null,
    projectId: owner.projectId ?? null,
    setId: owner.setId ?? null,
  };
  return `\n\n[shadowroom_owner]\n${JSON.stringify(safe)}\n[/shadowroom_owner]`;
}

function ownerFromInput(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const content = Array.isArray(input[index]?.content) ? input[index].content : [];
    const text = content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    const matches = [...text.matchAll(OWNER_BLOCK_RE)];
    const last = matches.at(-1)?.[1];
    if (last === undefined) continue;
    try {
      const parsed = JSON.parse(last);
      return {
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
        scope: typeof parsed.scope === "string" ? parsed.scope : null,
        projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
        setId: typeof parsed.setId === "string" ? parsed.setId : null,
      };
    } catch {
      return { sessionId: null, scope: null, projectId: null, setId: null };
    }
  }
  return { sessionId: null, scope: null, projectId: null, setId: null };
}

function stripOwnerBlocks(text) {
  return String(text).replace(OWNER_BLOCK_RE, "").trimEnd();
}

/**
 * Chat-only providers receive only ShadowRoom MCP namespaces. Codex's own shell, subagent, goal and
 * IDE tools stay out of the product model schema: the adapter cannot execute them, and exposing them
 * made page workers believe they could escape their page boundary.
 */
export function flattenAdapterTools(rawTools) {
  const tools = [];
  const nameMap = new Map();
  for (const tool of Array.isArray(rawTools) ? rawTools : []) {
    if (tool?.type !== "namespace" || !String(tool.name ?? "").startsWith("mcp__") || !Array.isArray(tool.tools)) continue;
    for (const sub of tool.tools) {
      if (sub?.type !== "function") continue;
      const flat = `${tool.name}__${sub.name}`;
      const serverName = String(tool.name).replace(/^mcp__/, "");
      nameMap.set(flat, { server: serverName, tool: sub.name });
      tools.push({
        type: "function",
        function: {
          name: flat,
          description: sub.description ?? tool.description ?? "",
          parameters: sub.parameters ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return { tools, nameMap };
}

const MEDIA_PROTOCOLS = {
  "minimax-t2a": {
    kind: "tts",
    path: "/v1/t2a_v2",
    build: (input) => ({
      model: input.model,
      text: input.text,
      output_format: "hex",
      voice_setting: { voice_id: input.voice || "male-qn-qingse", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: input.format || "mp3", sample_rate: (input.format || "mp3") === "mp3" ? 32_000 : 44_100, bitrate: 128_000, channel: 1 },
    }),
    pick: (payload) => {
      const audio = payload?.data?.audio;
      if (typeof audio !== "string" || audio === "") {
        const detail = payload?.base_resp?.status_msg ?? "返回里没有音频";
        throw new Error(detail);
      }
      return Buffer.from(audio, "hex");
    },
  },
  "minimax-music": {
    kind: "music",
    path: "/v1/music_generation",
    build: (input) => ({
      model: input.model,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.lyrics ? { lyrics: input.lyrics } : {}),
      output_format: "hex",
      audio_setting: { format: input.format || "mp3", sample_rate: 44_100, bitrate: 256_000 },
      lyrics_optimizer: input.lyrics ? false : true,
      ...(input.instrumental === undefined ? {} : { is_instrumental: input.instrumental }),
    }),
    pick: (payload) => {
      const audio = payload?.data?.audio;
      if (typeof audio !== "string" || audio === "") {
        const detail = payload?.base_resp?.status_msg ?? "返回里没有音频";
        throw new Error(detail);
      }
      return Buffer.from(audio, "hex");
    },
  },
  "minimax-image": {
    kind: "image",
    path: "/v1/image_generation",
    build: (input) => ({
      model: input.model,
      prompt: input.prompt || "a single lime green dot",
      aspect_ratio: "1:1",
      response_format: "url",
      n: 1,
      prompt_optimizer: false,
    }),
    pick: (payload) => {
      const urls = Array.isArray(payload?.data?.image_urls) ? payload.data.image_urls : [];
      const base64 = Array.isArray(payload?.data?.image_base64) ? payload.data.image_base64 : [];
      const detail = payload?.base_resp?.status_msg;
      if (urls.length === 0 && base64.length === 0) {
        throw new Error(typeof detail === "string" && detail !== "" ? detail : "返回里没有图像");
      }
      return { count: urls.length + base64.length };
    },
  },
  "openai-audio-speech": {
    kind: "tts",
    path: "/audio/speech",
    build: (input) => ({
      model: input.model,
      input: input.text,
      voice: input.voice || "alloy",
      response_format: input.format || "mp3",
    }),
    pick: null, // 裸字节，不解析
  },
  "elevenlabs-tts": {
    kind: "tts",
    path: "/text-to-speech/{voice}",
    build: (input) => ({ text: input.text, model_id: input.model }),
    pick: null,
  },
};

/**
 * 语音识别（STT）协议表 —— 和 TTS 一样是「每家形状不同」的适配层。
 *
 * MiniMax 的形状是**实测**出来的（2026-10-16，用户 key 真打）：`POST /v1/speech_to_text`，
 * `multipart/form-data`，表单字段 `model=asr-1.0` + `file=<wav>`，返回 JSON `{text, duration}`。
 * （先按 OpenAI 的 `/audio/transcriptions` 猜了一轮全是 404；官方错误信息里点名了要求的字段与型号。）
 * OpenAI 兼容端点走同一张表的 `openai-transcriptions`（`/audio/transcriptions` + file/model）。
 */
const STT_PROTOCOLS = {
  "minimax-asr": {
    path: "/v1/speech_to_text",
    fields: (input) => ({ model: input.model || "asr-1.0" }),
    pick: (payload) => ({ text: String(payload?.text ?? ""), duration: payload?.duration ?? null }),
  },
  "openai-transcriptions": {
    path: "/audio/transcriptions",
    fields: (input) => ({ model: input.model }),
    pick: (payload) => ({ text: String(payload?.text ?? "") }),
  },
};

/**
 * `<think>…</think>` 的剥离已上收到唯一的实现：core 的 agentMessage/delta 出口
 * （`think-stream.mjs` 的流式状态机，见 Agent#send 的 listener）。adapter 原样透传文本增量，
 * 思考内容因此能一路流到出口、被转成 reasoning 事件发给前端——而不是在这里被静默丢掉。
 */

/** 一轮 chat 请求：把文本与工具调用都收齐（文本仍然按流式解析）。 */
export async function runChatRound({ base, headers, model, messages, tools, temperature, onTextDelta }) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools === undefined || tools.length === 0 ? {} : { tools }),
      ...(temperature === undefined ? {} : { temperature }),
    }),
  });
  if (!response.ok) throw new Error(await providerFailure(response));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls = new Map();
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
        text += delta.content;
        // 首句延迟的关键（P1-4）：模型一开始说话就往外推，不等整轮结束——
        // 调用方把这段当作 message(output_index=0) 立刻 emit 给 Codex。
        if (onTextDelta) onTextDelta(delta.content, text);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) ?? { id: call.id ?? `call-${index}`, name: "", arguments: "" };
        if (typeof call.id === "string" && call.id !== "") current.id = call.id;
        if (typeof call.function?.name === "string" && call.function.name !== "") current.name = call.function.name;
        if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
    }
  }
  return { text, toolCalls: [...toolCalls.values()].filter((call) => call.name !== "") };
}

/**
 * 插件在 mcp-bridge 里的短 id（`generator`）与 Codex 配置里的仓库名（`shadow-music-generator`）不是一回事，
 * `/api/call` 只认前者——第一版直接拿仓库名去调，桥返回 404「unknown server」。
 */
let serverIdCache = null;
/** `shadow_music_generator` / `shadow-music-generator` / `ShadowMusicGrabber` 只是同一家的三种写法。 */
const normalizeServerName = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
async function pluginServerId(name) {
  try {
    if (serverIdCache === null) {
      const listed = await fetch(`${MCP_BRIDGE_URL}/api/servers`).then((response) => response.json());
      serverIdCache = new Map();
      for (const server of listed?.servers ?? []) {
        serverIdCache.set(normalizeServerName(server.id), String(server.id));
        if (server.repo !== undefined) serverIdCache.set(normalizeServerName(server.repo), String(server.id));
      }
    }
    return serverIdCache.get(normalizeServerName(name)) ?? String(name);
  } catch {
    return String(name);
  }
}

/** 通过 mcp-bridge 执行一个插件工具。 */
async function callPluginTool(target, rawArguments, owner = {}) {
  if (target === undefined) return { ok: false, text: `未知工具` };
  let args = {};
  try {
    args = JSON.parse(rawArguments === "" ? "{}" : rawArguments);
  } catch {
    return { ok: false, text: `${target.tool} 的参数不是合法 JSON` };
  }
  if (owner.scope && !scopeAllowsTool(owner.scope, target.server, target.tool)) {
    const text = `当前页面无权调用 ${target.server}.${target.tool}`;
    console.log(`[adapter] scope guard rejected ${owner.scope} → ${target.server}.${target.tool}`);
    return { ok: false, text, args };
  }
  /**
   * Async render workers deliver through a separate HTTP request. Carry the thread owner in the
   * start_render arguments so the job can persist it and stamp its eventual media-event. Unknown
   * fields are ignored by the other plugin tools, so this stays backwards-compatible.
   */
  if (target.tool === "start_render" && owner.sessionId !== null && owner.sessionId !== undefined) {
    args._shadowroom = owner;
  }
  try {
    const response = await fetch(`${MCP_BRIDGE_URL}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: await pluginServerId(target.server), tool: target.tool, arguments: args }),
    });
    const payload = await response.json();
    /**
     * 只有拿到 `result` 才算成功：第一版把「桥返回了错误对象」也当成 ok，模型于是看到一段
     * 错误 JSON 却以为工具跑过了。
     */
    const ok = response.ok && typeof payload?.result === "string" && payload.isError !== true;
    const text = typeof payload?.result === "string" ? payload.result : `调用失败（HTTP ${response.status}）：${JSON.stringify(payload).slice(0, 500)}`;
    console.log(`[adapter] ${target.server}.${target.tool} ${ok ? "ok" : "failed"} (${payload?.ms ?? "?"}ms) result=${JSON.stringify(text.slice(0, 200))}`);
    // args 一起出去：媒体事件要用它携带 clip_id 这类只存在于调用参数里的句柄。
    return { ok, text, args };
  } catch (cause) {
    return { ok: false, text: `调用 ${target.server}.${target.tool} 失败：${cause instanceof Error ? cause.message : String(cause)}`, args: {} };
  }
}

/**
 * 插件里跑出来的媒体（音乐、分轨…）记一条事件，供 Studio 吸收成轨道。
 *
 * 这些调用发生在适配器内部，Codex 看不到，所以「生成的东西出现在时间线上」得靠这条通道。
 */
function noteMediaEvent(entry) {
  // 「改已存在的东西」的三个工具不产出新轨道，但前端要吸收它们的结果（换片段文件 / 改音符 /
  // 改结构），而它们需要的 clip_id 只在这次调用的参数里——所以白名单和 args 一起加。
  if (!/render_song|render_part|regenerate_part|separate_stems|generate_music|transform_notes|arrange|clip_modulate/.test(entry.tool ?? "")) return;
  /**
   * 存**完整结果文本**：Studio 用和 Codex 工具卡片同一套解析（路径、bpm、段落、各声部），
   * 截断过的 preview 只够人看，不够落盘。args 同理：regenerate_part 的吸收靠参数里的 clip_id。
   */
  const id = (MEDIA_EVENTS[MEDIA_EVENTS.length - 1]?.id ?? 0) + 1;
  MEDIA_EVENTS.push({
    id,
    at: Date.now(),
    sessionId: entry.sessionId ?? null,
    scope: entry.scope ?? null,
    projectId: entry.projectId ?? null,
    setId: entry.setId ?? null,
    server: entry.server,
    tool: entry.tool,
    ok: entry.ok,
    text: entry.resultText ?? "",
    args: entry.args ?? {},
  });
  if (MEDIA_EVENTS.length > 50) MEDIA_EVENTS.shift();
}

/** Adapter-side invocation converted to the item shape Codex uses for MCP tools. */
export function adapterToolEventToItem(event) {
  return {
    type: "mcpToolCall",
    id: event.callId,
    server: event.server,
    tool: event.tool,
    status: event.phase === "completed" ? (event.ok ? "completed" : "failed") : "inProgress",
    arguments: event.arguments,
    ...(event.phase === "completed"
      ? { result: { content: [{ type: "text", text: event.text ?? "" }] } }
      : {}),
    ...(event.phase === "completed" && !event.ok ? { error: { message: event.text ?? "调用失败" } } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
  };
}

/** Thread-local subscription; adapter and Agent share this process, so the turn receives it live. */
export function subscribeAdapterToolEvents(sessionId, scope, listener) {
  const wrapped = (event) => {
    if (event.sessionId !== sessionId || event.scope !== scope) return;
    listener({
      type: "item",
      phase: event.phase,
      item: adapterToolEventToItem(event),
    });
  };
  ADAPTER_TOOL_LISTENERS.add(wrapped);
  return () => ADAPTER_TOOL_LISTENERS.delete(wrapped);
}

function noteAdapterToolEvent(entry) {
  const event = { id: ++adapterToolEventId, at: Date.now(), ...entry };
  for (const listener of ADAPTER_TOOL_LISTENERS) listener(event);
}

/** 这条能力用哪个适配器（没有就按「裸字节」处理，兼容最简单的自建服务）。 */
function mediaAdapter(protocol) {
  return MEDIA_PROTOCOLS[String(protocol ?? "")] ?? null;
}

/**
 * 协议名 → 适配器名，允许「按端点认家」。
 *
 * 为什么需要：设置页的协议下拉只有四种通用格式（chat_completions / responses / messages /
 * custom_endpoint），预设里那些供应商协议名（minimax-t2a、mimo-tts…）在存进设置时被抹平。
 * 用户在 UI 里配 MiniMax 得到的就是 protocol="custom_endpoint" + baseUrl=api.minimaxi.com——
 * 桥这边如果只认协议名，就会拿 OpenAI 的形状去撞 MiniMax 的 API（实测 404/400，TTS 没声音）。
 * 已知的供应商协议名优先；否则按端点主机名兜底；再认不出就保持原样走通用形状。
 */
function resolveMediaProtocol(protocol, baseUrl, kind) {
  const table = kind === "stt" ? STT_PROTOCOLS : MEDIA_PROTOCOLS;
  const name = String(protocol ?? "");
  if (table[name] !== undefined) return name;
  const host = String(baseUrl ?? "").toLowerCase();
  const isMinimaxHost = ["minimaxi.com", "minimax.io", "minimax.cn", "minimax.chat"].some(
    (domain) => host === domain || host.includes(`.${domain}`),
  );
  if (isMinimaxHost) {
    if (kind === "stt") return "minimax-asr";
    if (kind === "tts") return "minimax-t2a";
    if (kind === "music") return "minimax-music";
    if (kind === "image") return "minimax-image";
  }
  return name;
}

/**
 * Media endpoints come in two shapes from the settings page:
 * - preset value: `https://api.minimaxi.com`
 * - provider value: `https://api.minimax.cn/v1`
 *
 * MiniMax media paths already begin with `/v1`, so appending one to the provider
 * value creates `/v1/v1/...` and a misleading 404. Keep chat's `/v1` base intact,
 * but remove it only for adapters whose canonical path starts at the host root.
 */
function mediaBaseUrl(baseUrl, path) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (path.startsWith("/v1/") && /\/v1$/i.test(base)) return base.slice(0, -3);
  return base;
}

/** 调用一家供应商的媒体接口，返回音频字节与内容类型。 */
async function callMedia(provider, protocol, input, options = {}) {
  const adapter = mediaAdapter(protocol);
  const path = (adapter?.path ?? "/audio/speech").replace("{voice}", encodeURIComponent(input.voice || "default"));
  const body = adapter?.build(input) ?? { model: input.model, input: input.text, voice: input.voice, response_format: input.format };
  const { response, credential } = await callProvider(
    { ...provider, baseUrl: mediaBaseUrl(provider.baseUrl, path), protocol: provider.authProtocol ?? "openai" },
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
  if (!response.ok) throw new Error(await providerFailure(response));
  const contentType = response.headers.get("content-type") ?? "";
  let audio;
  if (adapter?.pick) {
    const payload = await response.json().catch(() => ({}));
    audio = adapter.pick(payload);
  } else if (contentType.includes("application/json")) {
    const payload = await response.json();
    const base64 = payload?.data?.audio ?? payload?.audio ?? (typeof payload?.data === "string" ? payload.data : undefined);
    if (typeof base64 !== "string" || base64 === "") throw new Error("返回里没有音频");
    audio = Buffer.from(base64, "base64");
  } else {
    audio = Buffer.from(await response.arrayBuffer());
  }
  if (audio.length < 512) throw new Error(`音频太短（${audio.length} 字节），可能不是音频`);
  return { audio, contentType: contentType.includes("json") ? "audio/mpeg" : contentType, credential };
}

/** STT shares the live endpoint and the settings-page test; keep the wire shape in one place. */
async function callStt(provider, protocol, input, options = {}) {
  const adapter = STT_PROTOCOLS[protocol];
  if (adapter === undefined) throw new Error(`未知识别协议：${protocol}`);
  const form = new FormData();
  for (const [key, value] of Object.entries(adapter.fields({ model: input.model, format: input.format }))) {
    if (value !== undefined && value !== null && value !== "") form.set(key, String(value));
  }
  form.set(
    "file",
    new Blob([input.audio], { type: String(input.format ? `audio/${input.format}` : "audio/wav") }),
    "turn.wav",
  );
  const { response } = await callProvider(
    { ...provider, baseUrl: mediaBaseUrl(provider.baseUrl, adapter.path), protocol: provider.authProtocol ?? "openai" },
    adapter.path,
    { method: "POST", body: form },
    { timeoutMs: 120_000, ...options },
  );
  if (!response.ok) throw new Error(await providerFailure(response));
  const payload = await response.json().catch(() => ({}));
  return adapter.pick(payload);
}

/** A tiny valid WAV is enough to authenticate and exercise an STT endpoint without sending user speech. */
function diagnosticWav(durationMs = 320) {
  const sampleRate = 16_000;
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/** Chat-only providers may wrap a five-token answer in reasoning markup; the probe should show the answer. */
function visibleModelReply(content) {
  return String(content ?? "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .trim();
}

/** 把一段音频写到 recordings/，并把真实时长量出来（WAV 读 header，其它交给 ffmpeg 探测）。 */
function saveMedia(audio, name, format) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = safeFileName(name) || `media-${stamp}`;
  const target = uniqueName(RECORDINGS_DIR, `${base}.${format}`);
  const targetPath = join(RECORDINGS_DIR, target);
  writeFileSync(targetPath, audio);
  let durationMs = wavDurationMs(audio);
  if (durationMs === 0) {
    const ffmpeg = findFfmpeg();
    if (ffmpeg !== null) {
      const probed = spawnSync(ffmpeg, ["-v", "error", "-i", targetPath, "-f", "null", "-"], { encoding: "utf8", timeout: 60_000 });
      const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(probed.stderr ?? "");
      if (match !== null) durationMs = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
    }
  }
  return { path: targetPath, name: target, duration_ms: durationMs, bytes: audio.length };
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
/** 导出给测试/工具用（本文件也被 tests 引用其内部函数）。 */
export async function startChatAdapter(provider, credential) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(credential === null ? {} : { authorization: `Bearer ${credential.value}` }), ...(provider.headers ?? {}) };
  const server = createServer(async (request, response) => {
    const send = (code, body, type = "application/json") => {
      response.writeHead(code, { "content-type": type });
      response.end(body);
    };
    const header = (name) => {
      const value = request.headers[name];
      return typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";
    };
    const headerOwner = {
      sessionId: header("x-shadowroom-session-id") || null,
      scope: header("x-shadowroom-scope") || null,
      projectId: header("x-shadowroom-project-id") || null,
      setId: header("x-shadowroom-set-id") || null,
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
      /**
       * `readJsonBody` already parses — calling `JSON.parse` on its result turned every request into
       * `"[object Object]" is not valid JSON`, i.e. a 500 the moment Codex connected. It answered
       * "stream disconnected" and retried five times, which is why the adapter looked unreachable.
       */
      const body = await readJsonBody(request, 8 * 1024 * 1024);
      for (const item of Array.isArray(body.input) ? body.input : []) {
        if (item?.type === "function_call_output") {
          console.log(`[adapter] tool result ← ${String(item.output ?? "").slice(0, 300)}`);
        }
        if (item?.type === "function_call") {
          console.log(`[adapter] tool call → ${item.name} ${String(item.arguments ?? "").slice(0, 200)}`);
        }
      }
      const toolNames = (body.tools ?? []).map((tool) => tool.name).filter(Boolean);
      console.log(`[adapter] ← ${body.model} · input=${Array.isArray(body.input) ? body.input.length : 0} · tools=${toolNames.length} · stream=${body.stream}`);
      console.log(`[adapter] tools: ${toolNames.join(", ").slice(0, 400)}`);
      const sample = (body.tools ?? []).find((tool) => String(tool.name ?? "").startsWith("mcp__"));
      if (sample !== undefined) console.log(`[adapter] raw mcp tool: ${JSON.stringify(sample).slice(0, 1200)}`);
      /** Responses `input` items → chat messages. */
      const input = Array.isArray(body.input) ? body.input : [];
      const embeddedOwner = ownerFromInput(input);
      const eventOwner = {
        sessionId: headerOwner.sessionId ?? embeddedOwner.sessionId,
        scope: headerOwner.scope ?? embeddedOwner.scope,
        projectId: headerOwner.projectId ?? embeddedOwner.projectId,
        setId: headerOwner.setId ?? embeddedOwner.setId,
      };
      const messages = [];
      if (typeof body.instructions === "string" && body.instructions !== "") messages.push({ role: "system", content: body.instructions });
      for (const item of input) {
        if (item?.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id, content: String(item.output ?? "") });
          continue;
        }
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = stripOwnerBlocks(content.map((part) => part?.text ?? "").join(""));
        if (item?.type === "function_call") {
          messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }] });
          continue;
        }
        messages.push({ role: item?.role === "assistant" ? "assistant" : "user", content: text });
      }
      /**
       * MCP 工具是**命名空间**（`type: "namespace"` + 嵌套 `tools`），普通工具是 `type: "function"`。
       *
       * 第一版只透传 function，于是所有插件工具在发给模型前就被丢掉了 —— 模型看不到 `detect_tempo`、
       * `render_song`，只能以为「MCP 没起来」。Codex 的 `ToolName` 是 namespace 与 name **拼起来**的
       * （`protocol/src/tool_name.rs` 的 `Display`），所以这里把命名空间展开成具体工具，
       * 名字写成 `mcp__服务器__工具`。
       */
      /**
       * This Codex cannot route namespaced plugin calls returned by a chat model, so the adapter runs
       * them itself and feeds the result back as a normal tool message. Only MCP namespaces enter this
       * table; built-in shell/subagent tools are deliberately filtered out.
       */
      const { tools, nameMap } = flattenAdapterTools(body.tools);
      console.log(`[adapter] scoped plugin tools=${tools.length}: ${tools.map((tool) => tool.function.name).join(", ")}`);
      /**
       * 工具循环：模型要工具 → 我们执行 → 结果喂回去 → 直到它给出最终回答。
       *
       * 对 chat-only 供应商（MiniMax、DeepSeek…）这是唯一能真正用上插件的方式；上限 8 轮避免打转。
       */
      const executed = [];
      let messagesForRound = messages;
      let finalText = "";
      let round = 0;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const adapterT0 = Date.now();
      let firstTextAt = null;
      const sseLog = [];
      const emit = (type, payload) => {
        sseLog.push(type);
        if (type === "response.output_text.delta" && firstTextAt === null) firstTextAt = Date.now();
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      };
      const id = `resp-${Date.now().toString(36)}`;
      emit("response.created", { response: { id, model: body.model ?? "", status: "in_progress", output: [] } });

      /**
       * One message item stays open across all adapter-side tool rounds. Closing it before the next
       * round caused `OutputTextDelta without active item`. Plugin calls are reported through the side
       * channel; they are not emitted as Responses function calls because the adapter already ran them.
       */
      let messageOpened = false;
      let messageClosed = false;
      let messageText = "";
      const openMessage = () => {
        if (messageOpened) return;
        messageOpened = true;
        emit("response.output_item.added", { output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "in_progress", content: [] } });
        emit("response.content_part.added", { item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      };
      const closeMessage = (final) => {
        if (!messageOpened || messageClosed) return;
        messageClosed = true;
        emit("response.output_text.done", { item_id: "msg-1", output_index: 0, content_index: 0, text: final });
        emit("response.content_part.done", { item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: final, annotations: [] } });
        emit("response.output_item.done", { output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: final, annotations: [] }] } });
      };

      for (; round < 8; round += 1) {
        /**
         * 文本增量原样透传——包括 <think> 标签。思考的剥离只发生在一个地方：core 把
         * agentMessage/delta 流回来时，bridge 出口的流式状态机（think-stream.mjs）把 think 转成
         * reasoning 事件、正文只发净文本。以前 adapter 在这里静默丢 think（用户看不到模型想了
         * 什么），而且它的 finish() 兜底会把未闭合的标签原样吐回正文——真机上 think 直出的
         * 泄漏就是那条路。一个规则一个实现（AGENTS.md 第一原则）。
         */
        const outcome = await runChatRound({
          base,
          headers,
          model: body.model,
          messages: messagesForRound,
          tools,
          temperature: body.temperature,
          // 每轮的文本增量：第一轮直接透传给用户（首句）；后续轮的文本也照发（工具间的话）。
          onTextDelta: (delta) => {
            if (delta === "") return;
            openMessage();
            messageText += delta;
            emit("response.output_text.delta", { item_id: "msg-1", output_index: 0, content_index: 0, delta });
          },
        });
        if (outcome.toolCalls.length === 0) {
          finalText = outcome.text;
          break;
        }
        const assistantToolMessage = {
          role: "assistant",
          // 关键：content 保留模型原文（不能写 null）——chat 供应商把纯文本+null 工具调用
          // 当完整回合直接 stop；合并成一条 {content, tool_calls} 才是合法的「说话又要工具」。
          ...(outcome.text === "" ? {} : { content: outcome.text }),
          tool_calls: outcome.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        };
        messagesForRound = [...messagesForRound, assistantToolMessage];
        let functionOutputIndex = 1;
        for (const call of outcome.toolCalls) {
          const target = nameMap.get(call.name);
          const callItem = { id: call.id ?? `call-${round}-${functionOutputIndex}`, type: "function_call", call_id: call.id ?? `call-${round}-${functionOutputIndex}`, name: call.name, arguments: call.arguments, status: "in_progress" };
          const startedAt = Date.now();
          const adapterCallId = `adapter-${eventOwner.sessionId ?? "local"}-${callItem.id}`;
          noteAdapterToolEvent({
            ...eventOwner,
            phase: "started",
            callId: adapterCallId,
            server: target?.server ?? "unknown",
            tool: target?.tool ?? call.name,
            arguments: call.arguments,
            ok: true,
          });
          const result = await callPluginTool(target, call.arguments, eventOwner);
          executed.push({ name: call.name, ...(target ?? {}), ok: result.ok, resultText: result.text, args: result.args });
          noteAdapterToolEvent({
            ...eventOwner,
            phase: "completed",
            callId: adapterCallId,
            server: target?.server ?? "unknown",
            tool: target?.tool ?? call.name,
            arguments: call.arguments,
            ok: result.ok,
            text: result.text,
            durationMs: Date.now() - startedAt,
          });
          messagesForRound = [
            ...messagesForRound,
            { role: "tool", tool_call_id: callItem.call_id, content: result.text },
          ];
          functionOutputIndex += 1;
        }
      }
      if (messageText !== "") finalText = messageText;
      if (finalText === "" && executed.length > 0) finalText = "（工具执行完了，但模型没有给出总结。）";
      for (const entry of executed) noteMediaEvent({ ...entry, ...eventOwner });
      let text = finalText;
      console.log(`[adapter] → done · rounds=${round + 1} · tools=${executed.length} · text=${JSON.stringify(text.slice(0, 40))}`);

      // 终态兜底：循环结束后 message 还没关（模型最后一轮直接给完整回答、没有工具）就在这里收。
      if (messageOpened && !messageClosed) {
        closeMessage(text);
      } else if (!messageOpened && text !== "") {
        openMessage();
        closeMessage(text);
      }
      const output = [];
      if (messageOpened) {
        output.push({ id: "msg-1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
      }
      emit("response.completed", {
        response: { id, model: body.model ?? "", status: "completed", output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      });
      console.log(`[adapter] → done · text=${JSON.stringify(text.slice(0, 40))} · calls=${executed.length}`);
      console.log(`[adapter] 首句 emit 于 ${firstTextAt === null ? "?" : firstTextAt - adapterT0}ms`);
      console.log(`[adapter] SSE 序: ${sseLog.join(" → ")}`);
      console.log(`[adapter] completed.output items: ${output.map((item) => item.type).join(", ")}`);
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
async function callProvider({ baseUrl, reference, protocol }, path, init, options = {}) {
  const credential = reference === null || reference === undefined ? null : resolveCredential(reference);
  const headers = { ...(init?.headers ?? {}) };
  if (credential !== null && protocol !== "elevenlabs") headers.authorization = `Bearer ${credential.value}`;
  if (credential !== null && protocol === "elevenlabs") headers["xi-api-key"] = credential.value;
  const url = `${String(baseUrl).replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  return { response, credential };
}

/** Turn a failed provider response into a sentence the settings page can show as-is. */
async function providerFailure(response) {
  if (response.status === 401 || response.status === 403) return "Key 无效或没有权限";
  if (response.status === 404) return "端点或模型不存在";
  if (response.status === 429) return "请求太频繁（被限流了）";
  if (response.status >= 500) return "服务商那边出错了";
  const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
  if (response.status === 410 && /music api.*no longer available/i.test(detail)) {
    return "MiniMax 音乐 API 已对新用户关闭（HTTP 410 / 2153）；音乐请用本地合成器";
  }
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

/**
 * What `GET /api/agent/file` may serve — audio for the players **plus images for cover art**
 * (the library writes `_library/covers/<id>.jpg`; the page loads it through this endpoint).
 *
 * Deliberately a separate map: `STREAMABLE` above doubles as the *import* filter, and letting a
 * .jpg through the import endpoint would mean "import this cover as an audio file".
 */
const SERVEABLE = new Map([
  ...STREAMABLE,
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

/** The plugins, injected into every thread so the agent has the same tools as the sidebar. */
const PLUGIN_REPOS = [
  "rekordbox-serato-bridge",
  "audio-analysis-dedupe",
  "set-planner",
  "shadow-music-generator",
  "stem-splitter",
  /**
   * 这两个是后加的，一开始漏在这份清单外——它们的工具因此**对模型不可见**（桥里有、模型调不到）：
   * soundfont-renderer = 真乐器音色；steward = 管家账本（situation_report / recent_events）。
   */
  "soundfont-renderer",
  "steward",
  "library",
  "ShadowMusicGrabber",
];

/**
 * A page worker gets the domain tools it can actually operate; it does not get the whole toolbox.
 * Hidden tools are removed from the model schema and checked again at execution time. `null` means
 * the whole server is intentionally part of that page scope.
 */
export const SCOPE_TOOL_ALLOWLIST = {
  butler: {
    steward: [
      "situation_report",
      "recent_events",
      "focus_change",
      "report_done",
      "app_command",
      "handoff_create",
      "handoff_claim",
      "handoff_finish",
      "handoff_get",
      "handoff_list",
    ],
  },
  studio: {
    "shadow-music-generator": [
      "submit_generation",
      "run_job",
      "job_status",
      "render_part",
      "render_song",
      "start_render",
      "cancel_render",
      "mix_arrangement",
      "export_stems",
      "export_midi",
      "arrange",
      "regenerate_part",
      "render_section",
      "transform_notes",
      "list_export_formats",
      "clip_modulate",
    ],
    "stem-splitter": ["separate_stems", "stem_job_status", "stem_job_cancel", "stem_backends", "stem_install_backend"],
    "soundfont-renderer": ["list_instruments", "render_notes", "render_midi"],
    "audio-analysis-dedupe": ["analyze_file", "hum_to_midi", "groove_to_pattern", "hum_to_drums", "detect_tempo", "detect_key"],
    library: ["list_tracks", "track_detail", "crate_list"],
  },
  dj: {
    "set-planner": ["plan_set", "suggest_next", "order_set"],
    "audio-analysis-dedupe": ["analyze_file", "detect_tempo", "detect_key", "suggest_cues"],
    library: ["list_tracks", "track_detail", "crate_list", "set_list", "set_detail", "stats"],
  },
  library: {
    library: null,
    "audio-analysis-dedupe": null,
    ShadowMusicGrabber: null,
    "stem-splitter": ["stem_backends", "stem_job_status"],
  },
};

/** Runtime mirror of the model-facing allow-list. The schema hides tools; this stops leaked calls. */
export function scopeAllowsTool(scope, server, tool) {
  const allow = SCOPE_TOOL_ALLOWLIST[scope];
  if (allow === undefined) return false;
  const normalized = String(server).toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = Object.keys(allow).find((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized);
  if (key === undefined) return false;
  const tools = allow[key];
  return tools === null || tools.includes(tool);
}

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
  "要改**结构**（\"加一个 8 小节的 breakdown\"\"再来一遍副歌\"\"把这段删掉\"）时，用 shadow-music-generator 的 arrange：把消息里 [arrangement_context] 的 bars/sections/tracks 原样传进去，operations 写 [{\"op\":\"insert_bars\",\"at_bar\":16,\"count\":8,\"name\":\"breakdown\"}] 或 [{\"op\":\"duplicate_section\",\"section\":\"drop\"}] 或 [{\"op\":\"remove_section\",\"section\":\"outro\"}] 或 [{\"op\":\"repeat_last_section\"}]，revision 回传。工具会算出每个片段的新位置（复制的片段带 copy_of），前端落盘并给受影响的片段标上「需重渲染」——**不要自己算位置，也不要顺手重渲染整首歌**。",
  "每条消息都会带一段 [arrangement_context]：当前工程的名字/速度/小节、段落、以及每条轨上每个片段的 **path** 与 **render_spec**。音频文件只有前端知道，所以**导出、分轨、改单轨一律用这里的 path/spec，不要凭记忆编路径**；片段没有 path 就是还没渲染的纯音符片段（导出时它只能走 MIDI）。",
  "想让**某一条轨道的声音**变一点（\"鼓再重一点\"\"bass 更暗\"\"换成方波\"\"镲密一点\"\"去掉某些鼓\"）时，用 shadow-music-generator 的 regenerate_part：把消息里 render_spec 的 part 原样传成 part、bpm/bars/sections 一起传、**clip_id 必填**（就是消息里 clip_context 的 clip_id，前端靠它把结果落到那条轨；不传工具会报错），patch 只动你要改的那几个键——gain_db（-24…+6）、cutoff（0–1，正数更亮）、swing（+0.05 之类）、humanize_ms（+10 之类）、pan、reverb、delay、wave（sine/triangle/square/saw）、pattern（鼓：合并某些行）、remove_voices、transpose、velocity_scale。**只重渲染这一轨，其他轨不动**；不要把整份 spec 重写成新歌，也不要顺手改别的参数。",
  "regenerate_part 的新文件放在 ~/Documents/ShadowRoom/recordings/ 下、文件名带时间戳（例如 drums-v2-<时间戳>.wav），这样旧的 stem 还在，用户撤销时不用重新渲染。",
  "用户要「给某个片段加侧链泵感 / pump / 呼吸感」时：用 shadow-music-generator 的 clip_modulate——clip_id 用消息里 [clip_context] 的 clip_id（是 [arrangement_context] 里的片段就取那一条），rate 只从 \"1/4\"、\"1/2\"、\"1bar\" 三档里选（默认 1bar），depth 0–1（默认 0.7，越深下潜越狠）。这是**渲染期**调制：片段的右键菜单里会立刻长出「泵感」条目，导出时才被烘进音频，**播放声音不变**——所以不要顺手重渲染，也不要自己算 rate_hz（前端按工程 BPM 换算）。",
  "用户要把一首歌/一段成品拆开时（\"把这首歌分轨 / 拆出人声 / 只要鼓\"）：调用 stem-splitter 的 separate_stems（path 用那条音频路径），它立刻返回 job_id，然后每隔几秒用 stem_job_status 看一次（stage 会从 decode 走到 separate 再到 collect），拿到 status=ok 再回复。四条分轨（人声/鼓/贝斯/其它）会自动落到 Studio 的新轨道上，你不用自己写文件；一次分离在 CPU 上要几分钟，先告诉用户开始了。",
  "需要知道这台机器能不能分轨，用 stem_backends：它说没有后端时，把启用方法原样告诉用户（装 demucs 到 _venvs/stem-splitter，或设 STEM_SPLIT_COMMAND）。",
  "导出同样可以让我做：mix_arrangement 导出整首（out_path/.bpm/.bars/sample_rate/bit_depth/container + tracks），export_stems 导出分轨（out_dir + name），export_midi 导出 MIDI（out_path；音符来自 clip.notes，或指向 .mid 的 clip）。它们的 tracks 结构一致：{name, gain, clips:[{path, start(小节), bars, gain, notes?}]}——path 取自 [arrangement_context] 里那条轨的片段，gain 用 volume/100，片段没渲染过就别编 path。默认把整首导出到 ~/Documents/ShadowRoom/exports/<歌名>.<格式>，然后一句话告诉用户文件在哪。",
  "做音乐/音频一律用 MCP 工具（render_song、render_part、transform_notes、separate_stems、detect_tempo 等）。**不要**为了绕过工具去 shell 里手动跑 Python 脚本：那既慢又要用户反复批准。如果工具调用失败并提示连不上 bridge，就直说一句「MCP bridge 没起来，请在终端跑 pnpm serve」，然后停下等用户——不要自己想办法绕过。",
  "用户要这首歌的 MIDI 时，最省事的是渲染时就带上 midi_path（render_song 的另一个参数，例如 ~/Documents/ShadowRoom/recordings/<歌名>.mid）：它写出的不是从音频里猜出来的音符，而是刚才实际演奏的那份编曲（鼓在 MIDI 的鼓通道上），Studio 里会多出一条 MIDI 轨，导出对话框的 MIDI 也读它。",
  "一个可用的例子：{\"out_path\":\"~/Documents/ShadowRoom/recordings/night-drive.wav\",\"bpm\":124,\"bars\":8,\"parts\":[{\"part\":\"drums\",\"pattern\":{\"kick\":\"x...x...x...x...\",\"clap\":\"....x.......x...\",\"hat\":\"..x...x...x...x.\"}},{\"part\":\"bass\",\"wave\":\"saw\",\"cutoff\":0.32,\"notes\":[{\"midi\":33,\"start\":0,\"length\":0.75},{\"midi\":33,\"start\":1.5,\"length\":0.5},{\"midi\":36,\"start\":3,\"length\":1}]}]}",
  "带结构的例子（32 小节 tech house）：{\"out_path\":\"~/Documents/ShadowRoom/recordings/drive.wav\",\"bpm\":126,\"sections\":[{\"name\":\"intro\",\"bars\":8},{\"name\":\"drop\",\"bars\":16},{\"name\":\"outro\",\"bars\":8}],\"parts\":[{\"part\":\"drums\",\"swing\":0.14,\"humanize_ms\":16,\"segments\":[{\"bars\":8,\"pattern\":{\"hat\":\"..x...x...x...x.\"}},{\"bars\":16,\"pattern\":{\"kick\":\"x...x...x...x...\",\"clap\":\"....x.......x...\",\"hat\":\"..x...x...x...x.\"}},{\"bars\":8,\"pattern\":{\"kick\":\"x...x...x...x...\",\"hat\":\"..x...x...x...x.\"}}]},{\"part\":\"bass\",\"wave\":\"saw\",\"cutoff\":0.32,\"pan\":0,\"repeat\":true,\"segments\":[{\"bars\":8,\"gain\":0},{\"bars\":16,\"notes\":[{\"midi\":33,\"start\":0,\"length\":0.75},{\"midi\":33,\"start\":1.5,\"length\":0.5},{\"midi\":36,\"start\":3,\"length\":0.75}]},{\"bars\":8,\"gain\":0}]},{\"part\":\"chords\",\"wave\":\"triangle\",\"pan\":-0.3,\"reverb\":0.18,\"repeat\":true,\"segments\":[{\"bars\":8,\"gain\":0.4,\"notes\":[{\"midi\":57,\"start\":0,\"length\":4},{\"midi\":60,\"start\":0,\"length\":4},{\"midi\":64,\"start\":0,\"length\":4}]},{\"bars\":16,\"notes\":[{\"midi\":57,\"start\":0,\"length\":4},{\"midi\":60,\"start\":0,\"length\":4},{\"midi\":64,\"start\":0,\"length\":4}]},{\"bars\":8,\"gain\":0.4,\"notes\":[{\"midi\":57,\"start\":0,\"length\":4},{\"midi\":60,\"start\":0,\"length\":4},{\"midi\":64,\"start\":0,\"length\":4}]}]}]}",
  "回答尽量短、口语化，因为会被朗读出来；需要执行的操作直接调用工具，不要只描述。",
].join("\n");

const SCOPE_INSTRUCTIONS = {
  butler:
    [
      "你是全局管家，不是 Studio、DJ 或曲库 worker。你负责跨页面状态、路由建议和账本查询；当前 MVP 不直接执行领域写操作。",
      "App 内动作只有一个工具 steward.app_command，必须按用户意图二选一。用户只想打开/切换页面（例如「切到 Studio」「带我去 DJ」）时，用 op=navigate，view 只从 workbench/conversation/plugins/studio/dj/library/settings 选，并写一句 reason；navigate 只换页面，不派 worker、不建 handoff、不要带附件。",
      "用户要改变 Studio/DJ/曲库里的东西时，用 op=dispatch，把任务放进 route={target, action_summary, confidence, required_context?, context?}；target 只选 studio/dj/library，action_summary 必须自包含，context 原样带上 [ui_context] 里的 workspace/projectId/setId。App 会自动打开目标页，不要先再发一个 navigate。",
      "同一句既换页又干活时只发 dispatch；一轮最多一个 dispatch，不要拆成两条。询问当前页面/工程状态、闲聊、打招呼、确认、拒绝、结束语（如「好的」「不需要了」）直接回答，不要调用 app_command，也不要制造补充信息卡。",
      "navigate 成功后只回一句「好，切到 Studio」这类确认，不播报工程 ID、切换次数或组件细节；不要假装同时完成了领域任务。",
      "除非用户明确问「现在在哪 / 刚才做了什么 / 当前状态」，否则不要主动播报页面、工程、切换次数、账本摘要或工具履历；打招呼就正常打招呼，不发状态报告。",
      "用户问「Studio/DJ/曲库刚才做了什么、现在在干嘛」时，先看 situation_report 里的 handoffs；需要更多细节再调 handoff_list，但只报结果和仍待办的事，不复读附件路径或整段指令。",
      "用户已经附上哼唱/录音并要求写进音乐时，action_summary 必须明确要求 worker 使用该附件（例如「用附带的语音录音调用 hum_to_midi，并写入当前 Studio 工程」）；不要回复让用户重新录一遍。",
      "安全、高置信度的路由会由前端直接交给目标 worker，不要要求用户再点确认；只有删除、清空、覆盖、移动等破坏性操作才需要确认卡。屏幕回复只说正在交给目标页面，不要假装结果已经生成。",
    ].join(""),
  studio:
    "你是当前 Studio 页面专属 worker。你只处理当前打开的工程；不要回答或修改 DJ Set、曲库全局管理。每条工程消息都带 projectId/revision，切换工程后以最新 context 为准。其它页面请求让用户回管家或去对应页面。",
  dj:
    "你是 DJ 页面专属 worker。你只处理当前 Set：选曲、排序、BPM/Camelot 关系和 set 计时。不要生成歌曲、分轨或修改曲库元数据；这些属于 Studio 或曲库 worker。",
  library:
    "你是曲目库页面专属 worker。你只处理入库、元数据、分类 crate、查重和库分析。不要生成音乐、编排 DJ Set 或修改 Studio 工程；这些属于其它页面。",
};

/**
 * Each page gets only the house rules for tools it can actually see. The Studio playbook is large and
 * mentions generator/splitter/soundfont repeatedly; appending it to DJ or Library made those workers
 * ask for tools that their schema deliberately hides.
 */
const DJ_INSTRUCTIONS = [
  "你运行在 Shadow Producers 的 DJ 页面。当前 Set 的数据在 [dj_set_context] 里，以它为准。",
  "选曲、推荐下一首和 AI 排序用 set-planner；读曲目详情或 crate 用 library；分析与 cue 建议用 audio-analysis-dedupe。",
  "不要生成歌曲、分轨、修改曲库元数据，也不要尝试调用 Rekordbox/Serato 转换工具；需要这些时让用户去对应页面。",
  "回答短、口语化，因为可能被朗读；执行动作时直接调用工具，不要只描述。",
].join("\n");

const LIBRARY_INSTRUCTIONS = [
  "你运行在 Shadow Producers 的曲目库页面。当前筛选、选中曲目和库状态在 [library_context] 里，以它为准。",
  "入库、元数据、分类 crate、查重和库分析用 library；音频分析用 audio-analysis-dedupe；下载与转码用 ShadowMusicGrabber；分轨后端状态用 stem-splitter。",
  "不要生成音乐、编排 DJ Set 或修改 Studio 工程；需要这些时让用户去对应页面。",
  "回答短、可执行；危险操作先说明影响再调用。",
].join("\n");

/**
 * 语音回答契约（voice-conversation S5，Kimi B1 六条 + DeepSeek 垫话/工具话规矩）。
 * 所有 scope 都带上：带 [voice_turn] 的回合按它说话；文字回合不受影响（规则只在语音回合生效，
 * 所以整段以"当回合带 [voice_turn] 标记"为前提）。
 */
const VOICE_CALL_RULES = [
  "[voice_call_rules] 带有 [voice_turn] 标记的回合是语音通话，你的回答会被朗读出来：",
  "1. 第一句直接给回答、动作或结论——不寒暄、不铺垫、不复述用户的话。",
  "2. 不主动播报当前页面、数量或切换历史（[ui_context] 是给你用的，不是给你念的）；只有用户问「现在什么状态 / 我在哪」才报状态。",
  "3. 不自报职责边界或工具履历（「我只做…」「我不会假装…」「我调用了…」）；只有用户问「你能干什么 / 为什么不能」才解释。",
  "4. 一轮最多一个追问，没有要问的就不问。",
  "5. 引用数字只说与当前问题直接相关的那个。",
  "6. 屏幕上可以有完整内容；朗读版只取前 1–2 句口语结论。",
  "7. 工具执行时不说「好的 / 收到 / 正在生成」，直接调用，完成后说结果；只有用户明确问状态才报中间态。",
  "8. 永不朗读思考过程、工具名、日志、URL、路径、ID、表格、代码。",
].join("\n");

export function developerInstructionsFor(scope) {
  const voice = `\n\n${VOICE_CALL_RULES}`;
  if (scope === "butler") return `${SCOPE_INSTRUCTIONS.butler}${voice}`;
  if (scope === "dj") return `${DJ_INSTRUCTIONS}\n\n${SCOPE_INSTRUCTIONS.dj}${voice}`;
  if (scope === "library") return `${LIBRARY_INSTRUCTIONS}\n\n${SCOPE_INSTRUCTIONS.library}${voice}`;
  return `${DEVELOPER_INSTRUCTIONS}\n\n${SCOPE_INSTRUCTIONS.studio}${voice}`;
}

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

/**
 * Thread-local MCP projection. The bridge's process has every plugin, but a thread only sees the
 * servers/tools in its scope. `enabled:false` also protects against profile-level servers leaking
 * back in through config merging.
 */
export function scopedMcpServers(scope) {
  const allow = SCOPE_TOOL_ALLOWLIST[scope] ?? SCOPE_TOOL_ALLOWLIST.butler;
  const all = mcpServers();
  const out = {};
  for (const [repo, server] of Object.entries(all)) {
    if (!(repo in allow)) {
      out[repo] = { ...server, enabled: false };
      continue;
    }
    const tools = allow[repo];
    out[repo] = tools === null ? { ...server } : { ...server, enabled_tools: tools };
  }
  return out;
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
    /**
     * Think splitters per (thread, turn, item): `<think>` tags can straddle chunks, so each
     * assistant item's delta stream owns one filter until its turn completes.
     */
    this.thinkFilters = new Map();
    /** Which provider a session's thread was started on, so settings updates reuse that thread. */
    this.threadProviders = new Map();
    /** Per-session serialized settings updates; the newest request wins the chain tail. */
    this.settingsChains = new Map();
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
      /**
       * 关键：这份配置必须带上 MCP 插件。
       *
       * 第一版只写了模型与 provider，切过去之后 agent **一个工具都没有**（它只能去 shell 里自己折腾，
       * 用户实测那次「生成音乐」花 153 秒、几十次要审批，就是这么来的）。所以这里按和默认配置同样的
       * 方式把插件写进 `[mcp_servers.*]`。
       */
      /**
       * 每个插件只写一次表头：TOML 里 `[table]` 重复出现是语法错误（第一版按每个环境变量写一次，
       * 264 个重复表头直接把内核启动打挂）。环境变量也不整份倒进来——进程本来就继承我们的 env，
       * 这里只补插件真正需要的那一个：PATH（让插件能找到工作区的 ffmpeg）。
       */
      const pluginLines = [];
      for (const [name, server] of Object.entries(mcpServers())) {
        pluginLines.push(`[mcp_servers.${JSON.stringify(name)}]`);
        if (typeof server.command === "string") pluginLines.push(`command = ${JSON.stringify(server.command)}`);
        if (Array.isArray(server.args)) pluginLines.push(`args = ${JSON.stringify(server.args)}`);
        // 插件的 `mcp_server.py` 是**相对路径**：没有 cwd 就找不到文件，插件起不来（第一版漏了它，
        // 结果切到自定义模型后工具全没了，模型只能以为「bridge 没起来」）。
        if (typeof server.cwd === "string") pluginLines.push(`cwd = ${JSON.stringify(server.cwd)}`);
        if (typeof server.default_tools_approval_mode === "string") {
          pluginLines.push(`default_tools_approval_mode = ${JSON.stringify(server.default_tools_approval_mode)}`);
        }
        pluginLines.push(`[mcp_servers.${JSON.stringify(name)}.env]`);
        pluginLines.push(`PATH = ${JSON.stringify(server.env?.PATH ?? process.env.PATH ?? "")}`);
        pluginLines.push("");
      }
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
        ...pluginLines,
      ];
      writeFileSync(join(home, "config.toml"), lines.join("\n"), { mode: 0o600 });
      this.codexHome = home;
      this.extraEnv = credential === null ? {} : { [envKey]: credential.value };
      console.log(`[agent] provider → ${provider.label} (${provider.model}) · CODEX_HOME=${home}`);
    }
    /**
     * Restarting on purpose: the old core's pending requests are going to be rejected with "agent core
     * exited", which is expected and must not look like a failure to the caller.
     */
    const child = this.child;
    this.child = null;
    this.threads.clear();
    this.threadProviders.clear();
    this.thinkFilters.clear();
    this.models = null;
    if (child !== null) {
      for (const pending of this.pending.values()) pending.reject(new Error("core restarted for a provider switch"));
      this.pending.clear();
      child.kill();
    }
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
    this.threadProviders.clear();
    this.thinkFilters.clear();
    this.stderr = [];

    child.on("exit", () => {
      /**
       * Only the *current* child's exit matters. A deliberate restart kills the old core; without this
       * guard its (late) exit event cleared the new core's state and rejected its `initialize`, which is
       * why every provider switch reported "agent core exited" while a turn still ran.
       */
      if (this.child !== child) return;
      this.child = null;
      for (const pending of this.pending.values()) pending.reject(new Error("agent core exited"));
      this.pending.clear();
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.stderr.push(text);
      if (this.stderr.length > 40) this.stderr.shift();
      // 插件/MCP 的启动失败只在核心的 stderr 里，必须能看见（否则只会表现成「工具不存在」）。
      if (/mcp|plugin|error|failed/i.test(text)) console.log(`[core] ${text.trim().slice(0, 300)}`);
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
        // thread/settings/update（模型/effort/权限的真实生效通道）只在 experimentalApi 下开放——
        // 2026-10-20 实测：false 时 core 直接回 "thread/settings/update requires experimentalApi
        // capability"。
        capabilities: { experimentalApi: true, requestAttestation: false },
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
  async threadFor(sessionId, provider = null, scope = "butler", eventContext = {}, threadSettings = null) {
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
    const safeScope = Object.hasOwn(SCOPE_TOOL_ALLOWLIST, scope) ? scope : "butler";
    const config = { mcp_servers: scopedMcpServers(safeScope) };
    // The access level a session starts with comes from the same table settings updates use; the env
    // defaults only apply when the UI never said anything.
    const preset = threadSettings?.access !== undefined ? accessPreset(threadSettings.access) : null;
    const params = {
      cwd: AGENT_CWD,
      sandbox: preset !== null ? preset.sandboxSlug : SANDBOX,
      approvalPolicy: preset !== null ? preset.approvalPolicy : APPROVAL,
      developerInstructions: developerInstructionsFor(safeScope),
      config,
    };
    // A provider choice overrides the model below (its branch sets `params.model` last).
    if (typeof threadSettings?.model === "string" && threadSettings.model !== "") {
      params.model = threadSettings.model;
    }
    if (provider !== null && provider.baseUrl && provider.model) {
      const key = provider.credentialRef ? resolveCredential(provider.credentialRef)?.value ?? "" : "";
      const id = `shadowroom-${String(provider.id ?? "custom").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const eventHeaders = {
        "x-shadowroom-session-id": sessionId,
        "x-shadowroom-scope": safeScope,
        ...(typeof eventContext.projectId === "string" && eventContext.projectId !== ""
          ? { "x-shadowroom-project-id": eventContext.projectId }
          : {}),
        ...(typeof eventContext.setId === "string" && eventContext.setId !== ""
          ? { "x-shadowroom-set-id": eventContext.setId }
          : {}),
      };
      const entry = {
        name: provider.label ?? id,
        base_url: provider.baseUrl,
        // Our providers are OpenAI-compatible endpoints; `chat` is the wire every one of them speaks.
        wire_api: provider.wireApi === "responses" ? "responses" : "chat",
        ...(key === "" ? {} : { experimental_bearer_token: key }),
        http_headers: { ...(provider.headers ?? {}), ...eventHeaders },
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
    this.threadProviders.set(sessionId, provider);
    this.info.model = started.model;
    return threadId;
  }

  /**
   * Apply model / effort / access to a session's thread and wait for the core to confirm.
   *
   * Confirmation is the `thread/settings/updated` notification, not the RPC reply — the reply only
   * says the request was accepted. Until the notification lands, nothing is "applied". A first call
   * on an unknown session creates the thread (with the same settings in `thread/start`).
   *
   * Updates are serialized per session: rapid clicks queue up and the chain tail is the value that
   * sticks, so the UI can never show A while the thread actually runs B.
   */
  applySettings(sessionId, settings, scope = "butler") {
    const previous = this.settingsChains.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#applySettingsOnce(sessionId, settings, scope));
    this.settingsChains.set(sessionId, run);
    run.finally(() => {
      if (this.settingsChains.get(sessionId) === run) this.settingsChains.delete(sessionId);
    }).catch(() => undefined);
    return run;
  }

  async #applySettingsOnce(sessionId, settings, scope) {
    const preset = accessPreset(settings.access);
    const provider = this.threadProviders.get(sessionId) ?? null;
    const threadId = await this.threadFor(sessionId, provider, scope, {}, {
      ...(typeof settings.model === "string" && settings.model !== "" ? { model: settings.model } : {}),
      access: settings.access,
    });
    let teardown = () => undefined;
    const confirmed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        teardown();
        reject(new Error("thread/settings/updated 没有在 15 秒内回来，这次设置不算生效"));
      }, 15_000);
      const listener = (message) => {
        if (message.method !== "thread/settings/updated") return;
        if (message.params?.threadId !== threadId) return;
        teardown();
        // 通知的形状是 {threadId, threadSettings: {…}}——回读的是内层（2026-10-21 实测）。
        resolve(message.params.threadSettings ?? message.params);
      };
      const listeners = this.listeners.get(threadId) ?? new Set();
      listeners.add(listener);
      this.listeners.set(threadId, listeners);
      teardown = () => {
        clearTimeout(timer);
        const current = this.listeners.get(threadId);
        if (current !== undefined) {
          current.delete(listener);
          if (current.size === 0) this.listeners.delete(threadId);
        }
      };
    });
    try {
      await this.request("thread/settings/update", {
        threadId,
        ...(typeof settings.model === "string" && settings.model !== "" ? { model: settings.model } : {}),
        ...(typeof settings.effort === "string" && settings.effort !== "" ? { effort: settings.effort } : {}),
        sandboxPolicy: preset.sandboxPolicy,
        approvalPolicy: preset.approvalPolicy,
      });
      return await confirmed;
    } catch (error) {
      teardown();
      throw error;
    }
  }

  /**
   * Start a turn and stream its events to `onEvent` until the turn ends.
   * @returns the Codex turn id.
   */
  async send(sessionId, text, onEvent, options = {}) {
    const safeScope = Object.hasOwn(SCOPE_TOOL_ALLOWLIST, options.scope ?? "") ? options.scope : "butler";
    // Only a recognized access level overrides the env defaults — anything else means "not said".
    const access =
      typeof options.settings?.access === "string" &&
      ["read-only", "workspace-write", "danger-full-access"].includes(options.settings.access)
        ? options.settings.access
        : undefined;
    const threadSettings = {
      ...(options.settings?.model !== undefined ? { model: options.settings.model } : {}),
      ...(access !== undefined ? { access } : {}),
    };
    const settingsPreset = access !== undefined ? accessPreset(access) : null;
    const threadId = await this.threadFor(
      sessionId,
      options.provider ?? null,
      safeScope,
      options.eventContext ?? {},
      threadSettings,
    );
    /**
     * `<think>…</think>` never reaches the answer text: each (thread, item) delta stream runs through
     * its own splitter, think payloads go out as reasoning events, and the turn's end settles any
     * tag that was still straddling a chunk. Keys carry the turn so a new turn starts a fresh filter
     * even when the core reuses an itemId.
     */
    const thinkKey = (itemId, turnId) => `${threadId}:${turnId ?? ""}:${itemId}`;
    const flushThink = (turnId) => {
      for (const [key, entry] of this.thinkFilters) {
        if (!key.startsWith(`${threadId}:${turnId ?? ""}:`)) continue;
        const out = entry.filter.flush();
        if (out.reasoning !== "") onEvent({ type: "reasoning", itemId: entry.itemId, turnId, text: out.reasoning });
        if (out.text !== "") onEvent({ type: "delta", text: out.text, itemId: entry.itemId, turnId });
        this.thinkFilters.delete(key);
      }
    };
    const unsubscribeAdapter = subscribeAdapterToolEvents(sessionId, safeScope, onEvent);
    const listener = (message) => {
      const { method, params } = message;
      if (method === "item/agentMessage/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : "msg";
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const key = thinkKey(itemId, turnId);
        let entry = this.thinkFilters.get(key);
        if (entry === undefined) {
          entry = { filter: createThinkFilter(), itemId };
          this.thinkFilters.set(key, entry);
        }
        const out = entry.filter.push(String(params.delta ?? ""));
        if (out.reasoning !== "") onEvent({ type: "reasoning", itemId, turnId, text: out.reasoning });
        if (out.text !== "") onEvent({ type: "delta", text: out.text, itemId, turnId });
        return;
      }
      if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
        onEvent({ type: "reasoning", itemId: params.itemId, turnId: params.turnId, text: params.delta });
        return;
      }
      if (method === "item/started" || method === "item/completed" || method === "item/updated") {
        onEvent({ type: "item", phase: method.split("/")[1], item: params.item, turnId: params.turnId });
        return;
      }
      if (method === "turn/completed") {
        flushThink(params.turn?.id);
        unsubscribeAdapter();
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
        input: [
          {
            type: "text",
            text:
              text +
              ownerBlock({
                sessionId,
                scope: safeScope,
                projectId: options.eventContext?.projectId,
                setId: options.eventContext?.setId,
              }),
            text_elements: [],
          },
          ...(options.input ?? []),
        ],
        // One source of truth now: `settings` carries the session's confirmed model/effort/access.
        // The bare model/effort options stay accepted so an older caller keeps working.
        ...(options.settings?.model !== undefined || options.model !== undefined
          ? { model: options.settings?.model ?? options.model }
          : {}),
        ...(options.settings?.effort !== undefined || options.effort !== undefined
          ? { effort: options.settings?.effort ?? options.effort }
          : {}),
        // Same values as thread settings — the turn is the last line of defence against a settings
        // update that never confirmed (2026-10-20 verified turn/start accepts these).
        ...(settingsPreset === null
          ? {}
          : {
              sandboxPolicy: settingsPreset.sandboxPolicy,
              approvalPolicy: settingsPreset.approvalPolicy,
            }),
      });
      const turnId = started?.turn?.id;
      // The turn runs asynchronously; the SSE stream stays open until turn/completed arrives.
      onEvent({ type: "turn", threadId, turnId });
      return { threadId, turnId, listener, listeners, cleanup: unsubscribeAdapter };
    } catch (error) {
      listeners.delete(listener);
      unsubscribeAdapter();
      throw error;
    }
  }

  release(threadId, listener, listeners, cleanup = () => undefined) {
    cleanup();
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
        instanceId: BRIDGE_INSTANCE,
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
     * 一家 TTS 供应商到底有哪些音色。
     *
     * 用户的原话是「通话与声音里面的那些声音跟人机一样」——系统音色是兜底，不是选择。能列音色的家
     * 就把它们列出来给人挑：MiniMax 的 `POST /v1/get_voice` 一次给系统音色 + 克隆音色，ElevenLabs
     * 的 `GET /voices`。OpenAI 兼容那一类没有列表端点，给官方预设名并说明可以手填。
     */
    if (request.method === "POST" && url.pathname === "/api/agent/providers/voices") {
      const body = await readJsonBody(request, 64 * 1024);
      const provider = { baseUrl: String(body.baseUrl ?? "").trim(), reference: body.credentialRef ?? null };
      const protocol = resolveMediaProtocol(
        String(body.protocolName ?? body.protocol ?? "openai"),
        provider.baseUrl,
        "tts",
      );
      if (provider.baseUrl === "") {
        json(response, 400, { error: "缺少端点" });
        return;
      }
      try {
        if (protocol === "minimax-t2a") {
          const { response: answer } = await callProvider(
            { ...provider, baseUrl: mediaBaseUrl(provider.baseUrl, "/v1/get_voice") },
            "/v1/get_voice",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ voice_type: "all" }),
            },
          );
          if (!answer.ok) throw new Error(await providerFailure(answer));
          const payload = await answer.json();
          const system = Array.isArray(payload?.system_voice) ? payload.system_voice : [];
          const cloned = Array.isArray(payload?.voice_cloning) ? payload.voice_cloning : [];
          const voices = [
            ...system.map((row) => ({ id: String(row?.voice_id ?? ""), name: String(row?.voice_name ?? row?.voice_id ?? "") })),
            ...cloned.map((row) => ({ id: String(row?.voice_id ?? ""), name: `${row?.voice_name ?? row?.voice_id}（我的克隆）`, cloned: true })),
          ].filter((voice) => voice.id !== "");
          console.log(`[agent] voices ${protocol} → ${voices.length}`);
          json(response, 200, { voices, source: "provider" });
          return;
        }
        if (protocol === "elevenlabs-tts") {
          const { response: answer } = await callProvider({ ...provider, protocol: "elevenlabs" }, "/voices", { method: "GET" });
          if (!answer.ok) throw new Error(await providerFailure(answer));
          const payload = await answer.json();
          const voices = (Array.isArray(payload?.voices) ? payload.voices : [])
            .map((row) => ({ id: String(row?.voice_id ?? ""), name: String(row?.name ?? row?.voice_id ?? "") }))
            .filter((voice) => voice.id !== "");
          json(response, 200, { voices, source: "provider" });
          return;
        }
        /** OpenAI 的 /audio/speech 只有固定那几个音色名，没有列表端点；自建服务同理。 */
        json(response, 200, {
          voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((id) => ({ id, name: id })),
          source: "preset",
          note: "这类语音接口没有「列出音色」的端点，上面是官方预设名；自建服务可以直接手填 voice id。",
        });
      } catch (cause) {
        json(response, 200, { error: `取音色失败：${cause instanceof Error ? cause.message : String(cause)}` });
      }
      return;
    }

    /**
     * 语音识别：把一句录音（base64 WAV）交给供应商的 STT，拿回文字。
     *
     * 为什么要有这条：浏览器自带的 SpeechRecognition 要连 Google 的识别服务（国内基本连不上），
     * 桌面包里干脆没有这个 API（DECISIONS ADR-018）。没有它，通话只能「听见自己」——
     * 用户 2026-10 的实测结论就是「根本用不了」。这里按 STT_PROTOCOLS 适配各家形状，
     * key 只留在桥里（和 TTS 同一条规矩）。
     */
    if (request.method === "POST" && url.pathname === "/api/agent/providers/stt") {
      let body;
      try {
        body = await readJsonBody(request, 64 * 1024 * 1024);
      } catch (cause) {
        // 单个回合的 WAV 上限 64MB（≈25 分钟 16k 单声道）；超了给 413 + 人话，别落成 500 英文原文。
        const tooLarge = /too large/i.test(String(cause?.message ?? cause));
        json(response, tooLarge ? 413 : 400, {
          error: tooLarge ? "这段录音太大（超过 64MB 上限）——说短一点，或分两次说。" : `请求读不出来：${cause instanceof Error ? cause.message : String(cause)}`,
        });
        return;
      }
      const audioBase64 = String(body.audio ?? "");
      const provider = {
        baseUrl: String(body.baseUrl ?? "").trim(),
        reference: body.credentialRef ?? null,
        protocol: body.protocol ?? "openai",
      };
      const protocolName = resolveMediaProtocol(
        typeof body.protocolName === "string" && body.protocolName !== "" ? body.protocolName : provider.protocol,
        provider.baseUrl,
        "stt",
      );
      const adapter = STT_PROTOCOLS[protocolName];
      if (adapter === undefined) {
        json(response, 400, { error: `未知识别协议：${protocolName}（可用：${Object.keys(STT_PROTOCOLS).join(", ")}）` });
        return;
      }
      if (audioBase64 === "" || provider.baseUrl === "") {
        json(response, 400, { error: "缺少 audio 或端点" });
        return;
      }
      try {
        const audio = Buffer.from(audioBase64, "base64");
        const started = Date.now();
        const picked = await callStt(provider, protocolName, {
          audio,
          model: body.model,
          format: body.format,
        });
        // 不把识别文本写进日志：用户说的话属于隐私，桥日志会被翻（MiniMax #356 低危 1）。
        console.log(`[agent] stt ${protocolName} ${audio.length}B → ${[...String(picked.text ?? '')].length} 字 (${Date.now() - started}ms)`);
        json(response, 200, picked);
      } catch (cause) {
        json(response, 200, { error: `识别失败：${cause instanceof Error ? cause.message : String(cause)}` });
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
      try {
        const { audio, contentType } = await callMedia(
          { baseUrl: provider.baseUrl, reference: provider.reference },
          resolveMediaProtocol(
            typeof body.protocolName === "string" ? body.protocolName : provider.protocol,
            provider.baseUrl,
            "tts",
          ),
          { model, text, voice: typeof body.voice === "string" ? body.voice : "", format: typeof body.format === "string" ? body.format : "mp3" },
        );
        console.log(`[agent] tts ${model} → ${audio.length} bytes`);
        json(response, 200, { audio: audio.toString("base64"), contentType, bytes: audio.length });
      } catch (cause) {
        json(response, 200, { error: `合成失败：${cause instanceof Error ? cause.message : String(cause)}` });
      }
      return;
    }

    /**
     * 适配器内部执行过的媒体工具调用（Studio 轮询它，把生成出来的音频落成轨道）。
     */
    if (request.method === "GET" && url.pathname === "/api/agent/media-events") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const events = MEDIA_EVENTS.filter((event) => event.id > since);
      json(response, 200, { events, next: MEDIA_EVENTS.length === 0 ? since : MEDIA_EVENTS[MEDIA_EVENTS.length - 1].id });
      return;
    }

    /**
     * 后台作业（异步渲染）把"做完了"推回来。
     *
     * 契约是"不给模型轮询工具"：generator 的 worker 自己按退避表盯着作业，终态用这条 POST 进来，
     * 事件形状刻意做成**一次普通的 render_song 工具调用**，所以前端那条吸收路径零学习成本就落轨。
     */
    if (request.method === "POST" && url.pathname === "/api/agent/media-events") {
      const body = await readJsonBody(request, 2 * 1024 * 1024);
      const id = MEDIA_EVENTS.length === 0 ? 1 : MEDIA_EVENTS[MEDIA_EVENTS.length - 1].id + 1;
      const event = {
        id,
        at: Date.now(),
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
        scope: typeof body.scope === "string" ? body.scope : null,
        projectId: typeof body.projectId === "string" ? body.projectId : null,
        setId: typeof body.setId === "string" ? body.setId : null,
        server: String(body.server ?? "unknown"),
        tool: String(body.tool ?? "unknown"),
        ok: body.ok !== false,
        text: typeof body.text === "string" ? body.text : "",
        ...(body.args === undefined ? {} : { args: body.args }),
      };
      MEDIA_EVENTS.push(event);
      if (MEDIA_EVENTS.length > 50) MEDIA_EVENTS.shift();
      console.log(`[agent] media event ← ${event.server}.${event.tool} ok=${event.ok} id=${event.id}`);
      json(response, 200, { id, accepted: true });
      return;
    }

    /**
     * 音乐生成：把一段描述交给供应商的音乐模型，落盘后把路径交回调用方。
     *
     * MiniMax 的 `/v1/music_generation` 会跑几十秒（编曲 + 渲染），所以这是**同步长请求**：
     * 调用方（agent 工具 / 前端）负责先告诉用户「在做」，这里只负责把音频拿回来。
     */
    if (request.method === "POST" && url.pathname === "/api/agent/providers/music") {
      const body = await readJsonBody(request, 256 * 1024);
      const prompt = String(body.prompt ?? "").trim();
      const model = String(body.model ?? "").trim();
      const provider = {
        baseUrl: String(body.baseUrl ?? "").trim(),
        reference: body.credentialRef ?? null,
        authProtocol: body.authProtocol === "elevenlabs" ? "elevenlabs" : "openai",
      };
      if (provider.baseUrl === "" || model === "") {
        json(response, 400, { error: "先选好供应商和音乐模型" });
        return;
      }
      if (prompt === "" && String(body.lyrics ?? "").trim() === "") {
        json(response, 400, { error: "给一句描述（prompt）或歌词（lyrics）" });
        return;
      }
      const started = Date.now();
      try {
        const { audio, contentType } = await callMedia(
          provider,
          resolveMediaProtocol(
            typeof body.protocolName === "string" ? body.protocolName : "custom",
            provider.baseUrl,
            "music",
          ),
          {
            model,
            prompt,
            lyrics: typeof body.lyrics === "string" ? body.lyrics : "",
            instrumental: body.instrumental === true,
            format: typeof body.format === "string" ? body.format : "mp3",
          },
          { timeoutMs: 180_000 },
        );
        const saved = saveMedia(audio, String(body.name ?? prompt.slice(0, 24)) || "music", typeof body.format === "string" ? body.format : "mp3");
        console.log(`[agent] music ${model} → ${saved.name} (${(saved.duration_ms / 1000).toFixed(1)}s, ${saved.bytes} bytes, ${Date.now() - started} ms)`);
        json(response, 200, { ...saved, model, ms: Date.now() - started, contentType });
      } catch (cause) {
        json(response, 200, { error: `音乐生成失败：${cause instanceof Error ? cause.message : String(cause)}` });
      }
      return;
    }

    /**
     * The smallest request that proves one role works. Agent / TTS / STT use a deliberately tiny
     * request; music has no separate validation endpoint, so its button is an explicit one-off
     * generation and the UI warns that it can take time and spend credit.
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
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "只回复 OK" }],
              max_tokens: 32,
            }),
          });
          if (!answer.ok) {
            json(response, 200, { ok: false, detail: await providerFailure(answer) });
            return;
          }
          const payload = await answer.json().catch(() => ({}));
          const said = visibleModelReply(payload?.choices?.[0]?.message?.content);
          json(response, 200, {
            ok: said !== "",
            detail: said !== "" ? `回复：${said.slice(0, 40)}` : "连接成功，但模型只返回了思考过程",
            ms: Date.now() - started,
          });
          return;
        }
        if (capability === "tts") {
          const voice = typeof body.voice === "string" && body.voice !== "" ? body.voice : "alloy";
          const { audio } = await callMedia(
            provider,
            resolveMediaProtocol(provider.protocol, provider.baseUrl, "tts"),
            { model, text: "测试", voice, format: "mp3" },
            { timeoutMs: 60_000 },
          );
          json(response, 200, {
            ok: audio.length > 1000,
            detail: `${audio.length} 字节音频`,
            ms: Date.now() - started,
          });
          return;
        }
        if (capability === "stt") {
          const picked = await callStt(
            provider,
            resolveMediaProtocol(provider.protocol, provider.baseUrl, "stt"),
            { audio: diagnosticWav(), model, format: "wav" },
          );
          json(response, 200, {
            ok: typeof picked?.text === "string",
            detail: `识别接口可用（测试音频返回 ${[...String(picked?.text ?? "")].length} 字）`,
            ms: Date.now() - started,
          });
          return;
        }
        if (capability === "voice_clone") {
          const protocol = resolveMediaProtocol(provider.protocol, provider.baseUrl, "tts");
          if (protocol !== "minimax-t2a") {
            json(response, 200, {
              ok: false,
              detail: "这类服务没有无副作用的 Voice Clone 测试；请在「通话与声音」里用样本验证",
              ms: Date.now() - started,
            });
            return;
          }
          const { response: answer } = await callProvider(
            { ...provider, baseUrl: mediaBaseUrl(provider.baseUrl, "/v1/get_voice") },
            "/v1/get_voice",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ voice_type: "all" }),
            },
          );
          if (!answer.ok) {
            json(response, 200, { ok: false, detail: await providerFailure(answer), ms: Date.now() - started });
            return;
          }
          const payload = await answer.json().catch(() => ({}));
          const voices = (Array.isArray(payload?.system_voice) ? payload.system_voice.length : 0) +
            (Array.isArray(payload?.voice_cloning) ? payload.voice_cloning.length : 0);
          json(response, 200, {
            ok: voices > 0,
            detail: voices > 0 ? `音色接口可用（${voices} 个已有音色）` : "音色接口返回为空",
            ms: Date.now() - started,
          });
          return;
        }
        if (capability === "music") {
          const { audio } = await callMedia(
            provider,
            resolveMediaProtocol(provider.protocol, provider.baseUrl, "music"),
            {
              model,
              prompt: "两秒测试节拍，纯音乐",
              lyrics: "",
              instrumental: true,
              format: "mp3",
            },
            { timeoutMs: 180_000 },
          );
          json(response, 200, {
            ok: audio.length > 1000,
            detail: `${audio.length} 字节测试音频`,
            ms: Date.now() - started,
          });
          return;
        }
        if (capability === "image") {
          const imageProtocol = resolveMediaProtocol(provider.protocol, provider.baseUrl, "image");
          if (imageProtocol === "minimax-image") {
            const adapter = MEDIA_PROTOCOLS["minimax-image"];
            const { response: answer } = await callProvider(
              { ...provider, baseUrl: mediaBaseUrl(provider.baseUrl, adapter.path) },
              adapter.path,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(adapter.build({ model })),
              },
              { timeoutMs: 120_000 },
            );
            if (!answer.ok) {
              json(response, 200, { ok: false, detail: await providerFailure(answer), ms: Date.now() - started });
              return;
            }
            const made = adapter.pick(await answer.json().catch(() => ({})));
            json(response, 200, {
              ok: made.count > 0,
              detail: `返回了 ${made.count} 张图`,
              ms: Date.now() - started,
            });
            return;
          }
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
     * Native file/folder chooser. The studio references audio in place, and the library needs the
     * folder path itself before it can scan. Both stay behind one narrow endpoint so the web layer
     * never has to invent shell paths or expose a general filesystem picker.
     */
    if (request.method === "POST" && url.pathname === "/api/agent/pick") {
      if (process.platform !== "darwin") {
        json(response, 501, { error: "原生文件对话框目前只在 macOS 上可用；拖拽或文件选择器一样可以导入" });
        return;
      }
      const body = await readJsonBody(request, 64 * 1024);
      const { script, folderMode } = buildPickScript(body);
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
          json(response, 500, {
            error:
              String(picked.err).trim() ||
              (folderMode ? "文件夹选择器打不开，请重试" : "文件对话框打不开（试试拖拽或文件选择器）"),
          });
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

    /**
     * 采样浏览器的目录枚举（Bitwig 刀3-D「采样」tab 的数据来源）。
     *
     * 刻意比 `/api/agent/file`（任意路径 + 可服务扩展）更窄：只允许白名单目录、只报音频文件，
     * 不做递归、上限 400 条。`/api/agent/file` 负责"按 path 流字节"，这里负责"让我看看有什么"——
     * 裁决书 §②D 假设的「现有目录能力」实际只存在于这一半，补上另一半即可，UI 不用绕过桥。
     */
    if (request.method === "GET" && url.pathname === "/api/agent/dir") {
      const rel = (url.searchParams.get("dir") ?? "imports").replace(/^\/+/, "");
      const resolved = resolve(WORKSPACES, rel);
      const allowed = [IMPORTS_DIR, RECORDINGS_DIR].some(
        (base) => resolved === base || resolved.startsWith(base + sep),
      );
      if (!allowed) {
        json(response, 403, { error: `目录不在可枚举白名单（imports / recordings）：${rel}` });
        return;
      }
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        json(response, 404, { error: `no such dir: ${resolved}` });
        return;
      }
      // imports/ 是「按日期分目录」的（imports/2026-10-15/xxx.wav），所以枚举要向下走几层：
      // 深度 ≤4、跳过隐藏项、只收能流式的音频扩展名、400 条封顶（裁决书 D 的列表预算）。
      const entries = [];
      const walk = (dir, depth) => {
        if (depth > 4 || entries.length >= 400) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entries.length >= 400) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
          if (!STREAMABLE.has(extension)) continue;
          const stats = statSync(full);
          entries.push({ name: entry.name, path: full, size: stats.size, mtime: stats.mtimeMs });
        }
      };
      walk(resolved, 1);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      json(response, 200, { dir: rel, root: resolved, entries });
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
      const contentType = SERVEABLE.get(extension);
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

    if (request.method === "POST" && url.pathname === "/api/agent/settings") {
      const body = await readBody(request);
      const sessionId = String(body.sessionId ?? "");
      if (sessionId === "") {
        json(response, 400, { error: "sessionId is required" });
        return;
      }
      if (
        body.access !== "read-only" && body.access !== "workspace-write" && body.access !== "danger-full-access"
      ) {
        json(response, 400, { error: "access must be one of read-only | workspace-write | danger-full-access" });
        return;
      }
      const scope = Object.hasOwn(SCOPE_TOOL_ALLOWLIST, body.scope) ? body.scope : "butler";
      try {
        const threadSettings = await agent.applySettings(
          sessionId,
          {
            ...(typeof body.model === "string" && body.model !== "" ? { model: body.model } : {}),
            ...(typeof body.effort === "string" && body.effort !== "" ? { effort: body.effort } : {}),
            access: body.access,
          },
          scope,
        );
        json(response, 200, { sessionId, threadSettings });
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
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
        if (handle !== null) agent.release(handle.threadId, handle.listener, handle.listeners, handle.cleanup);
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
            scope:
              body.scope === "studio" || body.scope === "dj" || body.scope === "library"
                ? body.scope
                : "butler",
            eventContext: {
              ...(typeof body.projectId === "string" && body.projectId !== "" ? { projectId: body.projectId } : {}),
              ...(typeof body.setId === "string" && body.setId !== "" ? { setId: body.setId } : {}),
            },
            model: typeof body.model === "string" && body.model !== "" ? body.model : undefined,
            effort: typeof body.effort === "string" && body.effort !== "" ? body.effort : undefined,
            settings:
              body.settings !== null && typeof body.settings === "object"
                ? {
                    ...(typeof body.settings.model === "string" && body.settings.model !== ""
                      ? { model: body.settings.model }
                      : {}),
                    ...(typeof body.settings.effort === "string" && body.settings.effort !== ""
                      ? { effort: body.settings.effort }
                      : {}),
                    ...(typeof body.settings.access === "string" &&
                    ["read-only", "workspace-write", "danger-full-access"].includes(body.settings.access)
                      ? { access: body.settings.access }
                      : {}),
                  }
                : null,
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

if (process.env.SHADOWROOM_ADAPTER_TEST !== "1") http.listen(PORT, HOST, () => {
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
