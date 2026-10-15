/**
 * 音色/采样浏览器纯逻辑（#bitwig-adoption D 项，缩水版）：GM128 名表、试听音符、过滤与
 * 拖拽 payload。本文件只放纯函数与静态数据（node 单测直接 import）；
 * <audio> 与合成器运行时在 components/StudioSoundsDrawer.tsx。
 *
 * 两处规格歧义自裁（裁决书 §②D 未写明，记此备查）：
 * ① GM 音色没有音频文件可流，HTMLAudio 物理上试听不了音色——音色试听走现有 lib/synth
 *    NotePlayer（WebAudio，起音 ≪100ms）；「单共享 HTMLAudio」按规格本意管采样 tab。
 * ② 桥目前没有任何目录列表端点（裁决书「已有」系误判）——imports 由调用方 props 注入，
 *    挂载阶段再定 fetch 通道。
 */
import { GM_HINTS, GM_NAMES } from "./studio-sounds-gm128";
import type { StudioNote } from "./studio";

/** 拖音色/采样的自定义 MIME（与试凑区 SCRATCH_MIME 同套路，时间轴 Files 通道不碰它）。 */
export const SOUND_MIME = "application/x-shadowroom-sound";

export type SoundDragPayload =
  | { kind: "instrument"; program: number; name: string }
  | { kind: "sample"; path: string; name: string };

export function encodeSoundDrag(payload: SoundDragPayload): string {
  return JSON.stringify(payload);
}

/** 解析拖拽 payload；坏 JSON / 缺字段 / program 越界一律 null（落点 handler 直接 return）。 */
export function decodeSoundDrag(raw: string): SoundDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.kind === "instrument" && typeof parsed.program === "number" && typeof parsed.name === "string") {
      if (!Number.isInteger(parsed.program) || parsed.program < 0 || parsed.program > 127) return null;
      return { kind: "instrument", program: parsed.program, name: parsed.name };
    }
    if (parsed.kind === "sample" && typeof parsed.path === "string" && parsed.path !== "" && typeof parsed.name === "string") {
      return { kind: "sample", path: parsed.path, name: parsed.name };
    }
    return null;
  } catch {
    return null;
  }
}

export type GmSound = { program: number; name: string; hint?: string };

/** GM 128 音色（bank 0，program 0–127）；精选 16 个带中文一句话（soundfont-renderer 同款）。 */
export const GM_SOUNDS: GmSound[] = GM_NAMES.map((name, program) => {
  const hint = GM_HINTS[program];
  return hint === undefined ? { program, name } : { program, name, hint };
});

export type SampleEntry = { path: string; name: string };

/** 大小写不敏感子串过滤；空串/空白 = 原样（≤328 项线性过一遍，无虚拟化必要）。 */
export function filterSounds<T extends { name: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  return items.filter((item) => item.name.toLowerCase().includes(q));
}

/** 音色试听音符：短琶音听出音色性格；Percussion（program 112–119）给密集短音。 */
export function auditionNotes(program: number): StudioNote[] {
  const note = (midi: number, start: number, end: number): StudioNote => ({ start_ms: start, end_ms: end, midi });
  if (program >= 112 && program <= 119) {
    return [note(60, 0, 90), note(60, 150, 240), note(67, 300, 390)];
  }
  return [note(60, 0, 320), note(64, 180, 500), note(67, 360, 850)];
}

/** 采样试听 = 单个共享 <audio> 换 src（规格 §②D：复用不新建，点击→出声 ≤100ms 的物理前提）。 */
export function auditionSample(
  element: { src: string; currentTime: number; play: () => Promise<void> },
  url: string,
): void {
  element.src = url;
  element.currentTime = 0;
  void element.play().catch(() => undefined);
}
