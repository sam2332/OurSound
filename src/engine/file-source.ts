// Plays an imported audio file as a segment: trim start (offset), speed,
// and seamless looping with a short crossfade at the seam.

import { assetCache, ASSET_LOOKAHEAD, type AssetMeta } from './assets.ts';
import { Tilt } from './dsp.ts';
import type { GeneratorDef } from './generators.ts';

/** Grain hop (s). Grains are 2 hops long with a Hann window, so two always overlap and sum to 1. */
const HOP = 0.04;
/** How far (s of file) a grain may shift to line up with the previous one. */
const ALIGN_SEARCH = 0.012;
/** How many grains back an alignment chain is rebuilt after a jump. */
const ALIGN_DEPTH = 6;

/** Reads frames of one asset with Catmull-Rom interpolation across chunks. */
class FrameReader {
  private cachedIdx = -1;
  private cL: Float32Array | null = null;
  private cR: Float32Array | null = null;
  private readonly meta: AssetMeta;
  private readonly chunkFrames: number;
  constructor(meta: AssetMeta, chunkFrames: number) {
    this.meta = meta;
    this.chunkFrames = chunkFrames;
  }

  /** One channel frame, or 0 if outside the file / not loaded yet. */
  private frame(i: number, right: boolean): number {
    if (i < 0) return 0;
    const idx = Math.floor(i / this.chunkFrames);
    if (idx !== this.cachedIdx) {
      const c = assetCache.get(this.meta.id, idx);
      this.cachedIdx = c ? idx : -1;
      this.cL = c?.L ?? null;
      this.cR = c?.R ?? null;
      if (!c) return 0;
    }
    const a = right ? this.cR : this.cL;
    return a ? (a[i - idx * this.chunkFrames] ?? 0) : 0;
  }

  /** Raw value at an integer frame (for grain alignment). */
  raw(i: number, right: boolean): number {
    return this.frame(i, right);
  }

  /** Interpolated value at fractional frame position `pos`. */
  at(pos: number, right: boolean): number {
    const i = Math.floor(pos);
    const f = pos - i;
    const y0 = this.frame(i - 1, right);
    const y1 = this.frame(i, right);
    const y2 = this.frame(i + 1, right);
    const y3 = this.frame(i + 2, right);
    // Catmull-Rom
    return (
      y1 +
      0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)))
    );
  }
}

export const fileSource: GeneratorDef = {
  type: 'file',
  label: 'Audio file',
  params: [
    { name: 'speed', label: 'Speed (tempo)', unit: '×', min: 0.25, max: 2, default: 1 },
    { name: 'pitch', label: 'Pitch', unit: 'st', min: -12, max: 12, default: 0 },
    { name: 'tone', label: 'Tone (dark ↔ bright)', unit: '', min: -1, max: 1, default: 0 },
    { name: 'loop', label: 'Loop', unit: '', min: 0, max: 1, default: 1, options: ['Off', 'On'] },
    { name: 'xfade', label: 'Loop crossfade', unit: 's', min: 0.05, max: 5, default: 0.35 },
    { name: 'offset', label: 'Start inside file', unit: 's', min: 0, max: 7200, default: 0 },
  ],
  create: (p, _seed, seg) => {
    const id = seg?.assetId ?? '';
    let reader: FrameReader | null = null;
    let readerFor: AssetMeta | undefined;
    const tiltL = new Tilt();
    const tiltR = new Tilt();
    let nextIndex = NaN;
    // grain start positions (file seconds), cached for the two grains in play
    let gk = NaN;
    let gS0 = 0; // grain gk
    let gS1 = 0; // grain gk - 1
    // aligned grain starts (WSOLA), by grain index; only the recent ones are kept
    const aligned = new Map<number, number>();
    let sl = 0;
    let sr_ = 0;
    return {
      render(t0, n, sr, outL, outR) {
        const meta = assetCache.meta.get(id);
        if (!meta) {
          outL.fill(0, 0, n);
          outR.fill(0, 0, n);
          return;
        }
        if (meta !== readerFor) {
          reader = new FrameReader(meta, assetCache.chunkFrames(meta));
          readerFor = meta;
        }
        const rd = reader!;
        const speed = Math.max(0.05, p.speed.value(t0));
        const ratio = Math.pow(2, Math.max(-24, Math.min(24, p.pitch.value(t0))) / 12);
        const tone = Math.max(-1, Math.min(1, p.tone.value(t0)));
        const loop = p.loop.value(t0) >= 0.5;
        const offset = Math.max(0, Math.min(meta.duration - 0.1, p.offset.value(t0)));
        const span = meta.duration - offset; // playable seconds
        const xf = Math.min(Math.max(0.01, p.xfade.value(t0)), span / 4);
        const period = span - xf; // loop period with the seam overlapped
        const fsr = meta.sampleRate;
        const stereo = meta.channels > 1;
        const chunkFrames = assetCache.chunkFrames(meta);

        const startIdx = Math.round(t0 * sr);
        if (startIdx !== nextIndex) {
          tiltL.reset();
          tiltR.reset();
          tiltL.set(sr);
          tiltR.set(sr);
        }
        nextIndex = startIdx + n;

        /** File content at `raw` seconds played (handles offset, loop and its seam) into sl/sr_. */
        const sampleAt = (raw: number) => {
          sl = 0;
          sr_ = 0;
          if (raw < 0) return;
          if (!loop) {
            const s = offset + raw;
            if (s < meta.duration) {
              const f = s * fsr;
              sl = rd.at(f, false);
              sr_ = stereo ? rd.at(f, true) : sl;
            }
          } else if (period > 0) {
            const u = raw - Math.floor(raw / period) * period;
            const f = (offset + u) * fsr;
            let l = rd.at(f, false);
            let r = stereo ? rd.at(f, true) : l;
            if (u < xf && raw >= period) {
              // blend in the tail of the previous pass (equal-power)
              const w = u / xf;
              const a = Math.sin((Math.PI / 2) * w);
              const b = Math.cos((Math.PI / 2) * w);
              const ft = (offset + period + u) * fsr;
              const tl = rd.at(ft, false);
              const tr = stereo ? rd.at(ft, true) : tl;
              l = l * a + tl * b;
              r = r * a + tr * b;
            }
            sl = l;
            sr_ = r;
          }
        };

        // Overlapping grains: each grain starts near the file position reached
        // so far (integral of speed = tempo) and reads at `ratio` (= pitch).
        // When tempo or pitch differ from normal, each grain's start is nudged
        // (within ±12 ms) to line its waveform up with the previous grain
        // (WSOLA), so tones stay clean instead of warbling. With speed 1 and
        // pitch 0 both grains read the same samples: exact playback.
        const exact = Math.abs(speed - 1) < 1e-9 && Math.abs(ratio - 1) < 1e-9;
        if (exact) aligned.clear();
        const nominal = (k: number) => p.speed.integral(k * HOP);
        const alignedStart = (k: number, depth: number): number => {
          const hit = aligned.get(k);
          if (hit !== undefined) return hit;
          const nom = nominal(k);
          if (k <= 0 || depth >= ALIGN_DEPTH) return nom;
          const prev = alignedStart(k - 1, depth + 1);
          const ref = prev + HOP * ratio; // where the previous grain is reading when this one starts
          const step = 3 / fsr; // lag step (file seconds)
          const dj = (6 / fsr) * ratio; // correlation sample spacing
          const nPts = Math.max(8, Math.floor((HOP * ratio) / dj));
          let best = nom;
          let bestScore = -Infinity;
          for (let lag = -ALIGN_SEARCH; lag <= ALIGN_SEARCH; lag += step) {
            const c = nom + lag;
            if (c < 0) continue;
            // both channels count separately (a mono mix could cancel out)
            let xy = 0;
            let yy = 1e-9;
            for (let j = 0; j < nPts; j++) {
              const ia = Math.round((offset + ref + j * dj) * fsr);
              const ib = Math.round((offset + c + j * dj) * fsr);
              const al = rd.raw(ia, false);
              const bl = rd.raw(ib, false);
              xy += al * bl;
              yy += bl * bl;
              if (stereo) {
                const ar = rd.raw(ia, true);
                const br = rd.raw(ib, true);
                xy += ar * br;
                yy += br * br;
              }
            }
            const score = xy / Math.sqrt(yy);
            if (score > bestScore) {
              bestScore = score;
              best = c;
            }
          }
          aligned.set(k, best);
          if (aligned.size > 16) aligned.delete(aligned.keys().next().value as number);
          return best;
        };

        for (let i = 0; i < n; i++) {
          const t = t0 + i / sr;
          const k = Math.floor(t / HOP);
          if (k !== gk) {
            gS0 = exact ? nominal(k) : alignedStart(k, 0);
            gS1 = k >= 1 ? (exact ? nominal(k - 1) : alignedStart(k - 1, 0)) : 0;
            gk = k;
          }
          let l = 0;
          let r = 0;
          // grain k
          {
            const d = t - k * HOP;
            const w = 0.5 - 0.5 * Math.cos(Math.PI * (d / HOP));
            sampleAt(gS0 + d * ratio);
            l += w * sl;
            r += w * sr_;
          }
          // grain k - 1
          if (k >= 1) {
            const d = t - (k - 1) * HOP;
            const w = 0.5 - 0.5 * Math.cos(Math.PI * (d / HOP));
            sampleAt(gS1 + d * ratio);
            l += w * sl;
            r += w * sr_;
          }
          outL[i] = tiltL.step(l, tone);
          outR[i] = tiltR.step(r, tone);
        }

        // ask for the chunks coming up next
        const endRaw = p.speed.integral(t0 + n / sr);
        for (let k = 1; k <= ASSET_LOOKAHEAD; k++) {
          const ahead = endRaw + k * (chunkFrames / fsr) * Math.min(1, speed);
          const s = loop && period > 0 ? offset + (ahead - Math.floor(ahead / period) * period) : offset + ahead;
          if (s < meta.duration) assetCache.request(id, Math.floor((s * fsr) / chunkFrames));
        }
        if (loop) assetCache.request(id, Math.floor((offset * fsr) / chunkFrames)); // the loop start
      },
    };
  },
};
