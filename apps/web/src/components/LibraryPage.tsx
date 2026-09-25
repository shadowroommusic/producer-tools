/**
 * 曲目库页：library 插件的用户界面——只读展示 + 扫描/学习动作。
 *
 * 页面语法与 DjPage 是同一个形状（顶栏 → 通知条 → 主区 grid）：
 * ① 扫描入口：自定义文件夹 → library.scan_folder（指纹增量），按钮态 + 一句中文结果；
 * ② 列表：list_tracks 服务端筛选（搜索 / BPM 区间 / Camelot / tag），行=标题/艺人/BPM/调性/时长/来源；
 * ③ 详情抽屉：track_detail 元信息 + 分析缺口 + **cue 只读**——cue 与颜色的编辑入口只在 DJ 页
 *    （这页 cue 块里没有任何 input/button，验收按 DOM 断言）；
 * ④ 统计与偏好看板：stats / preference_summary / learn_preferences / import_history 的数字 +
 *    「忘记偏好」两次点击确认（产品既有的两次点击语法，不做 modal）。
 *
 * 三样预留（口径见 docs/library-page-spec.md；二期再实现，这里只占位）：
 * - 入库进度位：顶栏 `.sr-lib-scanprogress`（data-slot="scan-progress"），后端任务表 + SSE
 *   就位后接「正在入库 N/M · 当前 歌名」；一期扫描是同步一次调用，先显示「扫描中…」与结果句；
 * - 封面显示位：抽屉头 `.sr-lib-cover`（data-slot="cover"），封面提取（嵌入图 → cover.jpg →
 *   占位，不联网）落地后原槽位换 <img>；
 * - 右键菜单骨架：行右键弹出，只读先行——「复制路径」可用；「打开所在文件夹」留 disabled
 *   占位（要桌面壳的 shell.openPath）。编辑名称 / 加入分类库 / 移除 / 废纸篓 / 彻底删除
 *   等二期口径落地再加（它们动真实文件，绝不抢跑）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/library.css";
import {
  EMPTY_FILTERS,
  analyzeMissing,
  buildTrackFilters,
  describeCueSource,
  describeImport,
  describeLearn,
  describeScan,
  fetchStats,
  filtersActive,
  forgetPreferences,
  formatBytes,
  formatMs,
  formatPlayedAt,
  importHistory,
  learnPreferences,
  listTracks,
  missingOf,
  preferenceSummary,
  setList,
  slotLetter,
  sourceOf,
  trackDetail,
  type FilterForm,
  type PrefModel,
  type SetRow,
  type Stats,
  type TrackDetail,
  type TrackRow,
  scanFolder,
} from "../lib/library";

/** 筛选去抖：输入停 250ms 才打给插件（服务端筛选，库大也不卡）。 */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function LibraryPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tracks, setTracks] = useState<TrackRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FilterForm>(EMPTY_FILTERS);
  const debouncedForm = useDebounced(form, 250);

  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  /** 右键菜单骨架（一期）：只放只读动作——复制路径能用；打开所在文件夹等桌面壳。 */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const [boardOpen, setBoardOpen] = useState(false);
  const [prefSummary, setPrefSummary] = useState<string | null>(null);
  const [sets, setSets] = useState<SetRow[] | null>(null);
  const [learnRows, setLearnRows] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"learn" | "import" | "analyze" | "forget" | null>(null);
  const [forgetArmed, setForgetArmed] = useState(false);
  const [forgetHistory, setForgetHistory] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TrackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const say = useCallback((text: string) => setNotice(text), []);
  const fail = useCallback(
    (prefix: string, cause: unknown) => say(`${prefix}：${cause instanceof Error ? cause.message : String(cause)}`),
    [say],
  );

  const refreshStats = useCallback(async () => {
    try {
      setStats(await fetchStats());
    } catch (cause) {
      fail("统计读取失败", cause);
    }
  }, [fail]);

  // 列表：筛选去抖后服务端查询。seq 守卫——慢响应回来时不覆盖更新的结果。
  const listSeq = useRef(0);
  const reloadTracks = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      const rows = await listTracks(buildTrackFilters(debouncedForm));
      if (seq === listSeq.current) setTracks(rows);
    } catch (cause) {
      if (seq === listSeq.current) {
        setTracks([]);
        fail("曲目列表读取失败", cause);
      }
    }
  }, [debouncedForm, fail]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);
  useEffect(() => {
    void reloadTracks();
  }, [reloadTracks]);

  // 看板第一次打开才读偏好与 set 列表（学习是写操作，绝不在「看一下」时自动跑）。
  useEffect(() => {
    if (!boardOpen || prefSummary !== null) return;
    void (async () => {
      try {
        const [summary, setRows] = await Promise.all([preferenceSummary(), setList()]);
        setPrefSummary(summary);
        setSets(setRows);
      } catch (cause) {
        fail("偏好读取失败", cause);
      }
    })();
  }, [boardOpen, prefSummary, fail]);

  // 详情抽屉：选中才拉 track_detail，seq 守卫同理。
  const detailSeq = useRef(0);
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    void (async () => {
      try {
        const row = await trackDetail(selectedId);
        if (seq === detailSeq.current) setDetail(row);
      } catch (cause) {
        if (seq === detailSeq.current) {
          setDetail(null);
          fail("曲目详情读取失败", cause);
        }
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false);
      }
    })();
  }, [selectedId, fail]);

  // Esc 关抽屉。
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const refreshDetail = useCallback(() => {
    if (selectedId === null) return;
    const seq = ++detailSeq.current;
    void trackDetail(selectedId)
      .then((row) => {
        if (seq === detailSeq.current) setDetail(row);
      })
      .catch(() => undefined);
  }, [selectedId]);

  const onScan = useCallback(async () => {
    const path = scanPath.trim();
    if (path === "" || scanning) return;
    setScanning(true);
    try {
      const result = await scanFolder(path);
      // 进度位常驻最后一句结果；通知条（role=alert）同时报一次，验收 ① 断言的就是它。
      const line = describeScan(result);
      setScanNote(line);
      say(line);
      await Promise.all([refreshStats(), reloadTracks()]);
      refreshDetail();
    } catch (cause) {
      const message = `扫描失败：${cause instanceof Error ? cause.message : String(cause)}`;
      setScanNote(message);
      say(message);
    } finally {
      setScanning(false);
    }
  }, [scanPath, scanning, say, refreshStats, reloadTracks, refreshDetail]);

  const onLearn = useCallback(async () => {
    if (busy !== null) return;
    setBusy("learn");
    try {
      const model: PrefModel = await learnPreferences();
      setLearnRows(describeLearn(model));
      setPrefSummary(await preferenceSummary());
    } catch (cause) {
      fail("学习失败", cause);
    } finally {
      setBusy(null);
    }
  }, [busy, fail]);

  const onImportHistory = useCallback(async () => {
    if (busy !== null) return;
    setBusy("import");
    try {
      const report = await importHistory();
      say(describeImport(report));
      setSets(await setList());
    } catch (cause) {
      fail("历史导入失败", cause);
    } finally {
      setBusy(null);
    }
  }, [busy, say, fail]);

  const onAnalyze = useCallback(async () => {
    if (busy !== null) return;
    setBusy("analyze");
    try {
      const result = await analyzeMissing(25);
      say(
        `补齐缺失分析：候选 ${result.candidates} · 补全 ${result.analysed} · 失败 ${result.failed}` +
          (result.errors.length > 0 ? `（${result.errors[0]}）` : "") +
          `，用时 ${result.ms}ms`,
      );
      await Promise.all([refreshStats(), reloadTracks()]);
      refreshDetail();
    } catch (cause) {
      fail("补齐分析失败", cause);
    } finally {
      setBusy(null);
    }
  }, [busy, say, fail, refreshStats, reloadTracks, refreshDetail]);

  // 忘记偏好：两次点击确认（第一次 arm 5 秒，第二次才真删）。
  const onForget = useCallback(async () => {
    if (busy !== null) return;
    if (!forgetArmed) {
      setForgetArmed(true);
      window.setTimeout(() => setForgetArmed(false), 5000);
      return;
    }
    setBusy("forget");
    setForgetArmed(false);
    try {
      await forgetPreferences(forgetHistory);
      say(forgetHistory ? "偏好模型与导入历史都已忘掉" : "偏好模型已忘掉（导入的 set 与历史保留）");
      setLearnRows(null);
      const [summary, setRows] = await Promise.all([preferenceSummary(), setList()]);
      setPrefSummary(summary);
      setSets(setRows);
    } catch (cause) {
      fail("忘记偏好失败", cause);
    } finally {
      setBusy(null);
    }
  }, [busy, forgetArmed, forgetHistory, say, fail]);

  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const patchForm = (patch: Partial<FilterForm>) => setForm((current) => ({ ...current, ...patch }));
  const active = filtersActive(form);
  const libraryEmpty = stats !== null && stats.tracks === 0;
  const missing = stats?.missing_analysis ?? 0;

  return (
    <div className="sr-lib">
      <div className="sr-lib-topbar">
        <input
          className="sr-input sr-lib-scanpath"
          value={scanPath}
          placeholder="文件夹路径，如 ~/Documents/ShadowRoom/recordings"
          aria-label="要扫描的文件夹路径"
          onChange={(event) => setScanPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onScan();
          }}
        />
        <button type="button" className="sr-btn sr-btn--accent" disabled={scanPath.trim() === "" || scanning} onClick={() => void onScan()}>
          {scanning ? "扫描中…" : "扫描文件夹"}
        </button>
        <span className="sr-lib-scanprogress" data-slot="scan-progress" aria-live="polite">
          {scanning ? "扫描中…" : (scanNote ?? "")}
        </span>
        <span className="sr-lib-count">{stats === null ? "统计读取中…" : `共 ${stats.tracks} 首 · 缺分析 ${missing}`}</span>
        <button
          type="button"
          className="sr-btn"
          data-open={boardOpen || undefined}
          aria-expanded={boardOpen}
          onClick={() => setBoardOpen((open) => !open)}
        >
          统计与偏好
        </button>
        <span className="sr-lib-linkage">推荐与排歌在 DJ 页 · 曲目库管「入库 / 可查 / 可学」</span>
      </div>

      {boardOpen ? (
        <section className="sr-lib-board" aria-label="统计与偏好">
          <div className="sr-lib-tiles">
            <div className="sr-lib-tile">
              <span className="sr-lib-tile-num">{stats?.tracks ?? "—"}</span>
              <span className="sr-lib-tile-cap">曲目</span>
            </div>
            <div className="sr-lib-tile">
              <span className="sr-lib-tile-num">{stats ? `${Math.round(stats.bpm_rate * 100)}%` : "—"}</span>
              <span className="sr-lib-tile-cap">有 BPM（{stats?.with_bpm ?? "—"}）</span>
            </div>
            <div className="sr-lib-tile">
              <span className="sr-lib-tile-num">{stats ? `${Math.round(stats.key_rate * 100)}%` : "—"}</span>
              <span className="sr-lib-tile-cap">有调性（{stats?.with_key ?? "—"}）</span>
            </div>
            <div className="sr-lib-tile">
              <span className="sr-lib-tile-num">{stats?.crates ?? "—"}</span>
              <span className="sr-lib-tile-cap">crate</span>
            </div>
            <div className="sr-lib-tile">
              <span className="sr-lib-tile-num">{stats ? formatBytes(stats.db_bytes) : "—"}</span>
              <span className="sr-lib-tile-cap">库体积</span>
            </div>
          </div>

          <div className="sr-lib-pref">
            <p className="sr-lib-pref-summary">{prefSummary ?? "偏好摘要读取中…"}</p>
            {learnRows !== null ? (
              <ul className="sr-lib-pref-rows">
                {learnRows.map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="sr-lib-sets">
            <p className="sr-lib-sets-cap">从哪些 set 学的</p>
            {sets === null ? (
              <p className="sr-lib-empty">读取中…</p>
            ) : sets.length === 0 ? (
              <p className="sr-lib-empty">还没有导入过 set——点下面的「读取 Rekordbox / Serato 历史」。</p>
            ) : (
              <ul className="sr-lib-set-rows">
                {sets.map((set) => (
                  <li key={set.id} className="sr-lib-set-row">
                    <span className="sr-lib-set-source">{set.source}</span>
                    <span className="sr-lib-set-name">{set.name}</span>
                    <span className="sr-lib-count">{set.track_count} 首</span>
                    <span className="sr-lib-count">{formatPlayedAt(set.played_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sr-lib-actions">
            <button type="button" className="sr-btn" disabled={busy !== null} onClick={() => void onLearn()}>
              {busy === "learn" ? "学习中…" : "重新学习"}
            </button>
            <button type="button" className="sr-btn" disabled={busy !== null} onClick={() => void onImportHistory()}>
              {busy === "import" ? "导入中…" : "读取 Rekordbox / Serato 历史"}
            </button>
            <button type="button" className="sr-btn" disabled={busy !== null || missing === 0} onClick={() => void onAnalyze()}>
              {busy === "analyze" ? "补齐中…" : `补齐缺失分析（${missing}）`}
            </button>
            <span className="sr-lib-actions-gap" />
            {/* 危险动作包成一组：换行整组一起落，checkbox 与按钮永远相邻、不被拆出视野。 */}
            <span className="sr-lib-forget-group">
              <label className="sr-lib-forget-history">
                <input type="checkbox" checked={forgetHistory} onChange={(event) => setForgetHistory(event.target.checked)} />
                连同 set 与历史一起删
              </label>
              <button
                type="button"
                className="sr-btn sr-lib-forget"
                data-armed={forgetArmed || undefined}
                disabled={busy !== null}
                onClick={() => void onForget()}
              >
                {busy === "forget" ? "忘记中…" : forgetArmed ? "再点一次确认忘记" : "忘记偏好"}
              </button>
            </span>
          </div>
        </section>
      ) : null}

      {notice !== null ? (
        <div className="sr-lib-notice" role="alert">
          {notice}
        </div>
      ) : null}

      <div className="sr-lib-main" data-drawer={selectedId !== null || undefined}>
        <section className="sr-lib-list" aria-label="曲目列表">
          <div className="sr-lib-filters">
            <input
              className="sr-input"
              value={form.query}
              placeholder="搜索 标题/艺人/专辑"
              aria-label="搜索标题、艺人、专辑"
              onChange={(event) => patchForm({ query: event.target.value })}
            />
            <input
              className="sr-input sr-input--num"
              value={form.bpmMin}
              placeholder="BPM ≥"
              aria-label="BPM 下限"
              inputMode="decimal"
              onChange={(event) => patchForm({ bpmMin: event.target.value })}
            />
            <input
              className="sr-input sr-input--num"
              value={form.bpmMax}
              placeholder="BPM ≤"
              aria-label="BPM 上限"
              inputMode="decimal"
              onChange={(event) => patchForm({ bpmMax: event.target.value })}
            />
            <input
              className="sr-input sr-input--key"
              value={form.camelot}
              placeholder="如 8A"
              aria-label="Camelot 调性代码"
              onChange={(event) => patchForm({ camelot: event.target.value })}
            />
            <input
              className="sr-input sr-lib-tag"
              value={form.tag}
              placeholder="tag"
              aria-label="genre tag"
              onChange={(event) => patchForm({ tag: event.target.value })}
            />
            {active ? (
              <button type="button" className="sr-btn" onClick={() => setForm(EMPTY_FILTERS)}>
                清除筛选
              </button>
            ) : null}
          </div>
          <span className="sr-lib-count">
            {tracks === null
              ? "加载中…"
              : `显示 ${tracks.length} 首（共 ${stats?.tracks ?? "—"} 首）${tracks.length >= 200 ? " · 只显示前 200" : ""}`}
          </span>
          <div className="sr-lib-rows">
            {tracks !== null && tracks.length === 0 ? (
              libraryEmpty ? (
                <p className="sr-lib-empty">还没有曲目。在上面填一个文件夹路径，点「扫描文件夹」把音乐收进来。</p>
              ) : active ? (
                <p className="sr-lib-empty">没有符合条件的曲目——放宽 BPM 区间或清掉筛选试试。</p>
              ) : (
                <p className="sr-lib-empty">没有曲目。</p>
              )
            ) : null}
            {(tracks ?? []).map((track) => (
              <button
                key={track.id}
                type="button"
                className="sr-lib-row"
                data-selected={selectedId === track.id || undefined}
                onClick={() => setSelectedId((current) => (current === track.id ? null : track.id))}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, path: track.path });
                }}
              >
                <span className="sr-lib-row-title">{track.title ?? track.path.split("/").pop()}</span>
                <span className="sr-lib-row-artist">{track.artist ?? "—"}</span>
                <span className="sr-lib-row-bpm">{track.bpm === null ? "—" : `${Math.round(track.bpm * 10) / 10} BPM`}</span>
                <span className="sr-lib-row-key">{track.camelot ?? track.key ?? "—"}</span>
                <span className="sr-lib-row-time">{formatMs(track.duration_ms)}</span>
                <span className="sr-lib-row-source">{sourceOf(track.path)}</span>
              </button>
            ))}
          </div>
        </section>

        {selectedId !== null ? (
          <aside className="sr-lib-drawer" aria-label="曲目详情">
            <header className="sr-lib-drawer-head">
              <span className="sr-lib-cover" data-slot="cover" aria-label="封面（二期提取嵌入封面与 cover.jpg）">
                封面
              </span>
              <strong className="sr-lib-drawer-title">{detail?.title ?? "曲目详情"}</strong>
              <button type="button" className="sr-lib-close" aria-label="关闭详情" onClick={() => setSelectedId(null)}>
                ×
              </button>
            </header>
            {detailLoading ? <p className="sr-lib-empty">读取中…</p> : null}
            {!detailLoading && detail === null ? <p className="sr-lib-empty">这首读不出来——它可能刚被移走。</p> : null}
            {!detailLoading && detail !== null ? (
              <div className="sr-lib-detail">
                <p className="sr-lib-path" title={detail.path}>
                  {detail.path}
                </p>
                <div className="sr-lib-meta">
                  <span>时长 {formatMs(detail.duration_ms)}</span>
                  <span>BPM {detail.bpm === null ? "—" : Math.round(detail.bpm * 100) / 100}</span>
                  <span>调性 {detail.key ?? "—"}</span>
                  <span>Camelot {detail.camelot ?? "—"}</span>
                  <span>能量 {detail.energy === null ? "—" : `${Math.round(detail.energy * 100)}%`}</span>
                  <span>
                    {detail.sample_rate === null ? "采样率 —" : `${detail.sample_rate} Hz`}
                    {detail.bit_depth === null ? "" : ` · ${detail.bit_depth}-bit`}
                  </span>
                  {detail.artist !== null ? <span>艺人 {detail.artist}</span> : null}
                  {detail.album !== null ? <span>专辑 {detail.album}</span> : null}
                  {detail.genre !== null ? <span>genre {detail.genre}</span> : null}
                  {detail.has_stems === 1 ? <span>已分轨</span> : null}
                </div>
                {missingOf(detail).length > 0 ? (
                  <p className="sr-lib-misses">
                    {missingOf(detail).map((what) => (
                      <span key={what} className="sr-lib-miss">
                        缺 {what}
                      </span>
                    ))}
                    <span className="sr-lib-miss-note">（看板里的「补齐缺失分析」统一补）</span>
                  </p>
                ) : null}
                <div className="sr-lib-crates">
                  <span className="sr-lib-detail-cap">crate</span>
                  {detail.crates.length === 0 ? (
                    <span className="sr-lib-count">不在任何 crate</span>
                  ) : (
                    detail.crates.map((crate) => (
                      <span key={crate.id} className="sr-lib-crate">
                        {crate.name}
                      </span>
                    ))
                  )}
                </div>
                {/* cue 只读块：这里没有任何编辑控件——写 cue 是 DJ 页的事（验收按 DOM 断言）。 */}
                <div className="sr-lib-cues" data-readonly="cues">
                  <span className="sr-lib-detail-cap">Cue（只读）</span>
                  <p className="sr-lib-cue-source">{describeCueSource(detail)}</p>
                  {detail.cues.length === 0 ? null : (
                    <ul className="sr-lib-cue-rows">
                      {detail.cues.map((cue) => (
                        <li key={cue.id} className="sr-lib-cue-row">
                          <span
                            className="sr-lib-cue-dot"
                            style={cue.color === null ? undefined : { backgroundColor: cue.color }}
                            aria-hidden="true"
                          />
                          <span className="sr-lib-cue-name">{cue.display_name}</span>
                          {cue.kind === "loop" ? <span className="sr-lib-cue-badge">loop</span> : null}
                          {cue.role !== null ? <span className="sr-lib-cue-badge">{cue.role}</span> : null}
                          {cue.slot !== null ? <span className="sr-lib-cue-badge">{slotLetter(cue.slot)}</span> : null}
                          {cue.cue_type !== null ? <span className="sr-lib-cue-badge">{cue.cue_type}</span> : null}
                          <span className="sr-lib-cue-time">
                            {formatMs(cue.position_ms)}
                            {cue.end_ms !== null ? ` → ${formatMs(cue.end_ms)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="sr-lib-cue-note">Cue 与颜色在 DJ 页编辑（这页只读）。</p>
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {menu !== null ? (
        <div
          className="sr-lib-rowmenu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 120) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="sr-lib-rowmenu-item"
            onClick={() => {
              void navigator.clipboard
                .writeText(menu.path)
                .then(() => say("路径已复制"))
                .catch(() => say(`复制不了，手动复制：${menu.path}`));
              setMenu(null);
            }}
          >
            复制路径
          </button>
          <button
            type="button"
            role="menuitem"
            className="sr-lib-rowmenu-item"
            disabled
            title="浏览器预览里开不了系统文件夹——桌面壳（Electron）里可用"
          >
            打开所在文件夹
          </button>
        </div>
      ) : null}
    </div>
  );
}
