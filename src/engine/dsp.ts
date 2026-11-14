// Small DSP building blocks shared by the procedural generators.

import { rand01 } from './hash.ts';
import type { Voice } from './generators.ts';

export const TWO_PI = Math.PI * 2;
const WARMUP = 4096;
const CHUNK = 128;


export function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** One-pole low-pass. */
export class LowPass {
  private y = 0;
  private a = 0;
  setCutoff(hz: number, sr: number) {
    this.a = 1 - Math.exp((-TWO_PI * Math.min(hz, sr * 0.45)) / sr);
  }
  step(x: number) {
    this.y += this.a * (x - this.y);
    return this.y;
  }
  reset() {
    this.y = 0;
  }
}

/** RBJ biquad (band-pass, constant 0 dB peak gain). */
export class BandPass {
  private b0 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  set(hz: number, q: number, sr: number) {
    const w = (TWO_PI * Math.min(hz, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  step(x: number) {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** Pink-ish noise (Paul Kellet's economy filter) on top of indexed white noise. */
export class Pink {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  step(w: number) {
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.2;
  }
  reset() {
    this.b0 = this.b1 = this.b2 = 0;
  }
}

export class Brown {
  private y = 0;
  step(w: number) {
    this.y = (this.y + 0.02 * w) / 1.02;
    return this.y * 3.5;
  }
  reset() {
    this.y = 0;
  }
}

/**
 * Smooth, time-pure random curve in [0, 1]: random knots every `period`
 * seconds, cosine-interpolated. value(t) needs no history.
 */
export function valueNoise(seed: number, t: number, period: number): number {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const a = rand01(seed, i);
  const b = rand01(seed, i + 1);
  const u = 0.5 - 0.5 * Math.cos(Math.PI * f);
  return a + (b - a) * u;
}

/**
 * Wraps a stateful sample-by-sample renderer so it can be entered at any
 * time: on a discontinuity it resets and replays WARMUP samples first.
 */
export interface StatefulCore {
  reset(): void;
  /** Render n samples starting at absolute local sample index `start`. */
  run(start: number, n: number, sr: number, L: Float32Array, R: Float32Array): void;
}

export function stateful(core: StatefulCore, warmup = WARMUP): Voice {
  let next = NaN;
  const sl = new Float32Array(CHUNK);
  const sr_ = new Float32Array(CHUNK);
  return {
    render(t0, n, sr, outL, outR) {
      const start = Math.round(t0 * sr);
      if (start !== next) {
        core.reset();
        for (let i = start - warmup; i < start; i += CHUNK) core.run(i, Math.min(CHUNK, start - i), sr, sl, sr_);
      }
      core.run(start, n, sr, outL, outR);
      next = start + n;
    },
  };
}


/**
 * Tone tilt: -1 = dark (blend toward a 700 Hz low-pass), +1 = bright
 * (boost above ~2.5 kHz), 0 = untouched. Both filters always run, so the
 * tone can change over time without clicks.
 */
export class Tilt {
  private lo = new LowPass();
  private hi = new LowPass();
  set(sr: number) {
    this.lo.setCutoff(700, sr);
    this.hi.setCutoff(2500, sr);
  }
  step(x: number, tone: number) {
    const l = this.lo.step(x);
    const h = x - this.hi.step(x);
    return tone < 0 ? x + -tone * (l - x) : x + tone * 1.5 * h;
  }
  reset() {
    this.lo.reset();
    this.hi.reset();
  }
}

/**
 * Adds a decaying sine to L/R over samples [from, to) of a block that starts
 * at sample `start`, by recurrence (no sin per sample). `phase` is the phase
 * (radians) at sample `from`, `w` the step per sample, `amp` the amplitude
 * at `from`, multiplied by `decay` every sample. Java: Dsp.addOsc (same order of operations).
 */
export function addOsc(
  L: Float32Array,
  R: Float32Array,
  start: number,
  from: number,
  to: number,
  phase: number,
  w: number,
  amp: number,
  decay: number,
  gl: number,
  gr: number,
): void {
  const c2 = 2 * Math.cos(w);
  let y1 = Math.sin(phase - w);
  let y0 = Math.sin(phase);
  let e = amp;
  for (let j = from; j < to; j++) {
    const x = y0 * e;
    L[j - start] += x * gl;
    R[j - start] += x * gr;
    const y2 = c2 * y0 - y1;
    y1 = y0;
    y0 = y2;
    e *= decay;
  }
}

/** Fractional part, so long-running phases stay precise. */
export function frac(x: number): number {
  return x - Math.floor(x);
}
