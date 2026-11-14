// Procedural ambient pad: slow, warm chords that drift from one to the next.
//
// Each chord is five held notes (a bass note and four above it); each note is
// two slightly detuned voices, one leaning to each ear, built from a few
// harmonics that fall away like a soft synth string. Chords change every
// `change` seconds with a long equal-power crossfade, picked by the seed from
// the mood's set. Every note's phase is exact from the instance time, so
// seeking is exact.
// Android port: android/.../engine/Pad.java (must match sample for sample).

import { TWO_PI, addOsc, clamp01, frac } from './dsp.ts';
import { fastUnit, seedMix } from './hash.ts';
import type { GeneratorDef } from './generators.ts';

export const PAD_MOODS = ['Warm', 'Dreamy', 'Dark'] as const;

/** Chords per mood: semitones above the root (C2), bass note first. */
const CHORDS: number[][][] = [
  // Warm: major, with open voicings
  [
    [0, 12, 16, 19, 26],
    [5, 12, 17, 21, 24],
    [-3, 12, 16, 21, 24],
    [7, 14, 19, 23, 26],
    [2, 14, 17, 21, 24],
  ],
  // Dreamy: major sevenths and ninths
  [
    [0, 11, 16, 19, 26],
    [5, 16, 21, 24, 28],
    [-3, 12, 19, 23, 26],
    [2, 14, 18, 21, 25],
    [-5, 14, 19, 23, 26],
  ],
  // Dark: minor
  [
    [0, 12, 15, 19, 26],
    [-4, 12, 15, 20, 24],
    [3, 15, 19, 22, 26],
    [-2, 14, 17, 22, 26],
    [5, 12, 17, 20, 24],
  ],
];
const NOTE_AMP = [0.9, 0.7, 0.62, 0.55, 0.32];
const HARMONICS = 6;
const LEVEL = 0.07;

/** Which chord of the mood plays as chord number c (never the same twice in a row). */
function chordIndex(sC: number, c: number, count: number): number {
  const raw = (x: number) => Math.floor(fastUnit(sC, x) * count);
  if (c === 0) return 0;
  const a = raw(c);
  return a === raw(c - 1) ? (a + 1) % count : a;
}

export const pad: GeneratorDef = {
  type: 'pad',
  label: 'Ambient pad',
  params: [
    { name: 'mood', label: 'Mood', unit: '', min: 0, max: PAD_MOODS.length - 1, default: 0, options: [...PAD_MOODS] },
    { name: 'pitch', label: 'Key (semitones from C)', unit: 'st', min: -6, max: 6, default: 0 },
    { name: 'change', label: 'Seconds per chord', unit: 's', min: 10, max: 180, default: 45 },
    { name: 'brightness', label: 'Brightness', unit: '', min: 0, max: 1, default: 0.35 },
    { name: 'movement', label: 'Movement', unit: '', min: 0, max: 1, default: 0.5 },
  ],
  create: (p, seed) => {
    const sC = seedMix(seed ^ 0xa0d1); // chord order
    const sV = seedMix(seed ^ 0xa0d2); // per-voice phases and swells
    // the chord grid is fixed when the instance starts, so it never shifts under you
    const L0 = Math.max(10, p.change.value(0));
    const X = Math.min(0.45 * L0, 14); // crossfade length
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const tEnd = (start + n) / sr;
        const mood = Math.max(0, Math.min(PAD_MOODS.length - 1, Math.round(p.mood.value(tc))));
        const bright = clamp01(p.brightness.value(tc));
        const move = clamp01(p.movement.value(tc));
        const chords = CHORDS[mood]!;
        const cA = Math.max(0, Math.floor((tc - X / 2) / L0));
        const cB = Math.floor((tEnd + X / 2) / L0);
        for (let c = cA; c <= cB; c++) {
          // equal-power window: in around c*L0, out around (c+1)*L0
          const w0 = chordWeight(c, L0, X, tc);
          const w1 = chordWeight(c, L0, X, tEnd);
          if (w0 <= 0 && w1 <= 0) continue;
          const chord = chords[chordIndex(sC, c, chords.length)]!;
          // the key is read at the chord's start, so notes never bend
          const key = Math.max(-6, Math.min(6, p.pitch.value(c * L0)));
          for (let v = 0; v < 5; v++) {
            const f = 65.406 * Math.pow(2, (key + chord[v]!) / 12);
            const id = (c * 8 + v) * 32;
            // a slow swell on each note
            const per = 9 + 8 * fastUnit(sV, id);
            const lph = TWO_PI * fastUnit(sV, id + 1);
            const sw0 = 1 - 0.4 * move * (0.5 + 0.5 * Math.sin((TWO_PI * tc) / per + lph));
            const sw1 = 1 - 0.4 * move * (0.5 + 0.5 * Math.sin((TWO_PI * tEnd) / per + lph));
            const g0 = w0 * sw0 * NOTE_AMP[v]! * LEVEL;
            const g1 = w1 * sw1 * NOTE_AMP[v]! * LEVEL;
            // per-sample gain ramp across the block, applied as a "decay" factor
            const ramp = g0 > 1e-9 && g1 > 1e-9 ? Math.pow(g1 / g0, 1 / n) : 1;
            const gStart = g0 > 1e-9 && g1 > 1e-9 ? g0 : 0.5 * (g0 + g1);
            const detune = (3 + 5 * move) / 1200;
            for (let side = 0; side < 2; side++) {
              const fv = f * Math.pow(2, side === 0 ? -detune : detune);
              const gl = side === 0 ? 0.8 : 0.35;
              const gr = side === 0 ? 0.35 : 0.8;
              for (let h = 1; h <= HARMONICS; h++) {
                const fh = fv * h;
                if (fh > 5000) break;
                const a = (gStart / h) * Math.exp(-(h - 1) * (1.7 - 1.4 * bright));
                const cyc = frac(fh * tc + fastUnit(sV, id + 2 + side * 8 + h));
                addOsc(L, R, start, start, start + n, TWO_PI * cyc, (TWO_PI * fh) / sr, a, ramp, gl, gr);
              }
            }
          }
        }
      },
    };
  },
};

/** Equal-power weight of chord c at time t. */
function chordWeight(c: number, len: number, x: number, t: number): number {
  const inStart = c * len - x / 2;
  const outStart = (c + 1) * len - x / 2;
  if (c > 0 && t < inStart) return 0;
  if (t >= outStart + x) return 0;
  let w = 1;
  if (c > 0 && t < inStart + x) w = Math.sin(((t - inStart) / x) * (Math.PI / 2));
  if (t > outStart) w *= Math.cos(((t - outStart) / x) * (Math.PI / 2));
  return w;
}
