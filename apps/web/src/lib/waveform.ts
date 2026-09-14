/**
 * Peak extraction for clip waveforms.
 *
 * The audio is streamed from the local bridge, decoded once, and reduced to N peaks that the clip can
 * draw. Results are cached by path, so a timeline with repeated clips decodes each file once.
 */
import { fileUrl } from "./studio";

const cache = new Map<string, number[]>();

/** Peaks in 0–1, or null when the file cannot be decoded. */
export async function peaksFor(path: string, buckets = 96): Promise<number[] | null> {
  const key = `${path}@${buckets}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(fileUrl(path));
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    const context = new AudioContext();
    const audio = await context.decodeAudioData(bytes);
    void context.close();
    if (audio.numberOfChannels === 0 || audio.length === 0) return null;
    // mono-fold every channel: peaks should show what you hear, not one side
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    const step = Math.max(1, Math.floor(audio.length / buckets));
    const peaks: number[] = [];
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const from = bucket * step;
      const to = Math.min(from + step, audio.length);
      let peak = 0;
      for (let index = from; index < to; index += 1) {
        let value = 0;
        for (const channel of channels) value = Math.max(value, Math.abs(channel[index]));
        if (value > peak) peak = value;
      }
      peaks.push(peak);
    }
    const loudest = Math.max(...peaks, 0.0001);
    const normalised = peaks.map((peak) => Math.min(1, peak / loudest));
    cache.set(key, normalised);
    return normalised;
  } catch {
    return null;
  }
}
