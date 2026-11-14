// Procedural stream: a babbling brook made of many small bubbles.
//
// Running water's sound is mostly bubbles: each one rings briefly at a pitch
// set by its size, and the pitch slides up as it rises to the surface. A few
// larger, nearer bubbles give the "babble"; a dense cloud of small far ones
// gives the steady wash. Every bubble lives in a time slot and is a pure
// function of (seed, slot), so seeking is exact.
// Android port: android/.../engine/Stream.java (must match sample for sample).

import { TWO_PI, clamp01 } from './dsp.ts';
import { fastUnit, seedMix } from './hash.ts';
import type { GeneratorDef } from './generators.ts';

const SLOT = 0.004; // s, one slot; up to LAYERS bubbles may start in each
const LAYERS = 3; // 0 = near babble, 1-2 = far wash
const LIFE = 0.09; // s, longest a bubble rings
const LEVEL = 0.55;

export const stream: GeneratorDef = {
  type: 'stream',
  label: 'Stream',
  params: [
    { name: 'flow', label: 'Flow', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'pitch', label: 'Bubbles (deep ↔ light)', unit: '', min: 0, max: 1, default: 0.45 },
    { name: 'closeness', label: 'Closeness', unit: '', min: 0, max: 1, default: 0.5 },
  ],
  create: (p, seed) => {
    const sB = seedMix(seed ^ 0x57e1);
    return {
      render(t0, n, sr, L, R) {
        L.fill(0);
        R.fill(0);
        const start = Math.round(t0 * sr);
        const tc = start / sr;
        const flow = clamp01(p.flow.value(tc));
        const pitch = clamp01(p.pitch.value(tc));
        const close = clamp01(p.closeness.value(tc));
        const base = 300 + 900 * pitch;
        const pNear = 0.04 + 0.3 * flow;
        const pFar = 0.15 + 0.7 * flow;
        const ampNear = 0.25 + 0.75 * close;
        const ampFar = 0.32 - 0.14 * close;
        const sA = Math.max(0, Math.floor((tc - LIFE) / SLOT));
        const sZ = Math.floor((start + n) / sr / SLOT);
        for (let s = sA; s <= sZ; s++) {
          for (let k = 0; k < LAYERS; k++) {
            const id = (s * LAYERS + k) * 8;
            const near = k === 0;
            if (fastUnit(sB, id) >= (near ? pNear : pFar)) continue;
            const at = Math.round((s + fastUnit(sB, id + 1)) * SLOT * sr);
            // pitch from bubble size: near ones larger (lower), far ones small and bright
            const spread = near ? 2.2 : 2.6;
            const f0 = base * (near ? 1 : 1.7) * Math.pow(2, (fastUnit(sB, id + 2) - 0.5) * spread);
            const tau = (5 + 9 * fastUnit(sB, id + 3)) / f0;
            const len = Math.min(Math.ceil(LIFE * sr), Math.ceil(5 * tau * sr));
            if (at + len <= start || at >= start + n) continue;
            // the pitch rises 30-80 % over the bubble's ring
            const sigma = (0.3 + 0.5 * fastUnit(sB, id + 4)) / tau;
            const amp = (near ? ampNear * (0.4 + 0.6 * fastUnit(sB, id + 5)) : ampFar * (0.3 + 0.7 * fastUnit(sB, id + 5))) * LEVEL;
            const pan = 0.5 + (near ? 0.7 : 0.95) * (fastUnit(sB, id + 6) - 0.5);
            const gl = Math.min(1, 2 * (1 - pan));
            const gr = Math.min(1, 2 * pan);
            const from = Math.max(start, at);
            const to = Math.min(start + n, at + len);
            for (let j = from; j < to; j++) {
              const t = (j - at) / sr;
              const env = (t < 0.0006 ? t / 0.0006 : 1) * Math.exp(-t / tau);
              const x = Math.sin(TWO_PI * f0 * (t + 0.5 * sigma * t * t)) * env * amp;
              L[j - start] += x * gl;
              R[j - start] += x * gr;
            }
          }
        }
      },
    };
  },
};
