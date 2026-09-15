/**
 * `ShadowMusicGrabber` panel: the three things you want by hand — ask what a file is, transcode it,
 * or decrypt the containers some stores write.
 *
 * Downloads live in the conversation (the agent can search, pick and fetch); a panel with a URL box
 * and a search field would be a worse version of that. Everything here reports its call into the
 * transcript like every other panel, so the work is never invisible.
 */
import { useState } from "react";
import { callTool } from "../lib/mcp";
import type { ToolCall } from "./ToolCallRow";

type Mode = "probe" | "convert" | "decrypt";

const LABELS: Record<Mode, { tool: string; title: string; hint: string }> = {
  probe: { tool: "probe_audio", title: "看这是什么", hint: "时长、采样率、编码、标签、内嵌封面" },
  convert: { tool: "convert_audio", title: "转码", hint: "转成 FLAC / WAV / MP3（用系统里的 ffmpeg）" },
  decrypt: { tool: "decrypt_audio", title: "解密", hint: "NCM / QMC / MFLAC 等加密容器" },
};

export function GrabberPanel({
  connected,
  tools,
  onBegin,
  onEnd,
}: {
  connected: boolean;
  tools: { name: string; description?: string }[];
  onBegin: (call: ToolCall) => void;
  onEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const [mode, setMode] = useState<Mode>("probe");
  const [path, setPath] = useState("");
  const [format, setFormat] = useState("flac");
  const [outDir, setOutDir] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const trimmed = path.trim();
    if (trimmed === "" || busy) return;
    const { tool } = LABELS[mode];
    const id = `${tool}-${Date.now()}`;
    const args =
      mode === "convert"
        ? { path: trimmed, output_format: format, ...(outDir.trim() === "" ? {} : { output_dir: outDir.trim() }) }
        : { path: trimmed };
    setBusy(true);
    setResult(null);
    onBegin({
      id,
      server: "ShadowMusicGrabber",
      name: tool,
      status: "running",
      summary: trimmed.split("/").pop() ?? trimmed,
      detail: JSON.stringify(args, null, 2),
    });
    try {
      const raw = await callTool<string>("grabber", tool, args);
      const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
      setResult(text);
      onEnd(id, { status: "ok", summary: resultSummary(mode, text), detail: text.slice(0, 4000) });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setResult(message);
      onEnd(id, { status: "error", summary: message, detail: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sr-plugin-pane">
      <div className="sr-chiprow" role="tablist" aria-label="动作">
        {(Object.keys(LABELS) as Mode[]).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={entry === mode}
            className="sr-chip sr-chip--button"
            data-on={entry === mode || undefined}
            onClick={() => {
              setMode(entry);
              setResult(null);
            }}
          >
            {LABELS[entry].title}
          </button>
        ))}
      </div>

      <p className="sr-plugin-hint">{LABELS[mode].hint}</p>

      <label className="sr-field">
        <span className="sr-field-label sr-mono">文件路径</span>
        <input
          className="sr-input"
          value={path}
          spellCheck={false}
          placeholder="/Users/…/track.flac"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
        />
      </label>

      {mode === "convert" && (
        <div className="sr-field-row">
          <label className="sr-field">
            <span className="sr-field-label sr-mono">格式</span>
            <select className="sr-input sr-input--num" value={format} aria-label="输出格式" onChange={(event) => setFormat(event.target.value)}>
              <option value="flac">FLAC</option>
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
            </select>
          </label>
          <label className="sr-field sr-field--grow">
            <span className="sr-field-label sr-mono">输出目录（可留空）</span>
            <input
              className="sr-input"
              value={outDir}
              spellCheck={false}
              placeholder="~/Music/ShadowMusicGrabber"
              onChange={(event) => setOutDir(event.target.value)}
            />
          </label>
        </div>
      )}

      <div className="sr-form-actions">
        <button
          type="button"
          className="sr-btn sr-btn--accent"
          disabled={!connected || path.trim() === "" || busy}
          onClick={() => void run()}
        >
          {busy ? "运行中…" : LABELS[mode].title}
        </button>
        <span className="sr-field-label sr-mono">
          {connected ? `${tools.length} 个工具可用` : "插件未连接"}
        </span>
      </div>

      {result !== null && <pre className="sr-plugin-result sr-scroll">{result}</pre>}
    </div>
  );
}

/** One short line for the transcript row: the interesting field, not the whole JSON. */
function resultSummary(mode: Mode, text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.output === "string") return parsed.output.split("/").pop() ?? parsed.output;
    if (typeof parsed.title === "string" && parsed.title !== "") return String(parsed.title);
    if (typeof parsed.duration_ms === "number") return `${Math.round(parsed.duration_ms / 1000)}s`;
  } catch {
    /* not JSON: fall through to a trimmed line */
  }
  const first = text.split("\n").find((line) => line.trim() !== "") ?? mode;
  return first.slice(0, 80);
}
