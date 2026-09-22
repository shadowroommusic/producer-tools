/**
 * Deck engine for the DJ page: two performance decks plus a library-preview deck.
 *
 * Why Web Audio `BufferSource` instead of `<audio>` elements (the Studio's approach): a DJ needs
 * deterministic seek (`start(when, offset)` is sample-exact; `mediaElement.currentTime` seeks
 * asynchronously and snaps to compressed-frame boundaries), and a crossfade that cannot drift
 * (two `<audio>` clocks drift apart and `.volume` ramps on the main thread; `AudioParam` curves
 * run on the audio thread). No `AudioWorklet`: param automation is precise enough, and manual
 * sample-pulling would pin whole tracks in memory with no eviction story (measured in
 * `_reference/stemdeck-dj`, which also clicks on keylock nudges).
 *
 * Memory is the risk of full-track decode (~21 MB/min stereo float32 — WebCodecs streaming was
 * evaluated and rejected for v1), so decoded buffers live in a refcounted LRU: an entry is only
 * evictable when `refCount === 0` and no decode is in flight; a deck pins its track from load until
 * replace/unload (pause keeps the pin — a DJ expects instant resume). If every entry is pinned the
 * cache grows past its limit rather than ever evicting a deck's track mid-performance.
 */
import { fileUrl } from "./studio.ts";

export type DeckId = "A" | "B" | "preview";
export type DeckState = "empty" | "loading" | "ready" | "playing";

export type DeckSnapshot = {
  id: DeckId;
  state: DeckState;
  path: string | null;
  durationMs: number;
  positionMs: number;
  volume: number;
};

export type MixerEvents = {
  onDeckChange?: (snapshot: DeckSnapshot) => void;
  /** Fired only when a track plays out to its end — never by pause/seek/replace. */
  onEnded?: (id: DeckId) => void;
};

/** Equal-power crossfade: x=0 is full A, x=1 is full B, x=0.5 leaves both at ≈0.7071. */
const CROSSFADE_RAMP_S = 0.03;
const gainA = (x: number): number => Math.cos((x * Math.PI) / 2);
const gainB = (x: number): number => Math.sin((x * Math.PI) / 2);

type CacheEntry = {
  buffer: AudioBuffer | null;
  /** Shared in-flight decode: two decks loading the same path await one promise, one fetch. */
  promise: Promise<AudioBuffer> | null;
  refCount: number;
  lastUsed: number;
};

/** Decoded-track store with the house rule: never evict what a deck holds or what is still decoding. */
export class BufferCache {
  private entries = new Map<string, CacheEntry>();
  private clock = 0;
  private readonly limit: number;
  private readonly decode: (path: string) => Promise<AudioBuffer>;

  constructor(limit: number, decode: (path: string) => Promise<AudioBuffer>) {
    this.limit = limit;
    this.decode = decode;
  }

  get size(): number {
    return this.entries.size;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** Get-or-create an entry; the caller awaits `entry.promise` and then pins with `pin()`. */
  acquire(path: string): CacheEntry {
    let entry = this.entries.get(path);
    if (entry === undefined) {
      entry = { buffer: null, promise: null, refCount: 0, lastUsed: ++this.clock };
      entry.promise = this.decode(path).then((buffer) => {
        entry!.buffer = buffer;
        entry!.promise = null;
        return buffer;
      });
      this.entries.set(path, entry);
      this.evict();
    } else {
      entry.lastUsed = ++this.clock;
    }
    return entry;
  }

  pin(entry: CacheEntry): void {
    entry.refCount += 1;
    entry.lastUsed = ++this.clock;
  }

  release(entry: CacheEntry): void {
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsed = ++this.clock;
    this.evict();
  }

  drop(path: string): void {
    this.entries.delete(path);
  }

  private evict(): void {
    // Candidates: idle and not mid-decode. If none qualify the cache stays over-limit on purpose —
    // memory pressure is recoverable, cutting a playing deck is not.
    while (this.entries.size > this.limit) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [path, entry] of this.entries) {
        if (entry.refCount > 0 || entry.promise !== null) continue;
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          victim = path;
        }
      }
      if (victim === null) return;
      this.entries.delete(victim);
    }
  }
}

export type MixerOptions = {
  contextFactory?: () => AudioContext;
  fetchFn?: typeof fetch;
  cacheLimit?: number;
  events?: MixerEvents;
};

export class DjMixer {
  readonly cache: BufferCache;
  private readonly decks: Record<DeckId, Deck>;
  private readonly options: MixerOptions;
  private contextValue: AudioContext | null = null;
  private master: GainNode | null = null;
  private xfadeA: GainNode | null = null;
  private xfadeB: GainNode | null = null;
  private crossfadeX = 0.5;
  private masterVolume = 1;

  constructor(options: MixerOptions = {}) {
    this.options = options;
    const limit = options.cacheLimit ?? 3;
    this.cache = new BufferCache(limit, (path) => this.decode(path));
    this.decks = {
      A: new Deck("A", this),
      B: new Deck("B", this),
      preview: new Deck("preview", this),
    };
  }

  deck(id: DeckId): Deck {
    return this.decks[id];
  }

  /** Lazily created: browsers want a user gesture before an `AudioContext` may start. */
  context(): AudioContext {
    if (this.contextValue === null) {
      this.contextValue = (this.options.contextFactory ?? (() => new AudioContext()))();
      this.master = this.contextValue.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.contextValue.destination);
      // A and B pass through the crossfader; preview goes straight to master so auditioning a
      // track never depends on where the performance crossfade happens to sit.
      this.xfadeA = this.contextValue.createGain();
      this.xfadeA.connect(this.master);
      this.xfadeB = this.contextValue.createGain();
      this.xfadeB.connect(this.master);
      this.decks.A.attach(this.xfadeA);
      this.decks.B.attach(this.xfadeB);
      this.decks.preview.attach(this.master);
      this.applyCrossfade();
    }
    if (this.contextValue.state === "suspended") void this.contextValue.resume();
    return this.contextValue;
  }

  /** Test/metering access to the crossfade params; the UI drives `setCrossfade`, never these. */
  crossfadeParams(): { a: AudioParam; b: AudioParam } {
    this.context();
    return { a: this.xfadeA!.gain, b: this.xfadeB!.gain };
  }

  setCrossfade(x: number): void {
    this.crossfadeX = Math.min(1, Math.max(0, x));
    if (this.contextValue !== null) this.applyCrossfade();
  }

  setMasterVolume(x: number): void {
    this.masterVolume = Math.min(1, Math.max(0, x));
    if (this.master !== null) this.master.gain.value = this.masterVolume;
  }

  private applyCrossfade(): void {
    // AudioParam automation, scheduled as a short fresh curve per move: sample-accurate on the
    // audio thread, no zipper noise, and a wiggling fader just re-schedules (cancel + new curve).
    const now = this.contextValue!.currentTime;
    const targets: Array<[AudioParam, number]> = [
      [this.xfadeA!.gain, gainA(this.crossfadeX)],
      [this.xfadeB!.gain, gainB(this.crossfadeX)],
    ];
    for (const [param, target] of targets) {
      param.cancelScheduledValues(now);
      param.setValueCurveAtTime(new Float32Array([param.value, target]), now, CROSSFADE_RAMP_S);
    }
  }

  private async decode(path: string): Promise<AudioBuffer> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const response = await fetchFn(fileUrl(path));
    if (!response.ok) throw new Error(`fetch failed (${response.status}) for ${path}`);
    const bytes = await response.arrayBuffer();
    return this.context().decodeAudioData(bytes);
  }

  emit(snapshot: DeckSnapshot): void {
    this.options.events?.onDeckChange?.(snapshot);
  }

  emitEnded(id: DeckId): void {
    this.options.events?.onEnded?.(id);
  }
}

export class Deck {
  readonly id: DeckId;
  private readonly mixer: DjMixer;
  private entry: CacheEntry | null = null;
  private path: string | null = null;
  private state: DeckState = "empty";
  private output: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offsetMs = 0;
  private volume = 1;
  /** Invalidates stale async loads: only the latest `load()` may pin its result. */
  private generation = 0;

  constructor(id: DeckId, mixer: DjMixer) {
    this.id = id;
    this.mixer = mixer;
  }

  /** The deck's level node, wired by the mixer (A/B → crossfader, preview → master). */
  attach(destination: AudioNode): void {
    const context = this.mixer.context();
    this.output = context.createGain();
    this.output.gain.value = this.volume;
    this.output.connect(destination);
    if (this.source !== null) this.source.connect(this.output);
  }

  snapshot(): DeckSnapshot {
    return {
      id: this.id,
      state: this.state,
      path: this.path,
      durationMs: this.durationMs(),
      positionMs: this.positionMs(),
      volume: this.volume,
    };
  }

  /** Decode starts here, not at play time — the play button must always answer instantly. */
  async load(path: string): Promise<void> {
    if (this.path === path && this.state !== "empty") return;
    const generation = ++this.generation;
    this.stopSource();
    this.releaseEntry();
    this.path = path;
    this.offsetMs = 0;
    this.state = "loading";
    this.emit();
    const entry = this.mixer.cache.acquire(path);
    try {
      await entry.promise;
    } catch (cause) {
      this.mixer.cache.drop(path); // a failed decode must not poison the cache for the retry
      if (generation === this.generation) {
        this.state = "empty";
        this.path = null;
        this.emit();
      }
      throw cause;
    }
    if (generation !== this.generation) {
      this.mixer.cache.release(entry); // replaced while decoding: hand the buffer back
      return;
    }
    this.mixer.cache.pin(entry);
    this.entry = entry;
    this.state = "ready";
    this.emit();
  }

  /** Eject the track and hand its buffer back to the cache. */
  unload(): void {
    this.generation += 1;
    this.stopSource();
    this.releaseEntry();
    this.path = null;
    this.offsetMs = 0;
    this.state = "empty";
    this.emit();
  }

  /** No-op unless a track is loaded — the UI disables transport while empty/loading. */
  play(): void {
    if (this.state !== "ready") return;
    this.startSource(this.offsetMs);
    this.state = "playing";
    this.emit();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.offsetMs = this.positionMs();
    this.stopSource();
    this.state = "ready";
    this.emit();
  }

  seekMs(ms: number): void {
    if (this.state !== "ready" && this.state !== "playing") return;
    const target = Math.min(this.durationMs(), Math.max(0, ms));
    if (this.state === "playing") {
      this.startSource(target);
    } else {
      this.offsetMs = target;
    }
    this.emit();
  }

  setVolume(x: number): void {
    this.volume = Math.min(1, Math.max(0, x));
    if (this.output !== null) this.output.gain.value = this.volume;
  }

  positionMs(): number {
    if (this.state !== "playing") return this.offsetMs;
    const elapsed = (this.mixer.context().currentTime - this.startedAt) * 1000;
    return Math.min(this.durationMs(), this.offsetMs + elapsed);
  }

  durationMs(): number {
    return this.entry?.buffer ? this.entry.buffer.duration * 1000 : 0;
  }

  private startSource(offsetMs: number): void {
    if (this.entry?.buffer == null || this.output === null) return;
    const context = this.mixer.context();
    this.stopSource();
    const source = context.createBufferSource();
    source.buffer = this.entry.buffer;
    source.onended = () => {
      // stopSource() nulls `this.source` first, so a stale stop never reaches here as a track end.
      if (this.source !== source) return;
      this.source = null;
      this.offsetMs = 0;
      this.state = "ready";
      this.mixer.emitEnded(this.id);
      this.emit();
    };
    source.connect(this.output);
    this.source = source;
    this.startedAt = context.currentTime;
    this.offsetMs = offsetMs;
    source.start(0, offsetMs / 1000);
  }

  private stopSource(): void {
    const source = this.source;
    if (source === null) return;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped — stopping twice is a no-op we do not care about
    }
  }

  private releaseEntry(): void {
    if (this.entry !== null) {
      this.mixer.cache.release(this.entry);
      this.entry = null;
    }
  }

  private emit(): void {
    this.mixer.emit(this.snapshot());
  }
}
