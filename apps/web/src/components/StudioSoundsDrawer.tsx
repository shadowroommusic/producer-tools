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
  /** imports/ 采样清单（本阶段调用方注入；挂载阶段再定 fetch 通道——桥暂无列目录端点）。 */
  imports: SampleEntry[];
  /** 复用走带的合成器；不给 = 首次点音色时自建（本组件独立自验的场景）。 */
  notePlayer?: NotePlayer;
  /** 行高 px（首帧口径：128+200 项在容器内只参与一次排版）。 */
  rowHeight?: number;
  /** 列表可视高度 px。 */
  height?: number;
};

const styles = {
  aside: {
    flex: "none", width: 248, margin: "8px 0 8px 8px",
    display: "flex", flexDirection: "column",
    border: "0.5px solid var(--sr-border-strong)", borderRadius: 10,
    background: "var(--sr-panel)", overflow: "hidden",
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
  list: { display: "flex", flexDirection: "column", gap: 4, padding: "0 8px 8px", overflowY: "auto" },
  row: (playing: boolean, height: number): CSSProperties => ({
    flex: "none", height, display: "flex", alignItems: "center", gap: 6, padding: "0 8px",
    border: `0.5px solid ${playing ? "var(--sr-accent)" : "var(--sr-border-strong)"}`,
    boxShadow: playing ? "0 0 0 0.5px var(--sr-accent) inset" : undefined,
    borderRadius: 8, cursor: "grab", userSelect: "none",
  }),
  program: { flex: "none", width: 28, fontSize: 10, color: "var(--sr-text-dim)", fontFamily: "monospace" },
  name: { flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  hint: { maxWidth: 90, fontSize: 10, color: "var(--sr-text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  empty: { margin: "4px 0", fontSize: 11, color: "var(--sr-text-dim)" },
} satisfies Record<string, CSSProperties | ((...args: never[]) => CSSProperties)>;

const InstrumentRow = memo(function InstrumentRow({
  sound, playing, rowHeight, onAudition,
}: { sound: GmSound; playing: boolean; rowHeight: number; onAudition: (sound: GmSound) => void }) {
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
      style={styles.row(playing, rowHeight)}
    >
      <span style={styles.program}>{String(sound.program).padStart(3, "0")}</span>
      <span style={styles.name}>{sound.name}</span>
      {sound.hint !== undefined && <span style={styles.hint}>{sound.hint}</span>}
    </div>
  );
});

const SampleRow = memo(function SampleRow({
  entry, playing, rowHeight, onAudition,
}: { entry: SampleEntry; playing: boolean; rowHeight: number; onAudition: (entry: SampleEntry) => void }) {
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
      style={styles.row(playing, rowHeight)}
    >
      <span style={styles.name}>{entry.name}</span>
    </div>
  );
});

function SoundsDrawerInner({ imports, notePlayer, rowHeight = 28, height = 400 }: Props) {
  const [tab, setTab] = useState<"instrument" | "sample">("instrument");
  const [queries, setQueries] = useState({ instrument: "", sample: "" });
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  /** 采样共享试听元素：首次点采样时建，之后只换 src（规格：复用不新建）。 */
  const sampleAudio = useRef<HTMLAudioElement | null>(null);
  const ownPlayer = useRef<NotePlayer | null>(null);
  const voice = useRef<NoteVoice | null>(null);
  const voiceTimer = useRef<number | null>(null);

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

  const visibleSounds = useMemo(() => filterSounds(GM_SOUNDS, queries.instrument), [queries.instrument]);
  const visibleSamples = useMemo(() => filterSounds(imports, queries.sample), [imports, queries.sample]);
  const visibleCount = tab === "instrument" ? visibleSounds.length : visibleSamples.length;
  const total = tab === "instrument" ? GM_SOUNDS.length : imports.length;

  return (
    <aside style={styles.aside} aria-label="音色浏览器">
      <header style={styles.head}>
        <span style={styles.title}>音色浏览器</span>
        <span style={styles.count}>{visibleCount}/{total}</span>
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
          采样 · {imports.length}
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
      <div style={{ ...styles.list, height }} data-sounds-list="">
        {tab === "instrument"
          ? visibleSounds.map((sound) => (
              <InstrumentRow
                key={sound.program}
                sound={sound}
                playing={playingKey === `gm:${sound.program}`}
                rowHeight={rowHeight}
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
            {total === 0 && tab === "sample" ? "imports/ 还是空的——导入的音频会出现在这里。" : "没有匹配。"}
          </p>
        )}
      </div>
    </aside>
  );
}

export const StudioSoundsDrawer = memo(SoundsDrawerInner);
