// Sound generators. A voice renders one repeat instance of a segment.
// Tones are fully time-pure: phase comes from the exact integral of the
// frequency curve, so a voice created at any time t sounds exactly as if it
// had been playing since the instance started.
// Noise is seeded per sample index; its coloring filters are warmed up on a
// seek so the result is the same no matter how you got there.

import type { GeneratorType, Segment } from './model.ts';
import { AMBIENT_GENERATORS } from './ambient.ts';
import { fileSource } from './file-source.ts';
import { BandPass, Tilt } from './dsp.ts';
import { fastSigned, seedMix } from './hash.ts';

/** Nominal output level of every generator at 0 dB (RMS ≈ -12 dBFS). */
export const NOMINAL_RMS = 0.25;
const TONE_PEAK = NOMINAL_RMS * Math.SQRT2;

export type ParamDef = {
  name: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
  /** Discrete choices (value = index). */
  options?: string[];
};

/** A param bound to one instance: local time in, value / integral out. */
export interface ParamReader {
  value(local: number): number;
  /** ∫ value from local=0 (instance start) to `local`. */
  integral(local: number): number;
}

export interface Voice {
  /**
   * Render n samples starting at instance-local time t0 into outL/outR
   * (overwrite, not add). Gain is applied by the mixer, not here.
   */
  render(t0: number, n: number, sr: number, outL: Float32Array, outR: Float32Array): void;
}

type VoiceFactory = (p: Record<string, ParamReader>, seed: number, seg?: Segment) => Voice;

export type GeneratorDef = {
  type: GeneratorType;
  label: string;
  params: ParamDef[];
  create: VoiceFactory;
};

const TWO_PI = Math.PI * 2;

function frac(x: number): number {
  return x - Math.floor(x);
}

// ---------------------------------------------------------------- tones

/**
 * Renders a sine whose frequency follows `freq`, starting from the exact phase
 * at t0. Frequency is linearly interpolated across the block.
 * Writes into `out` multiplied by `amp`.
 */
function renderSine(
  freq: ParamReader,
  extraCycles: number,
  t0: number,
  n: number,
  sr: number,
  amp: number,
  out: Float32Array,
  add: boolean,
): void {
  let phase = frac(freq.integral(t0) + extraCycles);
  const f0 = freq.value(t0);
  const f1 = freq.value(t0 + n / sr);
  const df = (f1 - f0) / n;
  let f = f0;
  for (let i = 0; i < n; i++) {
    const s = Math.sin(TWO_PI * phase) * amp;
    out[i] = add ? out[i] + s : s;
    // trapezoid step keeps the phase consistent with the exact integral
    phase += (f + 0.5 * df) / sr;
    if (phase >= 1) phase -= Math.floor(phase);
    f += df;
  }
}

/** carrier + beat as one reader (the right ear's frequency). */
function sumReader(a: ParamReader, b: ParamReader): ParamReader {
  return {
    value: (t) => a.value(t) + b.value(t),
    integral: (t) => a.integral(t) + b.integral(t),
  };
}

const binaural: GeneratorDef = {
  type: 'binaural',
  label: 'Binaural beat',
  params: [
    { name: 'carrier', label: 'Carrier', unit: 'Hz', min: 40, max: 1000, default: 200 },
    { name: 'beat', label: 'Beat', unit: 'Hz', min: 0, max: 40, default: 4 },
  ],
  create: (p) => {
    const right = sumReader(p.carrier, p.beat);
    return {
      render(t0, n, sr, outL, outR) {
        renderSine(p.carrier, 0, t0, n, sr, TONE_PEAK, outL, false);
        renderSine(right, 0, t0, n, sr, TONE_PEAK, outR, false);
      },
    };
  },
};

const monaural: GeneratorDef = {
  type: 'monaural',
  label: 'Monaural beat',
  params: [
    { name: 'carrier', label: 'Carrier', unit: 'Hz', min: 40, max: 1000, default: 200 },
    { name: 'beat', label: 'Beat', unit: 'Hz', min: 0, max: 40, default: 4 },
  ],
  create: (p) => {
    const upper = sumReader(p.carrier, p.beat);
    return {
      render(t0, n, sr, outL, outR) {
        renderSine(p.carrier, 0, t0, n, sr, TONE_PEAK * 0.5, outL, false);
        renderSine(upper, 0, t0, n, sr, TONE_PEAK * 0.5, outL, true);
        outR.set(outL.subarray(0, n));
      },
    };
  },
};

const isochronic: GeneratorDef = {
  type: 'isochronic',
  label: 'Isochronic tone',
  params: [
    { name: 'tone', label: 'Tone', unit: 'Hz', min: 40, max: 1000, default: 200 },
    { name: 'rate', label: 'Pulse rate', unit: 'Hz', min: 0.1, max: 40, default: 4 },
    { name: 'duty', label: 'Pulse width', unit: '', min: 0.1, max: 1, default: 0.5 },
  ],
  create: (p) => ({
    render(t0, n, sr, outL, outR) {
      renderSine(p.tone, 0, t0, n, sr, TONE_PEAK, outL, false);
      // Pulse envelope: raised cosine over the 'on' part of each cycle (click-free).
      let pp = frac(p.rate.integral(t0));
      const r0 = p.rate.value(t0);
      const r1 = p.rate.value(t0 + n / sr);
      const dr = (r1 - r0) / n;
      let r = r0;
      const duty = Math.min(1, Math.max(0.05, p.duty.value(t0)));
      for (let i = 0; i < n; i++) {
        const x = pp / duty;
        const env = x < 1 ? 0.5 - 0.5 * Math.cos(TWO_PI * x) : 0;
        outL[i] *= env;
        pp += (r + 0.5 * dr) / sr;
        if (pp >= 1) pp -= Math.floor(pp);
        r += dr;
      }
      outR.set(outL.subarray(0, n));
    },
  }),
};

const tone: GeneratorDef = {
  type: 'tone',
  label: 'Pure tone',
  params: [{ name: 'freq', label: 'Frequency', unit: 'Hz', min: 20, max: 2000, default: 432 }],
  create: (p) => ({
    render(t0, n, sr, outL, outR) {
      renderSine(p.freq, 0, t0, n, sr, TONE_PEAK, outL, false);
      outR.set(outL.subarray(0, n));
    },
  }),
};

// ---------------------------------------------------------------- noise

export const NOISE_COLORS = ['white', 'pink', 'brown', 'green', 'blue', 'violet'] as const;

// RMS normalization so every color sits at NOMINAL_RMS (measured in tests).
const WHITE_SCALE = NOMINAL_RMS * Math.sqrt(3); // uniform [-1,1) has RMS 1/√3
const PINK_SCALE = 0.14;
const BROWN_SCALE = 4.38;
// Measured so each color sits at NOMINAL_RMS too (see engine tests).
const GREEN_SCALE = 0.329;
const BLUE_SCALE = 0.2394;
const VIOLET_SCALE = 0.3073;
const GREEN_HZ = 500; // "green noise": the middle of the spectrum, like nature sounds
const WARMUP_SAMPLES = 8192;

/** Stateful coloring filter for one channel. */
class Colorer {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  private brown = 0;
  private prevPink = 0;
  private prevWhite = 0;
  readonly bp = new BandPass();

  reset() {
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
    this.brown = 0;
    this.prevPink = 0;
    this.prevWhite = 0;
    this.bp.reset();
  }

  /** Green: pink noise band-passed around 500 Hz (wide). */
  green(w: number): number {
    return this.bp.step(this.pink(w));
  }

  /** Blue (+3 dB/octave): first difference of pink. */
  blue(w: number): number {
    const p = this.pink(w);
    const out = p - this.prevPink;
    this.prevPink = p;
    return out;
  }

  /** Violet (+6 dB/octave): first difference of white. */
  violet(w: number): number {
    const out = w - this.prevWhite;
    this.prevWhite = w;
    return out;
  }

  /** Paul Kellet's refined pink filter. Input white in [-1,1). */
  pink(w: number): number {
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out;
  }

  /** Leaky integrator (brown/red noise, DC-safe). */
  brownStep(w: number): number {
    this.brown = (this.brown + 0.02 * w) / 1.02;
    return this.brown;
  }
}

const noise: GeneratorDef = {
  type: 'noise',
  label: 'Noise',
  params: [
    { name: 'color', label: 'Color', unit: '', min: 0, max: NOISE_COLORS.length - 1, default: 1, options: [...NOISE_COLORS] },
    { name: 'width', label: 'Stereo width', unit: '', min: 0, max: 1, default: 1 },
    { name: 'tone', label: 'Tone (dark ↔ bright)', unit: '', min: -1, max: 1, default: 0 },
  ],
  create: (p, seed) => {
    const tiltL = new Tilt();
    const tiltR = new Tilt();
    let tone = 0;
    const seedL = seedMix(seed ^ 0x1234567);
    const seedR = seedMix(seed ^ 0x7654321);
    const cl = new Colorer();
    const cr = new Colorer();
    let nextIndex = NaN; // sample index the filters are primed for
    let lastColor = -1;
    // Scratch outputs of step(); avoids allocating per sample in the audio thread.
    let sl = 0;
    let sr_ = 0;

    const step = (color: number, idx: number) => {
      const wl = fastSigned(seedL, idx);
      const wr = fastSigned(seedR, idx);
      if (color === 0) {
        sl = wl * WHITE_SCALE;
        sr_ = wr * WHITE_SCALE;
      } else if (color === 1) {
        sl = cl.pink(wl) * PINK_SCALE;
        sr_ = cr.pink(wr) * PINK_SCALE;
      } else if (color === 2) {
        sl = cl.brownStep(wl) * BROWN_SCALE;
        sr_ = cr.brownStep(wr) * BROWN_SCALE;
      } else if (color === 3) {
        sl = cl.green(wl) * GREEN_SCALE;
        sr_ = cr.green(wr) * GREEN_SCALE;
      } else if (color === 4) {
        sl = cl.blue(wl) * BLUE_SCALE;
        sr_ = cr.blue(wr) * BLUE_SCALE;
      } else {
        sl = cl.violet(wl) * VIOLET_SCALE;
        sr_ = cr.violet(wr) * VIOLET_SCALE;
      }
      sl = tiltL.step(sl, tone);
      sr_ = tiltR.step(sr_, tone);
    };

    return {
      render(t0, n, sr, outL, outR) {
        const color = Math.round(Math.min(NOISE_COLORS.length - 1, Math.max(0, p.color.value(t0))));
        const width = Math.min(1, Math.max(0, p.width.value(t0)));
        tone = Math.max(-1, Math.min(1, p.tone.value(t0)));
        const start = Math.round(t0 * sr);
        if (start !== nextIndex || color !== lastColor) {
          // Seek or color change: rebuild filter state from the preceding samples,
          // so the output only depends on the position, not on how we got here.
          cl.reset();
          cr.reset();
          cl.bp.set(GREEN_HZ, 0.6, sr);
          cr.bp.set(GREEN_HZ, 0.6, sr);
          tiltL.reset();
          tiltR.reset();
          tiltL.set(sr);
          tiltR.set(sr);
          for (let i = start - WARMUP_SAMPLES; i < start; i++) step(color, i);
          lastColor = color;
        }
        const a = 0.5 * (1 + width); // own channel
        const b = 0.5 * (1 - width); // shared part
        for (let i = 0; i < n; i++) {
          step(color, start + i);
          outL[i] = a * sl + b * sr_;
          outR[i] = a * sr_ + b * sl;
        }
        nextIndex = start + n;
      },
    };
  },
};

/** Registry. Types without an entry yet are skipped by the engine. */
export const GENERATORS: Partial<Record<GeneratorType, GeneratorDef>> = {
  binaural,
  monaural,
  isochronic,
  tone,
  noise,
  ...AMBIENT_GENERATORS,
  file: fileSource,
};

export function defaultParams(type: GeneratorType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of GENERATORS[type]?.params ?? []) out[d.name] = d.default;
  return out;
}
