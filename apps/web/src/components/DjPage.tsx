/**
 * Set workbench (transitional S1 shape): one player, the library, and cue editing.
 *
 * The page used to be a two-deck mixing desk; the set-builder redesign (2026-09-23) keeps a single
 * player for auditioning and cue work on the engine in `lib/dj-deck.ts`. The set board, timing,
 * suggestions and exports arrive in S2 — this file deliberately holds nothing else.
 *
 * No bottom input bar: typing lives in the orb and the conversation dock.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { IconPause, IconPlay } from "./icons";
import { callTool } from "../lib/mcp";
import { Player, type DeckSnapshot } from "../lib/dj-deck";

type LibraryTrack = {
  id: number;
  path: string;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  duration_ms: number | null;
};

type DjCue = {
  id?: number;
  position_ms: number;
  end_ms?: number | null;
  kind?: string;
  color?: string | null;
  name?: string | null;
  display_name: string;
};

type CueBlock = {
  cues: DjCue[];
  cue_source: string | null;
  imported_cue_total: number;
  imported_cue_overridden: number;
};

type TrackDetail = LibraryTrack & CueBlock & { peaks: number[]; genre?: string | null };

const CUE_COLORS = ["#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#6366f1"];

function mmss(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** Parse the bridge's text result; the caller decides what a failure means for the user. */
async function tool<T>(server: string, name: string, args: unknown): Promise<T> {
  const raw = await callTool<string>(server, name, args);
  return JSON.parse(String(raw)) as T;
}

const emptySnapshot = (): DeckSnapshot => ({
  state: "empty",
  path: null,
  durationMs: 0,
  positionMs: 0,
  volume: 1,
});

export function DjPage() {
  const changeRef = useRef<(snapshot: DeckSnapshot) => void>(() => {});
  const [player] = useState(
    () =>
      new Player({
        events: {
          onChange: (snapshot) => changeRef.current(snapshot),
        },
      }),
  );
  const [deck, setDeck] = useState<DeckSnapshot>(emptySnapshot());
  useEffect(() => {
    changeRef.current = (snapshot) => setDeck(snapshot);
    return () => {
      player.deck.unload();
    };
  }, [player]);

  const [trackId, setTrackId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TrackDetail | null>(null);
  const [cueBlock, setCueBlock] = useState<CueBlock | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // One re-render every 125ms while something plays, so position readouts follow the audio clock.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (deck.state !== "playing") return;
    const timer = window.setInterval(bump, 125);
    return () => window.clearInterval(timer);
  }, [deck.state]);

  const say = useCallback((text: string | null) => setNotice(text), []);

  /** Fetch detail once, then load the track onto the single player. */
  const loadTrack = useCallback(
    async (id: number) => {
      try {
        const next = await tool<TrackDetail>("library", "track_detail", { id });
        await player.deck.load(next.path);
        setTrackId(id);
        setDetail(next);
        setCueBlock({
          cues: next.cues ?? [],
          cue_source: next.cue_source ?? null,
          imported_cue_total: next.imported_cue_total ?? 0,
          imported_cue_overridden: next.imported_cue_overridden ?? 0,
        });
        setEditing(null);
        say(null);
      } catch (cause) {
        say(`载入失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [player, say],
  );

  /** Preview toggles: the same track stops, anything else loads and plays. */
  const previewTrack = useCallback(
    async (id: number) => {
      if (trackId === id && detail !== null) {
        if (deck.state === "playing") player.deck.pause();
        else player.deck.play();
        return;
      }
      await loadTrack(id);
      player.deck.play();
    },
    [trackId, detail, deck.state, player, loadTrack],
  );

  const saveCues = useCallback(
    async (cues: DjCue[]) => {
      if (trackId === null) return;
      try {
        const payload = cues.map((cue) => ({
          position_ms: cue.position_ms,
          end_ms: cue.end_ms ?? undefined,
          name: cue.name ?? undefined,
          color: cue.color ?? undefined,
          kind: cue.kind ?? "cue",
        }));
        const saved = await tool<CueBlock>("library", "cues_set", { track_id: trackId, cues: payload });
        setCueBlock(saved);
        say(null);
      } catch (cause) {
        say(`cue 保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [trackId, say],
  );

  const addCueAt = useCallback(() => {
    if (cueBlock === null) return;
    const at = Math.round(player.deck.positionMs());
    void saveCues([...cueBlock.cues, { position_ms: at, display_name: "" }]);
  }, [cueBlock, player, saveCues]);

  const renameCue = useCallback(
    (index: number, name: string) => {
      if (cueBlock === null) return;
      const next = cueBlock.cues.map((cue, i) => (i === index ? { ...cue, name: name.trim() || null } : cue));
      setEditing(null);
      void saveCues(next);
    },
    [cueBlock, saveCues],
  );

  const recolorCue = useCallback(
    (index: number) => {
      if (cueBlock === null) return;
      const next = cueBlock.cues.map((cue, i) => {
        if (i !== index) return cue;
        const used = CUE_COLORS.indexOf(cue.color ?? "");
        return { ...cue, color: CUE_COLORS[(used + 1) % CUE_COLORS.length] };
      });
      void saveCues(next);
    },
    [cueBlock, saveCues],
  );

  const removeCue = useCallback(
    (index: number) => {
      if (cueBlock === null) return;
      setEditing(null);
      void saveCues(cueBlock.cues.filter((_, i) => i !== index));
    },
    [cueBlock, saveCues],
  );

  const bpm = detail?.bpm ?? null;
  const canTransport = deck.state === "ready" || deck.state === "playing";
  const nudge = (beats: number) => {
    const step = bpm !== null && bpm > 0 ? (60_000 / bpm) * beats : 5_000 * Math.sign(beats);
    player.deck.seekMs(player.deck.positionMs() + step);
  };

  return (
    <div className="sr-dj">
      {notice !== null ? <div className="sr-dj-notice" role="alert">{notice}</div> : null}
      <section className="sr-dj-deck" data-state={deck.state}>
        <header className="sr-dj-deck-head">
          <span className="sr-dj-deck-title" title={deck.path ?? undefined}>
            {detail !== null ? (detail.title ?? detail.path.split("/").pop()) : deck.state === "loading" ? "载入中…" : "空 · 从曲库选一首"}
          </span>
          {detail !== null && detail.bpm !== null ? <span className="sr-chip">{Number(detail.bpm.toFixed(1))} BPM</span> : null}
          {detail?.camelot ? <span className="sr-chip">{detail.camelot}</span> : null}
        </header>
        <WaveformStrip
          peaks={detail?.peaks ?? []}
          durationMs={deck.durationMs}
          positionMs={player.deck.positionMs()}
          cues={cueBlock?.cues ?? []}
          onSeek={(ms) => player.deck.seekMs(ms)}
        />
        <div className="sr-dj-cues">
          {(cueBlock?.cues ?? []).map((cue, index) =>
            editing === index ? (
              <CueEditor
                key={cue.position_ms}
                cue={cue}
                onRename={(name) => renameCue(index, name)}
                onRecolor={() => recolorCue(index)}
                onRemove={() => removeCue(index)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <button
                key={`${cue.position_ms}-${cue.display_name}`}
                type="button"
                className="sr-dj-cue"
                title={`${cue.display_name} · ${mmss(cue.position_ms / 1000)} · 点击跳转，✎ 改名`}
                onClick={() => player.deck.seekMs(cue.position_ms)}
              >
                <span className="sr-dj-cue-dot" style={{ background: cue.color ?? "#e2e8f0" }} />
                <span className="sr-dj-cue-name">{cue.display_name}</span>
                <span className="sr-dj-cue-time">{mmss(cue.position_ms / 1000)}</span>
                <span
                  className="sr-dj-cue-edit"
                  role="button"
                  aria-label={`编辑 ${cue.display_name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditing(index);
                  }}
                >
                  ✎
                </span>
              </button>
            ),
          )}
          <button type="button" className="sr-dj-cue-add" onClick={addCueAt} disabled={!canTransport}>
            ＋ 打点
          </button>
          {cueBlock !== null && cueBlock.imported_cue_overridden > 0 ? (
            <span className="sr-dj-cue-note">已覆盖 {cueBlock.imported_cue_overridden} 条导入 cue</span>
          ) : null}
        </div>
        <div className="sr-dj-transport">
          <button
            type="button"
            className="sr-icon-btn"
            aria-label={deck.state === "playing" ? "暂停" : "播放"}
            aria-pressed={deck.state === "playing"}
            disabled={!canTransport}
            onClick={() => {
              if (deck.state === "playing") player.deck.pause();
              else player.deck.play();
            }}
          >
            {deck.state === "playing" ? <IconPause /> : <IconPlay />}
          </button>
          <span className="sr-dj-clock">{mmss(deck.positionMs / 1000)}</span>
          <span className="sr-dj-clock-total">/ {mmss(deck.durationMs / 1000)}</span>
          <div className="sr-dj-nudges">
            <button type="button" className="sr-page-action" disabled={!canTransport} onClick={() => nudge(-4)}>−4拍</button>
            <button type="button" className="sr-page-action" disabled={!canTransport} onClick={() => nudge(-1)}>−1拍</button>
            <button type="button" className="sr-page-action" disabled={!canTransport} onClick={() => nudge(1)}>+1拍</button>
            <button type="button" className="sr-page-action" disabled={!canTransport} onClick={() => nudge(4)}>+4拍</button>
          </div>
          <input
            className="sr-dj-vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={deck.volume}
            aria-label="音量"
            onChange={(event) => player.deck.setVolume(Number(event.target.value))}
          />
        </div>
        {deck.state === "loading" ? <p className="sr-dj-loading">解码中…</p> : null}
      </section>
      <LibraryBrowser
        previewing={deck.state !== "empty" ? deck.path : null}
        deckPaths={[deck.path]}
        onPreview={(id) => void previewTrack(id)}
        onLoadTrack={(id) => void loadTrack(id)}
      />
    </div>
  );
}

function WaveformStrip(props: {
  peaks: number[];
  durationMs: number;
  positionMs: number;
  cues: DjCue[];
  onSeek: (ms: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { peaks, durationMs, positionMs, cues } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#101014";
    context.fillRect(0, 0, width, height);
    if (peaks.length > 0 && durationMs > 0) {
      context.fillStyle = "#5b5f6b";
      const bar = width / peaks.length;
      peaks.forEach((peak, index) => {
        const h = Math.max(2, peak * (height - 12));
        context.fillRect(index * bar + 1, (height - h) / 2, Math.max(1, bar - 2), h);
      });
    }
    if (durationMs > 0) {
      const x = (positionMs / durationMs) * width;
      context.fillStyle = "#7dd3fc";
      context.fillRect(x - 1, 0, 2, height);
      for (const cue of cues) {
        const cx = (cue.position_ms / durationMs) * width;
        context.fillStyle = cue.color ?? "#e2e8f0";
        context.fillRect(cx - 1, 0, 3, 8);
      }
    }
  }, [peaks, durationMs, positionMs, cues]);

  return (
    <canvas
      ref={canvasRef}
      className="sr-dj-wave"
      width={560}
      height={64}
      onClick={(event) => {
        if (durationMs <= 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        props.onSeek(fraction * durationMs);
      }}
    />
  );
}

function CueEditor(props: {
  cue: DjCue;
  onRename: (name: string) => void;
  onRecolor: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.cue.name ?? props.cue.display_name);
  return (
    <span className="sr-dj-cue-editor">
      <input
        className="sr-input"
        value={name}
        autoFocus
        aria-label="cue 名称"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onRename(name);
          if (event.key === "Escape") props.onCancel();
        }}
        onBlur={() => props.onRename(name)}
      />
      {/* mousedown preventDefault keeps the input focused, so blur cannot fire (and commit a
          half-typed name) before the button's own click lands. */}
      <button type="button" className="sr-page-action" title="换一个颜色" onMouseDown={(event) => event.preventDefault()} onClick={props.onRecolor}>
        换色
      </button>
      <button type="button" className="sr-page-action" title="删掉这个点" onMouseDown={(event) => event.preventDefault()} onClick={props.onRemove}>
        删
      </button>
    </span>
  );
}

function LibraryBrowser(props: {
  previewing: string | null;
  deckPaths: Array<string | null>;
  onPreview: (trackId: number) => void;
  onLoadTrack: (trackId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [bpmMin, setBpmMin] = useState("");
  const [bpmMax, setBpmMax] = useState("");
  const [camelot, setCamelot] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // One fetch per settled filter set: 250ms debounce so typing a BPM range does not fire six scans.
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setFailed(null);
      try {
        const args: Record<string, unknown> = { limit: 200 };
        if (query.trim() !== "") args.query = query.trim();
        const lo = Number(bpmMin);
        const hi = Number(bpmMax);
        if (bpmMin !== "" && Number.isFinite(lo)) args.bpm_min = lo;
        if (bpmMax !== "" && Number.isFinite(hi)) args.bpm_max = hi;
        if (camelot.trim() !== "") args.camelot = camelot.trim();
        const result = await tool<{ tracks: LibraryTrack[] }>("library", "list_tracks", args);
        setTracks(result.tracks ?? []);
      } catch (cause) {
        setTracks([]);
        setFailed(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, bpmMin, bpmMax, camelot]);

  return (
    <section className="sr-dj-library" aria-label="曲目库">
      <div className="sr-dj-filters">
        <input
          className="sr-input"
          placeholder="搜索 标题/艺人/专辑"
          value={query}
          aria-label="搜索"
          onChange={(event) => setQuery(event.target.value)}
        />
        <input className="sr-input sr-input--num" placeholder="BPM ≥" value={bpmMin} aria-label="BPM 下限" onChange={(event) => setBpmMin(event.target.value)} />
        <input className="sr-input sr-input--num" placeholder="BPM ≤" value={bpmMax} aria-label="BPM 上限" onChange={(event) => setBpmMax(event.target.value)} />
        <input className="sr-input" placeholder="Camelot 如 8A" value={camelot} aria-label="Camelot" onChange={(event) => setCamelot(event.target.value)} />
        <span className="sr-dj-count">{loading ? "查询中…" : `共 ${tracks.length}${tracks.length >= 200 ? "+" : ""} 首`}</span>
      </div>
      {failed !== null ? <div className="sr-dj-notice" role="alert">{failed}</div> : null}
      <div className="sr-dj-rows">
        {tracks.map((track) => {
          const loaded = props.deckPaths.includes(track.path);
          return (
            <div
              key={track.id}
              className="sr-dj-row"
              data-loaded={loaded || undefined}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-shadowroom-track", String(track.id));
                event.dataTransfer.effectAllowed = "copy";
              }}
            >
              <span className="sr-dj-row-title">{track.title ?? track.path.split("/").pop()}</span>
              <span className="sr-dj-row-artist">{track.artist ?? ""}</span>
              {track.bpm !== null ? <span className="sr-chip">{Number(track.bpm.toFixed(1))} BPM</span> : null}
              {track.camelot ? <span className="sr-chip">{track.camelot}</span> : null}
              <span className="sr-dj-row-time">{track.duration_ms !== null ? mmss(track.duration_ms / 1000) : "—"}</span>
              <button
                type="button"
                className="sr-page-action"
                aria-label={`试听 ${track.title ?? track.id}`}
                onClick={() => props.onPreview(track.id)}
              >
                {props.previewing === track.path ? "停" : "试听"}
              </button>
              <button type="button" className="sr-page-action" onClick={() => props.onLoadTrack(track.id)}>
                装载
              </button>
            </div>
          );
        })}
        {!loading && tracks.length === 0 && failed === null ? (
          <p className="sr-dj-empty">库里没有匹配的曲目 —— 用曲目库插件先扫一个目录。</p>
        ) : null}
      </div>
    </section>
  );
}
