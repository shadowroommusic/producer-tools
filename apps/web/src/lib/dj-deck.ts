/**
 * Single-player engine for the Set workbench (formerly the two-deck DJ mixer).
 *
 * The page became a set builder, not a mixing desk, so the crossfader and deck A/B died with it;
 * one deck plays the selected track (auditioning and cue work), behind one lazy `AudioContext`.
 * Web Audio `BufferSource` over `<audio>` elements for the same reasons as before: deterministic
 * seek (`start(when, offset)` is sample-exact) and volume on the audio thread without zippers.
 *
 * Memory is still the risk of full-track decode (~21 MB/min stereo float32), so decoded buffers
 * live in a refcounted LRU: an entry is only evictable when `refCount === 0` and no decode is in
 * flight; the deck pins its track from load until replace/unload (pause keeps the pin — the user
 * expects instant resume). If everything is pinned the cache grows past its limit rather than
 * evicting a track that is loaded.
 */
import { fileUrl } from "./studio.ts";

export type DeckState = "empty" | "loading" | "ready" | "playing";

export type DeckSnapshot = {
  state: DeckState;
  path: string | null;
  durationMs: number;
  positionMs: number;
  volume: number;
};

export type PlayerEvents = {
  onChange?: (snapshot: DeckSnapshot) => void;
  /** Fired only when the track plays out to its end — never by pause/seek/replace. */
  onEnded?: () => void;
};

type CacheEntry = {
  buffer: AudioBuffer | null;
  /** Shared in-flight decode: reloading the same path awaits one promise, one fetch. */
  promise: Promise<AudioBuffer> | null;
  refCount: number;
  lastUsed: number;
};

/** Decoded-track store with the house rule: never evict what the deck holds or what is decoding. */
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
    // memory pressure is recoverable, unloading a track somebody works with is not.
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

export type PlayerOptions = {
  contextFactory?: () => AudioContext;
  fetchFn?: typeof fetch;
  cacheLimit?: number;
  events?: PlayerEvents;
};

export class Player {
  readonly cache: BufferCache;
  readonly deck: Deck;
  private readonly options: PlayerOptions;
  private contextValue: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterVolume = 1;

  constructor(options: PlayerOptions = {}) {
    this.options = options;
    this.cache = new BufferCache(options.cacheLimit ?? 3, (path) => this.decode(path));
    this.deck = new Deck(this);
  }

  /** Lazily created: browsers want a user gesture before an `AudioContext` may start. */
  context(): AudioContext {
    if (this.contextValue === null) {
      this.contextValue = (this.options.contextFactory ?? (() => new AudioContext()))();
      this.master = this.contextValue.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(this.contextValue.destination);
      this.deck.attach(this.master);
    }
    if (this.contextValue.state === "suspended") void this.contextValue.resume();
    return this.contextValue;
  }

  setMasterVolume(x: number): void {
    this.masterVolume = Math.min(1, Math.max(0, x));
    if (this.master !== null) this.master.gain.value = this.masterVolume;
  }

  private async decode(path: string): Promise<AudioBuffer> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const response = await fetchFn(fileUrl(path));
    if (!response.ok) throw new Error(`fetch failed (${response.status}) for ${path}`);
    const bytes = await response.arrayBuffer();
    return this.context().decodeAudioData(bytes);
  }

  emit(snapshot: DeckSnapshot): void {
    this.options.events?.onChange?.(snapshot);
  }

  emitEnded(): void {
    this.options.events?.onEnded?.();
  }
}

export class Deck {
  private readonly player: Player;
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

  constructor(player: Player) {
    this.player = player;
  }

  /** The deck's level node, wired by the player straight to master. */
  attach(destination: AudioNode): void {
    const context = this.player.context();
    this.output = context.createGain();
    this.output.gain.value = this.volume;
    this.output.connect(destination);
    if (this.source !== null) this.source.connect(this.output);
  }

  snapshot(): DeckSnapshot {
    return {
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
    const entry = this.player.cache.acquire(path);
    try {
      await entry.promise;
    } catch (cause) {
      this.player.cache.drop(path); // a failed decode must not poison the cache for the retry
      if (generation === this.generation) {
        this.state = "empty";
        this.path = null;
        this.emit();
      }
      throw cause;
    }
    if (generation !== this.generation) {
      this.player.cache.release(entry); // replaced while decoding: hand the buffer back
      return;
    }
    this.player.cache.pin(entry);
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
    const elapsed = (this.player.context().currentTime - this.startedAt) * 1000;
    return Math.min(this.durationMs(), this.offsetMs + elapsed);
  }

  durationMs(): number {
    return this.entry?.buffer ? this.entry.buffer.duration * 1000 : 0;
  }

  private startSource(offsetMs: number): void {
    if (this.entry?.buffer == null || this.output === null) return;
    const context = this.player.context();
    this.stopSource();
    const source = context.createBufferSource();
    source.buffer = this.entry.buffer;
    source.onended = () => {
      // stopSource() nulls `this.source` first, so a stale stop never reaches here as a track end.
      if (this.source !== source) return;
      this.source = null;
      this.offsetMs = 0;
      this.state = "ready";
      this.player.emitEnded();
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
      this.player.cache.release(this.entry);
      this.entry = null;
    }
  }

  private emit(): void {
    this.player.emit(this.snapshot());
  }
}
