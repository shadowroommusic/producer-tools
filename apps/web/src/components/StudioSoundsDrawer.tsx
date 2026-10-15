/**
 * 音色/采样浏览器（#bitwig-adoption D 项，缩水版）：左侧抽屉，与试凑区同栏的两个 tab ——
 * 「音色」= GM128 名表（静态打包，点击用现有合成器试听，拖到轨道头 = 指定音色）；
 * 「采样」= imports/ 列表（props 注入，点击用单个共享 <audio> 试听，拖 = 落 clip）。
 * 不做 packs 生态/云内容/标签筛选（裁决书 §③ 不做清单）。
 *
 * 性能口径（§②D）：列表 ≤328 项 memo 行不虚拟化；试听共享 1 个 <audio> 换 src 不新建；
 * 首帧 ≤16ms；bundle ≤4KB；零新依赖。样式内联在本文件：刀3 阶段一不动 app.css，
 * 避免与刀2（ZCode 检视器）撞文件；挂载阶段再收敛进样式表。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createNotePlayer, type NotePlayer, type NoteVoice } from "../lib/synth";
import {
  GM_SOUNDS,
  SOUND_MIME,
  auditionNotes,
  auditionSample,
  encodeSoundDrag,
  filterSounds,
  type GmSound,
  type SampleEntry,
} from "../lib/studio-sounds";
import { fileUrl } from "../lib/studio";

declare global {
  interface Window {
    /** e2e 探针：点击→出声实测（验收线 ≤100ms，两 tab 都打）。 */
    __soundsProbe?: { lastAuditionMs: number | null };
  }
}

type Props = {
  /**
   * imports/ 采样清单。给了就用给的（测试/隔离渲染）；不给 = 生产路径：每次展开自拉
   * GET /api/agent/dir?dir=imports（agent-bridge 030c4d8；本文件是该端点在 web 侧唯一调用点）。
   */
  imports?: SampleEntry[];
  /** 复用走带的合成器；不给 = 首次点音色时自建（本组件独立自验的场景）。 */
  notePlayer?: NotePlayer;
  /** 行高 px（首帧口径：128+200 项在容器内只参与一次排版）。 */
  rowHeight?: number;
  /** 抽屉宽 px（默认 248）；<260 时隐藏 hint 列——名字优先（F-6 规格）。 */
  width?: number;
};

const styles = {
  /* F-6 覆盖式：浮在轨道头列之上，不占布局宽度（展开前后 lane 可视宽度差 = 0 的物理保证）。
     sr-studio-body 有 position:relative，这里 absolute 相对它定位；背景必须用 tokens 里
     真实定义的浮层填充——var(--sr-panel) 没有定义，透明底会把下层时间线透出来。 */
  aside: {
    position: "absolute", left: 0, top: 8, bottom: 8, zIndex: 5,
    display: "flex", flexDirection: "column",
    border: "0.5px solid var(--sr-border-strong)", borderRadius: 10,
    background: "var(--sr-floating-fill, var(--sr-surface-elevated, #1a1d16))",
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
    overflow: "hidden",
  },
  head: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "6px 8px", borderBottom: "0.5px solid var(--sr-border-strong)",
  },
  title: { fontSize: 12, fontWeight: 600 },
  count: { fontSize: 10, color: "var(--sr-text-dim)" },
  tabs: { display: "flex", gap: 4, padding: "6px 8px", borderBottom: "0.5px solid var(--sr-border-strong)" },
  tab: (active: boolean): CSSProperties => ({
    flex: 1, padding: "3px 0", fontSize: 11, cursor: "pointer",
    border: `0.5px solid ${active ? "var(--sr-accent)" : "var(--sr-border-strong)"}`,
    borderRadius: 6, background: active ? "var(--sr-panel-strong, transparent)" : "transparent",
    color: active ? "inherit" : "var(--sr-text-dim)",
  }),
  search: {
    margin: "6px 8px", padding: "3px 8px", fontSize: 11,
    background: "transparent", color: "inherit",
    border: "0.5px solid var(--sr-border-strong)", borderRadius: 6,
  },
  list: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 4, padding: "0 8px 8px", overflowY: "auto" },
  row: (playing: boolean, height: number): CSSProperties => ({
    flex: "none", height, display: "flex", alignItems: "center", gap: 6, padding: "0 8px",
    border: `0.5px solid ${playing ? "var(--sr-accent)" : "var(--sr-border-strong)"}`,
    boxShadow: playing ? "0 0 0 0.5px var(--sr-accent) inset" : undefined,
    borderRadius: 8, cursor: "grab", userSelect: "none",
    // 首帧 ≤16ms 的物理手段：屏外行跳过排版（DOM 还在，选择器/count 不受影响），
    // contain-intrinsic 给占位尺寸防滚动条抖动。csstype 版本不一定收这三个属性，强转兜底。
    ...({
      contentVisibility: "auto",
      containIntrinsicWidth: "auto 200px",
      containIntrinsicHeight: `auto ${height}px`,
    } as CSSProperties),
  }),
  program: { flex: "none", width: 28, fontSize: 10, color: "var(--sr-text-dim)", fontFamily: "monospace" },
  name: { flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  hint: { maxWidth: 90, fontSize: 10, color: "var(--sr-text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: { margin: "4px 0", fontSize: 11, color: "var(--sr-text-dim)" },
  collapse: { border: 0, background: "transparent", color: "var(--sr-text-dim)", cursor: "pointer", fontSize: 12, padding: "0 2px" },
} satisfies Record<string, CSSProperties | ((...args: never[]) => CSSProperties)>;

const InstrumentRow = memo(function InstrumentRow({
  sound, playing, rowHeight, showHints, onAudition,
}: { sound: GmSound; playing: boolean; rowHeight: number; showHints: boolean; onAudition: (sound: GmSound) => void }) {
  const style = useMemo(() => styles.row(playing, rowHeight), [playing, rowHeight]);
  return (
    <div
      data-sound-key={`gm:${sound.program}`}
      data-kind="instrument"
      data-program={sound.program}
      data-name={sound.name}
      data-playing={playing || undefined}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          SOUND_MIME,
          encodeSoundDrag({ kind: "instrument", program: sound.program, name: sound.name }),
        );
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAudition(sound)}
      title={sound.hint ?? `${sound.name} · 点=试听，拖到轨道头=指定音色`}
      style={style}
    >
      <span style={styles.program}>{String(sound.program).padStart(3, "0")}</span>
      <span style={styles.name}>{sound.name}</span>
      {showHints && sound.hint !== undefined && <span style={styles.hint}>{sound.hint}</span>}
    </div>
  );
});

const SampleRow = memo(function SampleRow({
  entry, playing, rowHeight, onAudition,
}: { entry: SampleEntry; playing: boolean; rowHeight: number; onAudition: (entry: SampleEntry) => void }) {
  const style = useMemo(() => styles.row(playing, rowHeight), [playing, rowHeight]);
  return (
    <div
      data-sound-key={`sample:${entry.path}`}
      data-kind="sample"
      data-path={entry.path}
      data-name={entry.name}
      data-playing={playing || undefined}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          SOUND_MIME,
          encodeSoundDrag({ kind: "sample", path: entry.path, name: entry.name }),
        );
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAudition(entry)}
      title={`${entry.name} · 点=试听，拖到轨道=落 clip`}
      style={style}
    >
      <span style={styles.name}>{entry.name}</span>
    </div>
  );
});

function SoundsDrawerInner({ imports, notePlayer, rowHeight = 28, width = 248 }: Props) {
  /** 默认收起成 rail（与试凑区同款）：首帧成本 ≈ 0，采样清单等展开了再拉。 */
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"instrument" | "sample">("instrument");
  const showHints = width >= 260;
  const asideRef = useRef<HTMLElement | null>(null);
  const [queries, setQueries] = useState({ instrument: "", sample: "" });
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  /** 采样共享试听元素：首次点采样时建，之后只换 src（规格：复用不新建）。 */
  const sampleAudio = useRef<HTMLAudioElement | null>(null);
  const ownPlayer = useRef<NotePlayer | null>(null);
  const voice = useRef<NoteVoice | null>(null);
  const voiceTimer = useRef<number | null>(null);

  /**
   * AudioContext 冷启动（实测首次创建 ~120ms，吃满 §④D 的 ≤100ms 线）挪到 pointerdown：
   * 与 click 同属一次按下的事件序列，autoplay 策略同样放行——用户点下的瞬间 context 已建，
   * click 处理器里只剩振荡器调度（个位数 ms）。不改「点击→出声」口径，只挪创建时机。
   */
  const warmContext = useCallback(() => {
    const player = notePlayer ?? (ownPlayer.current ??= createNotePlayer());
    player.context();
  }, [notePlayer]);

  const auditionSound = useCallback(
    (sound: GmSound) => {
      const player = notePlayer ?? (ownPlayer.current ??= createNotePlayer());
      voice.current?.stop();
      if (voiceTimer.current !== null) window.clearTimeout(voiceTimer.current);
      const t0 = performance.now();
      voice.current = player.play(auditionNotes(sound.program), { leadSeconds: 0, gain: 0.8 });
      const key = `gm:${sound.program}`;
      setPlayingKey(key);
      voiceTimer.current = window.setTimeout(() => {
        voice.current = null;
        setPlayingKey((current) => (current === key ? null : current));
      }, 950);
      window.__soundsProbe = { lastAuditionMs: performance.now() - t0 };
    },
    [notePlayer],
  );

  const auditionOneSample = useCallback((entry: SampleEntry) => {
    sampleAudio.current ??= new Audio();
    const element = sampleAudio.current;
    const t0 = performance.now();
    auditionSample(element, fileUrl(entry.path));
    const key = `sample:${entry.path}`;
    setPlayingKey(key);
    const clear = () => setPlayingKey((current) => (current === key ? null : current));
    element.onended = clear;
    element.onerror = clear;
    window.__soundsProbe = { lastAuditionMs: performance.now() - t0 };
  }, []);

  /** 卸载全停：合成器 voice、采样元素、自建 context（复用的那个别动）。 */
  useEffect(
    () => () => {
      if (voiceTimer.current !== null) window.clearTimeout(voiceTimer.current);
      voice.current?.stop();
      sampleAudio.current?.pause();
      ownPlayer.current?.quiet();
    },
    [],
  );

  /** F-6：点抽屉外任意处收起（× 之外的第二出口）。监听只在展开时挂，收起即卸。 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = asideRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  /** imports 没给 = 生产：每次展开自拉一次目录（收起→展开即刷新，省一个刷新按钮）。 */
  const [fetched, setFetched] = useState<SampleEntry[] | null>(null);
  useEffect(() => {
    if (!open || imports !== undefined) return;
    let cancelled = false;
    fetch("/api/agent/dir?dir=imports")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`dir ${response.status}`))))
      .then((body: { entries?: unknown }) => {
        if (cancelled) return;
        const entries = Array.isArray(body.entries) ? (body.entries as { name: string; path: string }[]) : [];
        setFetched(entries.map((entry) => ({ name: String(entry.name), path: String(entry.path) })));
      })
      .catch(() => {
        if (!cancelled) setFetched([]); // 桥不在/拉失败 = 空态文案，不红屏
      });
    return () => { cancelled = true; };
  }, [open, imports]);
  const samples = imports ?? fetched ?? [];
  const samplesLoading = imports === undefined && fetched === null;

  const visibleSounds = useMemo(() => filterSounds(GM_SOUNDS, queries.instrument), [queries.instrument]);
  const visibleSamples = useMemo(() => filterSounds(samples, queries.sample), [samples, queries.sample]);
  const visibleCount = tab === "instrument" ? visibleSounds.length : visibleSamples.length;
  const total = tab === "instrument" ? GM_SOUNDS.length : samples.length;

  if (!open) {
    return (
      <button type="button" className="sr-sounds-rail sr-mono" onPointerDownCapture={warmContext} onClick={() => setOpen(true)}>
        音色浏览器
      </button>
    );
  }

  return (
    <aside
      ref={asideRef}
      style={{ ...styles.aside, width }}
      aria-label="音色浏览器"
      onPointerDownCapture={warmContext}
    >
      <header style={styles.head}>
        <span style={styles.title}>音色浏览器</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={styles.count}>{visibleCount}/{total}</span>
          <button type="button" style={styles.collapse} aria-label="收起音色浏览器" title="收起音色浏览器" onClick={() => setOpen(false)}>
            ×
          </button>
        </span>
      </header>
      <div style={styles.tabs} role="tablist">
        <button
          type="button" role="tab" data-tab="instrument" aria-selected={tab === "instrument"}
          style={styles.tab(tab === "instrument")} onClick={() => setTab("instrument")}
        >
          音色 · {GM_SOUNDS.length}
        </button>
        <button
          type="button" role="tab" data-tab="sample" aria-selected={tab === "sample"}
          style={styles.tab(tab === "sample")} onClick={() => setTab("sample")}
        >
          采样 · {samples.length}
        </button>
      </div>
      <input
        style={styles.search}
        type="search"
        placeholder={tab === "instrument" ? "滤音色…" : "滤采样…"}
        aria-label="过滤音色或采样"
        value={queries[tab]}
        onChange={(event) =>
          setQueries((current) =>
            tab === "instrument" ? { ...current, instrument: event.target.value } : { ...current, sample: event.target.value },
          )
        }
      />
      <div style={styles.list} data-sounds-list="">
        {tab === "instrument"
          ? visibleSounds.map((sound) => (
              <InstrumentRow
                key={sound.program}
                sound={sound}
                playing={playingKey === `gm:${sound.program}`}
                rowHeight={rowHeight}
                showHints={showHints}
                onAudition={auditionSound}
              />
            ))
          : visibleSamples.map((entry) => (
              <SampleRow
                key={entry.path}
                entry={entry}
                playing={playingKey === `sample:${entry.path}`}
                rowHeight={rowHeight}
                onAudition={auditionOneSample}
              />
            ))}
        {visibleCount === 0 && (
          <p style={styles.empty}>
            {tab === "sample" && samplesLoading
              ? "拉 imports/ 中…"
              : total === 0 && tab === "sample"
                ? "imports/ 还是空的（或桥不在）——导入的音频会出现在这里。"
                : "没有匹配。"}
          </p>
        )}
      </div>
    </aside>
  );
}

export const StudioSoundsDrawer = memo(SoundsDrawerInner);
