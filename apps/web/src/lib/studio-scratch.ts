/**
 * 试凑区（Pattern scratch pad，#bitwig-adoption A 项，缩水版 launcher）：
 * 候选格 + 小节量化循环 + 拖进时间轴。本文件只放纯函数（node 单测直接 import）；
 * <audio> 运行时在 components/StudioScratchPad.tsx。
 */
import type { StudioClip, StudioProject } from "./studio";

/** 格子上限 = MAX_TRACKS(10) × 6 候选（裁决书 §② A）；超出按旧到新剪。 */
export const SCRATCH_MAX_CELLS = 60;
/** 同时发声循环上限：第 5 个顶掉最旧的。 */
export const SCRATCH_MAX_LOOPS = 4;
/** 拖格的自定义 MIME（时间轴的 Files 通道不碰它）。 */
export const SCRATCH_MIME = "application/x-shadowroom-scratch";

export function addScratchClip(project: StudioProject, clip: StudioClip): StudioProject {
  const scratch = [...(project.scratch ?? []), clip];
  return { ...project, scratch: scratch.slice(-SCRATCH_MAX_CELLS) };
}

export function removeScratchClip(project: StudioProject, clipId: string): StudioProject {
  return { ...project, scratch: (project.scratch ?? []).filter((clip) => clip.id !== clipId) };
}

/**
 * 下一小节边界（ms，origin 起算）。ε=1ms：「恰好在边界上」算当前这条，不再多等一拍——
 * 循环启动误差按 |实际启动-预定边界| ≤ 30ms 验收，这里不许系统性偏一拍。
 */
export function nextBarBoundaryMs(nowMs: number, barMs: number, originMs: number): number {
  const elapsed = Math.max(0, nowMs - originMs);
  return originMs + Math.ceil((elapsed + 1) / barMs) * barMs;
}

export type LoopSlot = { clipId: string; startedAt: number };

/** 循环槽准入：已在槽=不动；未满=追加；满了=顶掉最旧的（槽位按 startedAt 升序）。 */
export function admitLoop(
  slots: LoopSlot[],
  clipId: string,
  now: number,
  max: number = SCRATCH_MAX_LOOPS,
): { slots: LoopSlot[]; evicted: string[] } {
  if (slots.some((slot) => slot.clipId === clipId)) return { slots, evicted: [] };
  if (slots.length < max) return { slots: [...slots, { clipId, startedAt: now }], evicted: [] };
  return { slots: [...slots.slice(1), { clipId, startedAt: now }], evicted: [slots[0].clipId] };
}
