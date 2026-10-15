/**
 * AI 设 cue 预览的翻译层（#ui-review F-4）：analysis 插件 suggest_cues 的 reason/notes 是
 * 英文技术句，界面是中文——逐句式翻成中文，**映射不中的一律返回 null**，调用方收进 title
 * （hover 才见原文），列表永远只出中文。宁可藏一句，不许翻错一句。
 *
 * 句式全集来自 audio-analysis-dedupe 的 autocue.py（in/out/loop 三类 reason + 7 条 notes，
 * 2026-10-16 对照源码枚举）；插件加了新句式时这里同步补，单测会逼你补。
 */

/** cue 候选的 reason → 中文；不认得的句式 → null。 */
export function zhCueReason(reason: string): string | null {
  const text = reason.trim();
  if (/^first stable onset at \d+ms, snapped \d+ms onto the bar grid/.test(text)) {
    return "第一个稳定起音 · 已对齐小节线";
  }
  if (/^first stable onset at \d+ms; no reliable tempo grid, left unsnapped$/.test(text)) {
    return "第一个稳定起音（速度网格不可信，未对齐小节）";
  }
  let m = text.match(/^energy falls to (\d+)% of the body at \d+ms and never recovers; snapped \d+ms to the bar grid$/);
  if (m !== null) return `能量衰到 ${m[1]}% 且未恢复 · 已对齐小节线`;
  m = text.match(/^energy falls to (\d+)% of the body at \d+ms and never recovers; unsnapped$/);
  if (m !== null) return `能量衰到 ${m[1]}% 且未恢复（未对齐小节）`;
  if (/^no clean final drop found; fallback at \d+% of the duration$/.test(text)) {
    return "没找到干净的尾落 · 按 90% 位置兜底";
  }
  if (text === "the detected drop landed before the in; fallback at 90% instead") {
    return "尾落点在入口之前 · 改按 90% 位置兜底";
  }
  m = text.match(/^(\d+)-beat section repeats immediately \(self-similarity [\d.]+\)$/);
  if (m !== null) return `${m[1]} 拍循环段 · 自相似度高`;
  return null;
}

/** 分析器 notes → 中文；不认得的句式 → null。 */
export function zhCueNote(note: string): string | null {
  const text = note.trim();
  if (text === "tempo grid too unreliable to snap to bar lines") return "速度网格不可信：cue 点未对齐小节线";
  if (text === "no stable start found — the level never settles above the floor") return "没找到稳定起点（响度一直没起来）";
  if (text === "the out is a 90% fallback — the track does not have a clean ending drop") return "出口按 90% 兜底：这首没有干净的尾落";
  if (text === "the natural out conflicted with the in, so the fallback was used") return "自然出口与入口冲突，已用兜底";
  if (text === "loop detection skipped: it needs a trustworthy tempo grid") return "跳过 loop 检测（需要可信的速度网格）";
  if (text === "no 8/16-beat section repeats cleanly enough to offer as a loop") return "没有足够工整的 8/16 拍循环段可提供";
  if (text === "the repeating section starts at or after the out, so no loop was offered") return "循环段起点在出口之后，未提供 loop";
  return null;
}

/** BPM 来源（autocue 的 bpm.source 三值）→ 用户语言。 */
export function zhBpmSource(source: string): string {
  if (source === "argument") return "BPM 来自传入值";
  if (source === "detected") return "BPM 本机检测";
  if (source === "fallback") return "BPM 未知 · 按 120 兜底";
  return source;
}
