/**
 * Set workbench: build an ordered set against the library, one player for auditioning and cue work.
 *
 * Layout: TopBar (set name / track count / actions) · left = library with the three pinned
 * suggestions over it · middle = the SetBoard (drag in, drag to order) · bottom = the single
 * player (`lib/dj-deck.ts`). Timing, AI ordering and exporting are S3/S5 — this file holds the
 * shape they will land in. Draft state (name + track ids) is the only thing persisted, under
 * `shadowroom.setdraft`; the truth about cues stays in library.db.
 *
 * No bottom input bar: typing lives in the orb and the conversation dock.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { DragEvent } from "react";
import { IconPause, IconPlay } from "./icons";
import { callTool } from "../lib/mcp";
import { Player, type DeckSnapshot } from "../lib/dj-deck";
import { formatPlanDuration, plannerTrackPayload } from "../lib/dj-plan";
import { zhBpmSource, zhCueNote, zhCueReason } from "../lib/dj-cue-zh";

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
  end_ms?: number | null;
  kind?: string;
  color?: string | null;
  name?: string | null;
  role?: string | null;
  slot?: number | null;
  display_name: string;
};

type CueBlock = {
  cues: DjCue[];
  cue_source: string | null;
  imported_cue_total: number;
  imported_cue_overridden: number;
};

type TrackDetail = LibraryTrack & CueBlock & { peaks: number[]; genre?: string | null };

type SuggestionRow = {
  id: number;
  title: string;
  artist: string;
  bpm: number | null;
  key: string | null;
  score: number;
  reasons: string[];
};

type Draft = {
  name: string;
  trackIds: number[];
  overlapMs: number;
};

type PlanRow = {
  id: string;
  play_start: string;
  play_end: string;
  warnings: string[];
};

type PlanResult = {
  summary: {
    total_duration_ms: number;
    sum_of_segments_ms: number;
    overlap_saved_ms: number;
    warning_count: number;
  };
  timeline: PlanRow[];
  warnings: string[];
};

type OrderResult = {
  ordered_ids: string[];
  set_score: number;
  greedy_score: number;
  two_opt_gain: number;
  two_opt_moves: number;
  elapsed_ms: number;
};

/** analysis.suggest_cues — computed only; nothing lands until the user confirms and cues_set writes. */
type AiCueCandidate = {
  position_ms: number;
  end_ms?: number;
  role: "in" | "out" | "loop";
  confidence: number;
  reason: string;
};

type AiCueResult = {
  duration_ms: number;
  bpm: { value: number; source: string };
  candidates: AiCueCandidate[];
  notes: string[];
  warnings: string[];
};

/** library.set_list row — an imported Rekordbox XML playlist or history set. */
type SetSummary = {
  id: number;
  source: string;
  name: string;
  played_at: number;
  track_count: number;
};

/** library.set_detail — tracks in played order; track_id is null when the import matched nothing. */
type SetDetail = {
  id: number;
  source: string;
  name: string;
  tracks: Array<{ position: number; track_id: number | null; title: string | null }>;
};

const DRAG_TRACK = "application/x-shadowroom-track";
const DRAG_ROW = "application/x-shadowroom-setrow";
const DRAFT_KEY = "shadowroom.setdraft";
const DEFAULT_OVERLAP_MS = 16_000;
const CUE_COLORS = ["#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#6366f1"];

function mmss(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * D5（2026-09-25 巡检）：planner 的 reasons 是英文句子，界面是中文——逐句翻成中文；
 * 行业词保持原文（BPM / camelot / 风格名如 kick、vocal、clap）。没认出来的句式原样放行，
 * 宁可露一句英文也不许把意思翻错。句式全集来自 set-planner 的 recommend.py 与 keys.py。
 */
function zhReason(reason: string): string {
  const text = reason.trim();
  if (text === "bpm unknown; verify by ear") return "BPM 未知，请靠耳朵确认";
  const bpm = text.match(/^(tempo match|double-time match|half-time match): (.+) → (.+) bpm \(([\d.]+)% apart\)$/);
  if (bpm !== null) {
    const label = { "tempo match": "BPM 匹配", "double-time match": "倍速匹配", "half-time match": "半速匹配" }[bpm[1]];
    return `${label}：${bpm[2]} → ${bpm[3]} BPM（差 ${bpm[4]}%）`;
  }
  if (text === "genres unknown; judge this one by ear") return "风格未知，请靠耳朵判断";
  const shared = text.match(/^shared genres: (.+)$/);
  if (shared !== null) return `共同风格：${shared[1]}`;
  if (text === "no shared genre tag") return "无共同风格标签";
  if (text === "energy unknown; judge this one by ear") return "能量未知，请靠耳朵判断";
  const energy = text.match(/^(steady energy|energy lift [+\d.]+|energy drop [-\d.]+) \((.+) → (.+)\)$/);
  if (energy !== null) {
    // F-4（ui-review）：能量浮点对用户无意义（0.814868→0.978326 是天书）——关系词留下，数值括号删。
    if (energy[1].startsWith("steady")) return "能量持平";
    return energy[1].startsWith("energy lift") ? "能量提升" : "能量回落";
  }
  const keyUnknown = text.match(/^key unknown \((source|target)\); beatmatch by ear or tag it first$/);
  if (keyUnknown !== null) return `调性未知（${keyUnknown[1] === "source" ? "当前曲" : "候选曲"}）：靠耳朵对拍或先打标`;
  const camelot = text.match(/^camelot (\S+) → (\S+) \((same|adjacent|energy boost|relative|two step|distant)\)$/);
  if (camelot !== null) {
    const relation = { same: "同调", adjacent: "相邻", "energy boost": "能量推进", relative: "关系调", "two step": "两步", distant: "远调" }[camelot[3]];
    return `camelot ${camelot[1]} → ${camelot[2]}（${relation}）`;
  }
  return text;
}

/**
 * D7（2026-09-25 巡检）：顶栏 ⚠ 徽标的出处是 plan_set 的 warnings（英文）——点开说明条时逐句
 * 翻成中文（句式全集来自 set-planner 的 timing.py 与 keys.py），没认出的原样放行。
 */
function zhWarning(warning: string): string {
  const text = warning.trim();
  if (text === "no A cue; the segment starts at the beginning of the file") return "没有 A cue，段从文件开头算起";
  if (text === "no B cue; the segment runs to the end of the track") return "没有 B cue，段一直放到曲末";
  if (text === "no B cue and no duration; this track cannot be timed") return "没有 B cue 也没有时长，无法计时";
  let m = text.match(/^cue A at (\d+) ms is past the track end \((\d+) ms\); using the track start$/);
  if (m !== null) return `cue A（${m[1]} ms）超出曲末（${m[2]} ms），改用曲头`;
  m = text.match(/^cue B at (\d+) ms is past the track end \((\d+) ms\); clamping to (\d+) ms$/);
  if (m !== null) return `cue B（${m[1]} ms）超出曲末（${m[2]} ms），截到 ${m[3]} ms`;
  m = text.match(/^cue A at (\d+) ms is negative; using 0 ms$/);
  if (m !== null) return `cue A（${m[1]} ms）是负数，改用 0 ms`;
  m = text.match(/^cue B \((\d+) ms\) is not after cue A \((\d+) ms\); falling back to the whole track$/);
  if (m !== null) return `cue B（${m[1]} ms）不在 cue A（${m[2]} ms）之后，改用整首`;
  m = text.match(/^segment is ([\d.]+) bars \(([\d.]+) bpm\); trimming it to a whole bar keeps phrasing clean$/);
  if (m !== null) return `段长 ${m[1]} 小节（${m[2]} BPM），裁成整小节保持乐句完整`;
  m = text.match(/^overlap (\d+) ms is longer than the shorter segment; clamped to (\d+) ms$/);
  if (m !== null) return `重叠 ${m[1]} ms 比短段还长，截到 ${m[2]} ms`;
  m = text.match(/^tempo changes ([\d.]+) → ([\d.]+) bpm \(([+\-][\d.]+)%\); plan a pitch or tempo-sync transition$/);
  if (m !== null) return `BPM 变化 ${m[1]} → ${m[2]}（${m[3]}%），建议走 pitch 或 tempo sync 过渡`;
  m = text.match(/^camelot (\S+) → (\S+) \(distant\); mix through a break or shift the pitch$/);
  if (m !== null) return `camelot ${m[1]} → ${m[2]}（远调），建议走 break 过渡或移 pitch`;
  m = text.match(/^key unknown \((source|target)\); beatmatch by ear or tag it first; mix through a break or shift the pitch$/);
  if (m !== null) return `调性未知（${m[1] === "source" ? "当前曲" : "候选曲"}），靠耳朵对拍或先打标，走 break 过渡或移 pitch`;
  return text;
}

/** Parse the bridge's text result; the caller decides what a failure means for the user. */
async function tool<T>(server: string, name: string, args: unknown): Promise<T> {
  const raw = await callTool<string>(server, name, args);
  return JSON.parse(String(raw)) as T;
}

function readDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Draft>;
      return {
        name: typeof parsed.name === "string" ? parsed.name : "未命名 set",
        trackIds: Array.isArray(parsed.trackIds) ? parsed.trackIds.filter((id) => typeof id === "number") : [],
        overlapMs:
          typeof parsed.overlapMs === "number" && Number.isFinite(parsed.overlapMs) && parsed.overlapMs >= 0
            ? parsed.overlapMs
            : DEFAULT_OVERLAP_MS,
      };
    }
  } catch {
    // corrupted draft = empty draft; the page must always come up
  }
  return { name: "未命名 set", trackIds: [], overlapMs: DEFAULT_OVERLAP_MS };
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

  const [draft, setDraft] = useState<Draft>(readDraft);
  const [details, setDetails] = useState<Record<number, TrackDetail>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [orderBusy, setOrderBusy] = useState(false);
  const [undoOrder, setUndoOrder] = useState<number[] | null>(null);
  const [aiCue, setAiCue] = useState<{ trackId: number; result: AiCueResult } | null>(null);
  const [aiCueBusy, setAiCueBusy] = useState(false);
  const [setChoices, setSetChoices] = useState<SetSummary[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  /** D7：⚠ 徽标的说明条可点开；出处是 plan_set 的 warnings。 */
  const [warningsOpen, setWarningsOpen] = useState(false);

  const say = useCallback((text: string | null) => setNotice(text), []);

  // One re-render every 125ms while something plays, so position readouts follow the audio clock.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (deck.state !== "playing") return;
    const timer = window.setInterval(bump, 125);
    return () => window.clearInterval(timer);
  }, [deck.state]);

  // Draft is the only persisted thing on this page.
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // storage may be full or blocked; the set keeps working in memory
    }
  }, [draft]);

  /** One detail per track, shared by the board, the player strip and the cue editor. */
  const ensureDetail = useCallback(
    async (id: number): Promise<TrackDetail> => {
      const cached = details[id];
      if (cached !== undefined) return cached;
      const next = await tool<TrackDetail>("library", "track_detail", { id });
      setDetails((current) => ({ ...current, [id]: next }));
      return next;
    },
    [details],
  );

  // Backfill details for anything the draft references (restore path and drag-in path share this).
  useEffect(() => {
    const missing = draft.trackIds.filter((id) => details[id] === undefined);
    for (const id of missing) {
      void tool<TrackDetail>("library", "track_detail", { id })
        .then((next) => setDetails((current) => ({ ...current, [id]: next })))
        .catch(() => {}); // a missing track shows as its id; the board flags it
    }
  }, [draft.trackIds, details]);

  /** Load a track onto the single player and make it the selected one. */
  const openTrack = useCallback(
    async (id: number) => {
      try {
        const next = await ensureDetail(id);
        await player.deck.load(next.path);
        setSelectedId(id);
        setEditing(null);
        setAiCue(null);
        say(null);
      } catch (cause) {
        say(`载入失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [ensureDetail, player, say],
  );

  const addToSet = useCallback(
    (id: number) => {
      setUndoOrder(null);
      setDraft((current) =>
        current.trackIds.includes(id) ? current : { ...current, trackIds: [...current.trackIds, id] },
      );
    },
    [],
  );

  const insertIntoSet = useCallback((id: number, at: number) => {
    setUndoOrder(null);
    setDraft((current) => {
      const next = current.trackIds.filter((existing) => existing !== id);
      const clamped = Math.min(at, next.length);
      return { ...current, trackIds: [...next.slice(0, clamped), id, ...next.slice(clamped)] };
    });
  }, []);

  const moveRow = useCallback((from: number, to: number) => {
    setUndoOrder(null);
    setDraft((current) => {
      const ids = [...current.trackIds];
      const [moved] = ids.splice(from, 1);
      ids.splice(Math.min(to, ids.length), 0, moved);
      return { ...current, trackIds: ids };
    });
  }, []);

  const removeFromSet = useCallback((id: number) => {
    setUndoOrder(null);
    setDraft((current) => ({ ...current, trackIds: current.trackIds.filter((existing) => existing !== id) }));
  }, []);

  const newSet = useCallback(() => {
    setUndoOrder(null);
    setDraft({ name: "未命名 set", trackIds: [], overlapMs: DEFAULT_OVERLAP_MS });
    setSuggestions([]);
    say(null);
  }, [say]);

  // ------------------------------------------------ import an existing set / export the draft as m3u
  /** Toggle the picker; the list is fetched fresh every time it opens. */
  const openImport = useCallback(async () => {
    if (setChoices !== null) {
      setSetChoices(null);
      return;
    }
    setImportBusy(true);
    try {
      const result = await tool<{ sets: SetSummary[] }>("library", "set_list", {});
      setSetChoices(result.sets);
    } catch (cause) {
      say(`读取 set 列表失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setImportBusy(false);
    }
  }, [setChoices, say]);

  /** set_detail's order is the set's order; rows the import never matched (track_id null) are skipped, named in the notice. */
  const importSet = useCallback(
    async (setId: number) => {
      setImportBusy(true);
      try {
        const detail = await tool<SetDetail>("library", "set_detail", { id: setId });
        const matched = detail.tracks.filter((t) => t.track_id !== null).map((t) => t.track_id as number);
        const skipped = detail.tracks.length - matched.length;
        setUndoOrder(null);
        setEditing(null);
        setAiCue(null);
        setDraft({ name: detail.name, trackIds: matched, overlapMs: DEFAULT_OVERLAP_MS });
        setSetChoices(null);
        say(
          skipped > 0
            ? `已导入「${detail.name}」：${matched.length} 首；${skipped} 条在库内匹配不上（跳过）`
            : `已导入「${detail.name}」：${matched.length} 首`,
        );
      } catch (cause) {
        say(`导入 set 失败：${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        setImportBusy(false);
      }
    },
    [say],
  );

  /** Our set lands in a crate first (crate = library's structure), then crate_export_m3u writes the file. */
  const exportM3u = useCallback(async () => {
    if (draft.trackIds.length === 0) return;
    setExportBusy(true);
    try {
      const crate = await tool<{ id: number; created: boolean }>("library", "crate_create", { name: draft.name });
      const added = await tool<{ added: number; skipped: number }>("library", "crate_add", {
        crate_id: crate.id,
        track_ids: draft.trackIds,
      });
      const out = await tool<{ path: string; tracks: number; missing_files: string[] }>("library", "crate_export_m3u", {
        crate_id: crate.id,
      });
      say(
        `已导出 ${out.tracks} 首 → ${out.path}` +
          (added.skipped > 0 ? `（同名 crate 已有 ${added.skipped} 首，未重复添加）` : "") +
          (out.missing_files.length > 0 ? `（${out.missing_files.length} 个文件当前缺失，仍写入）` : ""),
      );
    } catch (cause) {
      say(`导出 m3u 失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExportBusy(false);
    }
  }, [draft.name, draft.trackIds, say]);

  // ------------------------------------------------ suggestions: last track + whole-set blend
  useEffect(() => {
    const ids = draft.trackIds;
    if (ids.length === 0) {
      setSuggestions([]);
      return;
    }
    const lastId = ids[ids.length - 1];
    const last = details[lastId];
    if (last === undefined) return; // details backfill will re-trigger this effect
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSuggestBusy(true);
      try {
        const pool = await tool<{ tracks: LibraryTrack[] }>("library", "list_tracks", { limit: 200 });
        const poolPayload = (pool.tracks ?? []).map((t) => ({
          id: String(t.id),
          title: t.title ?? "",
          artist: t.artist ?? "",
          bpm: t.bpm,
          key: t.camelot ?? t.key,
          genres: [],
          energy: t.energy,
          duration_ms: t.duration_ms,
        }));
        const exclude = ids.map(String);
        const setTracks = ids.map((id) => details[id]).filter((d): d is TrackDetail => d !== undefined);
        const mean = (values: number[]): number | null =>
          values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
        const wholeCurrent = {
          id: "set",
          title: draft.name,
          bpm: mean(setTracks.map((t) => t.bpm).filter((v): v is number => v !== null)),
          key: null,
          genres: [...new Set(setTracks.map((t) => t.genre).filter((g): g is string => !!g))],
          energy: mean(setTracks.map((t) => t.energy).filter((v): v is number => v !== null)),
        };
        const [lastRes, wholeRes] = await Promise.all([
          tool<{ suggestions: Array<{ id: string; title: string; artist?: string; bpm: number | null; key: string | null; score: number; reasons: string[] }> }>(
            "planner",
            "suggest_next",
            {
              current: {
                id: String(last.id),
                title: last.title ?? "",
                artist: last.artist ?? "",
                bpm: last.bpm,
                key: last.camelot ?? last.key,
                genres: last.genre ? [last.genre] : [],
                energy: last.energy,
              },
              pool: poolPayload,
              limit: 5,
              exclude_ids: exclude,
            },
          ),
          tool<{ suggestions: Array<{ id: string; score: number; reasons: string[] }> }>(
            "planner",
            "suggest_next",
            { current: wholeCurrent, pool: poolPayload, limit: 5, exclude_ids: exclude },
          ),
        ]);
        if (cancelled) return;
        const wholeScore = new Map(wholeRes.suggestions.map((s) => [s.id, s.score]));
        const wholeReason = new Map(wholeRes.suggestions.map((s) => [s.id, s.reasons[0] ?? ""]));
        const rows: SuggestionRow[] = lastRes.suggestions.map((s) => {
          const whole = wholeScore.get(s.id);
          const score = whole === undefined ? s.score : (0.6 * s.score + 0.4 * whole) / 1.0;
          const reasons = [...s.reasons.map((r) => `末首：${zhReason(r)}`)];
          const wr = wholeReason.get(s.id);
          if (whole !== undefined && wr !== undefined && wr !== "") reasons.push(`整场：${zhReason(wr)}`);
          return {
            id: Number(s.id),
            title: s.title,
            artist: s.artist ?? "",
            bpm: s.bpm,
            key: s.key,
            score,
            reasons,
          };
        });
        rows.sort((a, b) => b.score - a.score);
        setSuggestions(rows.slice(0, 3));
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
  }, [draft.trackIds, draft.name, details, say]);

  // ------------------------------------------------ timing: plan_set drives the topbar readouts
  useEffect(() => {
    const ids = draft.trackIds;
    if (ids.length === 0) {
      setPlan(null);
      return;
    }
    if (ids.some((id) => details[id] === undefined)) return; // the backfill re-triggers this effect
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await tool<PlanResult>("planner", "plan_set", {
          set: { tracks: ids.map((id) => plannerTrackPayload(details[id])) },
          default_overlap_ms: Math.round(draft.overlapMs),
        });
        if (!cancelled) setPlan(result);
      } catch (cause) {
        if (!cancelled) {
          setPlan(null);
          say(`计时失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft.trackIds, draft.overlapMs, details, say]);

  /** planner.order_set re-orders the whole draft; the previous order stays one undo deep. */
  const applyAiOrder = useCallback(async () => {
    const ids = draft.trackIds;
    if (ids.length < 2 || ids.some((id) => details[id] === undefined)) return;
    setOrderBusy(true);
    try {
      const result = await tool<OrderResult>("planner", "order_set", {
        set: { tracks: ids.map((id) => plannerTrackPayload(details[id])) },
      });
      const ordered = result.ordered_ids.map(Number);
      if (ordered.length !== ids.length || ids.some((id) => !ordered.includes(id))) {
        throw new Error("插件返回的曲目集合与草稿不一致");
      }
      setUndoOrder(ids);
      setDraft((current) => ({ ...current, trackIds: ordered }));
      say(`AI 排序：2-opt ${result.two_opt_moves} 步 · ${Math.round(result.elapsed_ms)}ms · 总分 ${result.set_score}`);
    } catch (cause) {
      say(`AI 排序失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setOrderBusy(false);
    }
  }, [draft.trackIds, details, say]);

  const undoAiOrder = useCallback(() => {
    setUndoOrder((previous) => {
      if (previous !== null) setDraft((current) => ({ ...current, trackIds: previous }));
      return null;
    });
  }, []);

  // ------------------------------------------------ cue editing on the selected track
  const selectedDetail = selectedId !== null ? details[selectedId] : undefined;
  const cueBlock: CueBlock | null =
    selectedDetail !== undefined
      ? {
          cues: selectedDetail.cues ?? [],
          cue_source: selectedDetail.cue_source ?? null,
          imported_cue_total: selectedDetail.imported_cue_total ?? 0,
          imported_cue_overridden: selectedDetail.imported_cue_overridden ?? 0,
        }
      : null;

  const saveCues = useCallback(
    async (cues: DjCue[]) => {
      if (selectedId === null) return;
      try {
        const payload = cues.map((cue) => ({
          position_ms: cue.position_ms,
          end_ms: cue.end_ms ?? undefined,
          name: cue.name ?? undefined,
          color: cue.color ?? undefined,
          kind: cue.kind ?? "cue",
          role: cue.role ?? undefined,
          slot: cue.slot ?? undefined,
        }));
        const saved = await tool<CueBlock & { cues: DjCue[] }>("library", "cues_set", {
          track_id: selectedId,
          cues: payload,
        });
        // Write back through the shared detail cache so the board badges stay truthful.
        setDetails((current) => {
          const existing = current[selectedId];
          if (existing === undefined) return current;
          return {
            ...current,
            [selectedId]: {
              ...existing,
              cues: saved.cues,
              cue_source: saved.cue_source,
              imported_cue_total: saved.imported_cue_total,
              imported_cue_overridden: saved.imported_cue_overridden,
            },
          };
        });
        say(null);
      } catch (cause) {
        say(`cue 保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [selectedId, say],
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

  /** analysis.suggest_cues only computes; the preview card is the user gate before cues_set writes. */
  const requestAiCues = useCallback(async () => {
    if (selectedId === null || selectedDetail === undefined) return;
    setAiCueBusy(true);
    try {
      const result = await tool<AiCueResult>("analysis", "suggest_cues", {
        path: selectedDetail.path,
        ...(selectedDetail.bpm !== null ? { bpm: selectedDetail.bpm } : {}),
      });
      setAiCue({ trackId: selectedId, result });
      say(null);
    } catch (cause) {
      say(`AI 设 cue 失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setAiCueBusy(false);
    }
  }, [selectedId, selectedDetail, say]);

  /** Merge the preview into the cue set: same role is replaced, slots take the lowest free 0-7. */
  const applyAiCues = useCallback(() => {
    if (aiCue === null || cueBlock === null) return;
    let cues = [...cueBlock.cues];
    for (const cand of aiCue.result.candidates) {
      const replaced = cues.find((cue) => cue.role === cand.role);
      const rest = cues.filter((cue) => cue.role !== cand.role);
      const usedSlots = new Set(rest.map((cue) => cue.slot).filter((s): s is number => typeof s === "number"));
      const usedColors = new Set(rest.map((cue) => cue.color).filter((c): c is string => typeof c === "string"));
      let slot = replaced?.slot ?? null;
      if (slot === null) {
        slot = [0, 1, 2, 3, 4, 5, 6, 7].find((s) => !usedSlots.has(s)) ?? null;
      }
      cues = [
        ...rest,
        {
          position_ms: Math.round(cand.position_ms),
          end_ms: cand.end_ms !== undefined ? Math.round(cand.end_ms) : null,
          kind: cand.role === "loop" ? "loop" : "cue",
          role: cand.role,
          slot,
          color: replaced?.color ?? CUE_COLORS.find((c) => !usedColors.has(c)) ?? null,
          name: cand.role === "in" ? "AI 进" : cand.role === "out" ? "AI 出" : "AI loop",
          display_name: "",
        },
      ];
    }
    setAiCue(null);
    void saveCues(cues);
  }, [aiCue, cueBlock, saveCues]);

  const bpm = selectedDetail?.bpm ?? null;
  const canTransport = deck.state === "ready" || deck.state === "playing";
  const nudge = (beats: number) => {
    const step = bpm !== null && bpm > 0 ? (60_000 / bpm) * beats : 5_000 * Math.sign(beats);
    player.deck.seekMs(player.deck.positionMs() + step);
  };

  // The plan's per-track rows, keyed by track id for the SetBoard.
  const planRows = new Map<string, PlanRow>((plan?.timeline ?? []).map((row) => [row.id, row]));

  return (
    <div className="sr-dj">
      <div className="sr-dj-topbar">
        <input
          className="sr-input"
          value={draft.name}
          aria-label="set 名"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
        <span className="sr-dj-count">{draft.trackIds.length} 首</span>
        {draft.trackIds.length === 0 ? (
          // D6（2026-09-25 巡检）：空 set 时 16 秒的读数像是"已经有重叠"——空场显示 0 秒，
          // 草稿里的默认值保留，加歌后自动恢复。
          <span className="sr-dj-overlap" title="加入曲目后按下面的默认值生效">
            overlap <span className="sr-input sr-input--num sr-input--static">0</span> 秒
          </span>
        ) : (
          <label className="sr-dj-overlap" title="相邻两首的默认重叠时长（v1 全局一个值，逐首覆盖留后）">
            overlap
            <input
              className="sr-input sr-input--num"
              type="number"
              min={0}
              max={120}
              step={1}
              value={Math.round(draft.overlapMs / 1000)}
              aria-label="默认 overlap（秒）"
              onChange={(event) => {
                const seconds = Number(event.target.value);
                if (Number.isFinite(seconds) && seconds >= 0) {
                  setDraft((current) => ({ ...current, overlapMs: Math.round(seconds * 1000) }));
                }
              }}
            />
            秒
          </label>
        )}
        {plan !== null ? (
          <span className="sr-dj-timing">
            段 {formatPlanDuration(plan.summary.sum_of_segments_ms)} · 省 {formatPlanDuration(plan.summary.overlap_saved_ms)} · 总{" "}
            {formatPlanDuration(plan.summary.total_duration_ms)}
          </span>
        ) : null}
        {plan !== null && plan.summary.warning_count > 0 ? (
          <button
            type="button"
            className="sr-dj-badge sr-dj-warn-toggle"
            aria-expanded={warningsOpen}
            title="plan_set 的警告——点开看原文"
            onClick={() => setWarningsOpen((open) => !open)}
          >
            ⚠ {plan.summary.warning_count}
          </button>
        ) : null}
        <button
          type="button"
          className="sr-page-action"
          disabled={orderBusy || draft.trackIds.length < 2}
          title="planner.order_set：贪心链 + 2-opt 重排整个 set"
          onClick={() => void applyAiOrder()}
        >
          {orderBusy ? "排序中…" : "AI 排序"}
        </button>
        {undoOrder !== null ? (
          <button type="button" className="sr-page-action" onClick={undoAiOrder}>
            撤销排序
          </button>
        ) : null}
        <button type="button" className="sr-page-action" onClick={newSet}>
          新建 set
        </button>
        <button
          type="button"
          className="sr-page-action"
          aria-expanded={setChoices !== null}
          disabled={importBusy}
          title="library.set_list / set_detail：把导入的 Rekordbox XML 歌单或历史 set 落进看板"
          onClick={() => void openImport()}
        >
          {importBusy && setChoices === null ? "读取中…" : "导入 set"}
        </button>
        <button
          type="button"
          className="sr-page-action"
          disabled={exportBusy || draft.trackIds.length === 0}
          title="先落 crate（library.crate_create/crate_add），再 crate_export_m3u 写到 exports/"
          onClick={() => void exportM3u()}
        >
          {exportBusy ? "导出中…" : "导出 m3u"}
        </button>
      </div>
      {plan !== null && warningsOpen && plan.warnings.length > 0 ? (
        <div className="sr-dj-warnings" role="note">
          <span className="sr-dj-warnings-title">plan_set 警告（{plan.warnings.length}）——出处：planner.plan_set 的时间轴计算</span>
          <ul>
            {plan.warnings.map((warning, index) => (
              <li key={index}>{zhWarning(warning)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {setChoices !== null ? (
        <div className="sr-dj-import">
          {setChoices.length === 0 ? (
            <p className="sr-dj-empty">库里还没有导入的 set —— 用 library 插件先导 Rekordbox XML 或历史。</p>
          ) : (
            setChoices.map((set) => (
              <button
                key={set.id}
                type="button"
                className="sr-dj-import-row"
                disabled={importBusy}
                onClick={() => void importSet(set.id)}
              >
                <span className="sr-dj-import-name">{set.name}</span>
                <span className="sr-chip">{set.source}</span>
                <span className="sr-dj-count">{set.track_count} 首</span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {notice !== null ? <div className="sr-dj-notice" role="alert">{notice}</div> : null}
      <div className="sr-dj-main">
        <LibraryBrowser
          suggestions={suggestions}
          suggestBusy={suggestBusy}
          setIds={draft.trackIds}
          deckPath={deck.path}
          deckPlaying={deck.state === "playing"}
          onPreview={(id) => {
            if (selectedId === id && deck.state !== "empty") {
              if (deck.state === "playing") player.deck.pause();
              else player.deck.play();
            } else {
              void openTrack(id).then(() => player.deck.play());
            }
          }}
          onOpen={(id) => void openTrack(id)}
          onAdd={addToSet}
        />
        <SetBoard
          trackIds={draft.trackIds}
          details={details}
          planRows={planRows}
          selectedId={selectedId}
          onSelect={(id) => void openTrack(id)}
          onRemove={removeFromSet}
          onMove={moveRow}
          onInsert={insertIntoSet}
        />
      </div>
      <section className="sr-dj-deck" data-state={deck.state}>
        <header className="sr-dj-deck-head">
          <span className="sr-dj-deck-title" title={deck.path ?? undefined}>
            {selectedDetail !== undefined
              ? (selectedDetail.title ?? selectedDetail.path.split("/").pop())
              : deck.state === "loading"
                ? "载入中…"
                : "空 · 点一首或从曲库拖进来"}
          </span>
          {selectedDetail !== undefined && selectedDetail.bpm !== null ? (
            <span className="sr-chip">{Number(selectedDetail.bpm.toFixed(1))} BPM</span>
          ) : null}
          {selectedDetail?.camelot ? <span className="sr-chip">{selectedDetail.camelot}</span> : null}
        </header>
        <WaveformStrip
          peaks={selectedDetail?.peaks ?? []}
          durationMs={deck.durationMs}
          positionMs={player.deck.positionMs()}
          cues={cueBlock?.cues ?? []}
          onSeek={(ms) => player.deck.seekMs(ms)}
        />
        {aiCue !== null && aiCue.trackId === selectedId ? (
          <div className="sr-dj-aicue">
            <div className="sr-dj-aicue-head">
              <strong>AI 设 cue · 预览（未写入）</strong>
              <span className="sr-dj-cue-note">
                {aiCue.result.bpm.value.toFixed(1)} BPM（{zhBpmSource(aiCue.result.bpm.source)}）
              </span>
            </div>
            <ul className="sr-dj-aicue-list">
              {aiCue.result.candidates.map((cand) => {
                // F-4：reason 只出中文；插件哪天出了新句式（zhCueReason → null），原文收进 title 不裸奔
                const zh = zhCueReason(cand.reason);
                return (
                <li key={cand.role} title={zh === null ? cand.reason : undefined}>
                  <span className={`sr-dj-badge${cand.role === "in" ? " sr-dj-badge-in" : cand.role === "out" ? " sr-dj-badge-out" : ""}`}>
                    {cand.role === "in" ? "进" : cand.role === "out" ? "出" : "loop"}
                  </span>
                  <span className="sr-dj-aicue-time">
                    {mmss(cand.position_ms / 1000)}
                    {cand.end_ms !== undefined ? ` – ${mmss(cand.end_ms / 1000)}` : ""}
                  </span>
                  <span className="sr-dj-aicue-conf">{Math.round(cand.confidence * 100)}%</span>
                  {zh !== null && <span className="sr-dj-aicue-reason">{zh}</span>}
                  {(cueBlock?.cues ?? []).some((cue) => cue.role === cand.role) ? (
                    <span className="sr-dj-aicue-replace">替换现有</span>
                  ) : null}
                </li>
                );
              })}
            </ul>
            {aiCue.result.notes.map((note) => {
              const zh = zhCueNote(note);
              return zh !== null ? (
                <p key={note} className="sr-dj-aicue-note">{zh}</p>
              ) : (
                <p key={note} className="sr-dj-aicue-note" title={note}>本条注释只有英文，悬停查看原文</p>
              );
            })}
            <div className="sr-dj-aicue-actions">
              <button type="button" className="sr-page-action" onClick={applyAiCues}>写入 cues</button>
              <button type="button" className="sr-page-action" onClick={() => setAiCue(null)}>放弃</button>
            </div>
          </div>
        ) : null}
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
                {cue.role === "in" ? <span className="sr-dj-badge sr-dj-badge-in">进</span> : null}
                {cue.role === "out" ? <span className="sr-dj-badge sr-dj-badge-out">出</span> : null}
                {cue.kind === "loop" ? <span className="sr-dj-badge">loop</span> : null}
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
          <button
            type="button"
            className="sr-dj-cue-add"
            onClick={() => void requestAiCues()}
            disabled={aiCueBusy || selectedDetail === undefined}
          >
            {aiCueBusy ? "分析中…" : "AI 设 cue"}
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
          <span className="sr-dj-clock">{mmss(player.deck.positionMs() / 1000)}</span>
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

function SetBoard(props: {
  trackIds: number[];
  details: Record<number, TrackDetail>;
  planRows: Map<string, PlanRow>;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRemove: (id: number) => void;
  onMove: (from: number, to: number) => void;
  onInsert: (id: number, at: number) => void;
}) {
  const [dropAt, setDropAt] = useState<number | null>(null);

  const handleDrop = (event: DragEvent<HTMLElement>, index: number) => {
    event.preventDefault();
    setDropAt(null);
    const trackRaw = event.dataTransfer.getData(DRAG_TRACK);
    const rowRaw = event.dataTransfer.getData(DRAG_ROW);
    if (trackRaw !== "" && Number.isFinite(Number(trackRaw))) {
      props.onInsert(Number(trackRaw), index);
      return;
    }
    if (rowRaw !== "" && Number.isFinite(Number(rowRaw))) {
      props.onMove(Number(rowRaw), index);
    }
  };

  return (
    <section className="sr-dj-board" aria-label="set 曲目">
      <div className="sr-dj-board-head">
        <span className="sr-dj-mixer-label">Set</span>
        <span className="sr-dj-count">{props.trackIds.length} 首 · 拖入或拖动排序</span>
      </div>
      <div className="sr-dj-rows" onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleDrop(event, props.trackIds.length)}>
        {props.trackIds.map((id, index) => {
          const detail = props.details[id];
          const planRow = props.planRows.get(String(id));
          return (
            <div
              key={id}
              className="sr-dj-row"
              data-track-id={id}
              data-selected={props.selectedId === id || undefined}
              data-dropat={dropAt === index || undefined}
              draggable
              onDragStart={(event) => event.dataTransfer.setData(DRAG_ROW, String(index))}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDropAt(index);
              }}
              onDrop={(event) => {
                event.stopPropagation();
                handleDrop(event, index);
              }}
              onClick={() => props.onSelect(id)}
            >
              <span className="sr-dj-row-index">{index + 1}</span>
              <span className="sr-dj-row-title">
                {detail !== undefined ? (detail.title ?? detail.path.split("/").pop()) : `#${id}（载入中…）`}
              </span>
              {detail?.bpm !== null && detail !== undefined && detail.bpm !== null ? (
                <span className="sr-chip">{Number(detail.bpm.toFixed(1))} BPM</span>
              ) : null}
              {detail?.camelot ? <span className="sr-chip">{detail.camelot}</span> : null}
              {(detail?.cues ?? []).some((cue) => cue.role === "in") ? (
                <span className="sr-dj-badge sr-dj-badge-in">进</span>
              ) : null}
              {(detail?.cues ?? []).some((cue) => cue.role === "out") ? (
                <span className="sr-dj-badge sr-dj-badge-out">出</span>
              ) : null}
              {planRow !== undefined && planRow.warnings.length > 0 ? (
                <span className="sr-dj-badge" title={planRow.warnings.join("\n")}>
                  ⚠
                </span>
              ) : null}
              <span className="sr-dj-row-time">
                {planRow !== undefined
                  ? `${planRow.play_start}–${planRow.play_end}`
                  : detail?.duration_ms != null
                    ? mmss(detail.duration_ms / 1000)
                    : "—"}
              </span>
              <button
                type="button"
                className="sr-page-action"
                aria-label={`移出 ${detail?.title ?? id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRemove(id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
        {props.trackIds.length === 0 ? (
          <p className="sr-dj-empty">从左边把歌拖进来（或点「加入」），拖动可排序</p>
        ) : null}
      </div>
    </section>
  );
}

function LibraryBrowser(props: {
  suggestions: SuggestionRow[];
  suggestBusy: boolean;
  setIds: number[];
  deckPath: string | null;
  deckPlaying: boolean;
  onPreview: (trackId: number) => void;
  /** 点行=载入播放器+选中（不自动播放）；试听按钮才播放（D1，2026-09-25 巡检）。 */
  onOpen: (trackId: number) => void;
  onAdd: (trackId: number) => void;
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

  const inSet = new Set(props.setIds);

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
      {props.suggestions.length > 0 ? (
        <div className="sr-dj-suggest-strip">
          {props.suggestions.map((item) => (
            <div
              key={item.id}
              className="sr-dj-row sr-dj-suggest-row"
              data-inset={inSet.has(item.id) || undefined}
              draggable
              onDragStart={(event) => event.dataTransfer.setData(DRAG_TRACK, String(item.id))}
              onClick={() => props.onOpen(item.id)}
            >
              <span className="sr-dj-badge sr-dj-badge-pick">推荐</span>
              <span className="sr-dj-row-title">{item.title}</span>
              {item.bpm !== null ? <span className="sr-chip">{Number(item.bpm.toFixed(1))} BPM</span> : null}
              {item.key ? <span className="sr-chip">{item.key}</span> : null}
              <span className="sr-dj-score" title={`推荐分 ${Math.round(item.score * 100)} / 100`}>匹配 {Math.round(item.score * 100)}</span>
              <button
                type="button"
                className="sr-page-action"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onAdd(item.id);
                }}
              >
                加入
              </button>
              <div className="sr-dj-reasons">
                {item.reasons.map((reason, index) => (
                  <span key={index} className="sr-dj-reason">{reason}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {props.suggestBusy && props.suggestions.length === 0 ? (
        <span className="sr-dj-count">推荐计算中…</span>
      ) : null}
      <div className="sr-dj-rows">
        {tracks.map((track) => (
          <div
            key={track.id}
            className="sr-dj-row"
            data-inset={inSet.has(track.id) || undefined}
            data-previewing={props.deckPath === track.path || undefined}
            data-loaded={props.deckPath === track.path || undefined}
            role="button"
            tabIndex={0}
            aria-label={`载入 ${track.title ?? track.path.split("/").pop()}`}
            draggable
            onDragStart={(event) => event.dataTransfer.setData(DRAG_TRACK, String(track.id))}
            onClick={() => props.onOpen(track.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onOpen(track.id);
              }
            }}
          >
            <span className="sr-dj-row-title">{track.title ?? track.path.split("/").pop()}</span>
            {track.artist ? <span className="sr-dj-row-artist">{track.artist}</span> : null}
            {track.bpm !== null ? <span className="sr-chip">{Number(track.bpm.toFixed(1))} BPM</span> : null}
            {track.camelot ? <span className="sr-chip">{track.camelot}</span> : null}
            <span className="sr-dj-row-time">{track.duration_ms !== null ? mmss(track.duration_ms / 1000) : "—"}</span>
            <button
              type="button"
              className="sr-page-action"
              aria-label={`试听 ${track.title ?? track.id}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onPreview(track.id);
              }}
            >
              {props.deckPath === track.path && props.deckPlaying ? "停" : "试听"}
            </button>
            <button
              type="button"
              className="sr-page-action"
              aria-label={`加入 set ${track.title ?? track.id}`}
              disabled={inSet.has(track.id)}
              onClick={(event) => {
                event.stopPropagation();
                props.onAdd(track.id);
              }}
            >
              {inSet.has(track.id) ? "已在" : "加入"}
            </button>
          </div>
        ))}
        {!loading && tracks.length === 0 && failed === null ? (
          <p className="sr-dj-empty">库里没有匹配的曲目 —— 用曲目库插件先扫一个目录。</p>
        ) : null}
      </div>
    </section>
  );
}
