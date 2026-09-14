/**
 * `shadow-music-generator` panel: queue a generation job (dry-run by default, so nothing touches a
 * model), read a job back, and run a queued job through whatever adapter the machine has configured.
 */
import { useState } from "react";
import { callTool } from "../lib/mcp";
import type { ToolCall } from "./ToolCallRow";

type ToolId = "submit_generation" | "job_status";

type Job = {
  id: string;
  status: string;
  mode?: string;
  request?: {
    prompt?: string;
    mode?: string;
    model?: string | null;
    output_dir?: string | null;
    lyrics?: string | null;
  };
  model_license?: string;
  pipeline?: string | null;
  stages?: Array<{ name: string; status: string; duration_ms?: number; detail?: string }>;
  outputs?: string[];
  output?: string | null;
  error?: string | null;
};

const TOOLS: Array<{ id: ToolId; label: string }> = [
  { id: "submit_generation", label: "提交任务" },
  { id: "job_status", label: "任务状态" },
];

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};

/** Status pill: queued is neutral, running rides the accent, done is live-green, failed is danger. */
function StatusPill({ status }: { status: string }) {
  const tone = status === "completed" ? "live" : status === "failed" ? "danger" : status === "running" ? "accent" : "idle";
  return (
    <span className="sr-pill" data-tone={tone}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function JobCard({ job, onRun, busy }: { job: Job; onRun?: () => void; busy?: boolean }) {
  return (
    <article className="sr-candidate">
      <header className="sr-candidate-head">
        <StatusPill status={job.status} />
        <span className="sr-candidate-title sr-mono">{job.id}</span>
      </header>
      {job.request?.prompt && <p className="sr-plugin-hint">{job.request.prompt}</p>}
      <div className="sr-plugin-stats">
        <div className="sr-stat">
          <span className="sr-stat-label sr-mono">模式</span>
          <span className="sr-stat-value">{job.mode ?? job.request?.mode ?? "—"}</span>
        </div>
        <div className="sr-stat">
          <span className="sr-stat-label sr-mono">模型</span>
          <span className="sr-stat-value">{job.request?.model ?? "未指定"}</span>
        </div>
      </div>
      {(job.stages ?? []).length > 0 && (
        <ul className="sr-plugin-list">
          {(job.stages ?? []).map((stage) => (
            <li key={stage.name} className="sr-stage">
              <span className="sr-dot" data-state={stage.status === "ok" || stage.status === "completed" ? "live" : "idle"} />
              <span className="sr-stage-name">{stage.name}</span>
              <span className="sr-stage-detail sr-mono">
                {stage.status}
                {typeof stage.duration_ms === "number" ? ` · ${stage.duration_ms}ms` : ""}
                {stage.detail ? ` · ${stage.detail}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {job.output && <p className="sr-plugin-hint sr-plugin-hint--dim">{job.output}</p>}
      {job.error && <div className="sr-alert" data-level="danger">{job.error}</div>}
      {job.model_license && (
        <p className="sr-plugin-hint sr-plugin-hint--dim">模型许可：{job.model_license}</p>
      )}
      {onRun && job.status === "queued" && (
        <button type="button" className="sr-btn" onClick={onRun} disabled={busy}>
          {busy ? "运行中…" : "运行这个任务"}
        </button>
      )}
    </article>
  );
}

export function GeneratorPanel({
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
  const [tool, setTool] = useState<ToolId>("submit_generation");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [model, setModel] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [jobDir, setJobDir] = useState("");
  const [jobId, setJobId] = useState("");
  const [lookupDir, setLookupDir] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = connected && !busy;

  async function invoke(name: ToolId | "run_job", args: Record<string, unknown>, summary: string) {
    const id = `${name}-${Date.now()}`;
    setBusy(true);
    setError(null);
    onBegin({
      id,
      server: "shadow-music-generator",
      name,
      status: "running",
      summary,
      detail: JSON.stringify(args, null, 2),
    });
    try {
      const raw = await callTool<string>("generator", name, args);
      const text = String(raw ?? "");
      let parsed: Job;
      try {
        parsed = JSON.parse(text) as Job;
      } catch {
        throw new Error(text === "" ? "插件没有返回内容" : text);
      }
      setJob(parsed);
      if (parsed.id) setJobId(parsed.id);
      onEnd(id, {
        status: "ok",
        summary: `${parsed.id?.slice(0, 8) ?? name} · ${STATUS_LABEL[parsed.status] ?? parsed.status}`,
        detail: text.slice(0, 4000),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setJob(null);
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

      {tool === "submit_generation" ? (
        <>
          <label className="sr-field">
            <span className="sr-field-label sr-mono">提示词</span>
            <textarea
              className="sr-textarea"
              value={prompt}
              rows={4}
              placeholder="128 BPM tech house，暗房，rolling bass，人声切片…"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label className="sr-field">
            <span className="sr-field-label sr-mono">歌词（可选）</span>
            <textarea
              className="sr-textarea sr-textarea--short"
              value={lyrics}
              rows={3}
              onChange={(event) => setLyrics(event.target.value)}
            />
          </label>
          <div className="sr-plugin-options">
            <label className="sr-field">
              <span className="sr-field-label sr-mono">模型（可选）</span>
              <input className="sr-input" value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label className="sr-field">
              <span className="sr-field-label sr-mono">输出目录（可选）</span>
              <input
                className="sr-input"
                value={outputDir}
                spellCheck={false}
                onChange={(event) => setOutputDir(event.target.value)}
              />
            </label>
          </div>
          <label className="sr-field">
            <span className="sr-field-label sr-mono">任务目录（留空＝插件默认 .shadow-jobs）</span>
            <input
              className="sr-input"
              value={jobDir}
              spellCheck={false}
              onChange={(event) => setJobDir(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="sr-btn sr-btn--accent sr-plugin-run"
            disabled={!ready || prompt.trim().length === 0}
            onClick={() =>
              void invoke(
                "submit_generation",
                {
                  prompt: prompt.trim(),
                  mode: "dry-run",
                  ...(lyrics.trim() ? { lyrics: lyrics.trim() } : {}),
                  ...(model.trim() ? { model: model.trim() } : {}),
                  ...(outputDir.trim() ? { output_dir: outputDir.trim() } : {}),
                  ...(jobDir.trim() ? { job_dir: jobDir.trim() } : {}),
                },
                "dry-run",
              )
            }
          >
            {busy ? "提交中…" : "提交任务（dry-run）"}
          </button>
          <p className="sr-plugin-hint sr-plugin-hint--dim">
            dry-run 只校验并登记任务，不跑模型；要真的生成，需要机器上配好 SHADOW_PIPELINE_FACTORY。
          </p>
        </>
      ) : (
        <>
          <label className="sr-field">
            <span className="sr-field-label sr-mono">任务 ID</span>
            <input
              className="sr-input"
              value={jobId}
              spellCheck={false}
              placeholder="7096d618-…"
              onChange={(event) => setJobId(event.target.value)}
            />
          </label>
          <label className="sr-field">
            <span className="sr-field-label sr-mono">任务目录（可选）</span>
            <input
              className="sr-input"
              value={lookupDir}
              spellCheck={false}
              onChange={(event) => setLookupDir(event.target.value)}
            />
          </label>
          <div className="sr-plugin-options">
            <button
              type="button"
              className="sr-btn sr-plugin-run"
              disabled={!ready || jobId.trim().length === 0}
              onClick={() =>
                void invoke(
                  "job_status",
                  { job_id: jobId.trim(), ...(lookupDir.trim() ? { job_dir: lookupDir.trim() } : {}) },
                  jobId.trim().slice(0, 8),
                )
              }
            >
              查询状态
            </button>
            <button
              type="button"
              className="sr-btn"
              disabled={!ready || jobId.trim().length === 0}
              onClick={() =>
                void invoke(
                  "run_job",
                  { job_id: jobId.trim(), ...(lookupDir.trim() ? { job_dir: lookupDir.trim() } : {}) },
                  `run ${jobId.trim().slice(0, 8)}`,
                )
              }
            >
              运行任务
            </button>
          </div>
        </>
      )}

      {!connected && <p className="sr-plugin-hint sr-plugin-hint--dim">bridge 没启动，先跑 pnpm serve。</p>}
      {error && <div className="sr-alert" data-level="danger">{error}</div>}
      {job && (
        <JobCard
          job={job}
          busy={busy}
          onRun={() =>
            void invoke(
              "run_job",
              { job_id: job.id, ...(lookupDir.trim() ? { job_dir: lookupDir.trim() } : {}) },
              `run ${job.id.slice(0, 8)}`,
            )
          }
        />
      )}
    </div>
  );
}
