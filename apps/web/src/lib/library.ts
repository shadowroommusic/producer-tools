/**
 * 曲目库页的数据层：library 插件的工具封装 + 页面用的纯函数（纯函数才有单测）。
 *
 * 口径（AGENTS.md 踩坑）：桥的 `/api/call` 返回的 `result` 是 **JSON 字符串**（MCP 文本内容），
 * 不是结构化对象——照 `callTool<string>` + `JSON.parse` 解，与 DjPage 同一个形状。
 *
 * 这页是**只读 + 扫描/学习动作**：cue 与颜色的写路径（`cues_set`）只属于 DJ 页，这里刻意不封装。
 */
import { callTool } from "./mcp.ts";
import { fileUrl } from "./studio.ts";

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
  cover_path: string | null;
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

/** scan_folder 的即时返回（二期契约）：任务句柄，结果要轮询 scan_job_detail。 */
export type ScanStart = { job_id: number; status: string; folder: string; recursive: boolean; note?: string };

/** scan_job_detail：任务全貌。failures 元素形状二期还在定，渲染时防御性取值。 */
export type ScanJob = {
  id: number;
  folder: string;
  recursive: number | boolean;
  status: string;
  total: number;
  done: number;
  failed: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  ms: number | null;
  error: string | null;
  started_at?: number;
  finished_at?: number | null;
  failures: Array<Record<string, unknown>>;
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

export const scanFolder = (path: string) => tool<ScanStart>("scan_folder", { path });

export const scanJobDetail = (jobId: number) => tool<ScanJob>("scan_job_detail", { job_id: jobId });

export const fetchStats = () => tool<Stats>("stats", {});

export const preferenceSummary = () => tool<{ summary: string }>("preference_summary", {}).then((res) => res.summary);

export const learnPreferences = () => tool<PrefModel>("learn_preferences", {});

export const importHistory = () => tool<ImportReport>("import_history", { source: "auto" });

export const forgetPreferences = (forgetHistory: boolean) =>
  tool<{ removed: { preference_model: boolean; history: boolean } }>("forget_preferences", { forget_history: forgetHistory });

export const analyzeMissing = (limit = 25) =>
  tool<{ candidates: number; analysed: number; failed: number; errors: string[]; ms: number }>("analyze_missing", { limit });

export const setList = () => tool<{ sets: SetRow[] }>("set_list", {}).then((res) => res.sets);

// ---------------------------------------------------------------- 二期：菜单/删除/封面/归类/查重

export type CrateRow = { id: number; name: string; created_at: number; tracks: number };

export type RemoveResult = { track_id: number; path: string; title: string; row_deleted: boolean; file_action: string };

export type RenameResult = { track_id: number; title: string; previous_title: string | null; path: string; note: string };

export type MoveToCrateResult = { crate_id: number; crate_name: string; created: boolean; added: number; skipped: number; files_untouched: boolean };

export type CoversResult = {
  checked: number;
  extracted: number;
  from_embedded: number;
  from_folder: number;
  none: number;
  errors: number;
  missing_files: number;
  covers_dir: string;
};

export type DupTrack = {
  id: number;
  path: string;
  title: string | null;
  artist: string | null;
  duration_ms: number | null;
  format: string | null;
  size: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  added_at: number | null;
};

export type DupGroup = { layer: string; tracks: DupTrack[]; reasons: string[]; ber?: number | null };

export type DupResult = {
  checked: number;
  groups: DupGroup[];
  degraded: string | null;
  fpcalc: string | null;
  note?: string;
};

export const crateList = () => tool<{ crates: CrateRow[] }>("crate_list", {}).then((res) => res.crates);

export const trackRemove = (trackId: number, removeFile: boolean, permanent: boolean) =>
  tool<RemoveResult>("track_remove", { track_id: trackId, remove_file: removeFile, permanent });

export const trackRename = (trackId: number, newTitle: string) =>
  tool<RenameResult>("track_rename", { track_id: trackId, new_title: newTitle });

export const trackMoveToCrate = (crateName: string, trackIds: number[]) =>
  tool<MoveToCrateResult>("track_move_to_crate", { crate_name: crateName, track_ids: trackIds });

export const extractCovers = (trackIds?: number[]) =>
  tool<CoversResult>("extract_covers", trackIds !== undefined ? { track_ids: trackIds } : {});

export const findDuplicates = (limit = 200) => tool<DupResult>("find_duplicates", { limit });

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

/** 扫描完成 → 一句给用户看的中文（数字都在，不说「已优化」这种形容词）。 */
export function describeScan(job: ScanJob): string {
  const parts = [`找到 ${job.total} 个音频文件`];
  parts.push(`新入库 ${job.added}`);
  if (job.updated > 0) parts.push(`有更新 ${job.updated}`);
  if (job.unchanged > 0) parts.push(`未变 ${job.unchanged}`);
  if (job.failed > 0) parts.push(`失败 ${job.failed}`);
  if (job.missing > 0) parts.push(`${job.missing} 行本次没找到（库行保留，不删）`);
  return `${parts.join(" · ")}，用时 ${job.ms ?? 0}ms`;
}

/** 扫描中的进度句：喂进度显示位（二期 SSE 来了也显示它）。 */
export function describeScanProgress(job: ScanJob): string {
  const failed = job.failed > 0 ? ` · 失败 ${job.failed}` : "";
  return `正在入库 ${job.done}/${job.total}${failed}`;
}

/** 失败清单第一条的防御性渲染（failures 形状二期还在定：先 路径/原因，没有就原文）。 */
export function describeFailure(failure: Record<string, unknown>): string {
  const path = typeof failure.path === "string" ? failure.path : null;
  const reason = typeof failure.reason === "string" ? failure.reason : null;
  if (path !== null && reason !== null) return `${path}（${reason}）`;
  return path ?? reason ?? String(failure);
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

/** 封面图 URL：与音频同一个桥端点（agent bridge /api/agent/file，图片类型见总线 #100 提案）。 */
export function coverUrl(coverPath: string): string {
  return fileUrl(coverPath);
}

/** track_remove 结果 → 一句中文（三种文件结局都说清楚）。 */
export function describeRemove(result: RemoveResult): string {
  switch (result.file_action) {
    case "trashed":
      return `已移入废纸篓「${result.title}」，曲库记录一并删除`;
    case "unlinked":
      return `已彻底删除「${result.title}」——文件无法恢复`;
    case "file-missing":
      return `文件早就不在磁盘上了，库行已清「${result.title}」`;
    default:
      return `已从曲库移除「${result.title}」（文件还在，重扫会回来）`;
  }
}

/** 归类结果 → 一句中文（强调文件没动——规格的归类定义）。 */
export function describeMoveToCrate(result: MoveToCrateResult): string {
  const created = result.created ? "（crate 是新建的）" : "";
  const skipped = result.skipped > 0 ? `，跳过重复 ${result.skipped}` : "";
  return `已加入「${result.crate_name}」${created}：新加 ${result.added}${skipped}，文件没动`;
}

/** 封面提取结果 → 一句中文（没有/失败都说，不静默）。 */
export function describeCovers(result: CoversResult): string {
  const parts = [`检查 ${result.checked} 首`];
  parts.push(`提出 ${result.extracted} 张（嵌入 ${result.from_embedded} · 同目录 ${result.from_folder}）`);
  if (result.none > 0) parts.push(`没有封面 ${result.none}`);
  if (result.errors > 0 || result.missing_files > 0) parts.push(`读失败 ${result.errors + result.missing_files}`);
  return `封面：${parts.join(" · ")}`;
}

/** 重复组按层分开：acoustic 弹窗二选一；exact/suspect 只打角标（口径见规格 §4 与任务单）。 */
export function partitionDupGroups(groups: DupGroup[]): { acoustic: DupGroup[]; exact: DupGroup[]; suspect: DupGroup[] } {
  return {
    acoustic: groups.filter((g) => g.layer === "acoustic"),
    exact: groups.filter((g) => g.layer === "exact"),
    suspect: groups.filter((g) => g.layer === "suspect" || g.layer === "metadata"),
  };
}

/** trackId → 角标文案（exact 优先于 suspect；acoustic 不打角标——它走弹窗）。 */
export function dupBadgeMap(groups: DupGroup[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const group of groups) {
    const badge = group.layer === "exact" ? "完全重复" : group.layer === "suspect" || group.layer === "metadata" ? "疑似重复" : null;
    if (badge === null) continue;
    for (const track of group.tracks) {
      if (!map.has(track.id)) map.set(track.id, badge);
    }
  }
  return map;
}

export type DupFieldRow = { label: string; a: string; b: string; differ: boolean };

/** 两卡对比的字段行（规格 §4 的顺序：格式 → 位深/采样率 → 大小 → 时长 → 路径 → 入库时间 → BPM/调性）。 */
export function dupFieldRows(a: DupTrack, b: DupTrack): DupFieldRow[] {
  const rows: Array<[string, (t: DupTrack) => string]> = [
    ["格式", (t) => (t.format ?? "—").toUpperCase()],
    [
      "位深 · 采样率",
      (t) =>
        `${t.bit_depth === null ? "—" : `${t.bit_depth}-bit`} · ${t.sample_rate === null ? "—" : `${t.sample_rate / 1000}kHz`}`,
    ],
    ["大小", (t) => formatBytes(t.size ?? Number.NaN)],
    ["时长", (t) => formatMs(t.duration_ms)],
    ["路径", (t) => t.path],
    ["入库时间", (t) => formatPlayedAt(t.added_at)],
    ["BPM", (t) => (t.bpm === null ? "—" : String(Math.round(t.bpm * 10) / 10))],
    ["调性", (t) => t.camelot ?? t.key ?? "—"],
  ];
  return rows.map(([label, get]) => {
    const av = get(a);
    const bv = get(b);
    return { label, a: av, b: bv, differ: av !== bv };
  });
}

/** §3 弹窗文案的文件行：`title（8.4 MB · WAV 24bit/48kHz）`——artist 缺省不硬凑。 */
export function deleteFileLine(detail: Pick<TrackDetail, "title" | "artist" | "path" | "duration_ms"> & {
  size?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
}): string {
  const name = detail.artist ? `${detail.artist} - ${detail.title}` : (detail.title ?? detail.path);
  const ext = detail.path.slice(detail.path.lastIndexOf(".") + 1).toUpperCase();
  // §3 原样：「8.4 MB · WAV 24-bit/48kHz」——大小与格式块之间用中点，格式/位深/采样率连成一块。
  const block =
    ext +
    (detail.bit_depth !== null && detail.bit_depth !== undefined ? ` ${detail.bit_depth}-bit` : "") +
    (detail.sample_rate !== null && detail.sample_rate !== undefined ? `/${detail.sample_rate / 1000}kHz` : "");
  const tech = [detail.size !== null && detail.size !== undefined ? formatBytes(detail.size) : null, block]
    .filter((part) => part !== null)
    .join(" · ");
  return tech === "" ? name : `${name}（${tech}）`;
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
