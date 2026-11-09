// Procedural hand drums: a slow, steady beat for sleep or meditation.
//
// Every hit is a pure function of time: hits sit on a beat grid given by the
// exact integral of the tempo, and each drum stroke is synthesised from the
// time since its hit (a pitched membrane with a falling pitch, plus a short
// skin noise), so there is no state and seeking is exact.
// Android port: android/.../engine/Drums.java (must match sample for sample).

import { TWO_PI, clamp01 } from './dsp.ts';
import { fastSigned, fastUnit, rand01, seedMix } from './hash.ts';
import type { GeneratorDef, ParamReader } from './generators.ts';

export const DRUM_STYLES = ['Heartbeat', 'Steady', 'Shamanic', 'Tribal'] as const;

/** Longest a stroke rings (s). */
const RING = 1.6;
const STEPS = 8; // grid steps per bar (4 beats of eighth notes)
/** Per style, so busier rhythms aren't louder overall. */
const STYLE_GAIN = [0.8, 1, 0.7, 1];

/**
 * Pattern per style: [velocity, pitch ratio] for each of the 8 steps (0 = rest).
 * Heartbeat is special-cased (lub-dub inside each beat).
 */
const PATTERNS: number[][][] = [
  [],
  // Steady: one stroke a beat, the first of each bar a little stronger
  [[1, 1], [0, 0], [0.75, 1], [0, 0], [0.8, 1], [0, 0], [0.75, 1], [0, 0]],
  // Shamanic: every eighth note, even and hypnotic
  [[1, 1], [0.8, 1], [0.85, 1], [0.8, 1], [0.9, 1], [0.8, 1], [0.85, 1], [0.8, 1]],
  // Tribal: deep and high drums
  [[1, 1], [0, 0], [0.55, 1.6], [0.45, 1.6], [0.85, 1], [0.4, 1.9], [0.6, 1.6], [0, 0]],
];

/** The stroke at grid step `g` (half beats): velocity (0 = none), pitch ratio, position in beats. */
function strokeAt(style: number, variety: number, sV: number, g: number, out: number[]) {
  out[0] = 0;
  out[1] = 1;
  out[2] = g / 2;
  if (style === 0) {
    // heartbeat: "lub" on the beat, a softer "dub" 0.3 beat later
    const beat = Math.floor(g / 2);
    const dub = g - beat * 2 === 1;
    out[0] = dub ? 0.6 : 1;
    out[1] = dub ? 1.12 : 1;
    out[2] = beat + (dub ? 0.3 : 0);
  } else {
    const step = ((g % STEPS) + STEPS) % STEPS;
    const pat = PATTERNS[style]![step]!;
    out[0] = pat[0]!;
    out[1] = pat[1]!;
    // variety adds ghost notes in the rests and drops a few strokes
    const r = rand01(sV, g);
    if (out[0] === 0 && r < variety * 0.3) {
      out[0] = 0.25 + 0.3 * rand01(sV ^ 0x1f, g);
      out[1] = style === 3 ? 1.9 : 1.25;
    } else if (out[0] > 0 && step !== 0 && r < variety * 0.12) out[0] = 0;
  }
}

/** Time (s) at which the beat counter reaches `b` beats, refined by Newton steps. */
function timeOfBeat(tempo: ParamReader, b: number, guess: number): number {
  let t = guess;
  for (let k = 0; k < 3; k++) {
    const bpm = Math.max(20, tempo.value(t));
    t += ((b - tempo.integral(t) / 60) * 60) / bpm;
  }
  return t;
}

export const drums: GeneratorDef = {
  type: 'drums',
  label: 'Drums',
  params: [
    { name: 'tempo', label: 'Tempo', unit: 'BPM', min: 30, max: 180, default: 60 },
    { name: 'style', label: 'Rhythm', unit: '', min: 0, max: DRUM_STYLES.length - 1, default: 1, options: [...DRUM_STYLES] },
    { name: 'depth', label: 'Drum (deep ↔ high)', unit: '', min: 0, max: 1, default: 0.3 },
    { name: 'variety', label: 'Human feel', unit: '', min: 0, max: 1, default: 0.3 },
  ],
  create: (p, seed) => {
    const sV = seed ^ 0xd2a1; // pattern variations
    const sH = seedMix(seed ^ 0xd2a2); // per-stroke timing, loudness, tone
    const sN = seedMix(seed ^ 0xd2a3); // skin noise
    const stroke = [0, 0, 0];
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const style = Math.max(0, Math.min(DRUM_STYLES.length - 1, Math.round(p.style.value(tc))));
        const depth = clamp01(p.depth.value(tc));
        const variety = clamp01(p.variety.value(tc));
        const tA = Math.max(0, tc - RING);
        const tB = (start + n) / sr;
        // grid steps are half beats
        const gA = Math.floor((p.tempo.integral(tA) / 60) * 2) - 1;
        const gB = Math.ceil((p.tempo.integral(tB) / 60) * 2) + 1;
        const bpm0 = Math.max(20, p.tempo.value(tA));
        for (let g = gA; g <= gB; g++) {
          if (g < 0) continue;
          strokeAt(style, variety, sV, g, stroke);
          const vel0 = stroke[0]!;
          if (vel0 <= 0) continue;
          const b = stroke[2]!;
          // humanised timing (up to ±18 ms) and loudness
          const jitter = (fastUnit(sH, g * 4) - 0.5) * 0.036 * variety;
          const hitT = timeOfBeat(p.tempo, b, tA + ((b - p.tempo.integral(tA) / 60) * 60) / bpm0) + jitter;
          const at = Math.round(hitT * sr);
          if (at < 0) continue;
          const vel = vel0 * STYLE_GAIN[style]! * (1 - 0.35 * variety * fastUnit(sH, g * 4 + 1));
          // deep frame drum (~55 Hz) … high hand drum (~210 Hz)
          const f0 = (55 + 155 * depth * depth) * stroke[1]! * (1 + 0.04 * variety * (fastUnit(sH, g * 4 + 2) - 0.5));
          const tau = (0.55 - 0.35 * depth) / Math.sqrt(stroke[1]!);
          const len = Math.min(Math.floor(RING * sr), Math.ceil(tau * 6 * sr));
          if (at + len <= start || at >= start + n) continue;
          const pan = 0.5 + (stroke[1]! > 1 ? 0.18 : -0.05) + 0.2 * variety * (fastUnit(sH, g * 4 + 3) - 0.5);
          const gl = Math.min(1, 2 * (1 - pan));
          const gr = Math.min(1, 2 * pan);
          const from = Math.max(start, at);
          const to = Math.min(start + n, at + len);
          const skinTau = 0.004 + 0.004 * depth;
          for (let j = from; j < to; j++) {
            const t = (j - at) / sr;
            // membrane: the pitch falls ~70 % in the first 30 ms; phase is its exact integral
            const ph = TWO_PI * f0 * (t + 0.7 * 0.03 * (1 - Math.exp(-t / 0.03)));
            const onset = t < 0.0015 ? t / 0.0015 : 1;
            const body = Math.sin(ph) * Math.exp(-t / tau) + 0.3 * Math.sin(1.59 * ph) * Math.exp(-t / (tau * 0.35));
            const skin = (fastSigned(sN, j) + fastSigned(sN, j - 1)) * 0.5 * Math.exp(-t / skinTau) * (0.35 + 0.4 * depth);
            const x = (body + skin) * vel * onset;
            L[j - start] += x * gl;
            R[j - start] += x * gr;
          }
        }
      },
    };
  },
};
