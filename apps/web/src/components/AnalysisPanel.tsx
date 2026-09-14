/**
 * `audio-analysis-dedupe` panel: analyse one file, or scan a folder for duplicates.
 *
 * Same shape as the set-planner pane — tool switcher, inputs, run button, results — because that is
 * the panel convention this app uses (and the one DeepSeek Harness's right column keeps for every
 * registered surface).
 */
import { useState } from "react";
import { callTool } from "../lib/mcp";
import type { ToolCall } from "./ToolCallRow";

type ToolId = "analyze_file" | "dedupe_folder";

type FileInfo = {
  path: string;
  file_name: string;
  size_bytes: number;
  sha256?: string;
  container?: string | null;
  codec?: string | null;
  duration_ms?: number | null;
  sample_rate?: number | null;
  channels?: number | null;
  bits_per_sample?: number | null;
  bitrate_kbps?: number | null;
  probe?: string;
  warnings?: string[];
};

type Candidate = {
  a: string;
  b: string;
  score: number;
  reasons?: string[];
  differences?: string[];
  suggested_keep?: string;
  suggested_keep_reason?: string;
};

type DedupeReport = {
  file_count: number;
  exact_groups?: string[][];
  candidates?: Candidate[];
  candidates_truncated?: boolean;
  summary?: {
    exact_group_count?: number;
    identical_audio_group_count?: number;
    candidate_count?: number;
    redundant_bytes?: number;
    threshold?: number;
  };
  warnings?: string[];
  folder?: string;
};

const TOOLS: Array<{ id: ToolId; label: string }> = [
  { id: "analyze_file", label: "分析文件" },
  { id: "dedupe_folder", label: "查重" },
];

const PROBE_LABEL: Record<string, string> = {
  wave: "标准库 wave",
  ffprobe: "ffprobe",
  unavailable: "无探针",
};

const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== "number") return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(ms?: number | null): string {
  if (typeof ms !== "number") return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} (${(ms / 1000).toFixed(2)}s)`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="sr-stat">
      <span className="sr-stat-label sr-mono">{label}</span>
      <span className="sr-stat-value">{value}</span>
    </div>
  );
}

export function AnalysisPanel({
  connected,
  tools = [],
  onBegin,
  onEnd,
}: {
  connected: boolean;
  tools?: { name: string; description?: string }[];
  onBegin: (call: ToolCall) => void;
  onEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const [tool, setTool] = useState<ToolId>("analyze_file");
  const [filePath, setFilePath] = useState("");
  const [folder, setFolder] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [threshold, setThreshold] = useState("0.72");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileInfo | null>(null);
  const [report, setReport] = useState<DedupeReport | null>(null);

  const target = tool === "analyze_file" ? filePath : folder;
  const ready = connected && !busy && target.trim().length > 0;

  async function run() {
    const id = `${tool}-${Date.now()}`;
    const args =
      tool === "analyze_file"
        ? { path: filePath.trim() }
        : { folder: folder.trim(), recursive, threshold: Number(threshold) || 0.72 };
    setBusy(true);
    setError(null);
    onBegin({
      id,
      server: "audio-analysis-dedupe",
      name: tool,
      status: "running",
      summary: tool === "analyze_file" ? basename(filePath) : folder,
      detail: JSON.stringify(args, null, 2),
    });
    try {
      const raw = await callTool<string>("analysis", tool, args);
      const text = String(raw ?? "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(text === "" ? "插件没有返回内容" : text);
      }
      if (tool === "analyze_file") {
        const info = parsed as FileInfo;
        setFile(info);
        setReport(null);
        onEnd(id, {
          status: "ok",
          summary: `${info.file_name} · ${formatBytes(info.size_bytes)}`,
          detail: text.slice(0, 4000),
        });
      } else {
        const value = parsed as DedupeReport;
        setReport(value);
        setFile(null);
        onEnd(id, {
          status: "ok",
          summary: `${value.file_count} 个文件 · ${value.summary?.candidate_count ?? 0} 个候选`,
          detail: text.slice(0, 4000),
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setFile(null);
      setReport(null);
      onEnd(id, { status: "error", summary: message, detail: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sr-plugin-pane">
      <div className="sr-plugin-tabs" role="tablist" aria-label="工具">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="sr-plugin-tab"
            aria-selected={tool === entry.id}
            data-on={tool === entry.id || undefined}
            onClick={() => setTool(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tools.length > 0 && (
        <p className="sr-plugin-tools sr-mono">{tools.map((entry) => entry.name).join(" · ")}</p>
      )}

      {tool === "analyze_file" ? (
        <label className="sr-field">
          <span className="sr-field-label sr-mono">文件路径</span>
          <input
            className="sr-input"
            value={filePath}
            spellCheck={false}
            placeholder="/Users/…/track.wav"
            onChange={(event) => setFilePath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) void run();
            }}
          />
        </label>
      ) : (
        <>
          <label className="sr-field">
            <span className="sr-field-label sr-mono">文件夹</span>
            <input
              className="sr-input"
              value={folder}
              spellCheck={false}
              placeholder="/Users/…/Music"
              onChange={(event) => setFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready) void run();
              }}
            />
          </label>
          <div className="sr-plugin-options">
            <button
              type="button"
              className="sr-toggle"
              aria-pressed={recursive}
              data-on={recursive || undefined}
              onClick={() => setRecursive((current) => !current)}
            >
              递归子目录
            </button>
            <label className="sr-field sr-field--inline">
              <span className="sr-field-label sr-mono">相似阈值</span>
              <input
                className="sr-input sr-input--num"
                value={threshold}
                inputMode="decimal"
                onChange={(event) => setThreshold(event.target.value)}
              />
            </label>
          </div>
        </>
      )}

      <button type="button" className="sr-btn sr-btn--accent sr-plugin-run" onClick={run} disabled={!ready}>
        {busy ? "运行中…" : tool === "analyze_file" ? "分析这个文件" : "扫描重复"}
      </button>
      {!connected && <p className="sr-plugin-hint sr-plugin-hint--dim">bridge 没启动，先跑 pnpm serve。</p>}

      {error && <div className="sr-alert" data-level="danger">{error}</div>}

      {file && (
        <div className="sr-plugin-result">
          <div className="sr-plugin-stats">
            <Stat label="文件" value={file.file_name} />
            <Stat label="大小" value={formatBytes(file.size_bytes)} />
            <Stat label="时长" value={formatDuration(file.duration_ms)} />
            <Stat label="采样率" value={file.sample_rate ? `${file.sample_rate} Hz` : "—"} />
            <Stat label="声道" value={file.channels ?? "—"} />
            <Stat label="编码" value={file.codec ?? "—"} />
            <Stat label="比特率" value={file.bitrate_kbps ? `${file.bitrate_kbps} kbps` : "—"} />
            <Stat label="探针" value={PROBE_LABEL[file.probe ?? ""] ?? file.probe ?? "—"} />
          </div>
          {file.sha256 && <p className="sr-plugin-hash sr-mono">sha256 {file.sha256}</p>}
          {(file.warnings ?? []).map((warning) => (
            <div key={warning} className="sr-alert" data-level="warn">
              {warning}
            </div>
          ))}
          {file.probe === "unavailable" && (
            <p className="sr-plugin-hint sr-plugin-hint--dim">
              装上 ffprobe（ffmpeg）之后，这个面板还能读出时长、采样率和编码。
            </p>
          )}
        </div>
      )}

      {report && (
        <div className="sr-plugin-result">
          <div className="sr-plugin-stats">
            <Stat label="扫描文件" value={report.file_count} />
            <Stat label="完全重复" value={report.summary?.exact_group_count ?? 0} />
            <Stat label="相同音频" value={report.summary?.identical_audio_group_count ?? 0} />
            <Stat label="相似候选" value={report.summary?.candidate_count ?? 0} />
          </div>
          {(report.candidates ?? []).map((candidate) => (
            <article key={`${candidate.a}|${candidate.b}`} className="sr-candidate">
              <header className="sr-candidate-head">
                <span className="sr-candidate-score sr-mono">
                  {Math.round((candidate.score ?? 0) * 100)}%
                </span>
                <span className="sr-candidate-title">
                  {basename(candidate.a)} ↔ {basename(candidate.b)}
                </span>
              </header>
              <p className="sr-candidate-paths sr-mono">
                {candidate.a}
                <br />
                {candidate.b}
              </p>
              {(candidate.reasons ?? []).length > 0 && (
                <ul className="sr-plugin-bullets">
                  {(candidate.reasons ?? []).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {candidate.suggested_keep && (
                <p className="sr-plugin-hint sr-plugin-hint--dim">
                  建议保留 {basename(candidate.suggested_keep)}
                  {candidate.suggested_keep_reason ? ` —— ${candidate.suggested_keep_reason}` : ""}
                </p>
              )}
            </article>
          ))}
          {(report.warnings ?? []).map((warning) => (
            <div key={warning} className="sr-alert" data-level="note">
              {warning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
