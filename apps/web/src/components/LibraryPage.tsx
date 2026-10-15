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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileUrl } from "../lib/studio.ts";
import "../styles/library.css";
import {
  EMPTY_FILTERS,
  analyzeMissing,
  buildTrackFilters,
  describeCueSource,
  describeFailure,
  describeImport,
  describeLearn,
  describeScan,
  describeScanProgress,
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
  scanJobDetail,
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
  coverUrl,
  crateList,
  deleteFileLine,
  describeCovers,
  describeMoveToCrate,
  describeRemove,
  dupBadgeMap,
  dupFieldRows,
  findDuplicates,
  partitionDupGroups,
  trackMoveToCrate,
  trackRemove,
  trackRename,
  type CrateRow,
  type DupGroup,
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
  /** 右键菜单（二期全量）：root（动作）/ rename（内联改名）/ crates（加入分类库）三态。 */
  const [menu, setMenu] = useState<{ x: number; y: number; track: TrackRow } | null>(null);
  const [menuMode, setMenuMode] = useState<"root" | "rename" | "crates">("root");
  const [renameValue, setRenameValue] = useState("");
  const [crates, setCrates] = useState<CrateRow[] | null>(null);
  const [newCrateName, setNewCrateName] = useState("");
  /** 试听：一个共享 Audio 元素——流式播放，不像 deck 整文件解码（6 分钟立体声 ≈127MB 的教训）。 */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);
  /** 删除确认（§3/§7.2）：trash 默认焦点取消、permanent 小字链接进入 + 勾选武装。 */
  const [deleteTarget, setDeleteTarget] = useState<{ track: TrackRow; mode: "trash" | "permanent"; detail: TrackDetail | null } | null>(null);
  const [permaArmed, setPermaArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /** 查重：结果留作角标；acoustic 组排队进二选一弹窗；exact/suspect 只上报告与角标。 */
  const [dupBusy, setDupBusy] = useState(false);
  const [dupGroups, setDupGroups] = useState<DupGroup[] | null>(null);
  const [dupQueue, setDupQueue] = useState<DupGroup[]>([]);
  const [dupPanel, setDupPanel] = useState(false);
  const [dupNote, setDupNote] = useState<string | null>(null);

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

  // 扫描是任务了（二期契约）：scan_folder 只给 job_id，进度轮询 scan_job_detail，
  // 成功与失败都只写进度显示位这一个地方（二期 SSE 替换轮询时，UI 一个字都不用改）。
  const scanSeq = useRef(0);
  const onScan = useCallback(async () => {
    const path = scanPath.trim();
    if (path === "" || scanning) return;
    const seq = ++scanSeq.current;
    setScanning(true);
    try {
      const start = await scanFolder(path);
      setScanNote("任务已建立，等进度…");
      const deadline = Date.now() + 10 * 60 * 1000;
      let job = await scanJobDetail(start.job_id);
      while (job.status === "running" && Date.now() < deadline) {
        if (seq !== scanSeq.current) return; // 用户又起了一次扫描，这次轮询作废
        setScanNote(describeScanProgress(job));
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        job = await scanJobDetail(start.job_id);
      }
      if (seq !== scanSeq.current) return;
      if (job.status === "completed") {
        // 封面+分析已挂在扫描管线尾巴上（#94 B1），数字走 job 的 pipeline_json，前端不重复跑
        const line =
          describeScan(job) +
          (job.failed > 0 && job.failures.length > 0 ? `（第一个失败：${describeFailure(job.failures[0])}）` : "");
        setScanNote(line);
      } else if (job.status === "running") {
        setScanNote(`扫了 10 分钟还没完（${job.done}/${job.total}）——任务在后台继续，稍后刷新列表看`);
      } else {
        setScanNote(`扫描失败：${job.error ?? "任务没跑完，原因没说"}`);
      }
      await Promise.all([refreshStats(), reloadTracks()]);
      refreshDetail();
    } catch (cause) {
      if (seq === scanSeq.current) setScanNote(`扫描失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (seq === scanSeq.current) setScanning(false);
    }
  }, [scanPath, scanning, refreshStats, reloadTracks, refreshDetail]);

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
          (result.key_skipped_low_confidence > 0 ? ` · 调性低置信跳过 ${result.key_skipped_low_confidence}` : "") +
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

  // ---- 试听：菜单第一项（唯一出声的动作）。退出路径全停：再点/换歌/播完/报错/离开页面。
  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewing(null);
  }, []);
  const onPreview = useCallback(
    (track: TrackRow) => {
      if (previewing === track.id) {
        stopPreview();
        return;
      }
      audioRef.current?.pause();
      const audio = new Audio(fileUrl(track.path));
      audioRef.current = audio;
      setPreviewing(track.id);
      audio.onended = () => {
        if (audioRef.current === audio) stopPreview();
      };
      audio.onerror = () => {
        if (audioRef.current === audio) {
          stopPreview();
          say(`试听失败：${track.title ?? track.path}`);
        }
      };
      void audio.play().catch(() => undefined);
    },
    [previewing, stopPreview, say],
  );
  useEffect(() => {
    const audio = audioRef;
    return () => {
      audio.current?.pause();
      audio.current = null;
    };
  }, []);

  // ---- 改名（内联，改库 title 不动文件名）
  const onRename = useCallback(async () => {
    if (menu === null) return;
    const title = renameValue.trim();
    if (title === "") return;
    try {
      const res = await trackRename(menu.track.id, title);
      say(`已改名：${res.previous_title ?? menu.track.path.split("/").pop()} → ${res.title}（文件名没动）`);
      setMenu(null);
      await reloadTracks();
      refreshDetail();
    } catch (cause) {
      fail("改名失败", cause);
    }
  }, [menu, renameValue, say, fail, reloadTracks, refreshDetail]);

  // ---- 加入分类库（归类 = 逻辑分类，文件不动）
  const onMoveToCrate = useCallback(
    async (crateName: string) => {
      if (menu === null || crateName.trim() === "") return;
      try {
        const res = await trackMoveToCrate(crateName.trim(), [menu.track.id]);
        say(describeMoveToCrate(res));
        setMenu(null);
        setCrates(null);
        refreshDetail();
      } catch (cause) {
        fail("加入分类库失败", cause);
      }
    },
    [menu, say, fail, refreshDetail],
  );

  // ---- 从曲库移除（规格：不需要确认——文件不动、可逆）
  const onRemoveRow = useCallback(
    async (track: TrackRow) => {
      try {
        const res = await trackRemove(track.id, false, false);
        say(describeRemove(res));
        setMenu(null);
        if (selectedId === track.id) setSelectedId(null);
        await Promise.all([refreshStats(), reloadTracks()]);
      } catch (cause) {
        fail("从曲库移除失败", cause);
      }
    },
    [say, fail, selectedId, refreshStats, reloadTracks],
  );

  // ---- 删除确认（trash / permanent）
  const openDelete = useCallback(
    (track: TrackRow, mode: "trash" | "permanent") => {
      setMenu(null);
      setPermaArmed(false);
      setDeleteTarget({ track, mode, detail: null });
      void trackDetail(track.id)
        .then((row) => setDeleteTarget((current) => (current?.track.id === track.id ? { ...current, detail: row } : current)))
        .catch(() => undefined); // detail 读不到也照删——文件行退化为标题/路径
    },
    [],
  );
  useEffect(() => {
    if (deleteTarget !== null) cancelRef.current?.focus();
  }, [deleteTarget?.mode, deleteTarget === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDeleteConfirm = useCallback(async () => {
    if (deleteTarget === null || deleting) return;
    const { track, mode } = deleteTarget;
    setDeleting(true);
    try {
      const res = await trackRemove(track.id, true, mode === "permanent");
      say(describeRemove(res));
      setDeleteTarget(null);
      if (selectedId === track.id) setSelectedId(null);
      await Promise.all([refreshStats(), reloadTracks()]);
    } catch (cause) {
      fail("删除失败", cause);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, say, fail, selectedId, refreshStats, reloadTracks]);

  // 弹窗的 Esc（删除确认与查重二选一共用）。
  useEffect(() => {
    if (deleteTarget === null && dupQueue.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDeleteTarget(null);
      setDupQueue((queue) => queue.slice(1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteTarget !== null, dupQueue.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 查重：acoustic 弹窗二选一；exact/suspect 只报告与角标（永不自动删）
  const onDedupe = useCallback(async () => {
    if (dupBusy) return;
    setDupBusy(true);
    try {
      // 后端 limit 实际按 id 升序取最旧 N（描述写 newest 与行为不符，已报 ZCode）——
      // 给足覆盖全库的量，否则最新入库的重复对永远查不到；上限 1000 挡超大库的 fpcalc 成本。
      // stats 现取：useCallback 闭包里的 stats 是挂载时的 null（陈旧闭包实测踩过）。
      const fresh = await fetchStats().catch(() => stats);
      const res = await findDuplicates(Math.min(Math.max(fresh?.tracks ?? 200, 200), 1000));
      const { acoustic, exact, suspect } = partitionDupGroups(res.groups);
      setDupGroups(res.groups);
      setDupQueue(acoustic);
      setDupPanel(exact.length > 0 || suspect.length > 0);
      setDupNote(res.degraded);
      say(
        `查重（${res.checked} 首）：声学重复 ${acoustic.length} 组待二选一 · 完全重复 ${exact.length} 组 · 疑似 ${suspect.length} 组` +
          (res.degraded ? `（${res.degraded}）` : ""),
      );
    } catch (cause) {
      fail("查重失败", cause);
    } finally {
      setDupBusy(false);
    }
  }, [dupBusy, say, fail]);

  const onDupKeep = useCallback(
    async (group: DupGroup, keepId: number, otherId: number, otherTitle: string) => {
      try {
        const res = await trackRemove(otherId, true, false); // 规格：另一条移入废纸篓，可找回
        say(`已保留这条，「${otherTitle}」${res.file_action === "trashed" ? "移入废纸篓" : "已移除"}`);
        setDupQueue((queue) => queue.filter((g) => g !== group));
        setDupGroups((current) => (current === null ? current : current.filter((g) => g !== group)));
        if (selectedId === otherId) setSelectedId(null);
        await Promise.all([refreshStats(), reloadTracks()]);
      } catch (cause) {
        fail("保留失败", cause);
      }
    },
    [say, fail, selectedId, refreshStats, reloadTracks],
  );

  const dupBadges = useMemo(() => dupBadgeMap(dupGroups ?? []), [dupGroups]);
  const dupPartition = useMemo(() => partitionDupGroups(dupGroups ?? []), [dupGroups]);

  useEffect(() => {
    if (menu === null) return;
    const close = () => {
      setMenu(null);
      setMenuMode("root");
    };
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
        <button type="button" className="sr-btn" disabled={dupBusy} onClick={() => void onDedupe()}>
          {dupBusy ? "查重中…" : "查重"}
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

      {dupPanel && dupGroups !== null ? (
        <section className="sr-lib-dupreport" aria-label="查重报告">
          <div className="sr-lib-dupreport-head">
            <span>
              查重报告：完全重复 {dupPartition.exact.length} 组 · 疑似重复 {dupPartition.suspect.length} 组——这两层只打角标，
              永不弹窗、永不自动删。
            </span>
            <button type="button" className="sr-lib-close" aria-label="关掉查重报告" onClick={() => setDupPanel(false)}>
              ×
            </button>
          </div>
          {dupPartition.exact.map((group, index) => (
            <p key={`exact-${index}`} className="sr-lib-dupreport-row">
              <span className="sr-lib-dupbadge">完全重复</span>
              <span className="sr-lib-dupreport-names">{group.tracks.map((t) => t.title ?? t.path).join(" ↔ ")}</span>
              <span className="sr-lib-count">{group.reasons[0] ?? ""}</span>
            </p>
          ))}
          {dupPartition.suspect.map((group, index) => (
            <p key={`suspect-${index}`} className="sr-lib-dupreport-row">
              <span className="sr-lib-dupbadge sr-lib-dupbadge--suspect">疑似重复</span>
              <span className="sr-lib-dupreport-names">{group.tracks.map((t) => t.title ?? t.path).join(" ↔ ")}</span>
              <span className="sr-lib-count">{group.reasons[0] ?? ""}</span>
            </p>
          ))}
          {dupNote !== null ? <p className="sr-lib-count">{dupNote}</p> : null}
        </section>
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
                  setMenu({ x: event.clientX, y: event.clientY, track });
                  setMenuMode("root");
                }}
              >
                {track.cover_path === "" ? (
                  // 联网确认没有封面（#94 B2 的显式标记）：与「还没抓过」的占位区分开
                  <span className="sr-lib-row-cover sr-lib-row-cover--none" title="联网确认无封面" aria-label="联网确认无封面" />
                ) : track.cover_path !== null ? (
                  <img className="sr-lib-row-cover" src={coverUrl(track.cover_path)} alt="" loading="lazy" />
                ) : (
                  <span className="sr-lib-row-cover sr-lib-row-cover--ph" aria-hidden="true" />
                )}
                <span className="sr-lib-row-title">{track.title ?? track.path.split("/").pop()}</span>
                {dupBadges.has(track.id) ? <span className="sr-lib-dupbadge">{dupBadges.get(track.id)}</span> : null}
                {previewing === track.id ? (
                  <span
                    className="sr-lib-previewing"
                    role="button"
                    aria-label="停止试听"
                    onClick={(event) => {
                      event.stopPropagation();
                      stopPreview();
                    }}
                  >
                    ■ 停
                  </span>
                ) : null}
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
              {detail?.cover_path ? (
                <img className="sr-lib-cover sr-lib-cover--img" data-slot="cover" src={coverUrl(detail.cover_path)} alt={`${detail?.title ?? "曲目"} 封面`} />
              ) : (
                <span className="sr-lib-cover" data-slot="cover" aria-label="这首没有封面">
                  封面
                </span>
              )}
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
          style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 320) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menuMode === "root" ? (
            <>
              <button type="button" role="menuitem" className="sr-lib-rowmenu-item" onClick={() => { onPreview(menu.track); setMenu(null); }}>
                {previewing === menu.track.id ? "停止试听" : "试听"}
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
              <button
                type="button"
                role="menuitem"
                className="sr-lib-rowmenu-item"
                onClick={() => {
                  setRenameValue(menu.track.title ?? menu.track.path.split("/").pop() ?? "");
                  setMenuMode("rename");
                }}
              >
                编辑名称…
              </button>
              <button
                type="button"
                role="menuitem"
                className="sr-lib-rowmenu-item"
                onClick={() => {
                  setMenuMode("crates");
                  setNewCrateName("");
                  if (crates === null) void crateList().then(setCrates).catch(() => setCrates([]));
                }}
              >
                加入分类库 ▸
              </button>
              <span className="sr-lib-rowmenu-sep" />
              <button type="button" role="menuitem" className="sr-lib-rowmenu-item sr-lib-rowmenu-danger" onClick={() => void onRemoveRow(menu.track)}>
                从曲库移除
              </button>
              <button type="button" role="menuitem" className="sr-lib-rowmenu-item sr-lib-rowmenu-danger" onClick={() => openDelete(menu.track, "trash")}>
                移到废纸篓…
              </button>
              <button type="button" role="menuitem" className="sr-lib-rowmenu-item sr-lib-rowmenu-perma" onClick={() => openDelete(menu.track, "permanent")}>
                彻底删除…
              </button>
            </>
          ) : menuMode === "rename" ? (
            <form
              className="sr-lib-rowmenu-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void onRename();
              }}
            >
              <input
                className="sr-input"
                autoFocus
                value={renameValue}
                aria-label="新名称"
                onChange={(event) => setRenameValue(event.target.value)}
              />
              <span className="sr-lib-rowmenu-hint">Enter 保存 · Esc 取消（只改库里的名字，文件名不动）</span>
            </form>
          ) : (
            <div className="sr-lib-rowmenu-crates">
              {crates === null ? (
                <span className="sr-lib-rowmenu-hint">crate 读取中…</span>
              ) : (
                crates.map((crate) => (
                  <button
                    key={crate.id}
                    type="button"
                    role="menuitem"
                    className="sr-lib-rowmenu-item"
                    onClick={() => void onMoveToCrate(crate.name)}
                  >
                    <span className="sr-lib-rowmenu-crate-name">{crate.name}</span>
                    <span className="sr-lib-count">{crate.tracks} 首</span>
                  </button>
                ))
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onMoveToCrate(newCrateName);
                }}
              >
                <input
                  className="sr-input"
                  value={newCrateName}
                  placeholder="新 crate 名… Enter 建"
                  aria-label="新 crate 名"
                  onChange={(event) => setNewCrateName(event.target.value)}
                />
              </form>
              <button type="button" role="menuitem" className="sr-lib-rowmenu-item" onClick={() => setMenuMode("root")}>
                ‹ 返回
              </button>
            </div>
          )}
        </div>
      ) : null}

      {deleteTarget !== null ? (
        <div className="sr-lib-scrim" onClick={() => setDeleteTarget(null)}>
          <div
            className="sr-lib-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label={deleteTarget.mode === "trash" ? "移到废纸篓确认" : "彻底删除确认"}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="sr-lib-dialog-title">{deleteTarget.mode === "trash" ? "删除以下文件？" : "彻底删除以下文件？"}</p>
            <p className="sr-lib-dialog-file">
              {deleteTarget.detail !== null
                ? deleteFileLine(deleteTarget.detail)
                : (deleteTarget.track.title ?? deleteTarget.track.path)}
            </p>
            <p className="sr-lib-dialog-note">
              {deleteTarget.mode === "trash" ? "文件将移入系统废纸篓，曲库记录一并删除。" : "文件直接从磁盘删除，不进废纸篓、无法恢复。"}
            </p>
            {deleteTarget.mode === "permanent" ? (
              <label className="sr-lib-dialog-arm">
                <input type="checkbox" checked={permaArmed} onChange={(event) => setPermaArmed(event.target.checked)} />
                我知道无法恢复
              </label>
            ) : null}
            <div className="sr-lib-dialog-actions">
              <button ref={cancelRef} type="button" className="sr-btn" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                type="button"
                className="sr-btn sr-lib-dialog-danger"
                disabled={deleting || (deleteTarget.mode === "permanent" && !permaArmed)}
                onClick={() => void onDeleteConfirm()}
              >
                {deleting ? "删除中…" : deleteTarget.mode === "trash" ? "移入废纸篓" : "彻底删除"}
              </button>
            </div>
            {deleteTarget.mode === "trash" ? (
              <button
                type="button"
                className="sr-lib-dialog-permalink"
                onClick={() => {
                  setDeleteTarget((current) => (current === null ? current : { ...current, mode: "permanent" }));
                  setPermaArmed(false);
                }}
              >
                其实想彻底删掉？
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {dupQueue.length > 0 && dupQueue[0].tracks.length >= 2
        ? (() => {
            const group = dupQueue[0];
            const first = group.tracks[0];
            const second = group.tracks[1];
            const rows = dupFieldRows(first, second);
            return (
              <div className="sr-lib-scrim">
                <div className="sr-lib-dialog sr-lib-dupdialog" role="dialog" aria-modal="true" aria-label="重复曲目二选一">
                  <p className="sr-lib-dialog-title">同一首歌的两个文件，保留哪条？（还有 {dupQueue.length} 组）</p>
                  <p className="sr-lib-dialog-note">
                    {group.reasons.join("；")}
                    {group.ber !== null && group.ber !== undefined ? `；BER ${group.ber}` : ""}
                  </p>
                  <div className="sr-lib-dupcards">
                    {[first, second].map((track, index) => (
                      <div key={track.id} className="sr-lib-dupcard">
                        <p className="sr-lib-dupcard-title">{track.title ?? track.path}</p>
                        <dl className="sr-lib-dupfields">
                          {rows.map((row) => (
                            <div key={row.label} className="sr-lib-duprow" data-differ={row.differ || undefined}>
                              <dt>{row.label}</dt>
                              <dd>{index === 0 ? row.a : row.b}</dd>
                            </div>
                          ))}
                        </dl>
                        <button
                          type="button"
                          className="sr-btn sr-btn--accent"
                          onClick={() => void onDupKeep(group, track.id, (index === 0 ? second : first).id, (index === 0 ? second : first).title ?? (index === 0 ? second : first).path)}
                        >
                          保留这条
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="sr-lib-dialog-actions">
                    <button type="button" className="sr-btn" onClick={() => setDupQueue((queue) => queue.slice(1))}>
                      两条都保留
                    </button>
                  </div>
                  <p className="sr-lib-dup-foot">不会自动删——选「保留这条」后，另一条移入废纸篓，可找回。</p>
                </div>
              </div>
            );
          })()
        : null}
    </div>
  );
}
