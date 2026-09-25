/**
 * 曲目库页的纯函数：展示口径全在这里钉住——时间格式、来源推导、缺口判定、
 * 扫描/导入/学习结果的中文句、筛选表单→插件参数、slot 字母、cue 来源句。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_FILTERS,
  buildTrackFilters,
  coverUrl,
  deleteFileLine,
  describeCueSource,
  describeCovers,
  describeFailure,
  describeImport,
  describeLearn,
  describeMoveToCrate,
  describeRemove,
  describeScan,
  describeScanProgress,
  dupBadgeMap,
  dupFieldRows,
  partitionDupGroups,
  filtersActive,
  formatBytes,
  formatMs,
  formatPlayedAt,
  missingOf,
  slotLetter,
  sourceOf,
} from "../src/lib/library.ts";

test("formatMs：毫秒 → m:ss，未知给占位符", () => {
  assert.equal(formatMs(23000), "0:23");
  assert.equal(formatMs(90500), "1:31"); // 90.5s 四舍五入到 91s
  assert.equal(formatMs(0), "0:00");
  assert.equal(formatMs(null), "—");
  assert.equal(formatMs(undefined), "—");
  assert.equal(formatMs(Number.NaN), "—");
});

test("sourceOf：来源 = 路径的父目录名", () => {
  assert.equal(sourceOf("/Users/a/Documents/ShadowRoom/recordings/x.wav"), "recordings");
  assert.equal(sourceOf("/Users/a/stems/song (stems)/drums.wav"), "song (stems)");
  assert.equal(sourceOf("/x.wav"), "/");
});

test("missingOf：缺 BPM / 缺调性逐一点名", () => {
  assert.deepEqual(missingOf({ bpm: null, key: null }), ["BPM", "调性"]);
  assert.deepEqual(missingOf({ bpm: 128, key: null }), ["调性"]);
  assert.deepEqual(missingOf({ bpm: null, key: "8A" }), ["BPM"]);
  assert.deepEqual(missingOf({ bpm: 128, key: "8A" }), []);
});

const scanJob = (over) => ({
  id: 1, folder: "/x", recursive: 1, status: "completed",
  total: 8, done: 8, failed: 0, added: 8, updated: 0, unchanged: 0, missing: 0,
  ms: 123, error: null, failures: [], ...over,
});

test("describeScan：数字全在句子里，零值不啰嗦", () => {
  assert.equal(describeScan(scanJob()), "找到 8 个音频文件 · 新入库 8，用时 123ms");
  const mixed = describeScan(scanJob({ total: 10, added: 1, updated: 2, unchanged: 6, missing: 1, ms: 5 }));
  assert.equal(mixed, "找到 10 个音频文件 · 新入库 1 · 有更新 2 · 未变 6 · 1 行本次没找到（库行保留，不删），用时 5ms");
  assert.equal(describeScan(scanJob({ added: 6, failed: 2 })), "找到 8 个音频文件 · 新入库 6 · 失败 2，用时 123ms");
});

test("describeScanProgress：入库中只报 done/total 与失败", () => {
  assert.equal(describeScanProgress(scanJob({ status: "running", done: 3, total: 10 })), "正在入库 3/10");
  assert.equal(describeScanProgress(scanJob({ status: "running", done: 3, total: 10, failed: 1 })), "正在入库 3/10 · 失败 1");
});

test("describeFailure：路径/原因齐全给全，缺了不崩", () => {
  assert.equal(describeFailure({ path: "/a.mp3", reason: "无法解码" }), "/a.mp3（无法解码）");
  assert.equal(describeFailure({ path: "/a.mp3" }), "/a.mp3");
  assert.equal(describeFailure({ reason: "权限拒绝" }), "权限拒绝");
  assert.equal(describeFailure({}), "[object Object]");
});

test("describeImport：两家找到与否都要说清楚", () => {
  const line = describeImport({
    source: "auto",
    rekordbox: { found: true, sets: 4, note: null },
    serato: { found: false, sets: 0, note: null },
    sets: 4,
    tracks: 12,
    warnings: [],
  });
  assert.equal(line, "Rekordbox 4 个 set；Serato 没找到库——共导入 4 个 set、12 条曲目记录");
  const warned = describeImport({
    source: "auto",
    rekordbox: { found: false, sets: 0, note: "库是加密的" },
    serato: { found: true, sets: 1, note: null },
    sets: 1,
    tracks: 3,
    warnings: ["w1", "w2"],
  });
  assert.equal(warned, "Rekordbox 没找到库（库是加密的）；Serato 1 个 set——共导入 1 个 set、3 条曲目记录；警告 2 条（w1）");
});

test("describeLearn：样本不足原样展示 note，不假装学会", () => {
  const rows = describeLearn({ version: "v1", samples: 1, transitions: 0, note: "样本不足（<3 场 set 或无过渡），沿用默认策略" });
  assert.equal(rows[0], "样本不足（<3 场 set 或无过渡），沿用默认策略");
  assert.equal(rows[1], "样本 1 场 set · 0 次过渡");
  const full = describeLearn({
    version: "v2",
    samples: 5,
    transitions: 40,
    genre_weights: { techno: 0.5, house: 0.3 },
    delta_bpm: { p25: -1.2, p50: 1.5, p75: 3.2, unit: "percent" },
    camelot_moves: { "+1": 0.6, same: 0.2 },
    set_shape: { warmup: 0.4, peak: 0.8, close: 0.5 },
  });
  assert.deepEqual(full, [
    "样本 5 场 set · 40 次过渡",
    "风格：techno 50%、house 30%",
    "ΔBPM：中位 +1.5%（常见 -1.2%~3.2%）",
    "Camelot 走法：+1 60%、same 20%",
    "set 形状：warm-up 0.4 → peak 0.8 → close 0.5",
  ]);
});

test("formatBytes：库体积给人看", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(-1), "—");
});

test("buildTrackFilters：空串/NaN 不下发，camelot 归一大写", () => {
  assert.deepEqual(buildTrackFilters(EMPTY_FILTERS), {});
  assert.deepEqual(
    buildTrackFilters({ query: "  deep ", bpmMin: "120", bpmMax: "130", camelot: "8a", tag: " house " }),
    { query: "deep", bpm_min: 120, bpm_max: 130, camelot: "8A", tags: ["house"] },
  );
  assert.deepEqual(buildTrackFilters({ query: "", bpmMin: "abc", bpmMax: "", camelot: "", tag: "" }), {});
});

test("filtersActive：任何一格有字就算活跃", () => {
  assert.equal(filtersActive(EMPTY_FILTERS), false);
  assert.equal(filtersActive({ ...EMPTY_FILTERS, tag: "lofi" }), true);
  assert.equal(filtersActive({ ...EMPTY_FILTERS, query: "   " }), false);
});

test("formatPlayedAt：unix 秒与文本两种库值都出日期", () => {
  assert.match(formatPlayedAt(1790267891.031754), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatPlayedAt("2026-09-25T20:00:00"), "2026-09-25");
  assert.equal(formatPlayedAt(null), "—");
  assert.equal(formatPlayedAt(""), "—");
  assert.equal(formatPlayedAt(-1), "—");
});

test("slotLetter：0..7 → A..H", () => {
  assert.equal(slotLetter(0), "A");
  assert.equal(slotLetter(7), "H");
  assert.equal(slotLetter(8), "8");
});

test("describeCueSource：有效集来源与覆盖数", () => {
  assert.equal(describeCueSource({ cue_source: null, imported_cue_total: 0, imported_cue_overridden: 0 }), "这首还没有 cue");
  assert.equal(
    describeCueSource({ cue_source: "rekordbox-xml", imported_cue_total: 3, imported_cue_overridden: 0 }),
    "来自导入（rekordbox-xml）",
  );
  assert.equal(
    describeCueSource({ cue_source: "app", imported_cue_total: 3, imported_cue_overridden: 2 }),
    "在 DJ 页编辑过，覆盖了 2/3 条导入 cue",
  );
});

// ---------------------------------------------------------------- 二期：删除/归类/封面/查重

test("coverUrl：走桥的文件端点（与音频同一个）", () => {
  assert.equal(coverUrl("/a b/cover.jpg"), `/api/agent/file?path=${encodeURIComponent("/a b/cover.jpg")}`);
});

test("describeRemove：三种文件结局都说清楚", () => {
  const base = { track_id: 1, path: "/x/a.wav", title: "a", row_deleted: true };
  assert.equal(describeRemove({ ...base, file_action: "none" }), "已从曲库移除「a」（文件还在，重扫会回来）");
  assert.equal(describeRemove({ ...base, file_action: "trashed" }), "已移入废纸篓「a」，曲库记录一并删除");
  assert.equal(describeRemove({ ...base, file_action: "unlinked" }), "已彻底删除「a」——文件无法恢复");
  assert.equal(describeRemove({ ...base, file_action: "file-missing" }), "文件早就不在磁盘上了，库行已清「a」");
});

test("describeMoveToCrate：新建/重复/文件没动都在句子里", () => {
  assert.equal(
    describeMoveToCrate({ crate_id: 1, crate_name: "deep", created: true, added: 1, skipped: 0, files_untouched: true }),
    "已加入「deep」（crate 是新建的）：新加 1，文件没动",
  );
  assert.equal(
    describeMoveToCrate({ crate_id: 1, crate_name: "deep", created: false, added: 0, skipped: 1, files_untouched: true }),
    "已加入「deep」：新加 0，跳过重复 1，文件没动",
  );
});

test("describeCovers：提出/没有/失败都报", () => {
  assert.equal(
    describeCovers({ checked: 8, extracted: 3, from_embedded: 2, from_folder: 1, none: 5, errors: 0, missing_files: 0, covers_dir: "/x" }),
    "封面：检查 8 首 · 提出 3 张（嵌入 2 · 同目录 1） · 没有封面 5",
  );
  assert.equal(
    describeCovers({ checked: 2, extracted: 0, from_embedded: 0, from_folder: 0, none: 1, errors: 1, missing_files: 0, covers_dir: "/x" }),
    "封面：检查 2 首 · 提出 0 张（嵌入 0 · 同目录 0） · 没有封面 1 · 读失败 1",
  );
});

const dupTrack = (over) => ({
  id: 1, path: "/x/a.wav", title: "a", artist: null, duration_ms: 10000, format: "wav",
  size: 1000, sample_rate: 44100, bit_depth: 16, bpm: 120, key: "Am", camelot: null, added_at: 1790000000,
  ...over,
});

test("partitionDupGroups：acoustic 弹窗、exact/suspect+metadata 角标", () => {
  const groups = [
    { layer: "acoustic", tracks: [dupTrack({ id: 1 }), dupTrack({ id: 2 })], reasons: [] },
    { layer: "exact", tracks: [dupTrack({ id: 3 }), dupTrack({ id: 4 })], reasons: [] },
    { layer: "suspect", tracks: [dupTrack({ id: 5 }), dupTrack({ id: 6 })], reasons: [] },
    { layer: "metadata", tracks: [dupTrack({ id: 7 }), dupTrack({ id: 8 })], reasons: [] },
  ];
  const p = partitionDupGroups(groups);
  assert.equal(p.acoustic.length, 1);
  assert.equal(p.exact.length, 1);
  assert.equal(p.suspect.length, 2);
});

test("dupBadgeMap：exact 完全重复、suspect/metadata 疑似重复、acoustic 不打角标、exact 优先", () => {
  const groups = [
    { layer: "acoustic", tracks: [dupTrack({ id: 1 })], reasons: [] },
    { layer: "suspect", tracks: [dupTrack({ id: 2 })], reasons: [] },
    { layer: "metadata", tracks: [dupTrack({ id: 3 })], reasons: [] },
    { layer: "exact", tracks: [dupTrack({ id: 2 }), dupTrack({ id: 4 })], reasons: [] },
  ];
  const map = dupBadgeMap(groups);
  assert.equal(map.get(1), undefined);
  assert.equal(map.get(2), "疑似重复"); // 先落 suspect 后 exact 不覆盖（exact 组在后面）
  assert.equal(map.get(3), "疑似重复");
  assert.equal(map.get(4), "完全重复");
});

test("dupFieldRows：规格顺序 + 不一致标记", () => {
  const a = dupTrack({ format: "wav", size: 3984608, sample_rate: 44100, bit_depth: 16 });
  const b = dupTrack({ format: "mp3", size: 360448, sample_rate: 44100, bit_depth: null, path: "/x/a.mp3" });
  const rows = dupFieldRows(a, b);
  assert.deepEqual(rows.map((r) => r.label), ["格式", "位深 · 采样率", "大小", "时长", "路径", "入库时间", "BPM", "调性"]);
  assert.equal(rows[0].differ, true); // WAV vs MP3
  assert.equal(rows[1].differ, true); // 16-bit 与 —
  assert.equal(rows[1].a, "16-bit · 44.1kHz");
  assert.equal(rows[2].differ, true); // 大小不同
  assert.equal(rows[4].differ, true); // 路径不同
  assert.equal(rows[6].differ, false); // BPM 同
});

test("deleteFileLine：§3 弹窗文件行——artist 缺省不硬凑，技术块缺项自动省", () => {
  assert.equal(
    deleteFileLine({ title: "song", artist: "artist", path: "/x/song.mp3", duration_ms: 101000, size: 8820014, sample_rate: 48000, bit_depth: 24 }),
    "artist - song（8.4 MB · MP3 24-bit/48kHz）",
  );
  assert.equal(
    deleteFileLine({ title: "song", artist: null, path: "/x/song.wav", duration_ms: 1000, size: null, sample_rate: 44100, bit_depth: null }),
    "song（WAV/44.1kHz）",
  );
});
