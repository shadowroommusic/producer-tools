/**
 * 音色/采样浏览器（#bitwig-adoption D 项，缩水版）：覆盖式抽屉，与试凑区共用左侧 rail——
 * 「音色」= GM128 名表（静态打包，点击用现有合成器试听，拖到轨道头 = 指定音色）；
 * 「采样」= imports/ 列表（props 注入，点击用单个共享 <audio> 试听，拖 = 落 clip）。
 * 不做 packs 生态/云内容/标签筛选（裁决书 §③ 不做清单）。
 *
 * 形态（ui/studio-refresh，2026-10-19）：开关受控于 StudioPage（统一左 rail），Esc / 点外部 /
 * 头部 × 三条出口都能收起；不给 open 时回退自管 + 自渲染 rail 按钮（e2e 隔离挂载的老用法，
 * 类名 .sr-sounds-rail 保留给脚本）。样式已从内联迁进 styles/studio.css（抽屉底座
 * .sr-studio-drawer 与试凑区同款），本文件不再持有样式对象。
 *
 * 性能口径（§②D）：列表 ≤328 项 memo 行不虚拟化（行 content-visibility 跳过屏外排版）；
 * 试听共享 1 个 <audio> 换 src 不新建；首帧 ≤16ms；零新依赖。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createNotePlayer, type NotePlayer, type NoteVoice } from "../lib/synth";
import "../styles/studio.css";
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
  /** 抽屉宽 px（默认 248，CSS 里另有低分辨率收缩上限）；<260 时隐藏 hint 列——名字优先（F-6 规格）。 */
  width?: number;
  /** 受控展开（StudioPage 的统一左 rail 持有状态）；不给 = 自管（隔离挂载，自渲染 rail）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const InstrumentRow = memo(function InstrumentRow({
  sound, playing, rowHeight, showHints, onAudition,
}: { sound: GmSound; playing: boolean; rowHeight: number; showHints: boolean; onAudition: (sound: GmSound) => void }) {
  const style = useMemo<CSSProperties>(
    () => ({ height: rowHeight, containIntrinsicHeight: `auto ${rowHeight}px` }),
    [rowHeight],
  );
  return (
    <div
      className="sr-sounds-row"
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
      <span className="sr-sounds-program">{String(sound.program).padStart(3, "0")}</span>
      <span className="sr-sounds-name">{sound.name}</span>
      {showHints && sound.hint !== undefined && <span className="sr-sounds-hint">{sound.hint}</span>}
    </div>
  );
});

const SampleRow = memo(function SampleRow({
  entry, playing, rowHeight, onAudition,
}: { entry: SampleEntry; playing: boolean; rowHeight: number; onAudition: (entry: SampleEntry) => void }) {
  const style = useMemo<CSSProperties>(
    () => ({ height: rowHeight, containIntrinsicHeight: `auto ${rowHeight}px` }),
    [rowHeight],
  );
  return (
    <div
      className="sr-sounds-row"
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
      <span className="sr-sounds-name">{entry.name}</span>
    </div>
  );
});

function SoundsDrawerInner({
  imports,
  notePlayer,
  rowHeight = 28,
  width,
  open,
  onOpenChange,
}: Props) {
  /** 受控（页面 rail）/ 自管（隔离挂载）二选一：给了 open 就只听页面的。 */
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (onOpenChange !== undefined) onOpenChange(next);
      else setSelfOpen(next);
    },
    [onOpenChange],
  );
  const [tab, setTab] = useState<"instrument" | "sample">("instrument");
  const showHints = (width ?? 248) >= 260;
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

  /** 收起的三条出口之二/三：Esc、点抽屉外（× 是第一条）。监听只在展开时挂，收起即卸。
      左 rail 按钮放行：它的 click 自己带开合逻辑，这里先关一次会让「点活动钮收起」失效。 */
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest(".sr-studio-rail-btn") !== null) return;
      const root = asideRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isOpen, setOpen]);

  /** imports 没给 = 生产：每次展开自拉一次目录（收起→展开即刷新，省一个刷新按钮）。 */
  const [fetched, setFetched] = useState<SampleEntry[] | null>(null);
  useEffect(() => {
    if (!isOpen || imports !== undefined) return;
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
  }, [isOpen, imports]);
  const samples = imports ?? fetched ?? [];
  const samplesLoading = imports === undefined && fetched === null;

  const visibleSounds = useMemo(() => filterSounds(GM_SOUNDS, queries.instrument), [queries.instrument]);
  const visibleSamples = useMemo(() => filterSounds(samples, queries.sample), [samples, queries.sample]);
  const visibleCount = tab === "instrument" ? visibleSounds.length : visibleSamples.length;
  const total = tab === "instrument" ? GM_SOUNDS.length : samples.length;

  if (!isOpen) {
    // 受控模式（页面统一左 rail）下收起就是什么都不渲染；自渲染 rail 只属于非受控的
    // 隔离挂载——否则页内会出现两颗同名类按钮（实测 strict mode violation）。
    if (onOpenChange !== undefined) return null;
    return (
      <button type="button" className="sr-sounds-rail sr-mono" onPointerDownCapture={warmContext} onClick={() => setOpen(true)}>
        音色浏览器
      </button>
    );
  }

  return (
    <aside
      ref={asideRef}
      className="sr-studio-drawer sr-sounds"
      style={width === undefined ? undefined : { width }}
      aria-label="音色浏览器"
      onPointerDownCapture={warmContext}
    >
      <header className="sr-studio-drawer-head">
        <span className="sr-studio-drawer-title">音色浏览器</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="sr-studio-drawer-count">{visibleCount}/{total}</span>
          <button type="button" className="sr-studio-drawer-close" aria-label="收起音色浏览器" title="收起音色浏览器" onClick={() => setOpen(false)}>
            ×
          </button>
        </span>
      </header>
      <div className="sr-sounds-tabs" role="tablist">
        <button
          type="button" role="tab" data-tab="instrument" aria-selected={tab === "instrument"}
          className="sr-sounds-tab" onClick={() => setTab("instrument")}
        >
          音色 · {GM_SOUNDS.length}
        </button>
        <button
          type="button" role="tab" data-tab="sample" aria-selected={tab === "sample"}
          className="sr-sounds-tab" onClick={() => setTab("sample")}
        >
          采样 · {samples.length}
        </button>
      </div>
      <input
        className="sr-sounds-search"
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
      <div className="sr-sounds-list" data-sounds-list="">
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
          <p className="sr-sounds-empty">
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
