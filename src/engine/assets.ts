// Audio-thread side of imported audio files.
//
// Files are never loaded whole. The main thread decodes them in 5-second
// chunks on request; the engine keeps only the chunks it is using (plus a
// look-ahead) and asks for more as playback moves. A missing chunk plays as
// silence for a moment instead of blocking the audio thread.

export const ASSET_CHUNK_SEC = 5;
/** Chunks requested ahead of the play position. */
export const ASSET_LOOKAHEAD = 6;
/** Drop chunks unused for this many render blocks (~60 s at 128 frames / 48 kHz). */
const EVICT_AFTER_BLOCKS = 22500;

export type AssetMeta = {
  id: string;
  name: string;
  sampleRate: number;
  channels: number;
  /** Seconds. */
  duration: number;
};

export type AssetChunk = { L: Float32Array; R: Float32Array; lastUse: number };

export class AssetCache {
  readonly meta = new Map<string, AssetMeta>();
  private chunks = new Map<string, AssetChunk>();
  private pending = new Set<string>();
  private inFlight = new Set<string>();
  clock = 0;

  static key(id: string, idx: number) {
    return id + '#' + idx;
  }

  chunkFrames(meta: AssetMeta) {
    return Math.round(ASSET_CHUNK_SEC * meta.sampleRate);
  }

  chunkCount(meta: AssetMeta) {
    return Math.ceil((meta.duration * meta.sampleRate) / this.chunkFrames(meta));
  }

  /** Chunk if cached; otherwise requests it and returns undefined. */
  get(id: string, idx: number): AssetChunk | undefined {
    const k = AssetCache.key(id, idx);
    const c = this.chunks.get(k);
    if (c) {
      c.lastUse = this.clock;
      return c;
    }
    this.request(id, idx);
    return undefined;
  }

  request(id: string, idx: number) {
    const m = this.meta.get(id);
    if (!m || idx < 0 || idx >= this.chunkCount(m)) return;
    const k = AssetCache.key(id, idx);
    if (this.chunks.has(k) || this.inFlight.has(k)) {
      const c = this.chunks.get(k);
      if (c) c.lastUse = this.clock;
      return;
    }
    this.pending.add(k);
  }

  put(id: string, idx: number, L: Float32Array, R: Float32Array) {
    const k = AssetCache.key(id, idx);
    this.inFlight.delete(k);
    this.pending.delete(k);
    this.chunks.set(k, { L, R, lastUse: this.clock });
  }

  /** Requests to send to the main thread (marks them in flight). */
  takeRequests(): { id: string; idx: number }[] {
    const out: { id: string; idx: number }[] = [];
    for (const k of this.pending) {
      const sep = k.lastIndexOf('#');
      out.push({ id: k.slice(0, sep), idx: Number(k.slice(sep + 1)) });
      this.inFlight.add(k);
    }
    this.pending.clear();
    return out;
  }

  /** A request failed or was dropped: allow asking again. */
  forget(id: string, idx: number) {
    this.inFlight.delete(AssetCache.key(id, idx));
  }

  evict() {
    for (const [k, c] of this.chunks) {
      if (this.clock - c.lastUse > EVICT_AFTER_BLOCKS) this.chunks.delete(k);
    }
  }

  clear() {
    this.chunks.clear();
    this.pending.clear();
    this.inFlight.clear();
  }

  get size() {
    return this.chunks.size;
  }
}

/** The audio thread's single cache (the worklet and tests share this module). */
export const assetCache = new AssetCache();
