/**
 * Peak extraction for clip waveforms.
 *
 * Library first: a track the library has scanned already carries 64-bucket peaks (computed once at
 * scan time), so the studio reuses them instead of re-downloading and re-decoding the whole file.
 * Files the library does not know — or knows without peaks (non-WAV at scan time) — fall back to
 * streaming from the local bridge and decoding once. Results are cached by path, so a timeline with
 * repeated clips resolves each file once.
 */
// 显式 .ts 后缀：单测直接用 node 跑这些 lib（node 的类型剥离不做扩展名解析），tsc 侧有
// allowImportingTsExtensions 放行，Vite 也认。
import { callTool } from "./mcp.ts";
import { fileUrl } from "./studio.ts";

const cache = new Map<string, number[]>();

type TrackRow = { id: number; path?: string | null };
type TrackDetail = { peaks?: number[] | null };

/** 桥的 /api/call 把 MCP 文本内容原样塞进 result——结构化数据是一坨 JSON 字符串（callTool 全家都现场 parse）。 */
function parseResult<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

/**
 * path → library track id, built once per session. An unreachable bridge or plugin yields an empty
 * index: every lookup then misses and peaks fall back to decoding, exactly like before this existed.
 */
let libraryIndex: Promise<Map<string, number>> | null = null;

function listLibraryPaths(): Promise<Map<string, number>> {
  if (libraryIndex === null) {
    libraryIndex = callTool("library", "list_tracks", { limit: 100000 })
      .then(
        (raw) =>
          new Map(
            (parseResult<{ tracks?: TrackRow[] }>(raw).tracks ?? [])
              .filter((row): row is TrackRow & { path: string } => typeof row.path === "string" && row.path !== "")
              .map((row) => [row.path, row.id]),
          ),
      )
      .catch(() => new Map());
  }
  return libraryIndex;
}

/** The library's stored peaks, normalised like the decoder path; null when the library has none. */
async function libraryPeaks(path: string): Promise<number[] | null> {
  const index = await listLibraryPaths();
  const id = index.get(path);
  if (id === undefined) return null;
  try {
    const detail = parseResult<TrackDetail>(await callTool("library", "track_detail", { id }));
    const peaks = detail.peaks;
    if (!Array.isArray(peaks) || peaks.length === 0) return null;
    return normalise(peaks);
  } catch {
    return null;
  }
}

/** Both producers emit absolute bucket peaks; scale so the loudest bucket is 1, as drawn. */
function normalise(peaks: number[]): number[] {
  const loudest = Math.max(...peaks, 0.0001);
  return peaks.map((peak) => Math.min(1, peak / loudest));
}

/** Stream the whole file and decode it once — the fallback for files outside the library. */
async function decodePeaks(path: string, buckets: number): Promise<number[] | null> {
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
    return normalise(peaks);
  } catch {
    return null;
  }
}

/**
 * Peaks in 0–1, or null when neither the library nor a decode can produce them.
 *
 * Cached per path (not per bucket count): a library hit always answers with the library's 64
 * buckets, so the resolved array no longer depends on `buckets` — that parameter only shapes the
 * decode fallback.
 */
export async function peaksFor(path: string, buckets = 96): Promise<number[] | null> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const peaks = (await libraryPeaks(path)) ?? (await decodePeaks(path, buckets));
  if (peaks !== null) cache.set(path, peaks);
  return peaks;
}

/** Tests only: drop the cache and the library index so every case starts cold. */
export function resetPeaksCacheForTest(): void {
  cache.clear();
  libraryIndex = null;
}
