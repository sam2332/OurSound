// Procedural campfire.
//
// Three layers, all seekable (randomness is a pure function of seed + index):
//  - the flame: a low, breathing roar (brown + pink noise, flickering);
//  - crackles: very short clicks, coming in bursts as the wood catches;
//  - pops: louder, duller knocks of splitting wood, each throwing a few sparks.
// Android port: android/.../engine/Campfire.java (must match sample for sample).

import { Brown, LowPass, Pink, clamp01, stateful, valueNoise } from './dsp.ts';
import { fastSigned, fastUnit, seedMix } from './hash.ts';
import type { GeneratorDef } from './generators.ts';

const CRACKLE_SLOT = 96; // samples per crackle slot (2 ms at 48 kHz)
const CRACKLE_LEN = 96; // longest crackle (samples)
const POP_SLOT = 4800; // samples per pop slot (100 ms at 48 kHz)
const POP_LEN = 7200; // a pop and its sparks (samples)
const SPARKS = 4; // most sparks after a pop

/**
 * Adds one noise click at absolute sample `at` (overlapping [start, start+n)).
 * crisp 1 = sharp tick (high-passed), 0 = dull knock (low-passed).
 */
function click(
  L: Float32Array,
  R: Float32Array,
  start: number,
  n: number,
  at: number,
  tau: number,
  len: number,
  amp: number,
  crisp: number,
  pan: number,
  noise: number,
) {
  const from = Math.max(start, at);
  const to = Math.min(start + n, at + len);
  if (from >= to) return;
  const gl = Math.min(1, 2 * (1 - pan));
  const gr = Math.min(1, 2 * pan);
  let n1 = fastSigned(noise, from - 1);
  let n2 = fastSigned(noise, from - 2);
  for (let j = from; j < to; j++) {
    const k = j - at;
    const n0 = fastSigned(noise, j);
    const x = crisp * (n0 - n1) * 0.6 + (1 - crisp) * (n0 + n1 + n2) * 0.4;
    // 2-sample onset, then exponential decay
    const e = amp * (k < 2 ? (k + 1) / 2 : Math.exp(-(k - 2) / tau));
    L[j - start] += x * e * gl;
    R[j - start] += x * e * gr;
    n2 = n1;
    n1 = n0;
  }
}

export const campfire: GeneratorDef = {
  type: 'campfire',
  label: 'Campfire',
  params: [
    { name: 'size', label: 'Fire size', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'crackle', label: 'Crackle', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'pops', label: 'Pops', unit: '', min: 0, max: 1, default: 0.4 },
  ],
  create: (p, seed) => {
    const sL = seedMix(seed ^ 0xf1a1);
    const sR = seedMix(seed ^ 0xf1a2);
    const sF = seed ^ 0xf1a3; // flicker curves
    const sB = seed ^ 0xf1a4; // crackle bursts
    const cHit = seedMix(seed ^ 0xc401);
    const cPos = seedMix(seed ^ 0xc402);
    const cAmp = seedMix(seed ^ 0xc403);
    const cTau = seedMix(seed ^ 0xc404);
    const cPan = seedMix(seed ^ 0xc405);
    const cNoise = seedMix(seed ^ 0xc406);
    const pHit = seedMix(seed ^ 0xb001);
    const pRnd = seedMix(seed ^ 0xb002);
    const pNoise = seedMix(seed ^ 0xb003);
    const brownL = new Brown();
    const brownR = new Brown();
    const pinkL = new Pink();
    const pinkR = new Pink();
    const lpL = new LowPass();
    const lpR = new LowPass();
    const roarL = new LowPass();
    const roarR = new LowPass();
    const SUB = 32;
    return stateful({
      reset() {
        brownL.reset();
        brownR.reset();
        pinkL.reset();
        pinkR.reset();
        lpL.reset();
        lpR.reset();
        roarL.reset();
        roarR.reset();
      },
      run(start, n, sr, L, R) {
        const t0 = start / sr;
        const size = clamp01(p.size.value(t0));
        const crackle = clamp01(p.crackle.value(t0));
        const pops = clamp01(p.pops.value(t0));

        // the flame: a breathing low roar
        roarL.setCutoff(300 + 350 * size, sr);
        roarR.setCutoff(300 + 350 * size, sr);
        lpL.setCutoff(900 + 900 * size, sr);
        lpR.setCutoff(900 + 900 * size, sr);
        for (let i0 = 0; i0 < n; i0 += SUB) {
          const t = (start + i0) / sr;
          const flick = 0.55 * valueNoise(sF, t, 0.35) + 0.45 * valueNoise(sF ^ 0x2b, t, 1.9);
          const fl = 0.7 * flick + 0.3 * valueNoise(sF ^ 0x5c, t, 0.6);
          const fr = 0.7 * flick + 0.3 * valueNoise(sF ^ 0xc5, t, 0.6);
          const roar = 0.25 + 0.7 * size;
          const air = 0.08 + 0.2 * size;
          const m = Math.min(n, i0 + SUB);
          for (let i = i0; i < m; i++) {
            const idx = start + i;
            const wl = fastSigned(sL, idx);
            const wr = fastSigned(sR, idx);
            L[i] = roarL.step(brownL.step(wl)) * roar * (0.55 + 0.9 * fl) + lpL.step(pinkL.step(wl)) * air * fl;
            R[i] = roarR.step(brownR.step(wr)) * roar * (0.55 + 0.9 * fr) + lpR.step(pinkR.step(wr)) * air * fr;
          }
        }

        // Crackles: each 2 ms slot may hold one; they come in bursts.
        const firstC = Math.floor((start - CRACKLE_LEN) / CRACKLE_SLOT);
        const lastC = Math.floor((start + n - 1) / CRACKLE_SLOT);
        for (let slot = firstC; slot <= lastC; slot++) {
          const ts = (slot * CRACKLE_SLOT) / sr;
          const b = valueNoise(sB, ts, 0.45) * valueNoise(sB ^ 0x77, ts, 3.1);
          const perSecond = crackle * (3 + 260 * b * b * (0.4 + 0.6 * size));
          if (fastUnit(cHit, slot) >= (perSecond * CRACKLE_SLOT) / sr) continue;
          const at = slot * CRACKLE_SLOT + Math.floor(fastUnit(cPos, slot) * CRACKLE_SLOT);
          const r = fastUnit(cAmp, slot);
          const tau = (0.04 + 0.3 * fastUnit(cTau, slot)) * (sr / 1000);
          click(L, R, start, n, at, tau, CRACKLE_LEN, 0.9 * r * r * (0.4 + 0.6 * size), 0.85, fastUnit(cPan, slot), cNoise);
        }

        // Pops: splitting wood, a dull knock and a few sparks after it.
        const firstP = Math.floor((start - POP_LEN) / POP_SLOT);
        const lastP = Math.floor((start + n - 1) / POP_SLOT);
        const popProb = pops * pops * 0.06;
        for (let slot = firstP; slot <= lastP; slot++) {
          if (fastUnit(pHit, slot) >= popProb) continue;
          const base = slot * 16;
          const at = slot * POP_SLOT + Math.floor(fastUnit(pRnd, base) * POP_SLOT);
          if (at + POP_LEN <= start || at >= start + n) continue;
          const loud = 0.5 + 0.5 * fastUnit(pRnd, base + 1);
          const pan = 0.2 + 0.6 * fastUnit(pRnd, base + 2);
          const tau = (1.5 + 3 * fastUnit(pRnd, base + 3)) * (sr / 1000);
          click(L, R, start, n, at, tau, Math.ceil(tau * 7), 1.6 * loud, 0.3, pan, pNoise);
          const sparks = Math.floor(fastUnit(pRnd, base + 4) * (SPARKS + 1));
          for (let s = 0; s < sparks; s++) {
            const r = base + 5 + s * 2;
            const sAt = at + Math.floor((0.01 + 0.12 * fastUnit(pRnd, r)) * sr);
            const sTau = (0.05 + 0.25 * fastUnit(pRnd, r + 1)) * (sr / 1000);
            const sPan = Math.min(1, Math.max(0, pan + 0.4 * (fastUnit(pRnd, r + 1) - 0.5)));
            click(L, R, start, n, sAt, sTau, CRACKLE_LEN, 0.7 * loud, 0.9, sPan, cNoise);
          }
        }
      },
    });
  },
};
