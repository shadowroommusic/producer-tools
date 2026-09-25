/**
 * 曲目库页的纯函数：展示口径全在这里钉住——时间格式、来源推导、缺口判定、
 * 扫描/导入/学习结果的中文句、筛选表单→插件参数、slot 字母、cue 来源句。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_FILTERS,
  buildTrackFilters,
  describeCueSource,
  describeImport,
  describeLearn,
  describeScan,
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

test("describeScan：数字全在句子里，零值不啰嗦", () => {
  const line = describeScan({ folder: "/x", recursive: true, found: 8, added: 8, updated: 0, unchanged: 0, missing: 0, ms: 123 });
  assert.equal(line, "找到 8 个音频文件 · 新入库 8，用时 123ms");
  const mixed = describeScan({ folder: "/x", recursive: true, found: 10, added: 1, updated: 2, unchanged: 6, missing: 1, ms: 5 });
  assert.equal(mixed, "找到 10 个音频文件 · 新入库 1 · 有更新 2 · 未变 6 · 1 行本次没找到（库行保留，不删），用时 5ms");
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
