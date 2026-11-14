// Procedural hand drums: a small kit played from a 16-step pattern.
//
// The kit: a deep frame drum, a mid hand drum, a high slap drum, a shaker and
// a wood block. Patterns are 16 sixteenth-note steps (one bar of four beats)
// with a velocity per drum and step; the presets are patterns too, and "My
// pattern" plays the one drawn on the segment's drum pad.
//
// Every hit is a pure function of time: hits sit on a grid given by the exact
// integral of the tempo, and each stroke is synthesised from the time since
// its hit, so there is no state and seeking is exact.
// Android port: android/.../engine/Drums.java (must match sample for sample).

import { TWO_PI, clamp01 } from './dsp.ts';
import { fastSigned, fastUnit, rand01, seedMix } from './hash.ts';
import type { GeneratorDef, ParamReader } from './generators.ts';

export const DRUM_STYLES = ['Heartbeat', 'Steady', 'Shamanic', 'Tribal', 'My pattern'] as const;
export const CUSTOM_STYLE = 4;
export const DRUM_LANES = ['Low drum', 'Mid drum', 'High drum', 'Shaker', 'Wood'] as const;
export const DRUM_STEPS = 16;

/** Longest a stroke rings (s). */
const RING = 1.3;
/** Per style, so busier rhythms aren't louder overall. */
const STYLE_GAIN = [0.85, 1, 0.75, 0.85, 0.85];
const LEVEL = 0.62;

const row = (hits: Record<number, number>) => Array.from({ length: DRUM_STEPS }, (_, i) => hits[i] ?? 0);

/** The preset rhythms as drum-pad patterns: [lane][step] velocity (0 = rest). Heartbeat is played specially. */
export const DRUM_PRESETS: number[][][] = [
  // Heartbeat (shown on the pad as its nearest grid version)
  [row({ 0: 1, 1: 0.6, 4: 1, 5: 0.6, 8: 1, 9: 0.6, 12: 1, 13: 0.6 }), row({}), row({}), row({}), row({})],
  // Steady: one stroke a beat, the first of each bar a little stronger
  [row({ 0: 1, 4: 0.75, 8: 0.8, 12: 0.75 }), row({}), row({}), row({ 2: 0.25, 6: 0.25, 10: 0.25, 14: 0.25 }), row({})],
  // Shamanic: every eighth note, even and hypnotic
  [row({ 0: 1, 2: 0.8, 4: 0.85, 6: 0.8, 8: 0.9, 10: 0.8, 12: 0.85, 14: 0.8 }), row({}), row({}), row({}), row({})],
  // Tribal: deep and high drums with a shaker
  [
    row({ 0: 1, 8: 0.85 }),
    row({ 4: 0.55, 6: 0.45, 12: 0.6 }),
    row({ 10: 0.45, 15: 0.3 }),
    row({ 1: 0.2, 3: 0.25, 5: 0.2, 7: 0.25, 9: 0.2, 11: 0.25, 13: 0.2, 15: 0.25 }),
    row({ 2: 0.3, 14: 0.3 }),
  ],
];

/** A fresh empty pad pattern. */
export const emptyPattern = (): number[][] => DRUM_LANES.map(() => row({}));

/** Time (s) at which the beat counter reaches `b` beats, refined by Newton steps. */
function timeOfBeat(tempo: ParamReader, b: number, guess: number): number {
  let t = guess;
  for (let k = 0; k < 3; k++) {
    const bpm = Math.max(20, tempo.value(t));
    t += ((b - tempo.integral(t) / 60) * 60) / bpm;
  }
  return t;
}

/** Soft noise: n neighbouring samples averaged (a stateless low-pass). */
function softNoise(s: number, j: number, n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) x += fastSigned(s, j - i);
  return x / n;
}

/**
 * One stroke of drum `lane` at time t since the hit (s), for a kit tuned by
 * `tune` (1 = normal) and pitched by `ratio`. Returns the mono sample.
 */
function stroke(lane: number, t: number, tune: number, ratio: number, sN: number, j: number): number {
  if (lane === 0) {
    // frame drum: a deep membrane whose pitch settles in the first 25 ms, a soft beater, a little skin
    const f0 = 58 * tune * ratio;
    const ph = TWO_PI * f0 * (t + 0.18 * 0.025 * (1 - Math.exp(-t / 0.025)));
    const onset = t < 0.002 ? t / 0.002 : 1;
    const body = Math.sin(ph) * Math.exp(-t / 0.45) + 0.3 * Math.sin(1.47 * ph) * Math.exp(-t / 0.16);
    const beater = 0.22 * Math.sin(TWO_PI * f0 * 3.1 * t) * Math.exp(-t / 0.006);
    const skin = 0.22 * softNoise(sN, j, 6) * Math.exp(-t / 0.01);
    return (body + beater + skin) * onset;
  }
  if (lane === 1) {
    // hand drum: a rounder mid tone with two overtones
    const f0 = 125 * tune * ratio;
    const ph = TWO_PI * f0 * (t + 0.1 * 0.02 * (1 - Math.exp(-t / 0.02)));
    const onset = t < 0.0015 ? t / 0.0015 : 1;
    const body =
      Math.sin(ph) * Math.exp(-t / 0.28) + 0.4 * Math.sin(1.59 * ph) * Math.exp(-t / 0.14) + 0.2 * Math.sin(2.14 * ph) * Math.exp(-t / 0.1);
    const skin = 0.3 * softNoise(sN, j, 3) * Math.exp(-t / 0.006);
    return (body * 0.85 + skin) * onset;
  }
  if (lane === 2) {
    // slap drum: short and bright
    const f0 = 260 * tune * ratio;
    const ph = TWO_PI * f0 * t;
    const onset = t < 0.001 ? t / 0.001 : 1;
    const body = Math.sin(ph) * Math.exp(-t / 0.12) + 0.5 * Math.sin(1.5 * ph) * Math.exp(-t / 0.07);
    const slap = 0.55 * softNoise(sN, j, 2) * Math.exp(-t / 0.004);
    return (body * 0.7 + slap) * onset;
  }
  if (lane === 3) {
    // shaker: a brief rush of bright grains
    const n = (fastSigned(sN, j) - fastSigned(sN, j - 1)) * 0.5;
    const env = t < 0.006 ? t / 0.006 : Math.exp(-(t - 0.006) / 0.035);
    return n * env * 0.5;
  }
  // wood block: two hollow tones, gone in a moment
  const fw = 820 * (0.85 + 0.3 * (tune - 0.8) / 0.6);
  const onset = t < 0.0005 ? t / 0.0005 : 1;
  return (0.45 * Math.sin(TWO_PI * fw * t) * Math.exp(-t / 0.025) + 0.25 * Math.sin(TWO_PI * fw * 1.57 * t) * Math.exp(-t / 0.015)) * onset;
}

/** How long a stroke of each drum rings (s). */
const LANE_LEN = [RING, 0.9, 0.5, 0.2, 0.15];
const LANE_PAN = [0.5, 0.4, 0.62, 0.7, 0.36];

export const drums: GeneratorDef = {
  type: 'drums',
  label: 'Drums',
  params: [
    { name: 'tempo', label: 'Tempo', unit: 'BPM', min: 30, max: 180, default: 60 },
    { name: 'style', label: 'Rhythm', unit: '', min: 0, max: DRUM_STYLES.length - 1, default: 1, options: [...DRUM_STYLES] },
    { name: 'depth', label: 'Drums (deep ↔ high)', unit: '', min: 0, max: 1, default: 0.3 },
    { name: 'variety', label: 'Human feel', unit: '', min: 0, max: 1, default: 0.3 },
  ],
  create: (p, seed, seg) => {
    const sV = seed ^ 0xd2a1; // pattern variations
    const sH = seedMix(seed ^ 0xd2a2); // per-stroke timing, loudness, tone
    const sN = seedMix(seed ^ 0xd2a3); // skin noise
    const custom = seg?.drumPattern;
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const style = Math.max(0, Math.min(DRUM_STYLES.length - 1, Math.round(p.style.value(tc))));
        const depth = clamp01(p.depth.value(tc));
        const variety = clamp01(p.variety.value(tc));
        const tune = 0.8 + 0.6 * depth;
        const pattern = style === CUSTOM_STYLE ? (custom ?? DRUM_PRESETS[1]!) : DRUM_PRESETS[style]!;
        const tA = Math.max(0, tc - RING);
        const tB = (start + n) / sr;
        // grid steps are quarter beats (sixteenth notes)
        const gA = Math.floor((p.tempo.integral(tA) / 60) * 4) - 2;
        const gB = Math.ceil((p.tempo.integral(tB) / 60) * 4) + 1;
        const bpm0 = Math.max(20, p.tempo.value(tA));
        for (let g = gA; g <= gB; g++) {
          if (g < 0) continue;
          const step = g % DRUM_STEPS;
          for (let lane = 0; lane < 5; lane++) {
            let vel = pattern[lane]?.[step] ?? 0;
            let ratio = 1;
            let pos = g / 4;
            if (style === 0) {
              // heartbeat: "lub" on the beat, a softer, higher "dub" 0.3 beat later
              if (lane !== 0 || (g % 4 !== 0 && g % 4 !== 1)) continue;
              const dub = g % 4 === 1;
              vel = dub ? 0.6 : 1;
              ratio = dub ? 1.12 : 1;
              pos = Math.floor(g / 4) + (dub ? 0.3 : 0);
            } else {
              // human feel: ghost notes on the high drum and shaker, a few strokes dropped
              const r = rand01(sV, g * 8 + lane);
              if (vel === 0 && (lane === 2 || lane === 3) && r < variety * 0.12) vel = 0.15 + 0.2 * rand01(sV ^ 0x1f, g * 8 + lane);
              else if (vel > 0 && step !== 0 && r < variety * 0.08) vel = 0;
            }
            if (vel <= 0) continue;
            const id = (g * 8 + lane) * 4;
            const jitter = (fastUnit(sH, id) - 0.5) * 0.036 * variety;
            const hitT = timeOfBeat(p.tempo, pos, tA + ((pos - p.tempo.integral(tA) / 60) * 60) / bpm0) + jitter;
            const at = Math.round(hitT * sr);
            if (at < 0) continue;
            const len = Math.ceil(LANE_LEN[lane]! * sr);
            if (at + len <= start || at >= start + n) continue;
            const amp = vel * STYLE_GAIN[style]! * (1 - 0.3 * variety * fastUnit(sH, id + 1)) * LEVEL;
            const tn = tune * (1 + 0.03 * variety * (fastUnit(sH, id + 2) - 0.5));
            const pan = LANE_PAN[lane]! + 0.16 * variety * (fastUnit(sH, id + 3) - 0.5);
            const gl = Math.min(1, 2 * (1 - pan));
            const gr = Math.min(1, 2 * pan);
            const from = Math.max(start, at);
            const to = Math.min(start + n, at + len);
            for (let j = from; j < to; j++) {
              const x = stroke(lane, (j - at) / sr, tn, ratio, sN, j) * amp;
              L[j - start] += x * gl;
              R[j - start] += x * gr;
            }
          }
        }
      },
    };
  },
};
