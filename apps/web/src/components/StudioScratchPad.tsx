/**
 * 试凑区（#bitwig-adoption A 项，缩水版 launcher）：AI 的候选先落这里——点格按下一小节
 * 边界循环试听（同时 ≤4 格，第 5 格顶掉最旧的），拖进时间轴才算进歌。
 * 没有 scene、follow actions、第二套音序器（裁决书 §③ 不做清单）。
 *
 * 性能口径（裁决书 §② A）：格子 memo、循环元素复用不新建、启动用 setTimeout 直排（不走
 * rAF 逐帧等）、收起时整条不挂载。playhead 经 getPlayheadBars() 取，面板不跟 60fps 重渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SCRATCH_MAX_LOOPS,
  SCRATCH_MIME,
  admitLoop,
  nextBarBoundaryMs,
  type LoopSlot,
} from "../lib/studio-scratch";
import { fileUrl, isPlayable, type StudioClip } from "../lib/studio";

declare global {
  interface Window {
    /** e2e 探针：循环启动误差实测（验收线 ≤30ms）。 */
    __scratchProbe?: { lastStartErrorMs: number | null };
  }
}

type Props = {
  scratch: StudioClip[];
  bpm: number;
  playing: boolean;
  /** 取当前走带位置（小节，浮点）——引用式取值，避免面板跟随走带逐帧重渲染。 */
  getPlayheadBars: () => number;
  onRemove: (clipId: string) => void;
  onCollapse?: never;
};

function ScratchPadInner({ scratch, bpm, playing, getPlayheadBars, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<LoopSlot[]>([]);
  const players = useRef(new Map<string, HTMLAudioElement>());
  const timers = useRef(new Map<string, number>());
  /** 走带停了以后试凑区自己的时钟原点（首次打开时立）。 */
  const epoch = useRef<number | null>(null);
  const barMs = 240_000 / Math.max(1, bpm);

  const stopLoop = useCallback((clipId: string) => {
    const timer = timers.current.get(clipId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(clipId);
    }
    const element = players.current.get(clipId);
    if (element !== undefined) {
      element.pause();
      element.currentTime = 0;
    }
    setSlots((current) => current.filter((slot) => slot.clipId !== clipId));
  }, []);

  /** 卸载/换工程时全停（元素一并销毁，别留着占内存）。 */
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
      for (const element of players.current.values()) element.pause();
      players.current.clear();
    },
    [],
  );

  const toggle = useCallback(
    (clip: StudioClip) => {
      if (slots.some((slot) => slot.clipId === clip.id)) {
        stopLoop(clip.id);
        return;
      }
      if (!isPlayable(clip.source)) return;
      const now = performance.now();
      if (epoch.current === null) epoch.current = now;
      // 时间轴在播：对齐走带的下一小节；停着：对齐本面板时钟的下一小节（同一 bpm 时基）
      const delay = playing
        ? Math.max(0, (Math.ceil(getPlayheadBars() + 1e-6) - getPlayheadBars()) * barMs)
        : nextBarBoundaryMs(now, barMs, epoch.current) - now;
      const expectedAt = now + delay;
      const timer = window.setTimeout(() => {
        timers.current.delete(clip.id);
        let element = players.current.get(clip.id);
        if (element === undefined) {
          element = new Audio(fileUrl(clip.source as string));
          players.current.set(clip.id, element);
        }
        element.loop = true;
        element.currentTime = 0;
        void element.play().catch(() => undefined);
        window.__scratchProbe = { lastStartErrorMs: performance.now() - expectedAt };
        setSlots((current) => {
          const admitted = admitLoop(current, clip.id, Date.now());
          for (const evictedId of admitted.evicted) stopLoop(evictedId);
          return admitted.slots;
        });
      }, delay);
      timers.current.set(clip.id, timer);
    },
    [slots, playing, getPlayheadBars, barMs, stopLoop],
  );

  const remove = useCallback(
    (clipId: string) => {
      stopLoop(clipId);
      players.current.get(clipId)?.remove();
      players.current.delete(clipId);
      onRemove(clipId);
    },
    [onRemove, stopLoop],
  );

  /** 格外移除（拖进轨道 / agent 改工程）→ 同步停掉它的循环：槽位归还，也别留着没 UI 能停的声音。 */
  useEffect(() => {
    const ids = new Set(scratch.map((clip) => clip.id));
    for (const slot of slots) if (!ids.has(slot.clipId)) stopLoop(slot.clipId);
  }, [scratch, slots, stopLoop]);

  const playingIds = useMemo(() => new Set(slots.map((slot) => slot.clipId)), [slots]);

  if (!open) {
    return (
      <button type="button" className="sr-scratch-rail sr-mono" onClick={() => setOpen(true)}>
        试凑区{scratch.length > 0 ? ` · ${scratch.length}` : ""}
      </button>
    );
  }
  return (
    <aside className="sr-scratch" aria-label="试凑区">
      <header className="sr-scratch-head">
        <span className="sr-scratch-title">试凑区 · 候选 {scratch.length}</span>
        <button type="button" className="sr-icon-btn" title="收起试凑区" onClick={() => setOpen(false)}>
          ×
        </button>
      </header>
      <p className="sr-scratch-hint">
        点格 = 下一小节边界循环试听（同时 ≤{SCRATCH_MAX_LOOPS} 格）· 拖到轨道 = 进歌
      </p>
      <div className="sr-scratch-grid">
        {scratch.map((clip) => {
          const playable = isPlayable(clip.source);
          return (
            <div
              key={clip.id}
              className="sr-scratch-cell"
              data-playing={playingIds.has(clip.id) || undefined}
              data-clip-id={clip.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(SCRATCH_MIME, clip.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => toggle(clip)}
              title={
                playable
                  ? `${clip.name} · ${clip.length} 小节 · 点=循环试听，拖到轨道=进歌`
                  : `${clip.name} · 没有音频可循环（仍可拖进轨道）`
              }
            >
              <span className="sr-scratch-cell-name">{clip.name}</span>
              <span className="sr-scratch-cell-meta sr-mono">
                {clip.length} 小节{playable ? "" : " · 无音频"}
              </span>
              <button
                type="button"
                className="sr-scratch-cell-remove"
                title="从试凑区移除"
                onClick={(event) => {
                  event.stopPropagation();
                  remove(clip.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {scratch.length === 0 && (
          <p className="sr-scratch-empty">让 AI 给你几个版本——候选先落在这里，不直接进歌。</p>
        )}
      </div>
    </aside>
  );
}

export const StudioScratchPad = memo(ScratchPadInner);
