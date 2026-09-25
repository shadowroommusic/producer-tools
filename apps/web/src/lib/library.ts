/**
 * 曲目库页的数据层：library 插件的工具封装 + 页面用的纯函数（纯函数才有单测）。
 *
 * 口径（AGENTS.md 踩坑）：桥的 `/api/call` 返回的 `result` 是 **JSON 字符串**（MCP 文本内容），
 * 不是结构化对象——照 `callTool<string>` + `JSON.parse` 解，与 DjPage 同一个形状。
 *
 * 这页是**只读 + 扫描/学习动作**：cue 与颜色的写路径（`cues_set`）只属于 DJ 页，这里刻意不封装。
 */
import { callTool } from "./mcp.ts";

const SERVER = "library";

async function tool<T>(name: string, args: unknown): Promise<T> {
  const raw = await callTool<string>(SERVER, name, args);
  return JSON.parse(String(raw)) as T;
}

// ---------------------------------------------------------------- 类型（与插件返回逐字段对齐）

export type TrackRow = {
  id: number;
  path: string;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  energy: number | null;
  duration_ms: number | null;
  has_stems: number;
};

export type CueRow = {
  id: number;
  position_ms: number;
  end_ms: number | null;
  kind: string | null;
  color: string | null;
  name: string | null;
  role: string | null;
  slot: number | null;
  cue_type: string | null;
  display_name: string;
};

export type TrackDetail = TrackRow & {
  album: string | null;
  year: string | null;
  genre: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  peaks: number[];
  crates: Array<{ id: number; name: string }>;
  cues: CueRow[];
  cue_source: string | null;
  imported_cue_total: number;
  imported_cue_overridden: number;
};

export type ScanResult = {
  folder: string;
  recursive: boolean;
  found: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  ms: number;
};

export type Stats = {
  tracks: number;
  with_bpm: number;
  with_key: number;
  bpm_rate: number;
  key_rate: number;
  analysis_complete_rate: number;
  missing_analysis: number;
  crates: number;
  db_bytes: number;
  db_path: string;
};

export type PrefModel = {
  version: string;
  samples: number;
  transitions?: number;
  note?: string;
  genre_weights?: Record<string, number>;
  delta_bpm?: { p25: number | null; p50: number | null; p75: number | null; unit: string };
  camelot_moves?: Record<string, number>;
  energy_steps?: { p25: number | null; p50: number | null; p75: number | null };
  set_shape?: { warmup: number; peak: number; close: number };
};

export type VendorReport = { found: boolean; sets: number; note: string | null };

export type ImportReport = {
  source: string;
  rekordbox: VendorReport;
  serato: VendorReport;
  sets: number;
  tracks: number;
  warnings: string[];
};

export type SetRow = { id: number; source: string; name: string; played_at: number | string | null; track_count: number };

export type TrackFilters = {
  query?: string;
  bpm_min?: number;
  bpm_max?: number;
  camelot?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
};

// ---------------------------------------------------------------- 工具封装

export const listTracks = (filters: TrackFilters) =>
  tool<{ tracks: TrackRow[] }>("list_tracks", { limit: 200, ...filters }).then((res) => res.tracks);

export const trackDetail = (id: number) => tool<TrackDetail>("track_detail", { id });

export const scanFolder = (path: string) => tool<ScanResult>("scan_folder", { path });

export const fetchStats = () => tool<Stats>("stats", {});

export const preferenceSummary = () => tool<{ summary: string }>("preference_summary", {}).then((res) => res.summary);

export const learnPreferences = () => tool<PrefModel>("learn_preferences", {});

export const importHistory = () => tool<ImportReport>("import_history", { source: "auto" });

export const forgetPreferences = (forgetHistory: boolean) =>
  tool<{ removed: { preference_model: boolean; history: boolean } }>("forget_preferences", { forget_history: forgetHistory });

export const analyzeMissing = (limit = 25) =>
  tool<{ candidates: number; analysed: number; failed: number; errors: string[]; ms: number }>("analyze_missing", { limit });

export const setList = () => tool<{ sets: SetRow[] }>("set_list", {}).then((res) => res.sets);

// ---------------------------------------------------------------- 纯函数（单测钉住）

/** 毫秒 → m:ss（未知时长给占位，不瞎编 0:00）。 */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 「来源」列：库里没有 source 字段，取路径的父目录名（recordings / stems / imports…）。 */
export function sourceOf(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length >= 2 ? parts[parts.length - 2] : "/";
}

/** 分析缺口：这首还缺什么。页面只展示缺口，补齐动作在看板里（analyze_missing 是批量工具）。 */
export function missingOf(track: Pick<TrackRow, "bpm" | "key">): string[] {
  const missing: string[] = [];
  if (track.bpm === null || track.bpm === undefined) missing.push("BPM");
  if (track.key === null || track.key === undefined) missing.push("调性");
  return missing;
}

/** 扫描结果 → 一句给用户看的中文（数字都在，不说「已优化」这种形容词）。 */
export function describeScan(result: ScanResult): string {
  const parts = [`找到 ${result.found} 个音频文件`];
  parts.push(`新入库 ${result.added}`);
  if (result.updated > 0) parts.push(`有更新 ${result.updated}`);
  if (result.unchanged > 0) parts.push(`未变 ${result.unchanged}`);
  if (result.missing > 0) parts.push(`${result.missing} 行本次没找到（库行保留，不删）`);
  return `${parts.join(" · ")}，用时 ${result.ms}ms`;
}

/** 历史导入报告 → 一句中文；某家没找到要说清楚，不静默。 */
export function describeImport(report: ImportReport): string {
  const vendor = (name: string, v: VendorReport) =>
    v.found ? `${name} ${v.sets} 个 set` : `${name} 没找到库${v.note ? `（${v.note}）` : ""}`;
  const base = `${vendor("Rekordbox", report.rekordbox)}；${vendor("Serato", report.serato)}——共导入 ${report.sets} 个 set、${report.tracks} 条曲目记录`;
  return report.warnings.length > 0 ? `${base}；警告 ${report.warnings.length} 条（${report.warnings[0]}）` : base;
}

/** 学习结果 → 看板数字行。样本不足时插件给 note，原样展示（不假装学会了）。 */
export function describeLearn(model: PrefModel): string[] {
  const rows: string[] = [];
  if (model.note) rows.push(model.note);
  rows.push(`样本 ${model.samples} 场 set · ${model.transitions ?? 0} 次过渡`);
  const genres = Object.entries(model.genre_weights ?? {});
  if (genres.length > 0) rows.push(`风格：${genres.slice(0, 4).map(([name, w]) => `${name} ${Math.round(w * 100)}%`).join("、")}`);
  const bpm = model.delta_bpm;
  if (bpm?.p50 !== null && bpm?.p50 !== undefined) {
    rows.push(`ΔBPM：中位 ${bpm.p50 > 0 ? "+" : ""}${bpm.p50}%（常见 ${bpm.p25}%~${bpm.p75}%）`);
  }
  const moves = Object.entries(model.camelot_moves ?? {});
  if (moves.length > 0) rows.push(`Camelot 走法：${moves.slice(0, 3).map(([name, w]) => `${name} ${Math.round(w * 100)}%`).join("、")}`);
  const shape = model.set_shape;
  if (shape) rows.push(`set 形状：warm-up ${shape.warmup} → peak ${shape.peak} → close ${shape.close}`);
  return rows;
}

/** 库体积：给人看的 KB/MB。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type FilterForm = { query: string; bpmMin: string; bpmMax: string; camelot: string; tag: string };

export const EMPTY_FILTERS: FilterForm = { query: "", bpmMin: "", bpmMax: "", camelot: "", tag: "" };

/** 筛选表单 → list_tracks 参数：空串/NaN 一律不下发（一个合法值一个答案）。 */
export function buildTrackFilters(form: FilterForm): TrackFilters {
  const filters: TrackFilters = {};
  const query = form.query.trim();
  if (query !== "") filters.query = query;
  const bpmMin = Number(form.bpmMin);
  if (form.bpmMin.trim() !== "" && Number.isFinite(bpmMin)) filters.bpm_min = bpmMin;
  const bpmMax = Number(form.bpmMax);
  if (form.bpmMax.trim() !== "" && Number.isFinite(bpmMax)) filters.bpm_max = bpmMax;
  const camelot = form.camelot.trim().toUpperCase();
  if (camelot !== "") filters.camelot = camelot;
  const tag = form.tag.trim();
  if (tag !== "") filters.tags = [tag];
  return filters;
}

/** 筛选表单是不是干净的（决定「清除筛选」按钮出不出来）。 */
export function filtersActive(form: FilterForm): boolean {
  return Object.values(form).some((value) => value.trim() !== "");
}

/** played_at 两种都见得到：XML 导入存 unix 秒（number），历史导入存文本——统一给 YYYY-MM-DD。 */
export function formatPlayedAt(value: number | string | null): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.slice(0, 10) || "—";
  if (!Number.isFinite(value) || value <= 0) return "—";
  const date = new Date(value * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** hot cue 槽位 0..7 → A..H（DJ 的肌肉记忆）。 */
export function slotLetter(slot: number): string {
  return slot >= 0 && slot <= 7 ? String.fromCharCode(65 + slot) : String(slot);
}

/** cue 来源一句人话：有效集来自哪里 + 被覆盖的导入 cue 条数。 */
export function describeCueSource(detail: Pick<TrackDetail, "cue_source" | "imported_cue_total" | "imported_cue_overridden">): string {
  if (detail.cue_source === null) return "这首还没有 cue";
  const from = detail.cue_source === "app" ? "在 DJ 页编辑过" : `来自导入（${detail.cue_source}）`;
  if (detail.cue_source === "app" && detail.imported_cue_overridden > 0) {
    return `${from}，覆盖了 ${detail.imported_cue_overridden}/${detail.imported_cue_total} 条导入 cue`;
  }
  return from;
}
