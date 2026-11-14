// Procedural singing bowl: struck now and then, ringing for a long time.
//
// A bowl rings at a few inharmonic partials, and each partial is really two
// close tones (the bowl isn't perfectly round), so it slowly beats and seems
// to turn. Here those two tones lean to opposite ears. Strikes sit on the
// integral of the strike rate (like the crickets' chirps), each one a pure
// function of time and seed, so seeking is exact.
// Android port: android/.../engine/Bowl.java (must match sample for sample).

import { TWO_PI, addOsc, clamp01 } from './dsp.ts';
import { fastUnit, seedMix } from './hash.ts';
import type { GeneratorDef, ParamReader } from './generators.ts';

const RATIO = [1, 2.76, 5.4, 8.93]; // partials of a struck bowl
const AMP = [1, 0.5, 0.26, 0.12];
const DECAY = [1, 0.55, 0.3, 0.18]; // ring time of each partial, relative to the first
const SPLIT = [0.5, 1.3, 2.4, 3.6]; // Hz between the two tones of each partial
/** Other bowls a strike may pick: a fourth and a fifth above. */
const BOWLS = [1, 1.335, 1.498];
const LEVEL = 0.2;

/** Time (s) at which the strike counter reaches `b`, refined by Newton steps. */
function timeOfStrike(rate: ParamReader, b: number, guess: number): number {
  let t = guess;
  for (let k = 0; k < 3; k++) {
    const r = Math.max(0.1, rate.value(t)) / 60;
    t += (b - rate.integral(t) / 60) / r;
  }
  return t;
}

export const bowl: GeneratorDef = {
  type: 'bowl',
  label: 'Singing bowl',
  params: [
    { name: 'rate', label: 'Strikes per minute', unit: '/min', min: 0.5, max: 8, default: 2 },
    { name: 'pitch', label: 'Bowl (large ↔ small)', unit: '', min: 0, max: 1, default: 0.35 },
    { name: 'ring', label: 'Ring time', unit: '', min: 0, max: 1, default: 0.6 },
    { name: 'variety', label: 'Variety', unit: '', min: 0, max: 1, default: 0.5 },
  ],
  create: (p, seed) => {
    const sS = seedMix(seed ^ 0xb041);
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const pitch = clamp01(p.pitch.value(tc));
        const ring = clamp01(p.ring.value(tc));
        const variety = clamp01(p.variety.value(tc));
        const f1 = 110 * Math.pow(2, 2 * pitch);
        const tau1 = 5 + 20 * ring;
        const tA = Math.max(0, tc - 5 * tau1);
        const tB = (start + n) / sr;
        const bA = p.rate.integral(tA) / 60;
        const bB = p.rate.integral(tB) / 60;
        const rate0 = Math.max(0.1, p.rate.value(tA)) / 60;
        const kA = Math.max(0, Math.floor(bA) - 1);
        const kB = Math.ceil(bB) + 1;
        for (let k = kA; k <= kB; k++) {
          const id = k * 16;
          // the first strike comes a moment after the start, the rest roughly on the beat
          const b = k + 0.15;
          const gap = 1 / rate0;
          const jitter = (fastUnit(sS, id) - 0.5) * 0.5 * variety * gap;
          const tk = timeOfStrike(p.rate, b, tA + (b - bA) / rate0) + jitter;
          const at = Math.round(tk * sr);
          if (at < 0 || at >= start + n) continue;
          const vel = (0.65 + 0.35 * fastUnit(sS, id + 1)) * LEVEL;
          if (vel * Math.exp(-(start - at) / (sr * tau1)) < 1e-6) continue;
          const pick = fastUnit(sS, id + 2) < variety * 0.6 ? 1 + Math.floor(fastUnit(sS, id + 3) * 2) : 0;
          const f = f1 * BOWLS[pick]!;
          const from = Math.max(start, at);
          const to = start + n;
          // a soft strike: the partials swell in over 4 ms
          const attackEnd = Math.min(to, at + Math.ceil(0.004 * sr));
          for (let m = 0; m < 4; m++) {
            const tau = tau1 * DECAY[m]!;
            const decay = Math.exp(-1 / (sr * tau));
            const split = SPLIT[m]! * (0.6 + 0.8 * fastUnit(sS, id + 4 + m));
            for (let side = 0; side < 2; side++) {
              const fm = f * RATIO[m]! + (side === 0 ? -0.5 : 0.5) * split;
              const w = (TWO_PI * fm) / sr;
              const ph0 = TWO_PI * fastUnit(sS, id + 8 + m * 2 + side);
              const gl = side === 0 ? 0.78 : 0.32;
              const gr = side === 0 ? 0.32 : 0.78;
              const a = vel * AMP[m]! * 0.5;
              if (from < attackEnd) {
                for (let j = from; j < attackEnd; j++) {
                  const t = (j - at) / sr;
                  const x = Math.sin(w * (j - at) + ph0) * a * Math.exp(-t / tau) * (t / 0.004);
                  L[j - start] += x * gl;
                  R[j - start] += x * gr;
                }
              }
              const f2 = Math.max(from, attackEnd);
              if (f2 < to) addOsc(L, R, start, f2, to, w * (f2 - at) + ph0, w, a * Math.exp(-(f2 - at) / (sr * tau)), decay, gl, gr);
            }
          }
          // the mallet: a short soft knock
          const knockEnd = Math.min(to, at + Math.ceil(0.08 * sr));
          for (let j = from; j < knockEnd; j++) {
            const t = (j - at) / sr;
            const x = Math.sin(TWO_PI * f * 2.3 * t) * Math.exp(-t / 0.012) * (t < 0.001 ? t / 0.001 : 1) * vel * 0.12;
            L[j - start] += x * 0.55;
            R[j - start] += x * 0.55;
          }
        }
      },
    };
  },
};
