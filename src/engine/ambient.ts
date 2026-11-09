// Procedural ambience: box fan, rain, thunder, wind, ocean.
//
// Same rules as the other generators:
// - randomness is a pure function of (seed, sample/slot index), so events such
//   as raindrops, thunder and waves are re-derived on demand, never stored;
// - filters have state, so after a seek they are warmed up on the preceding
//   samples, which makes the output depend only on the position.

import { BandPass, Brown, LowPass, Pink, TWO_PI, clamp01, stateful, valueNoise } from './dsp.ts';
import { fastSigned, fastUnit, rand01, seedMix } from './hash.ts';
import type { GeneratorDef, ParamReader } from './generators.ts';
import { campfire } from './campfire.ts';
import { crickets } from './crickets.ts';
import { drums } from './drums.ts';
import { thunder } from './thunder.ts';

// ------------------------------------------------------------------ box fan

const fan: GeneratorDef = {
  type: 'fan',
  label: 'Box fan',
  params: [
    { name: 'speed', label: 'Speed', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'tone', label: 'Brightness', unit: '', min: 0, max: 1, default: 0.4 },
    { name: 'wobble', label: 'Wobble', unit: '', min: 0, max: 1, default: 0.3 },
  ],
  create: (p, seed) => {
    const sL = seedMix(seed ^ 0x51f1);
    const sR = seedMix(seed ^ 0x51f2);
    const pinkL = new Pink();
    const pinkR = new Pink();
    const brownL = new Brown();
    const brownR = new Brown();
    const lpL = new LowPass();
    const lpR = new LowPass();
    const rumbleL = new LowPass();
    const rumbleR = new LowPass();
    // Rotation rate (Hz) = 14 + 10·speed. Its exact integral gives the blade phase.
    const rotCycles = (t: number) => 14 * t + 10 * p.speed.integral(t);
    return stateful({
      reset() {
        pinkL.reset();
        pinkR.reset();
        brownL.reset();
        brownR.reset();
        lpL.reset();
        lpR.reset();
        rumbleL.reset();
        rumbleR.reset();
      },
      run(start, n, sr, L, R) {
        const t0 = start / sr;
        const speed = clamp01(p.speed.value(t0));
        const tone = clamp01(p.tone.value(t0));
        const wobble = clamp01(p.wobble.value(t0));
        const cutoff = 350 + tone * 2600 + speed * 1400;
        lpL.setCutoff(cutoff, sr);
        lpR.setCutoff(cutoff, sr);
        rumbleL.setCutoff(140, sr);
        rumbleR.setCutoff(140, sr);
        const airGain = 0.55 + 0.6 * speed;
        const rot0 = rotCycles(t0);
        const rotHz = 14 + 10 * speed;
        // 3 blades: blade-pass at 3× rotation; slight imbalance at 1×.
        for (let i = 0; i < n; i++) {
          const idx = start + i;
          const rot = rot0 + (rotHz * i) / sr;
          const blade = Math.sin(TWO_PI * 3 * rot);
          const imbalance = Math.sin(TWO_PI * rot);
          const am = 1 + 0.12 * blade + 0.25 * wobble * imbalance;
          const wl = fastSigned(sL, idx);
          const wr = fastSigned(sR, idx);
          const airL = lpL.step(pinkL.step(wl)) * airGain * am;
          const airR = lpR.step(pinkR.step(wr)) * airGain * am;
          const rl = rumbleL.step(brownL.step(wl)) * 1.6;
          const rr = rumbleR.step(brownR.step(wr)) * 1.6;
          // faint motor hum at blade-pass and 2× (phase-exact)
          const hum = 0.02 * blade + 0.012 * Math.sin(TWO_PI * 6 * rot);
          L[i] = (airL + rl + hum) * 1.15;
          R[i] = (airR + rr + hum) * 1.15;
        }
      },
    });
  },
};

// ------------------------------------------------------------------ rain

const DROP_SLOT = 48; // samples per drop slot (1 ms at 48 kHz)
const DROP_MAX_LEN = 1024; // samples a drop can last (~21 ms)
const DROP_ATTACK = 12; // samples (0.25 ms): a sharp, click-like onset

const rain: GeneratorDef = {
  type: 'rain',
  label: 'Rain',
  params: [
    { name: 'intensity', label: 'Intensity', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'drops', label: 'Drops', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'brightness', label: 'Brightness', unit: '', min: 0, max: 1, default: 0.5 },
  ],
  create: (p, seed) => {
    const sL = seedMix(seed ^ 0x7a11);
    const sR = seedMix(seed ^ 0x7a12);
    // pre-mixed seeds for the per-slot drop decisions (one hash round each)
    const dHit = seedMix(seed ^ 0x3d09);
    const dPos = seedMix(seed ^ 0x3d11);
    const dTau = seedMix(seed ^ 0x3d22);
    const dTone = seedMix(seed ^ 0x3d33);
    const dNoise = seedMix(seed ^ 0x3d66);
    const dAmp = seedMix(seed ^ 0x3d44);
    const dPan = seedMix(seed ^ 0x3d55);
    const pinkL = new Pink();
    const pinkR = new Pink();
    const lpL = new LowPass();
    const lpR = new LowPass();
    const hpL = new LowPass();
    const hpR = new LowPass();
    return stateful({
      reset() {
        pinkL.reset();
        pinkR.reset();
        lpL.reset();
        lpR.reset();
        hpL.reset();
        hpR.reset();
      },
      run(start, n, sr, L, R) {
        const t0 = start / sr;
        const intensity = clamp01(p.intensity.value(t0));
        const drops = clamp01(p.drops.value(t0));
        const bright = clamp01(p.brightness.value(t0));
        lpL.setCutoff(1200 + bright * 7000, sr);
        lpR.setCutoff(1200 + bright * 7000, sr);
        hpL.setCutoff(250, sr);
        hpR.setCutoff(250, sr);
        const bed = 0.35 + 0.9 * intensity;

        // the steady "hiss" of rain
        for (let i = 0; i < n; i++) {
          const idx = start + i;
          const xl = pinkL.step(fastSigned(sL, idx));
          const xr = pinkR.step(fastSigned(sR, idx));
          const yl = lpL.step(xl);
          const yr = lpR.step(xr);
          L[i] = (yl - hpL.step(yl)) * bed;
          R[i] = (yr - hpR.step(yr)) * bed;
        }

        // Individual drops: each 1 ms slot may hold one, decided by its hash.
        // A drop is a short burst of noise (an impact), never a tone: a sharp
        // onset and a few-millisecond decay. Most are faint, a few are close.
        const perSecond = 20 + 900 * drops * (0.3 + intensity);
        const prob = Math.min(0.9, (perSecond * DROP_SLOT) / sr);
        const firstSlot = Math.floor((start - DROP_MAX_LEN) / DROP_SLOT);
        const lastSlot = Math.floor((start + n - 1) / DROP_SLOT);
        const msToSamples = sr / 1000;
        for (let slot = firstSlot; slot <= lastSlot; slot++) {
          if (fastUnit(dHit, slot) >= prob) continue;
          const r1 = fastUnit(dPos, slot);
          const r2 = fastUnit(dTau, slot);
          const r3 = fastUnit(dTone, slot);
          const r4 = fastUnit(dAmp, slot);
          const dropStart = slot * DROP_SLOT + Math.floor(r1 * DROP_SLOT);
          // decay 0.4–2.6 ms; brighter surfaces ring a little shorter
          const tau = (0.4 + 2.2 * r2) * (1 - 0.35 * bright) * msToSamples;
          const len = Math.min(DROP_MAX_LEN, DROP_ATTACK + Math.ceil(tau * 7));
          if (dropStart + len <= start || dropStart >= start + n) continue;
          // 0 = dull pat (leaves, soil) … 1 = crisp tap (window, roof)
          const crisp = clamp01(bright * 0.8 + r3 * 0.4 - 0.2);
          const amp = 0.55 * r4 * r4 * r4 * (0.4 + intensity);
          const pan = fastUnit(dPan, slot);
          const gl = Math.min(1, 2 * (1 - pan));
          const gr = Math.min(1, 2 * pan);
          const from = Math.max(start, dropStart);
          const to = Math.min(start + n, dropStart + len);
          const decay = Math.exp(-1 / tau);
          const k0 = from - dropStart;
          let env = amp * (k0 < DROP_ATTACK ? 1 : Math.exp(-(k0 - DROP_ATTACK) / tau));
          // noise for this drop, by absolute sample index (stateless and seekable)
          let n1 = fastSigned(dNoise, from - 1);
          let n2 = fastSigned(dNoise, from - 2);
          for (let j = from; j < to; j++) {
            const k = j - dropStart;
            const n0 = fastSigned(dNoise, j);
            // crisp: first difference (high-pass); dull: 3-tap average (low-pass)
            const x = crisp * (n0 - n1) * 0.6 + (1 - crisp) * (n0 + n1 + n2) * 0.4;
            const e = k < DROP_ATTACK ? (env * (k + 1)) / DROP_ATTACK : env;
            L[j - start] += x * e * gl;
            R[j - start] += x * e * gr;
            if (k >= DROP_ATTACK) env *= decay;
            n2 = n1;
            n1 = n0;
          }
        }
      },
    });
  },
};

// ------------------------------------------------------------------ wind

const wind: GeneratorDef = {
  type: 'wind',
  label: 'Wind',
  params: [
    { name: 'strength', label: 'Strength', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'gusts', label: 'Gustiness', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'pitch', label: 'Pitch', unit: '', min: 0, max: 1, default: 0.4 },
  ],
  create: (p, seed) => {
    const sL = seedMix(seed ^ 0x3311);
    const sR = seedMix(seed ^ 0x3312);
    const sG = seed ^ 0x3313;
    const pinkL = new Pink();
    const pinkR = new Pink();
    const bpL = new BandPass();
    const bpR = new BandPass();
    const whL = new BandPass();
    const whR = new BandPass();
    const SUB = 32; // coefficient update interval
    return stateful({
      reset() {
        pinkL.reset();
        pinkR.reset();
        bpL.reset();
        bpR.reset();
        whL.reset();
        whR.reset();
      },
      run(start, n, sr, L, R) {
        const t0 = start / sr;
        const strength = clamp01(p.strength.value(t0));
        const gusts = clamp01(p.gusts.value(t0));
        const pitch = clamp01(p.pitch.value(t0));
        for (let i0 = 0; i0 < n; i0 += SUB) {
          const t = (start + i0) / sr;
          const g = 0.6 * valueNoise(sG, t, 7) + 0.4 * valueNoise(sG ^ 0x99, t, 2.3);
          const gl = 0.5 * valueNoise(sG ^ 0x5a, t, 5) + 0.5 * g;
          const gr = 0.5 * valueNoise(sG ^ 0xa5, t, 5) + 0.5 * g;
          const amp = (0.25 + 0.9 * strength) * (1 - gusts * 0.85 + gusts * 0.85 * g * 1.6);
          const cL = 180 + pitch * 700 + 900 * gl * (0.3 + gusts);
          const cR = 180 + pitch * 700 + 900 * gr * (0.3 + gusts);
          bpL.set(cL, 0.9, sr);
          bpR.set(cR, 0.9, sr);
          whL.set(cL * 2.6, 6, sr);
          whR.set(cR * 2.6, 6, sr);
          const whistle = 0.5 * gusts * g * g;
          const m = Math.min(n, i0 + SUB);
          for (let i = i0; i < m; i++) {
            const idx = start + i;
            const xl = pinkL.step(fastSigned(sL, idx));
            const xr = pinkR.step(fastSigned(sR, idx));
            L[i] = (bpL.step(xl) * 2.2 + whL.step(xl) * whistle) * amp;
            R[i] = (bpR.step(xr) * 2.2 + whR.step(xr) * whistle) * amp;
          }
        }
      },
    });
  },
};

// ------------------------------------------------------------------ ocean

const ocean: GeneratorDef = {
  type: 'ocean',
  label: 'Ocean waves',
  params: [
    { name: 'period', label: 'Seconds between waves', unit: 's', min: 4, max: 20, default: 9 },
    { name: 'size', label: 'Wave size', unit: '', min: 0, max: 1, default: 0.6 },
    { name: 'closeness', label: 'Closeness', unit: '', min: 0, max: 1, default: 0.5 },
  ],
  create: (p, seed) => {
    const sL = seedMix(seed ^ 0x0ce1);
    const sR = seedMix(seed ^ 0x0ce2);
    const sW = seed ^ 0x0ce3;
    const pinkL = new Pink();
    const pinkR = new Pink();
    const brownL = new Brown();
    const brownR = new Brown();
    const lpL = new LowPass();
    const lpR = new LowPass();
    const SUB = 32;

    /** Loudness and brightness of the waves at time t (time-pure). */
    const waveAt = (t: number, period: number, out: { amp: number; bright: number }) => {
      // Waves sit on a jittered grid, like random repeats.
      const k0 = Math.floor(t / period);
      out.amp = 0;
      out.bright = 0;
      for (let k = k0 - 2; k <= k0; k++) {
        const start = (k + (rand01(sW, k) - 0.5) * 0.5) * period;
        const x = (t - start) / period; // 0..~1.8 over one wave
        if (x < 0 || x > 1.9) continue;
        const size = 0.55 + 0.45 * rand01(sW ^ 0x77, k);
        const crest = 0.42 + 0.1 * rand01(sW ^ 0x88, k);
        let e: number;
        let b: number;
        if (x < crest) {
          const u = x / crest;
          e = u * u * u; // the wave builds
          b = u * u * 0.6;
        } else {
          const u = x - crest;
          e = Math.exp(-u * 2.2); // crash then wash out
          b = Math.exp(-u * 5) + 0.15 * Math.exp(-u * 1.5);
        }
        out.amp += e * size;
        out.bright = Math.max(out.bright, b * size);
      }
    };
    const w = { amp: 0, bright: 0 };

    return stateful({
      reset() {
        pinkL.reset();
        pinkR.reset();
        brownL.reset();
        brownR.reset();
        lpL.reset();
        lpR.reset();
      },
      run(start, n, sr, L, R) {
        const t0 = start / sr;
        const period = Math.max(4, p.period.value(t0));
        const size = clamp01(p.size.value(t0));
        const close = clamp01(p.closeness.value(t0));
        for (let i0 = 0; i0 < n; i0 += SUB) {
          const t = (start + i0) / sr;
          waveAt(t, period, w);
          const cutoff = 220 + w.bright * (1800 + 3500 * close);
          lpL.setCutoff(cutoff, sr);
          lpR.setCutoff(cutoff, sr);
          const amp = (0.12 + w.amp * (0.5 + 0.8 * size)) * 1.5;
          const m = Math.min(n, i0 + SUB);
          for (let i = i0; i < m; i++) {
            const idx = start + i;
            const wl = fastSigned(sL, idx);
            const wr = fastSigned(sR, idx);
            const hl = lpL.step(pinkL.step(wl));
            const hr = lpR.step(pinkR.step(wr));
            const rumble = 0.25 + 0.5 * w.amp;
            L[i] = hl * amp + brownL.step(wl) * 0.18 * rumble;
            R[i] = hr * amp + brownR.step(wr) * 0.18 * rumble;
          }
        }
      },
    });
  },
};

/**
 * Output trims so every ambience sits near NOMINAL_RMS (-12 dBFS) at 0 dB.
 * Measured with default params; thunder is trimmed by its peaks instead,
 * since it is silent between strikes.
 */
function trimmed(def: GeneratorDef, k: number): GeneratorDef {
  return {
    ...def,
    create: (p, seed) => {
      const v = def.create(p, seed);
      return {
        render(t0, n, sr, L, R) {
          v.render(t0, n, sr, L, R);
          for (let i = 0; i < n; i++) {
            L[i] *= k;
            R[i] *= k;
          }
        },
      };
    },
  };
}

export const AMBIENT_GENERATORS = {
  fan: trimmed(fan, 0.49),
  rain: trimmed(rain, 1.53),
  thunder: trimmed(thunder, 0.5),
  wind: trimmed(wind, 1.42),
  ocean: trimmed(ocean, 0.96),
  campfire: trimmed(campfire, 2),
  drums: trimmed(drums, 1),
  crickets: trimmed(crickets, 0.6),
} as const;

// re-exported for tests
export { valueNoise };
export type { ParamReader };
