// Procedural purring cat: a low, rapid flutter that swells with each breath.
//
// A purr is a train of tiny pulses (the larynx snapping open about 25 times a
// second), louder on the breath out and softer, a little brighter, on the
// breath in. Each pulse is a short low thump plus a puff of soft noise. Pulses
// sit on the integral of the pulse rate and breaths on the integral of the
// breathing rate, so everything is a pure function of time; seeking is exact.
// Android port: android/.../engine/Purr.java (must match sample for sample).

import { TWO_PI, clamp01, frac } from './dsp.ts';
import { fastSigned, fastUnit, seedMix } from './hash.ts';
import type { GeneratorDef, ParamReader } from './generators.ts';

const GRAIN = 0.045; // s, one pulse rings this long
const LEVEL = 0.9;

/** Pulses per second for pitch p. */
const pulseRate = (p: number) => 20 + 12 * p;

/** Loudness through one breath (phase 0..1): out, a short pause, in, a pause. */
function breathEnv(ph: number): number {
  if (ph < 0.56) {
    const s = Math.sin((Math.PI * ph) / 0.56);
    return Math.sqrt(s);
  }
  if (ph >= 0.6 && ph < 0.96) {
    const s = Math.sin((Math.PI * (ph - 0.6)) / 0.36);
    return 0.55 * Math.sqrt(s);
  }
  return 0;
}

/** Time (s) at which the pulse counter reaches `b`, refined by Newton steps. */
function timeOfPulse(pitch: ParamReader, b: number, guess: number): number {
  let t = guess;
  for (let k = 0; k < 3; k++) {
    const r = pulseRate(clamp01(pitch.value(t)));
    t += (b - (20 * t + 12 * pitch.integral(t))) / r;
  }
  return t;
}

export const purr: GeneratorDef = {
  type: 'purr',
  label: 'Purring cat',
  params: [
    { name: 'breaths', label: 'Breaths per minute', unit: '/min', min: 8, max: 40, default: 20 },
    { name: 'pitch', label: 'Purr (slow ↔ fast)', unit: '', min: 0, max: 1, default: 0.4 },
    { name: 'rumble', label: 'Rumble (soft ↔ rough)', unit: '', min: 0, max: 1, default: 0.5 },
  ],
  create: (p, seed) => {
    const sP = seedMix(seed ^ 0x9a11);
    const sN = seedMix(seed ^ 0x9a12);
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const rumble = clamp01(p.rumble.value(tc));
        const tA = Math.max(0, tc - GRAIN);
        const tB = (start + n) / sr;
        const cA = 20 * tA + 12 * p.pitch.integral(tA);
        const cB = 20 * tB + 12 * p.pitch.integral(tB);
        const r0 = pulseRate(clamp01(p.pitch.value(tA)));
        const len = Math.ceil(GRAIN * sr);
        for (let k = Math.max(0, Math.floor(cA) - 1); k <= Math.ceil(cB) + 1; k++) {
          const id = k * 8;
          const tk = timeOfPulse(p.pitch, k, tA + (k - cA) / r0) + (fastUnit(sP, id) - 0.5) * 0.004;
          const at = Math.round(tk * sr);
          if (at < 0 || at + len <= start || at >= start + n) continue;
          const bph = frac(p.breaths.integral(tk) / 60);
          const env = breathEnv(bph);
          if (env <= 0) continue;
          const inhale = bph >= 0.6;
          const amp = env * (0.8 + 0.4 * fastUnit(sP, id + 1)) * LEVEL;
          const fb = (inhale ? 85 : 70) * (0.9 + 0.2 * fastUnit(sP, id + 2));
          const noiseAmt = 0.25 + 0.75 * rumble;
          const from = Math.max(start, at);
          const to = Math.min(start + n, at + len);
          for (let j = from; j < to; j++) {
            const t = (j - at) / sr;
            const att = t < 0.002 ? t / 0.002 : 1;
            const body = Math.sin(TWO_PI * fb * t) * Math.exp(-t / 0.011) + 0.45 * Math.sin(TWO_PI * fb * 2.1 * t) * Math.exp(-t / 0.006);
            // soft noise: a few neighbouring samples averaged (stateless low-pass)
            const nl = (fastSigned(sN, j) + fastSigned(sN, j - 1) + fastSigned(sN, j - 2) + fastSigned(sN, j - 3)) * 0.25;
            const nr = (fastSigned(sN, j + 7919) + fastSigned(sN, j + 7918) + fastSigned(sN, j + 7917) + fastSigned(sN, j + 7916)) * 0.25;
            const ne = Math.exp(-t / (inhale ? 0.005 : 0.008)) * noiseAmt * 0.9;
            const b = body * (1.1 - 0.5 * rumble);
            L[j - start] += (b + nl * ne) * amp * att;
            R[j - start] += (b + nr * ne) * amp * att;
          }
        }
      },
    };
  },
};
