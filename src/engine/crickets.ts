// Procedural crickets: a few near ones and a chorus further off.
//
// Each cricket chirps on its own clock (the chirp-rate integral times a small
// per-cricket drift, so the chorus slowly phases in and out). A chirp is a
// handful of short sine pulses near the cricket's song pitch. Every chirp is a
// pure function of time and seed, like the drums, so seeking is exact.
// Android port: android/.../engine/Crickets.java (must match sample for sample).

import { TWO_PI, clamp01 } from './dsp.ts';
import { fastUnit, seedMix } from './hash.ts';
import type { GeneratorDef, ParamReader } from './generators.ts';

const MAX_CRICKETS = 16;
const PULSE_GAP = 0.024; // s between pulses in a chirp
const PULSE_LEN = 0.017; // s, one pulse
const LOOKBACK = 0.16; // s, longest chirp plus timing jitter

/** Time (s) at which the chirp counter reaches `b`, refined by Newton steps. */
function timeOfChirp(rate: ParamReader, b: number, guess: number): number {
  let t = guess;
  for (let k = 0; k < 3; k++) {
    const r = Math.max(0.2, rate.value(t));
    t += (b - rate.integral(t)) / r;
  }
  return t;
}

export const crickets: GeneratorDef = {
  type: 'crickets',
  label: 'Crickets',
  params: [
    { name: 'crickets', label: 'Crickets', unit: '', min: 1, max: MAX_CRICKETS, default: 5 },
    { name: 'rate', label: 'Chirps per second', unit: '/s', min: 0.5, max: 4, default: 2 },
    { name: 'pitch', label: 'Pitch (low ↔ high)', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'rests', label: 'Pauses', unit: '', min: 0, max: 1, default: 0.3 },
  ],
  create: (p, seed) => {
    const sC = seedMix(seed ^ 0xc71c); // who each cricket is
    const sJ = seedMix(seed ^ 0xc71d); // per-chirp timing and loudness
    const sB = seedMix(seed ^ 0xc71e); // singing or resting, per bout
    // per cricket: pitch, clock drift, offset, pulses, loudness, pan, bout length and offset
    const freqMul: number[] = [];
    const rateMul: number[] = [];
    const off: number[] = [];
    const pulses: number[] = [];
    const gain: number[] = [];
    const pan: number[] = [];
    const boutLen: number[] = [];
    const boutOff: number[] = [];
    for (let i = 0; i < MAX_CRICKETS; i++) {
      const u = (k: number) => fastUnit(sC, i * 16 + k);
      freqMul.push(1 + 0.14 * (u(0) - 0.5));
      rateMul.push(1 + 0.16 * (u(1) - 0.5));
      off.push(u(2));
      pulses.push(3 + Math.floor(u(3) * 3));
      gain.push(i === 0 ? 1 : 0.3 + 0.55 * u(4));
      pan.push(0.5 + 0.8 * (u(5) - 0.5));
      boutLen.push(4 + 8 * u(6));
      boutOff.push(u(7) * (4 + 8 * u(6)));
    }
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const count = Math.max(1, Math.min(MAX_CRICKETS, p.crickets.value(tc)));
        const pitch = clamp01(p.pitch.value(tc));
        const rests = clamp01(p.rests.value(tc));
        const tA = Math.max(0, tc - LOOKBACK);
        const tB = (start + n) / sr;
        const bA = p.rate.integral(tA);
        const bB = p.rate.integral(tB);
        const rate0 = Math.max(0.2, p.rate.value(tA));
        const baseHz = 2800 + 3200 * pitch;
        for (let i = 0; i < MAX_CRICKETS; i++) {
          // a fractional count fades the last cricket in
          const fade = Math.min(1, count - i);
          if (fade <= 0) break;
          const rm = rateMul[i]!;
          const kA = Math.max(0, Math.floor(rm * bA + off[i]!) - 1);
          const kB = Math.ceil(rm * bB + off[i]!) + 1;
          const np = pulses[i]!;
          const len = Math.ceil(((np - 1) * PULSE_GAP + PULSE_LEN) * sr);
          const f = baseHz * freqMul[i]!;
          const gl = Math.min(1, 2 * (1 - pan[i]!));
          const gr = Math.min(1, 2 * pan[i]!);
          for (let k = kA; k <= kB; k++) {
            const b = (k - off[i]!) / rm;
            if (b < 0) continue;
            const r = k * 16 + i;
            const jitter = (fastUnit(sJ, r * 4) - 0.5) * 0.016;
            const tk = timeOfChirp(p.rate, b, tA + (b - bA) / rate0) + jitter;
            const at = Math.round(tk * sr);
            if (at < 0 || at + len <= start || at >= start + n) continue;
            // crickets sing in bouts and rest in between
            const bout = Math.floor((tk + boutOff[i]!) / boutLen[i]!);
            if (fastUnit(sB, bout * 16 + i) < rests * 0.85) continue;
            const amp = gain[i]! * fade * (0.75 + 0.25 * fastUnit(sJ, r * 4 + 1));
            const ph0 = TWO_PI * fastUnit(sJ, r * 4 + 2);
            const from = Math.max(start, at);
            const to = Math.min(start + n, at + len);
            for (let j = from; j < to; j++) {
              const tau = (j - at) / sr;
              const q = Math.floor(tau / PULSE_GAP);
              if (q >= np) continue;
              const u = (tau - q * PULSE_GAP) / PULSE_LEN;
              if (u >= 1) continue;
              const s = Math.sin(Math.PI * u);
              const env = s * s * (q === 0 ? 0.75 : 1);
              const ph = TWO_PI * f * tau + ph0;
              const x = (Math.sin(ph) + 0.12 * Math.sin(2 * ph)) * env * amp;
              L[j - start] += x * gl;
              R[j - start] += x * gr;
            }
          }
        }
      },
    };
  },
};
