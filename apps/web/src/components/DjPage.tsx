/**
 * DJ — the two-deck page.
 *
 * Decks A/B and the preview all run on the one `DjMixer` engine (`lib/dj-deck.ts`): the performance
 * decks go through the crossfader, the library preview goes straight to master. The library is the
 * `library` plugin (SQLite) — this page is also the ONLY place cue points are edited: the effective
 * cue set comes from `track_detail`, edits go back through `cues_set` (the sole write path).
 *
 * No bottom input bar anywhere on the page — typing lives in the orb and the conversation dock.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DragEvent } from "react";
import { IconPause, IconPlay } from "./icons";
import { callTool } from "../lib/mcp";
import { DjMixer, type DeckId, type DeckSnapshot } from "../lib/dj-deck";

type LibraryTrack = {
  id: number;
  path: string;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  energy: number | null;
  duration_ms: number | null;
};

type DjCue = {
  id?: number;
  position_ms: number;
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

type Suggestion = {
  id: string;
  title: string;
  artist?: string;
  bpm: number | null;
  key: string | null;
  score: number;
  reasons: string[];
  cautions?: string[];
};

type CrateInfo = { id: number; name: string; tracks: number };

const DJ_STORAGE_KEY = "shadowroom.dj";
const DJ_LOAD_KEY = "shadowroom.dj.load";
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

type DjState = {
  deckA: number | null;
  deckB: number | null;
  crossfade: number;
  master: number;
};

function readDjState(): DjState {
  try {
    const raw = window.localStorage.getItem(DJ_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<DjState>;
      return {
        deckA: typeof parsed.deckA === "number" ? parsed.deckA : null,
        deckB: typeof parsed.deckB === "number" ? parsed.deckB : null,
        crossfade: typeof parsed.crossfade === "number" ? Math.min(1, Math.max(0, parsed.crossfade)) : 0.5,
        master: typeof parsed.master === "number" ? Math.min(1, Math.max(0, parsed.master)) : 1,
      };
    }
  } catch {
    // corrupted storage is treated as empty — the page must always come up
  }
  return { deckA: null, deckB: null, crossfade: 0.5, master: 1 };
}

const emptySnapshot = (id: DeckId): DeckSnapshot => ({
  id,
  state: "empty",
  path: null,
  durationMs: 0,
  positionMs: 0,
  volume: 1,
});

export function DjPage() {
  const changeRef = useRef<(snapshot: DeckSnapshot) => void>(() => {});
  const endedRef = useRef<(id: DeckId) => void>(() => {});
  const [mixer] = useState(
    () =>
      new DjMixer({
        events: {
          onDeckChange: (snapshot) => changeRef.current(snapshot),
          onEnded: (id) => endedRef.current(id),
        },
      }),
  );
  const [decks, setDecks] = useState<Record<DeckId, DeckSnapshot>>({
    A: emptySnapshot("A"),
    B: emptySnapshot("B"),
    preview: emptySnapshot("preview"),
  });
  useEffect(() => {
    changeRef.current = (snapshot) => setDecks((current) => ({ ...current, [snapshot.id]: snapshot }));
    endedRef.current = () => {};
    return () => {
      for (const id of ["A", "B", "preview"] as DeckId[]) mixer.deck(id).unload();
    };
  }, [mixer]);

  const persisted = useMemo(readDjState, []);
  const [crossfade, setCrossfade] = useState(persisted.crossfade);
  const [master, setMaster] = useState(persisted.master);
  /** Which track each deck holds — the one place that maps a loaded deck back to a library id. */
  const [deckTracks, setDeckTracks] = useState<{ A: number | null; B: number | null }>({ A: null, B: null });
  const [cueBlocks, setCueBlocks] = useState<Record<number, CueBlock>>({});
  const [details, setDetails] = useState<Record<number, TrackDetail>>({});
  const [editing, setEditing] = useState<{ deckId: DeckId; index: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // One re-render every 125ms while something plays, so position readouts follow the audio clock.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const anyPlaying = decks.A.state === "playing" || decks.B.state === "playing" || decks.preview.state === "playing";
  useEffect(() => {
    if (!anyPlaying) return;
    const timer = window.setInterval(bump, 125);
    return () => window.clearInterval(timer);
  }, [anyPlaying]);

  useEffect(() => {
    mixer.setCrossfade(crossfade);
  }, [mixer, crossfade]);
  useEffect(() => {
    mixer.setMasterVolume(master);
  }, [mixer, master]);

  // Only the loaded decks and the faders are remembered — where the playhead was is not, a reload
  // means the decks come up paused at zero.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        DJ_STORAGE_KEY,
        JSON.stringify({ deckA: deckTracks.A, deckB: deckTracks.B, crossfade, master }),
      );
    } catch {
      // storage may be full or blocked; the decks keep working without it
    }
  }, [deckTracks, crossfade, master]);

  const say = useCallback((text: string | null) => setNotice(text), []);

  // ------------------------------------------------ suggestions (set-planner)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);

  useEffect(() => {
    const trackId = deckTracks.A;
    const detail = trackId === null ? undefined : details[trackId];
    if (trackId === null || detail === undefined) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSuggestBusy(true);
      try {
        const pool = await tool<{ tracks: LibraryTrack[] }>("library", "list_tracks", { limit: 200 });
        const payload = {
          current: {
            id: String(detail.id),
            title: detail.title ?? "",
            artist: detail.artist ?? "",
            bpm: detail.bpm,
            key: detail.camelot ?? detail.key,
            genres: detail.genre ? [detail.genre] : [],
            energy: detail.energy,
          },
          pool: (pool.tracks ?? []).map((t) => ({
            id: String(t.id),
            title: t.title ?? "",
            artist: t.artist ?? "",
            bpm: t.bpm,
            key: t.camelot ?? t.key,
            genres: [],
            energy: t.energy,
            duration_ms: t.duration_ms,
          })),
          limit: 5,
        };
        const result = await tool<{ suggestions: Suggestion[] }>("planner", "suggest_next", payload);
        if (cancelled) return;
        setSuggestions(result.suggestions ?? []);
      } catch (cause) {
        if (!cancelled) {
          setSuggestions([]);
          say(`下一首推荐失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      } finally {
        if (!cancelled) setSuggestBusy(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deckTracks.A, details, say]);

  // ------------------------------------------------ crates + m3u
  const [crates, setCrates] = useState<CrateInfo[]>([]);
  const [crateBusy, setCrateBusy] = useState(false);

  const refreshCrates = useCallback(async () => {
    try {
      const result = await tool<{ crates: CrateInfo[] }>("library", "crate_list", {});
      setCrates(result.crates ?? []);
    } catch (cause) {
      say(`crate 列表失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [say]);

  useEffect(() => {
    void refreshCrates();
  }, [refreshCrates]);

  const saveDeckToCrate = useCallback(
    async (deckId: "A" | "B", name: string) => {
      const trackId = deckTracks[deckId];
      const trimmed = name.trim();
      if (trackId === null || trimmed === "") return;
      setCrateBusy(true);
      try {
        const created = await tool<{ id: number }>("library", "crate_create", { name: trimmed });
        const added = await tool<{ added: number; skipped: number }>("library", "crate_add", {
          crate_id: created.id,
          track_ids: [trackId],
        });
        await refreshCrates();
        say(added.skipped > 0 ? `「${trimmed}」里已经有这首` : `已存进「${trimmed}」`);
      } catch (cause) {
        say(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        setCrateBusy(false);
      }
    },
    [deckTracks, refreshCrates, say],
  );

  const exportCrate = useCallback(
    async (crateId: number) => {
      setCrateBusy(true);
      try {
        const result = await tool<{ path: string; tracks: number; missing_files: string[] }>(
          "library",
          "crate_export_m3u",
          { crate_id: crateId },
        );
        say(
          `m3u 已导出：${result.path}${
            result.missing_files.length > 0 ? `（${result.missing_files.length} 个文件不在盘上）` : ""
          }`,
        );
      } catch (cause) {
        say(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        setCrateBusy(false);
      }
    },
    [say],
  );

  const loadDeck = useCallback(
    async (deckId: "A" | "B", trackId: number) => {
      try {
        const detail = details[trackId] ?? (await tool<TrackDetail>("library", "track_detail", { id: trackId }));
        setDetails((current) => ({ ...current, [trackId]: detail }));
        setCueBlocks((current) => ({ ...current, [trackId]: cueBlockOf(detail) }));
        await mixer.deck(deckId).load(detail.path);
        setDeckTracks((current) => ({ ...current, [deckId]: trackId }));
        say(null);
      } catch (cause) {
        say(`装到 ${deckId} 失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [details, mixer, say],
  );

  // Restore what was on the decks before the reload; a pending handover wins.
  useEffect(() => {
    if (restored) return;
    setRestored(true);
    const handover = window.localStorage.getItem(DJ_LOAD_KEY);
    if (handover !== null) {
      window.localStorage.removeItem(DJ_LOAD_KEY);
      const trackId = Number(handover);
      if (Number.isFinite(trackId)) void loadDeck("A", trackId);
      return;
    }
    if (persisted.deckA !== null) void loadDeck("A", persisted.deckA);
    if (persisted.deckB !== null) void loadDeck("B", persisted.deckB);
  }, [restored, persisted.deckA, persisted.deckB, loadDeck]);

  /** Preview toggles: the same track stops, anything else loads and plays. */
  const previewTrack = useCallback(
    async (trackId: number) => {
      try {
        const preview = mixer.deck("preview");
        const current = preview.snapshot();
        const detail = details[trackId] ?? (await tool<TrackDetail>("library", "track_detail", { id: trackId }));
        setDetails((all) => ({ ...all, [trackId]: detail }));
        if (current.path === detail.path && current.state !== "empty") {
          if (current.state === "playing") preview.pause();
          else preview.play();
          return;
        }
        await preview.load(detail.path);
        preview.play();
      } catch (cause) {
        say(`试听失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [details, mixer, say],
  );

  const saveCues = useCallback(
    async (trackId: number, cues: DjCue[]) => {
      try {
        const payload = cues.map((cue) => ({
          position_ms: cue.position_ms,
          name: cue.name ?? undefined,
          color: cue.color ?? undefined,
          kind: cue.kind ?? "cue",
        }));
        const saved = await tool<CueBlock>("library", "cues_set", { track_id: trackId, cues: payload });
        setCueBlocks((current) => ({ ...current, [trackId]: saved }));
        say(null);
        return saved;
      } catch (cause) {
        say(`cue 保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    },
    [say],
  );

  const deckTrackId = useCallback((deckId: "A" | "B"): number | null => deckTracks[deckId], [deckTracks]);

  const addCueAt = useCallback(
    (deckId: "A" | "B") => {
      const trackId = deckTrackId(deckId);
      const block = trackId === null ? undefined : cueBlocks[trackId];
      if (trackId === null || block === undefined) return;
      const at = Math.round(mixer.deck(deckId).positionMs());
      void saveCues(trackId, [...block.cues, { position_ms: at, display_name: "" }]);
    },
    [cueBlocks, deckTrackId, mixer, saveCues],
  );

  const jumpToCue = useCallback(
    (deckId: "A" | "B", cue: DjCue) => {
      mixer.deck(deckId).seekMs(cue.position_ms);
    },
    [mixer],
  );

  const removeCue = useCallback(
    (deckId: "A" | "B", index: number) => {
      const trackId = deckTrackId(deckId);
      const block = trackId === null ? undefined : cueBlocks[trackId];
      if (trackId === null || block === undefined) return;
      const next = block.cues.filter((_, i) => i !== index);
      setEditing(null);
      void saveCues(trackId, next);
    },
    [cueBlocks, deckTrackId, saveCues],
  );

  const renameCue = useCallback(
    (deckId: "A" | "B", index: number, name: string) => {
      const trackId = deckTrackId(deckId);
      const block = trackId === null ? undefined : cueBlocks[trackId];
      if (trackId === null || block === undefined) return;
      const next = block.cues.map((cue, i) => (i === index ? { ...cue, name: name.trim() || null } : cue));
      setEditing(null);
      void saveCues(trackId, next);
    },
    [cueBlocks, deckTrackId, saveCues],
  );

  const recolorCue = useCallback(
    (deckId: "A" | "B", index: number) => {
      const trackId = deckTrackId(deckId);
      const block = trackId === null ? undefined : cueBlocks[trackId];
      if (trackId === null || block === undefined) return;
      const next = block.cues.map((cue, i) => {
        if (i !== index) return cue;
        const used = CUE_COLORS.indexOf(cue.color ?? "");
        return { ...cue, color: CUE_COLORS[(used + 1) % CUE_COLORS.length] };
      });
      void saveCues(trackId, next);
    },
    [cueBlocks, deckTrackId, saveCues],
  );

  return (
    <div className="sr-dj">
      {notice !== null ? <div className="sr-dj-notice" role="alert">{notice}</div> : null}
      <div className="sr-dj-decks">
        <DeckPanel
          deckId="A"
          deck={decks.A}
          cueBlock={deckTrackId("A") !== null ? cueBlocks[deckTrackId("A") as number] : undefined}
          detail={deckTrackId("A") !== null ? details[deckTrackId("A") as number] : undefined}
          positionMs={mixer.deck("A").positionMs()}
          editing={editing?.deckId === "A" ? editing.index : null}
          onPlayPause={() => {
            const deck = mixer.deck("A");
            if (decks.A.state === "playing") deck.pause();
            else deck.play();
          }}
          onSeek={(ms) => mixer.deck("A").seekMs(ms)}
          onVolume={(x) => mixer.deck("A").setVolume(x)}
          onLoadTrack={(trackId) => void loadDeck("A", trackId)}
          onEject={() => {
            mixer.deck("A").unload();
            setDeckTracks((current) => ({ ...current, A: null }));
          }}
          onAddCue={() => addCueAt("A")}
          onJump={(cue) => jumpToCue("A", cue)}
          onEdit={(index) => setEditing({ deckId: "A", index })}
          onRename={(index, name) => renameCue("A", index, name)}
          onRecolor={(index) => recolorCue("A", index)}
          onRemove={(index) => removeCue("A", index)}
          onCancelEdit={() => setEditing(null)}
        />
        <MixerColumn
          crossfade={crossfade}
          master={master}
          onCrossfade={setCrossfade}
          onMaster={setMaster}
        />
        <DeckPanel
          deckId="B"
          deck={decks.B}
          cueBlock={deckTrackId("B") !== null ? cueBlocks[deckTrackId("B") as number] : undefined}
          detail={deckTrackId("B") !== null ? details[deckTrackId("B") as number] : undefined}
          positionMs={mixer.deck("B").positionMs()}
          editing={editing?.deckId === "B" ? editing.index : null}
          onPlayPause={() => {
            const deck = mixer.deck("B");
            if (decks.B.state === "playing") deck.pause();
            else deck.play();
          }}
          onSeek={(ms) => mixer.deck("B").seekMs(ms)}
          onVolume={(x) => mixer.deck("B").setVolume(x)}
          onLoadTrack={(trackId) => void loadDeck("B", trackId)}
          onEject={() => {
            mixer.deck("B").unload();
            setDeckTracks((current) => ({ ...current, B: null }));
          }}
          onAddCue={() => addCueAt("B")}
          onJump={(cue) => jumpToCue("B", cue)}
          onEdit={(index) => setEditing({ deckId: "B", index })}
          onRename={(index, name) => renameCue("B", index, name)}
          onRecolor={(index) => recolorCue("B", index)}
          onRemove={(index) => removeCue("B", index)}
          onCancelEdit={() => setEditing(null)}
        />
      </div>
      <SuggestPanel
        active={deckTracks.A !== null}
        busy={suggestBusy}
        suggestions={suggestions}
        onLoadTrack={(deckId, trackId) => void loadDeck(deckId, trackId)}
      />
      <CrateBar
        crates={crates}
        busy={crateBusy}
        hasA={deckTracks.A !== null}
        hasB={deckTracks.B !== null}
        onSaveDeck={(deckId, name) => void saveDeckToCrate(deckId, name)}
        onExport={(crateId) => void exportCrate(crateId)}
      />
      <LibraryBrowser
        previewing={decks.preview.state !== "empty" ? decks.preview.path : null}
        deckPaths={[decks.A.path, decks.B.path]}
        onPreview={(trackId) => void previewTrack(trackId)}
        onLoadTrack={(deckId, trackId) => void loadDeck(deckId, trackId)}
      />
    </div>
  );
}

function cueBlockOf(detail: TrackDetail): CueBlock {
  return {
    cues: detail.cues ?? [],
    cue_source: detail.cue_source ?? null,
    imported_cue_total: detail.imported_cue_total ?? 0,
    imported_cue_overridden: detail.imported_cue_overridden ?? 0,
  };
}

type DeckPanelProps = {
  deckId: "A" | "B";
  deck: DeckSnapshot;
  cueBlock: CueBlock | undefined;
  detail: TrackDetail | undefined;
  positionMs: number;
  editing: number | null;
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
  onVolume: (x: number) => void;
  onLoadTrack: (trackId: number) => void;
  onEject: () => void;
  onAddCue: () => void;
  onJump: (cue: DjCue) => void;
  onEdit: (index: number) => void;
  onRename: (index: number, name: string) => void;
  onRecolor: (index: number) => void;
  onRemove: (index: number) => void;
  onCancelEdit: () => void;
};

function DeckPanel(props: DeckPanelProps) {
  const { deckId, deck, cueBlock, detail, positionMs, editing } = props;
  const [dragOver, setDragOver] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canTransport = deck.state === "ready" || deck.state === "playing";
  const bpm = detail?.bpm ?? null;

  // Waveform: cached peaks from the library (64 buckets), playhead + cue marks over them.
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
    const peaks = detail?.peaks ?? [];
    if (peaks.length > 0 && deck.durationMs > 0) {
      context.fillStyle = "#5b5f6b";
      const bar = width / peaks.length;
      peaks.forEach((peak, index) => {
        const h = Math.max(2, peak * (height - 12));
        context.fillRect(index * bar + 1, (height - h) / 2, Math.max(1, bar - 2), h);
      });
    }
    if (deck.durationMs > 0) {
      const x = (positionMs / deck.durationMs) * width;
      context.fillStyle = "#7dd3fc";
      context.fillRect(x - 1, 0, 2, height);
      for (const cue of cueBlock?.cues ?? []) {
        const cx = (cue.position_ms / deck.durationMs) * width;
        context.fillStyle = cue.color ?? "#e2e8f0";
        context.fillRect(cx - 1, 0, 3, 8);
      }
    }
  }, [detail, positionMs, deck.durationMs, cueBlock]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const raw = event.dataTransfer.getData("application/x-shadowroom-track");
    const id = Number(raw);
    if (raw !== "" && Number.isFinite(id)) props.onLoadTrack(id);
  };

  const nudge = (beats: number) => {
    const step = bpm !== null && bpm > 0 ? (60_000 / bpm) * beats : 5_000 * Math.sign(beats);
    props.onSeek(positionMs + step);
  };

  return (
    <section
      className="sr-dj-deck"
      data-deck={deckId}
      data-state={deck.state}
      data-dragover={dragOver || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <header className="sr-dj-deck-head">
        <span className="sr-dj-deck-letter">{deckId}</span>
        <span className="sr-dj-deck-title" title={deck.path ?? undefined}>
          {detail !== undefined ? (detail.title ?? detail.path.split("/").pop()) : deck.state === "loading" ? "载入中…" : "空 · 拖一首进来"}
        </span>
        {detail?.bpm !== undefined && detail.bpm !== null ? (
          <span className="sr-chip">{Number(detail.bpm.toFixed(1))} BPM</span>
        ) : null}
        {detail?.camelot ? <span className="sr-chip">{detail.camelot}</span> : null}
        <button type="button" className="sr-page-action" onClick={props.onEject} disabled={deck.state === "empty"}>
          卸
        </button>
      </header>
      <canvas
        ref={canvasRef}
        className="sr-dj-wave"
        width={560}
        height={64}
        onClick={(event) => {
          if (deck.durationMs <= 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - rect.left) / rect.width;
          props.onSeek(fraction * deck.durationMs);
        }}
      />
      <div className="sr-dj-cues">
        {(cueBlock?.cues ?? []).map((cue, index) =>
          editing === index ? (
            <CueEditor
              key={cue.position_ms}
              cue={cue}
              onRename={(name) => props.onRename(index, name)}
              onRecolor={() => props.onRecolor(index)}
              onRemove={() => props.onRemove(index)}
              onCancel={props.onCancelEdit}
            />
          ) : (
            <button
              key={`${cue.position_ms}-${cue.display_name}`}
              type="button"
              className="sr-dj-cue"
              title={`${cue.display_name} · ${mmss(cue.position_ms / 1000)} · 点击跳转，✎ 改名`}
              onClick={() => props.onJump(cue)}
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
                  props.onEdit(index);
                }}
              >
                ✎
              </span>
            </button>
          ),
        )}
        <button type="button" className="sr-dj-cue-add" onClick={props.onAddCue} disabled={!canTransport}>
          ＋ 打点
        </button>
        {cueBlock !== undefined && cueBlock.imported_cue_overridden > 0 ? (
          <span className="sr-dj-cue-note">已覆盖 {cueBlock.imported_cue_overridden} 条导入 cue</span>
        ) : null}
      </div>
      <div className="sr-dj-transport">
        <button
          type="button"
          className="sr-icon-btn"
          aria-label={deck.state === "playing" ? `暂停 deck ${deckId}` : `播放 deck ${deckId}`}
          aria-pressed={deck.state === "playing"}
          disabled={!canTransport}
          onClick={props.onPlayPause}
        >
          {deck.state === "playing" ? <IconPause /> : <IconPlay />}
        </button>
        <span className="sr-dj-clock">{mmss(positionMs / 1000)}</span>
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
          aria-label={`deck ${deckId} 音量`}
          onChange={(event) => props.onVolume(Number(event.target.value))}
        />
      </div>
      {deck.state === "loading" ? <p className="sr-dj-loading">解码中…</p> : null}
    </section>
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

function MixerColumn(props: {
  crossfade: number;
  master: number;
  onCrossfade: (x: number) => void;
  onMaster: (x: number) => void;
}) {
  return (
    <section className="sr-dj-mixer" aria-label="混音台">
      <span className="sr-dj-mixer-label">交叉淡入</span>
      <div className="sr-dj-xrow">
        <span>A</span>
        <input
          className="sr-dj-xfade"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={props.crossfade}
          aria-label="交叉淡入"
          onChange={(event) => props.onCrossfade(Number(event.target.value))}
        />
        <span>B</span>
      </div>
      <span className="sr-dj-mixer-label">主音量</span>
      <input
        className="sr-dj-master"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={props.master}
        aria-label="主音量"
        onChange={(event) => props.onMaster(Number(event.target.value))}
      />
    </section>
  );
}

function SuggestPanel(props: {
  active: boolean;
  busy: boolean;
  suggestions: Suggestion[];
  onLoadTrack: (deckId: "A" | "B", trackId: number) => void;
}) {
  const { active, busy, suggestions } = props;
  return (
    <section className="sr-dj-suggest" aria-label="下一首建议">
      <div className="sr-dj-suggest-head">
        <span className="sr-dj-mixer-label">下一首</span>
        {busy ? <span className="sr-dj-count">计算中…</span> : null}
        {!active ? <span className="sr-dj-count">先在 A 装一首歌</span> : null}
      </div>
      <div className="sr-dj-suggest-rows">
        {active && !busy && suggestions.length === 0 ? (
          <p className="sr-dj-empty">库里没有可推荐的曲目</p>
        ) : null}
        {suggestions.map((item) => {
          const trackId = Number(item.id);
          return (
            <div
              key={item.id}
              className="sr-dj-row"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-shadowroom-track", item.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
            >
              <span className="sr-dj-row-title">{item.title}</span>
              <span className="sr-dj-row-artist">{item.artist ?? ""}</span>
              {item.bpm !== null ? <span className="sr-chip">{Number(item.bpm.toFixed(1))} BPM</span> : null}
              {item.key ? <span className="sr-chip">{item.key}</span> : null}
              <span className="sr-dj-score">{(item.score * 100).toFixed(0)}</span>
              <button type="button" className="sr-page-action" onClick={() => props.onLoadTrack("A", trackId)}>
                装到 A
              </button>
              <button type="button" className="sr-page-action" onClick={() => props.onLoadTrack("B", trackId)}>
                装到 B
              </button>
              <div className="sr-dj-reasons">
                {(item.reasons ?? []).map((reason, index) => (
                  <span key={index} className="sr-dj-reason">{reason}</span>
                ))}
                {(item.cautions ?? []).map((caution, index) => (
                  <span key={`c${index}`} className="sr-dj-caution">{caution}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CrateBar(props: {
  crates: CrateInfo[];
  busy: boolean;
  hasA: boolean;
  hasB: boolean;
  onSaveDeck: (deckId: "A" | "B", name: string) => void;
  onExport: (crateId: number) => void;
}) {
  const { crates, busy, hasA, hasB } = props;
  const [name, setName] = useState("");
  const [deckId, setDeckId] = useState<"A" | "B">("A");
  return (
    <section className="sr-dj-crates" aria-label="crate">
      <div className="sr-dj-crate-save">
        <select
          className="sr-input sr-input--num"
          value={deckId}
          aria-label="存哪一台"
          onChange={(event) => setDeckId(event.target.value === "B" ? "B" : "A")}
        >
          <option value="A" disabled={!hasA}>deck A</option>
          <option value="B" disabled={!hasB}>deck B</option>
        </select>
        <input
          className="sr-input"
          placeholder="crate 名"
          value={name}
          aria-label="crate 名"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onSaveDeck(deckId, name);
          }}
        />
        <button
          type="button"
          className="sr-page-action"
          disabled={busy || name.trim() === "" || !(deckId === "A" ? hasA : hasB)}
          onClick={() => props.onSaveDeck(deckId, name)}
        >
          存入
        </button>
      </div>
      <div className="sr-dj-crate-list">
        {crates.map((crate) => (
          <span key={crate.id} className="sr-dj-crate-item">
            <span className="sr-dj-crate-name">{crate.name}</span>
            <span className="sr-dj-count">{crate.tracks}</span>
            <button
              type="button"
              className="sr-page-action"
              disabled={busy || crate.tracks === 0}
              onClick={() => props.onExport(crate.id)}
            >
              导出 m3u
            </button>
          </span>
        ))}
        {crates.length === 0 ? <span className="sr-dj-count">还没有 crate</span> : null}
      </div>
    </section>
  );
}

type LibraryBrowserProps = {
  previewing: string | null;
  deckPaths: Array<string | null>;
  onPreview: (trackId: number) => void;
  onLoadTrack: (deckId: "A" | "B", trackId: number) => void;
};

function LibraryBrowser(props: LibraryBrowserProps) {
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

  const dragStart = (event: DragEvent<HTMLDivElement>, trackId: number) => {
    event.dataTransfer.setData("application/x-shadowroom-track", String(trackId));
    event.dataTransfer.effectAllowed = "copy";
  };

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
          const loadedDeck = props.deckPaths.indexOf(track.path);
          return (
            <div
              key={track.id}
              className="sr-dj-row"
              data-loaded={loadedDeck >= 0 ? (["A", "B"] as const)[loadedDeck] : undefined}
              draggable
              onDragStart={(event) => dragStart(event, track.id)}
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
              <button type="button" className="sr-page-action" onClick={() => props.onLoadTrack("A", track.id)}>
                装到 A
              </button>
              <button type="button" className="sr-page-action" onClick={() => props.onLoadTrack("B", track.id)}>
                装到 B
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
