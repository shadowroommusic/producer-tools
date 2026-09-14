/**
 * `rekordbox-serato-bridge` panel: read the local libraries, preview a conversion, then convert.
 *
 * The three library paths are remembered in localStorage — they are long, machine-specific and every
 * tool in this plugin needs at least two of them. Conversion never touches a vendor database unless
 * the Serato→Rekordbox direction is explicitly switched to "写入" (and even then the plugin takes a
 * backup first); the Rekordbox→Serato direction only ever writes into the output folder you name.
 */
import { useEffect, useState } from "react";
import { callTool } from "../lib/mcp";
import type { ToolCall } from "./ToolCallRow";

type Tab = "library" | "preview" | "convert";
type Direction = "rb2serato" | "serato2rb";

type Paths = { rekordboxDatabase: string; rekordboxDir: string; seratoDatabase: string };

type SetList = { set_count?: number; sets?: Array<{ name: string; track_count: number }> };

type Preview = {
  direction?: string;
  source?: {
    track_count?: number;
    tracks_with_cues?: number;
    cue_count?: number;
    non_local_tracks?: number;
  };
  target?: {
    asset_count?: number;
    local_asset_count?: number;
    streaming_asset_count?: number;
    local_assets_with_cues?: number;
    cue_count?: number;
  };
  matches?: Array<{
    source_id?: string;
    target_id?: string | null;
    method?: string;
    confidence?: number;
    cue_count?: number;
    source_path?: string;
  }>;
  summary?: Record<string, number>;
  warnings?: string[];
};

type Report = {
  mode?: string;
  set?: string;
  track_count?: number;
  converted?: number;
  missing?: number;
  failed?: number;
  out_dir?: string;
  album_dir?: string;
  crate?: string;
  manifest?: string;
  xml?: string;
  tracks?: Array<{
    title?: string;
    artist?: string;
    status?: string;
    error?: string;
    staged?: string;
    markers?: number;
  }>;
  entries?: Array<{
    title?: string;
    artist?: string;
    status?: string;
    error?: string;
    staged?: string;
    markers?: number;
  }>;
  warnings?: string[];
  [key: string]: unknown;
};

const STORAGE_KEY = "shadowroom.converter.paths";

/** The browser cannot expand `~`; the bridge hands us the home directory so we can. */
function expand(path: string, home: string): string {
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

/** Standard locations on macOS; all three are editable and remembered. */
function defaultPaths(home: string): Paths {
  return {
    rekordboxDatabase: `${home}/Library/Pioneer/rekordbox/master.db`,
    rekordboxDir: `${home}/Library/Pioneer/rekordbox`,
    seratoDatabase: `${home}/Library/Application Support/Serato/Library/master.sqlite`,
  };
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "library", label: "曲库" },
  { id: "preview", label: "预览" },
  { id: "convert", label: "转换" },
];

const MATCH_LABEL: Record<string, string> = {
  exact_path: "路径完全一致",
  filename_size: "文件名 + 大小",
  metadata: "元数据",
  unmatched: "未匹配",
  target_assets_not_referenced: "库里没被引用",
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="sr-stat">
      <span className="sr-stat-label sr-mono">{label}</span>
      <span className="sr-stat-value">{value}</span>
    </div>
  );
}

/** Collapsed raw JSON, same chrome as a tool-call row. */
function RawBlock({ label, json }: { label: string; json: string }) {
  const [open, setOpen] = useState(false);
  let readable = json;
  try {
    readable = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    /* keep the raw text */
  }
  return (
    <div className="sr-call">
      <button type="button" className="sr-call-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="sr-call-chevron">{open ? "▾" : "▸"}</span>
        <span className="sr-call-name">{label}</span>
        <span className="sr-call-state sr-mono">原始返回</span>
      </button>
      {open && <pre className="sr-call-detail sr-scroll">{readable}</pre>}
    </div>
  );
}

export function ConverterPanel({
  connected,
  tools = [],
  home = "",
  onBegin,
  onEnd,
}: {
  connected: boolean;
  tools?: { name: string; description?: string }[];
  home?: string;
  onBegin: (call: ToolCall) => void;
  onEnd: (id: string, patch: Partial<ToolCall>) => void;
}) {
  const [paths, setPaths] = useState<Paths>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const fallback = defaultPaths(home);
      return stored === null ? fallback : { ...fallback, ...(JSON.parse(stored) as Partial<Paths>) };
    } catch {
      return defaultPaths(home);
    }
  });
  const [tab, setTab] = useState<Tab>("library");
  const [direction, setDirection] = useState<Direction>("rb2serato");
  const [sets, setSets] = useState<SetList | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // conversion inputs
  const [name, setName] = useState("ShadowRoom Set");
  const [outDir, setOutDir] = useState("");
  const [playlist, setPlaylist] = useState("");
  const [deviceRoot, setDeviceRoot] = useState("");
  const [tracksText, setTracksText] = useState("");
  const [withCuesOnly, setWithCuesOnly] = useState(false);
  const [writeBeatgrid, setWriteBeatgrid] = useState(true);
  const [seratoSetName, setSeratoSetName] = useState("");
  const [apply, setApply] = useState(false);
  const [xmlPath, setXmlPath] = useState("");

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  }, [paths]);

  // The bridge answers asynchronously; once home arrives, turn any `~/…` into a real path.
  useEffect(() => {
    if (home === "") return;
    const fallback = defaultPaths(home);
    setPaths((current) => ({
      rekordboxDatabase: expand(current.rekordboxDatabase, home) || fallback.rekordboxDatabase,
      rekordboxDir: expand(current.rekordboxDir, home) || fallback.rekordboxDir,
      seratoDatabase: expand(current.seratoDatabase, home) || fallback.seratoDatabase,
    }));
  }, [home]);

  const rb = { rekordbox_database: paths.rekordboxDatabase, rekordbox_dir: paths.rekordboxDir };
  const ready = connected && !busy;

  async function invoke(tool: string, args: Record<string, unknown>, summary: string) {
    const id = `${tool}-${Date.now()}`;
    setBusy(true);
    setError(null);
    onBegin({
      id,
      server: "rekordbox-serato-bridge",
      name: tool,
      status: "running",
      summary,
      detail: JSON.stringify(args, null, 2),
    });
    try {
      const result = await callTool<string>("converter", tool, args);
      const text = String(result ?? "");
      setRaw(text);
      const parsed = JSON.parse(text) as unknown;
      if (tool === "list_sets") {
        const value = parsed as SetList;
        setSets(value);
        onEnd(id, { status: "ok", summary: `${value.set_count ?? 0} 个播放列表`, detail: text.slice(0, 4000) });
      } else if (tool.startsWith("preview")) {
        const value = parsed as Preview;
        setPreview(value);
        onEnd(id, {
          status: "ok",
          summary: `${value.source?.track_count ?? 0} → ${value.target?.asset_count ?? 0}`,
          detail: text.slice(0, 4000),
        });
      } else {
        const value = parsed as Report;
        setReport(value);
        onEnd(id, {
          status: "ok",
          summary:
            value.xml !== undefined
              ? "导出 XML"
              : value.mode === "set-conversion"
                ? `${value.track_count ?? 0} 首`
                : value.mode ?? tool,
          detail: text.slice(0, 4000),
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setPreview(null);
      setReport(null);
      onEnd(id, { status: "error", summary: message, detail: message });
    } finally {
      setBusy(false);
    }
  }

  const convertReady =
    direction === "rb2serato"
      ? name.trim().length > 0 && outDir.trim().length > 0 && (playlist.trim().length > 0 || deviceRoot.trim().length > 0)
      : paths.seratoDatabase.trim().length > 0;

  return (
    <div className="sr-plugin-pane">
      <div className="sr-plugin-tabs" role="tablist" aria-label="工具">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="sr-plugin-tab"
            aria-selected={tab === entry.id}
            data-on={tab === entry.id || undefined}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tools.length > 0 && <p className="sr-plugin-tools sr-mono">{tools.map((t) => t.name).join(" · ")}</p>}

      <div className="sr-plugin-options sr-plugin-options--stack">
        <label className="sr-field">
          <span className="sr-field-label sr-mono">Rekordbox 数据库</span>
          <input
            className="sr-input"
            value={paths.rekordboxDatabase}
            spellCheck={false}
            onChange={(event) => setPaths((p) => ({ ...p, rekordboxDatabase: event.target.value }))}
          />
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">Rekordbox 目录</span>
          <input
            className="sr-input"
            value={paths.rekordboxDir}
            spellCheck={false}
            onChange={(event) => setPaths((p) => ({ ...p, rekordboxDir: event.target.value }))}
          />
        </label>
        <label className="sr-field">
          <span className="sr-field-label sr-mono">Serato 数据库</span>
          <input
            className="sr-input"
            value={paths.seratoDatabase}
            spellCheck={false}
            onChange={(event) => setPaths((p) => ({ ...p, seratoDatabase: event.target.value }))}
          />
        </label>
      </div>

      {tab === "library" && (
        <>
          <button
            type="button"
            className="sr-btn sr-btn--accent sr-plugin-run"
            disabled={!ready}
            onClick={() => void invoke("list_sets", { ...rb }, "播放列表")}
          >
            {busy ? "读取中…" : "读取播放列表"}
          </button>
          {sets && (
            <div className="sr-plugin-result">
              <div className="sr-plugin-stats">
                <Stat label="播放列表" value={sets.set_count ?? 0} />
                <Stat
                  label="曲目合计"
                  value={(sets.sets ?? []).reduce((sum, item) => sum + (item.track_count ?? 0), 0)}
                />
              </div>
              <ul className="sr-plugin-list">
                {(sets.sets ?? []).map((item) => (
                  <li key={item.name} className="sr-plugin-timeline-row">
                    <span className="sr-plugin-timeline-title">{item.name}</span>
                    <span className="sr-plugin-timeline-meta sr-mono">{item.track_count} 首</span>
                  </li>
                ))}
              </ul>
              <p className="sr-plugin-hint sr-plugin-hint--dim">
                点一个名字可以填进"转换"里的播放列表字段。
              </p>
            </div>
          )}
        </>
      )}

      {tab === "preview" && (
        <>
          <div className="sr-plugin-tabs" role="tablist" aria-label="方向">
            <button
              type="button"
              role="tab"
              className="sr-plugin-tab"
              aria-selected={direction === "rb2serato"}
              data-on={direction === "rb2serato" || undefined}
              onClick={() => setDirection("rb2serato")}
            >
              Rekordbox → Serato
            </button>
            <button
              type="button"
              role="tab"
              className="sr-plugin-tab"
              aria-selected={direction === "serato2rb"}
              data-on={direction === "serato2rb" || undefined}
              onClick={() => setDirection("serato2rb")}
            >
              Serato → Rekordbox
            </button>
          </div>
          <button
            type="button"
            className="sr-btn sr-btn--accent sr-plugin-run"
            disabled={!ready}
            onClick={() =>
              void invoke(
                direction === "rb2serato" ? "preview_rekordbox_to_serato" : "preview_serato_to_rekordbox",
                { ...rb, serato_database: paths.seratoDatabase },
                direction === "rb2serato" ? "Rekordbox → Serato" : "Serato → Rekordbox",
              )
            }
          >
            {busy ? "读取中…" : "运行预览（只读）"}
          </button>
          {preview && (
            <div className="sr-plugin-result">
              <div className="sr-plugin-stats">
                <Stat label="来源曲目" value={preview.source?.track_count ?? 0} />
                <Stat label="来源 cue" value={preview.source?.cue_count ?? 0} />
                <Stat label="目标资产" value={preview.target?.asset_count ?? 0} />
                <Stat label="目标 cue" value={preview.target?.cue_count ?? 0} />
                <Stat label="已匹配" value={preview.summary?.matched_with_cues ?? 0} />
                <Stat label="未匹配" value={preview.summary?.unmatched ?? 0} />
              </div>
              <div className="sr-plugin-options">
                {Object.entries(preview.summary ?? {})
                  .filter(([key]) => key !== "matched_with_cues" && key !== "unmatched")
                  .map(([key, value]) => (
                    <span key={key} className="sr-chip">
                      <span className="sr-chip-label sr-mono">
                        {MATCH_LABEL[key] ?? key} {value}
                      </span>
                    </span>
                  ))}
              </div>
              <ul className="sr-plugin-list">
                {(preview.matches ?? []).slice(0, 40).map((match) => (
                  <li key={match.source_id ?? match.source_path} className="sr-plugin-timeline-row">
                    <span className="sr-plugin-timeline-title">
                      {(match.source_path ?? match.source_id ?? "").split("/").pop() || "—"}
                    </span>
                    <span className="sr-plugin-timeline-meta sr-mono">
                      {match.target_id ? `${MATCH_LABEL[match.method ?? ""] ?? match.method} · ${match.cue_count ?? 0} cue` : "未匹配"}
                    </span>
                  </li>
                ))}
              </ul>
              {(preview.matches ?? []).length > 40 && (
                <p className="sr-plugin-hint sr-plugin-hint--dim">
                  只显示前 40 条，完整清单在下面的原始返回里。
                </p>
              )}
              {(preview.warnings ?? []).map((warning) => (
                <div key={warning} className="sr-alert" data-level="note">
                  {warning}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "convert" && (
        <>
          <div className="sr-plugin-tabs" role="tablist" aria-label="方向">
            <button
              type="button"
              role="tab"
              className="sr-plugin-tab"
              aria-selected={direction === "rb2serato"}
              data-on={direction === "rb2serato" || undefined}
              onClick={() => setDirection("rb2serato")}
            >
              Rekordbox → Serato
            </button>
            <button
              type="button"
              role="tab"
              className="sr-plugin-tab"
              aria-selected={direction === "serato2rb"}
              data-on={direction === "serato2rb" || undefined}
              onClick={() => setDirection("serato2rb")}
            >
              Serato → Rekordbox
            </button>
          </div>

          {direction === "rb2serato" ? (
            <>
              <label className="sr-field">
                <span className="sr-field-label sr-mono">名称（crate 文件名）</span>
                <input className="sr-input" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="sr-field">
                <span className="sr-field-label sr-mono">输出目录（拷到 U 盘根目录）</span>
                <input
                  className="sr-input"
                  value={outDir}
                  spellCheck={false}
                  placeholder="/Volumes/USB/ShadowRoom Set"
                  onChange={(event) => setOutDir(event.target.value)}
                />
              </label>
              <label className="sr-field">
                <span className="sr-field-label sr-mono">Rekordbox 播放列表（先"读取播放列表"）</span>
                <input
                  className="sr-input"
                  value={playlist}
                  list="sr-playlists"
                  onChange={(event) => setPlaylist(event.target.value)}
                />
                <datalist id="sr-playlists">
                  {(sets?.sets ?? []).map((item) => (
                    <option key={item.name} value={item.name} />
                  ))}
                </datalist>
              </label>
              <details className="sr-details">
                <summary className="sr-details-summary">或者从设备（U 盘）转换</summary>
                <div className="sr-plugin-options sr-plugin-options--stack">
                  <label className="sr-field">
                    <span className="sr-field-label sr-mono">设备根目录</span>
                    <input
                      className="sr-input"
                      value={deviceRoot}
                      spellCheck={false}
                      placeholder="/Volumes/USB"
                      onChange={(event) => setDeviceRoot(event.target.value)}
                    />
                  </label>
                  <label className="sr-field">
                    <span className="sr-field-label sr-mono">设备里的曲目路径（每行一条，留空＝全部）</span>
                    <textarea
                      className="sr-textarea sr-textarea--short"
                      value={tracksText}
                      rows={3}
                      spellCheck={false}
                      onChange={(event) => setTracksText(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="sr-toggle"
                    aria-pressed={withCuesOnly}
                    data-on={withCuesOnly || undefined}
                    onClick={() => setWithCuesOnly((value) => !value)}
                  >
                    只转有 cue 的曲目
                  </button>
                </div>
              </details>
              <div className="sr-plugin-options">
                <button
                  type="button"
                  className="sr-toggle"
                  aria-pressed={writeBeatgrid}
                  data-on={writeBeatgrid || undefined}
                  onClick={() => setWriteBeatgrid((value) => !value)}
                >
                  写 BeatGrid
                </button>
              </div>
              <button
                type="button"
                className="sr-btn sr-btn--accent sr-plugin-run"
                disabled={!ready || !convertReady}
                onClick={() =>
                  void invoke(
                    "convert_set",
                    {
                      name: name.trim(),
                      out_dir: outDir.trim(),
                      write_beatgrid: writeBeatgrid,
                      ...(deviceRoot.trim()
                        ? {
                            device_root: deviceRoot.trim(),
                            with_cues_only: withCuesOnly,
                            ...(tracksText.trim()
                              ? { tracks: tracksText.split("\n").map((line) => line.trim()).filter(Boolean) }
                              : {}),
                          }
                        : { ...rb, playlist: playlist.trim() }),
                    },
                    name.trim(),
                  )
                }
              >
                {busy ? "转换中…" : "转换到输出目录"}
              </button>
              <p className="sr-plugin-hint sr-plugin-hint--dim">
                只会往你写的输出目录里复制并写 Serato 标签；Rekordbox 数据库和原始音频文件不会被改。
              </p>
            </>
          ) : (
            <>
              <label className="sr-field">
                <span className="sr-field-label sr-mono">Serato crate（留空＝全部本地曲目）</span>
                <input
                  className="sr-input"
                  value={seratoSetName}
                  onChange={(event) => setSeratoSetName(event.target.value)}
                />
              </label>
              <label className="sr-field">
                <span className="sr-field-label sr-mono">Rekordbox 播放列表名</span>
                <input className="sr-input" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="sr-field">
                <span className="sr-field-label sr-mono">或导出 XML（不碰数据库）</span>
                <input
                  className="sr-input"
                  value={xmlPath}
                  spellCheck={false}
                  placeholder="~/Desktop/set.xml"
                  onChange={(event) => setXmlPath(event.target.value)}
                />
              </label>
              <div className="sr-plugin-options">
                <button
                  type="button"
                  className="sr-toggle"
                  aria-pressed={apply}
                  data-on={apply || undefined}
                  onClick={() => setApply((value) => !value)}
                >
                  {apply ? "写入数据库（会先备份）" : "dry-run（只报告）"}
                </button>
              </div>
              <button
                type="button"
                className="sr-btn sr-btn--accent sr-plugin-run"
                disabled={!ready}
                onClick={() =>
                  void invoke(
                    "convert_set_to_rekordbox",
                    {
                      serato_database: paths.seratoDatabase,
                      ...(seratoSetName.trim() ? { set_name: seratoSetName.trim() } : {}),
                      ...(name.trim() ? { name: name.trim() } : {}),
                      ...(xmlPath.trim() ? { xml_path: xmlPath.trim() } : { ...rb, apply }),
                    },
                    xmlPath.trim() ? "导出 XML" : apply ? "写入 Rekordbox" : "dry-run",
                  )
                }
              >
                {busy ? "运行中…" : xmlPath.trim() ? "导出 XML" : apply ? "写入并备份" : "运行 dry-run"}
              </button>
              <p className="sr-plugin-hint sr-plugin-hint--dim">
                dry-run 只报告会写什么；写入前插件会自动备份 master.db。写数据库时请先退出 Rekordbox。
              </p>
            </>
          )}
        </>
      )}

      {!connected && <p className="sr-plugin-hint sr-plugin-hint--dim">bridge 没启动，先跑 pnpm serve。</p>}
      {error && <div className="sr-alert" data-level="danger">{error}</div>}

      {report && (
        <div className="sr-plugin-result">
          <div className="sr-plugin-stats">
            {report.track_count !== undefined && <Stat label="曲目" value={report.track_count} />}
            {report.converted !== undefined && <Stat label="已转换" value={report.converted} />}
            {report.missing !== undefined && <Stat label="源文件缺失" value={report.missing} />}
            {report.failed !== undefined && <Stat label="失败" value={report.failed} />}
            {report.set !== undefined && <Stat label="集合" value={String(report.set)} />}
            {report.xml !== undefined && <Stat label="XML" value={String(report.xml)} />}
            {report.mode !== undefined && <Stat label="模式" value={String(report.mode)} />}
          </div>
          {(report.crate ?? report.album_dir ?? report.out_dir) !== undefined && (
            <p className="sr-plugin-hash sr-mono">{report.crate ?? report.album_dir ?? report.out_dir}</p>
          )}
          {(report.tracks ?? report.entries ?? []).length > 0 && (
            <ul className="sr-plugin-list">
              {(report.tracks ?? report.entries ?? []).slice(0, 40).map((entry, index) => (
                <li key={`${entry.title ?? index}`} className="sr-plugin-timeline-row">
                  <span className="sr-plugin-timeline-title">
                    {entry.title ?? "—"}
                    {entry.artist ? ` · ${entry.artist}` : ""}
                  </span>
                  <span className="sr-plugin-timeline-meta sr-mono">
                    {entry.status ?? "—"}
                    {entry.markers !== undefined ? ` · ${entry.markers} 个标记` : ""}
                    {entry.error ? ` · ${entry.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(report.warnings ?? []).map((warning) => (
            <div key={warning} className="sr-alert" data-level="note">
              {warning}
            </div>
          ))}
          <RawBlock label={report.mode ?? "report"} json={raw ?? "{}"} />
        </div>
      )}

      {tab === "library" && sets && <RawBlock label="list_sets" json={raw ?? "{}"} />}
      {tab === "preview" && preview && <RawBlock label="preview" json={raw ?? "{}"} />}
    </div>
  );
}
