/**
 * `set-planner` panel: the first plugin that runs a real job — the set JSON goes through the MCP
 * bridge to `plan_set`, and the returned timeline is rendered as rows.
 */
import { useState } from "react";
import { callTool } from "../lib/mcp";

const SAMPLE = {
  tracks: [
    {
      id: "a",
      title: "Rooftop 909",
      bpm: 128,
      key: "8A",
      energy: 6,
      duration_ms: 360000,
      cues: [
        { name: "A", position_ms: 15000 },
        { name: "B", position_ms: 210000 },
      ],
    },
    {
      id: "b",
      title: "Glass Bloom",
      bpm: 124,
      key: "9A",
      energy: 5,
      duration_ms: 300000,
      cues: [
        { name: "A", position_ms: 8000 },
        { name: "B", position_ms: 180000 },
      ],
    },
    { id: "c", title: "Night Circuit", bpm: 126, key: "10A", energy: 7, duration_ms: 330000 },
  ],
  transitions: [{ from: "a", to: "b", overlap_ms: 16000 }],
};

type PlanResult = {
  summary?: { total_duration?: string; overlap_saved_ms?: number };
  timeline?: Array<{
    id?: string;
    title?: string;
    play_start?: string;
    play_end?: string;
    duration_ms?: number;
    bars?: number;
  }>;
  warnings?: string[];
};

export function SetPlannerPanel({ connected }: { connected: boolean }) {
  const [input, setInput] = useState(JSON.stringify(SAMPLE, null, 2));
  const [result, setResult] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const payload = JSON.parse(input);
      const raw = await callTool<string>("planner", "plan_set", {
        set: payload,
        default_overlap_ms: 16000,
      });
      setResult(typeof raw === "string" ? (JSON.parse(raw) as PlanResult) : (raw as PlanResult));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sr-plugin-pane">
      <p className="sr-plugin-hint">
        这份 JSON 经 MCP bridge 发给 set-planner 的 <code>plan_set</code>。
      </p>
      <textarea
        className="sr-plugin-input sr-scroll"
        value={input}
        rows={14}
        spellCheck={false}
        aria-label="set JSON"
        onChange={(event) => setInput(event.target.value)}
      />
      <button
        type="button"
        className="sr-btn sr-btn--accent sr-plugin-run"
        onClick={run}
        disabled={busy || !connected}
      >
        {busy ? "运行中…" : "运行 plan_set"}
      </button>
      {!connected && <p className="sr-plugin-hint sr-plugin-hint--dim">bridge 没启动，先跑 pnpm serve。</p>}

      {error && <div className="sr-alert" data-level="danger">{error}</div>}

      {result && (
        <div className="sr-plugin-result">
          <div className="sr-plugin-summary sr-mono">
            总时长 {result.summary?.total_duration ?? "—"} · 衔接节省{" "}
            {result.summary?.overlap_saved_ms ?? 0} ms
          </div>
          <ul className="sr-plugin-list">
            {(result.timeline ?? []).map((row, index) => (
              <li key={row.id ?? index} className="sr-plugin-timeline-row">
                <span className="sr-plugin-timeline-title">{row.title ?? row.id ?? `#${index + 1}`}</span>
                <span className="sr-plugin-timeline-meta sr-mono">
                  {row.play_start ?? "—"} → {row.play_end ?? "—"}
                  {row.bars ? ` · ${row.bars} 小节` : ""}
                </span>
              </li>
            ))}
          </ul>
          {(result.warnings ?? []).length > 0 && (
            <div className="sr-alert" data-level="warn">
              {(result.warnings ?? []).slice(0, 3).join("；")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
