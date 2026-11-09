// Procedural thunder with real variety.
//
// Every strike is derived from (seed, slot) — never stored — and gets:
//  - a TYPE, weighted by how close it is:
//      boom     close crack-and-BOOM with a chest-felt thump
//      flicker  2–4 cracks in quick succession (multi-stroke lightning)
//      rumble   a rolling rumble made of several overlapping rolls
//      growl    a low, muffled growl far away
//      skyroll  a long roll (30–45 s) travelling across the sky
//  - its own timbre (filter), stereo width and movement across the field,
//  - a rolling texture made of separate arrivals: the sound of each part of the
//    bolt reaches you at its own time, so a roll is a string of shock pulses
//    with a quick hit and a short fade (smooth swells alone sound like wind).
// Strikes come in bursts and lulls following a slowly drifting storm-activity
// curve around the strikes-per-hour setting. "Variety" goes from a steady,
// uniform storm (0) to a wild, mixed one (1).

import { Brown, LowPass, Pink, TWO_PI, clamp01, stateful, valueNoise } from './dsp.ts';
import { fastSigned, rand01, seedMix } from './hash.ts';
import type { GeneratorDef } from './generators.ts';

/** Seconds per scheduling slot; each slot may hold one strike. */
export const THUNDER_SLOT = 6;
const MAX_LEN = 46; // longest strike (s)
const TAIL = 6; // fade after a strike's nominal length (s)
const LOOKBACK = Math.ceil((MAX_LEN + TAIL + 2) / THUNDER_SLOT) + 1;
const ACTIVITY_PERIOD = 240; // s: how fast storm activity drifts
const SUB = 32; // envelope evaluation step (samples)

export type StrikeType = 'boom' | 'flicker' | 'rumble' | 'growl' | 'skyroll';
const TYPES: StrikeType[] = ['boom', 'flicker', 'rumble', 'growl', 'skyroll'];

type Roll = { at: number; attack: number; decay: number; amp: number };
type Crack = { at: number; amp: number; decay: number };

export type Strike = {
  slot: number;
  type: StrikeType;
  start: number;
  dur: number;
  near: number;
  cutoff: number;
  width: number;
  rolls: Roll[];
  cracks: Crack[];
  thump: number;
  panFrom: number;
  panTo: number;
  /** Arrivals per second at the height of a roll. */
  arrRate: number;
  /** Typical fade of one arrival (s). */
  arrDecay: number;
  grumbleSeed: number;
  level: number;
};

/** Storm activity multiplier at time t (mean ≈ 1): bursts and lulls. */
export function stormActivity(seed: number, t: number, variety: number): number {
  // Two drifting layers: storm cells (~20 min) and bursts within them (~4 min).
  // v³ makes most of the time calmer and a little of it very active (mean ≈ 1);
  // the 0.3 floor keeps lulls from going silent for many minutes.
  const cell = valueNoise(seed ^ 0xac71, t, ACTIVITY_PERIOD * 4);
  const burst = valueNoise(seed ^ 0x3c19, t, ACTIVITY_PERIOD);
  const v = 0.45 * cell + 0.55 * burst;
  const bursty = 0.3 + 4.07 * v * v * v;
  return 1 + (bursty - 1) * clamp01(variety);
}

function pickType(r: number, near: number, variety: number): StrikeType {
  const far = 1 - near;
  const base = [near * near * 2, near * 0.9, 1, far * far * 2, 0.3 + 0.5 * far];
  // Low variety: concentrate on the types typical for this distance.
  const sharp = 1 + 3 * (1 - clamp01(variety));
  const w = base.map((x) => Math.pow(x + 1e-3, sharp));
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i] / total;
    if (r < acc) return TYPES[i];
  }
  return 'rumble';
}

const between = (r: number, a: number, b: number) => a + (b - a) * r;

/** The strike in `slot`, or null. Pure function of its arguments. */
export function strikeFor(seed: number, slot: number, perHour: number, distance: number, variety: number): Strike | null {
  const tMid = (slot + 0.5) * THUNDER_SLOT;
  const p = Math.min(0.95, ((perHour * THUNDER_SLOT) / 3600) * stormActivity(seed, tMid, variety));
  if (rand01(seed, slot) >= p) return null;
  let k = 0;
  const r = () => rand01(seed ^ Math.imul(0x9e3779b1, ++k), slot);

  const near = clamp01(1 - distance + (r() - 0.5) * (0.2 + 0.6 * variety));
  const type = pickType(r(), near, variety);
  const start = slot * THUNDER_SLOT + r() * (THUNDER_SLOT - 0.5);
  const delay = (1 - near) * 0.6; // sound arrives later from far away
  const pan0 = (r() - 0.5) * 1.2;
  const rolls: Roll[] = [];
  const cracks: Crack[] = [];
  let dur: number;
  let cutoff: number;
  let thump = 0;
  let panTo = pan0;
  let width: number;
  let arrRate: number;
  let arrDecay: number;
  let level = 1;

  switch (type) {
    case 'boom': {
      dur = between(r(), 6, 14);
      cracks.push({ at: 0, amp: 0.35 + 0.65 * near, decay: between(r(), 0.05, 0.13) });
      thump = 0.5 + 0.5 * near;
      rolls.push({ at: 0.03, attack: between(r(), 0.06, 0.2), decay: between(r(), 1, 2.5), amp: 1 });
      const extra = 1 + Math.floor(r() * 3);
      for (let i = 0; i < extra; i++)
        rolls.push({ at: between(r(), 0.5, dur * 0.5), attack: between(r(), 0.2, 0.7), decay: between(r(), 1.5, 3.5), amp: between(r(), 0.3, 0.7) });
      cutoff = 320 + 900 * near;
      width = 0.8;
      panTo = pan0 + (r() - 0.5) * 0.3;
      arrRate = between(r(), 7, 12);
      arrDecay = 0.16;
      break;
    }
    case 'flicker': {
      dur = between(r(), 6, 12);
      const strokes = 2 + Math.floor(r() * 3);
      let at = 0;
      for (let i = 0; i < strokes; i++) {
        cracks.push({ at, amp: (0.3 + 0.6 * near) * between(r(), 0.6, 1), decay: between(r(), 0.04, 0.09) });
        rolls.push({ at: at + 0.02, attack: between(r(), 0.05, 0.15), decay: between(r(), 0.6, 1.5), amp: between(r(), 0.5, 0.9) });
        at += between(r(), 0.15, 0.55);
      }
      rolls.push({ at: at + 0.1, attack: between(r(), 0.3, 0.8), decay: between(r(), 2, 4), amp: 0.8 });
      thump = 0.45 * near;
      cutoff = 360 + 800 * near;
      width = 0.85;
      panTo = pan0 + (r() - 0.5) * 0.5;
      arrRate = between(r(), 8, 14);
      arrDecay = 0.12;
      break;
    }
    case 'rumble': {
      dur = between(r(), 10, 24);
      const n = 4 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++)
        rolls.push({
          at: i === 0 ? 0 : r() * dur * 0.7,
          attack: between(r(), 0.3, 1.2),
          decay: between(r(), 1.5, 4),
          amp: i === 0 ? 1 : between(r(), 0.35, 0.9),
        });
      if (near > 0.6) cracks.push({ at: 0, amp: 0.4 * near, decay: 0.06 });
      thump = 0.3 * near * near;
      cutoff = 160 + 620 * near;
      width = 0.9;
      panTo = pan0 + (r() < 0.5 ? -1 : 1) * between(r(), 0.3, 0.8);
      arrRate = between(r(), 5, 9);
      arrDecay = 0.22;
      break;
    }
    case 'growl': {
      dur = between(r(), 8, 20);
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++)
        rolls.push({ at: r() * dur * 0.6, attack: between(r(), 1, 2.5), decay: between(r(), 2, 5), amp: between(r(), 0.4, 0.85) });
      cutoff = 70 + 180 * near;
      width = 0.55;
      panTo = pan0 + (r() - 0.5) * 0.4;
      arrRate = between(r(), 3, 6);
      arrDecay = 0.3;
      level = 0.8;
      break;
    }
    case 'skyroll':
    default: {
      dur = between(r(), 28, 45);
      const n = 7 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++)
        rolls.push({ at: (i / n) * dur * 0.85 + r() * 2, attack: between(r(), 0.6, 2), decay: between(r(), 2, 5), amp: between(r(), 0.3, 0.8) });
      cutoff = 120 + 420 * near;
      width = 1;
      // travels across the whole sky, one side to the other
      const side = r() < 0.5 ? -1 : 1;
      panTo = -side * 0.8;
      arrRate = between(r(), 4, 8);
      arrDecay = 0.25;
      return {
        slot, type, start, dur, near, cutoff, width, rolls: rolls.map((x) => ({ ...x, at: x.at + delay })), cracks,
        thump: 0, panFrom: side * 0.8, panTo, arrRate, arrDecay, grumbleSeed: hashSeed(seed, slot), level: 0.9,
      };
    }
  }
  // Variety also varies loudness from strike to strike.
  level *= 1 - 0.4 * clamp01(variety) * r();
  return {
    slot, type, start, dur, near, cutoff, width,
    rolls: rolls.map((x) => ({ ...x, at: x.at + delay })),
    cracks: cracks.map((x) => ({ ...x, at: x.at + delay * 0.2 })),
    thump, panFrom: pan0, panTo, arrRate, arrDecay, grumbleSeed: hashSeed(seed, slot), level,
  };
}

function hashSeed(seed: number, slot: number) {
  return Math.floor(rand01(seed ^ 0x51ed27, slot) * 2 ** 31);
}

const ARR_SLOT = 0.05; // s per arrival slot
const ARR_BACK = 40; // slots looked back (2 s covers the longest arrival fade)

/** The smooth shape of a strike's rolls at strike-local time x. */
function rollsAt(s: Strike, x: number): number {
  let e = 0;
  for (const r of s.rolls) {
    const u = x - r.at;
    if (u <= 0) continue;
    const a = u < r.attack ? 0.5 - 0.5 * Math.cos((Math.PI * u) / r.attack) : 1;
    const d = u < r.attack ? 1 : Math.exp(-(u - r.attack) / r.decay);
    e += r.amp * a * d;
  }
  // many overlapping rolls shouldn't pile up into one huge peak
  return e / Math.sqrt(Math.max(1, s.rolls.length / 2));
}

/**
 * Rumble envelope at time t: a quiet bed following the rolls, plus separate
 * arrivals (quick hit, short fade) scattered through them, denser and louder
 * where the rolls are strong. Time-pure.
 */
export function rumbleEnvelope(s: Strike, t: number): number {
  const x = t - s.start;
  if (x < 0 || x > s.dur + TAIL) return 0;
  const base = rollsAt(s, x);
  // close strikes hit hard; far ones arrive softened
  const att = 0.006 + 0.04 * (1 - s.near);
  const pMax = Math.min(0.9, s.arrRate * ARR_SLOT);
  let a = 0;
  const q1 = Math.floor(x / ARR_SLOT);
  for (let q = q1; q > q1 - ARR_BACK && q >= 0; q--) {
    const hit = rand01(s.grumbleSeed, q * 4 + 1);
    if (hit >= pMax) continue;
    const at = (q + rand01(s.grumbleSeed, q * 4)) * ARR_SLOT;
    const u = x - at;
    if (u < 0) continue;
    const env0 = rollsAt(s, at);
    if (hit >= pMax * Math.min(1, env0 * 1.5)) continue;
    const k = rand01(s.grumbleSeed, q * 4 + 2);
    const amp = env0 * (0.3 + 1.6 * k * k * k);
    const tau = s.arrDecay * (0.5 + rand01(s.grumbleSeed, q * 4 + 3));
    const rise = u < att ? 0.5 - 0.5 * Math.cos((Math.PI * u) / att) : 1;
    a += amp * rise * Math.exp(-Math.max(0, u - att) / tau);
  }
  if (base === 0 && a === 0) return 0;
  const tail = x > s.dur ? Math.max(0, 1 - (x - s.dur) / TAIL) : 1;
  return (0.23 * base + 0.52 * a) * tail * s.level;
}

// The rumble's noise and filters sit high enough to be heard on small speakers.
const RUMBLE_OPEN = 1.8; // filter cutoffs, times each strike's own
const RUMBLE_PINK = 1.5;
const RUMBLE_BROWN = 0.5;
const LOW_CUT = 35; // Hz: below this is felt, not heard, and only eats headroom

const MAX_ARR = 48; // most shock pulses tracked per strike in one control step
const P_SLOT = 0.004; // s per pulse slot
const P_MAX_D = 0.031; // longest pulse (s)

/**
 * The shock pulses of `s` overlapping strike-local times [xa, xb], written to
 * `out` from `off` as [at, amp, duration, rise]. Returns how many.
 * Thunder is made of N-waves: a sharp jump up, a slide down, a sharp jump back.
 * Their sharp edges are what you hear as the crack and grumble of a roll; far
 * away the edges soften and the pulses stretch, so the sound gets duller.
 */
function pulsesAt(s: Strike, xa: number, xb: number, out: Float64Array, off: number): number {
  const seed = s.grumbleSeed ^ 0x2b2b;
  const pMax = Math.min(0.9, s.arrRate * 6 * P_SLOT);
  const dur = 0.004 + 0.022 * (1 - s.near);
  const rise = 0.0003 + 0.0025 * (1 - s.near);
  let c = 0;
  const qa = Math.max(0, Math.floor((xa - P_MAX_D) / P_SLOT));
  const qb = Math.floor(xb / P_SLOT);
  for (let q = qa; q <= qb && c < MAX_ARR; q++) {
    const hit = rand01(seed, q * 4);
    if (hit >= pMax) continue;
    const at = (q + rand01(seed, q * 4 + 1)) * P_SLOT;
    const d = dur * (0.6 + 0.8 * rand01(seed, q * 4 + 2));
    if (at > xb || at + d < xa) continue;
    const env0 = rollsAt(s, at);
    if (hit >= pMax * Math.min(1, env0 * 1.5)) continue;
    const k = rand01(seed, q * 4 + 3);
    const o = off + c * 4;
    out[o] = at;
    out[o + 1] = env0 * (0.3 + 1.4 * k * k * k);
    out[o + 2] = d;
    out[o + 3] = rise;
    c++;
  }
  return c;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/** Sum of the pulses in `buf` at strike-local time x. */
function pulseAt(buf: Float64Array, off: number, count: number, x: number): number {
  let y = 0;
  for (let j = 0; j < count; j++) {
    const o = off + j * 4;
    const u = x - buf[o];
    const d = buf[o + 2];
    if (u < 0 || u >= d) continue;
    const tr = buf[o + 3];
    const w = u < tr ? smooth(u / tr) : u < d - tr ? 1 - (2 * (u - tr)) / (d - 2 * tr) : -1 + smooth((u - d + tr) / tr);
    y += buf[o + 1] * w;
  }
  return y;
}

function crackEnvelope(s: Strike, t: number): number {
  let e = 0;
  for (const c of s.cracks) {
    const x = t - s.start - c.at;
    if (x < 0 || x > c.decay * 9) continue;
    const a = x < 0.002 ? x / 0.002 : 1;
    // ripping flutter
    const rip = 0.55 + 0.45 * valueNoise(s.grumbleSeed ^ 0x77, x, 1 / 70);
    e += c.amp * a * Math.exp(-x / c.decay) * rip;
  }
  return e * s.level;
}

/** Deep sub-bass thump on close strikes: a short falling sine (felt more than heard). */
function thumpAt(s: Strike, t: number): number {
  if (s.thump === 0) return 0;
  const x = t - s.start - 0.02;
  if (x < 0 || x > 1.6) return 0;
  const env = x < 0.012 ? x / 0.012 : Math.exp(-(x - 0.012) / 0.32);
  const phase = 36 * x + 24 * 0.12 * (1 - Math.exp(-x / 0.12)); // 60 → 36 Hz
  return Math.sin(TWO_PI * phase) * env * s.thump * s.level;
}

const strikeEnd = (s: Strike) => s.start + s.dur + TAIL;

type StrikeState = { l1: LowPass; l2: LowPass; r1: LowPass; r2: LowPass };

export const thunder: GeneratorDef = {
  type: 'thunder',
  label: 'Thunder',
  params: [
    { name: 'rate', label: 'Strikes per hour', unit: '/h', min: 1, max: 120, default: 20 },
    { name: 'distance', label: 'Distance', unit: '', min: 0, max: 1, default: 0.5 },
    { name: 'intensity', label: 'Intensity', unit: '', min: 0, max: 1, default: 0.7 },
    { name: 'variety', label: 'Variety', unit: '', min: 0, max: 1, default: 0.6 },
  ],
  create: (p, seed) => {
    const sEv = (seed ^ 0x7d3a) >>> 0;
    const sL = seedMix(seed ^ 0x6b1);
    const sR = seedMix(seed ^ 0x6b2);
    const brownL = new Brown();
    const brownR = new Brown();
    const pinkL = new Pink();
    const pinkR = new Pink();
    const lowL = new LowPass();
    const lowR = new LowPass();
    const strikes: (Strike | null)[] = new Array(LOOKBACK).fill(null);
    const states = new Map<number, StrikeState>();
    const envA = new Float64Array(LOOKBACK);
    const envB = new Float64Array(LOOKBACK);
    const crA = new Float64Array(LOOKBACK);
    const crB = new Float64Array(LOOKBACK);
    const panL = new Float64Array(LOOKBACK);
    const panR = new Float64Array(LOOKBACK);
    const arrBuf = new Float64Array(LOOKBACK * MAX_ARR * 4);
    const arrN = new Int32Array(LOOKBACK);
    let lastSlot = NaN;
    let lastRate = NaN;
    let lastDistance = NaN;
    let lastVariety = NaN;
    let prevWl = 0;

    const stateFor = (s: Strike, sr: number): StrikeState => {
      let st = states.get(s.slot);
      if (!st) {
        st = { l1: new LowPass(), l2: new LowPass(), r1: new LowPass(), r2: new LowPass() };
        st.l1.setCutoff(s.cutoff * RUMBLE_OPEN, sr);
        st.r1.setCutoff(s.cutoff * RUMBLE_OPEN, sr);
        st.l2.setCutoff(s.cutoff * 1.4 * RUMBLE_OPEN, sr);
        st.r2.setCutoff(s.cutoff * 1.4 * RUMBLE_OPEN, sr);
        states.set(s.slot, st);
      }
      return st;
    };

    return stateful({
      reset() {
        brownL.reset();
        brownR.reset();
        pinkL.reset();
        pinkR.reset();
        lowL.reset();
        lowR.reset();
        states.clear();
        prevWl = 0;
      },
      run(start, n, sr, L, R) {
        const t0 = start / sr;
        const t1 = (start + n) / sr;
        const rate = Math.max(0, p.rate.value(t0));
        const distance = clamp01(p.distance.value(t0));
        const intensity = clamp01(p.intensity.value(t0));
        const variety = clamp01(p.variety.value(t0));
        const slot = Math.floor(t0 / THUNDER_SLOT);
        if (
          slot !== lastSlot ||
          Math.abs(rate - lastRate) > 0.01 ||
          Math.abs(distance - lastDistance) > 0.01 ||
          Math.abs(variety - lastVariety) > 0.01
        ) {
          for (let k = 0; k < LOOKBACK; k++) strikes[k] = strikeFor(sEv, slot - k, rate, distance, variety);
          lastSlot = slot;
          lastRate = rate;
          lastDistance = distance;
          lastVariety = variety;
        }

        let any = false;
        for (let k = 0; k < LOOKBACK; k++) {
          const s = strikes[k];
          if (s && s.start <= t1 && strikeEnd(s) >= t0) any = true;
          else if (s) states.delete(s.slot);
        }
        if (!any) {
          // silence between strikes, with sources at a known state (seek-safe)
          brownL.reset();
          brownR.reset();
          pinkL.reset();
          pinkR.reset();
          lowL.reset();
          lowR.reset();
          states.clear();
          L.fill(0, 0, n);
          R.fill(0, 0, n);
          return;
        }

        const gain = 1.8 * (0.35 + 0.65 * intensity);
        const pulseGain = gain * 1;
        lowL.setCutoff(LOW_CUT, sr);
        lowR.setCutoff(LOW_CUT, sr);
        for (let i0 = 0; i0 < n; i0 += SUB) {
          const m = Math.min(n, i0 + SUB);
          const ta = (start + i0) / sr;
          const tb = (start + m) / sr;
          for (let k = 0; k < LOOKBACK; k++) {
            const s = strikes[k];
            if (!s || s.start > tb || strikeEnd(s) < ta) {
              envA[k] = envB[k] = crA[k] = crB[k] = 0;
              arrN[k] = 0;
              continue;
            }
            envA[k] = rumbleEnvelope(s, ta);
            arrN[k] = pulsesAt(s, ta - s.start, tb - s.start, arrBuf, k * MAX_ARR * 4);
            envB[k] = rumbleEnvelope(s, tb);
            crA[k] = crackEnvelope(s, ta);
            crB[k] = crackEnvelope(s, tb);
            // position moves across the field over the strike
            const u = clamp01((0.5 * (ta + tb) - s.start) / (s.dur + TAIL));
            const pan = Math.max(-1, Math.min(1, s.panFrom + (s.panTo - s.panFrom) * (u * u * (3 - 2 * u))));
            panL[k] = Math.min(1, 1 - pan);
            panR[k] = Math.min(1, 1 + pan);
          }
          for (let i = i0; i < m; i++) {
            const idx = start + i;
            const wl = fastSigned(sL, idx);
            const wr = fastSigned(sR, idx);
            const bl = brownL.step(wl) * RUMBLE_BROWN + pinkL.step(wl) * RUMBLE_PINK;
            const br = brownR.step(wr) * RUMBLE_BROWN + pinkR.step(wr) * RUMBLE_PINK;
            const crackNoise = (wl - prevWl) * 0.7; // crisp, tearing
            prevWl = wl;
            const f = (i - i0) / (m - i0);
            const t = idx / sr;
            let l = 0;
            let r = 0;
            for (let k = 0; k < LOOKBACK; k++) {
              const s = strikes[k];
              if (!s) continue;
              const e = envA[k] + (envB[k] - envA[k]) * f;
              const c = crA[k] + (crB[k] - crA[k]) * f;
              const th = thumpAt(s, t);
              const bm = arrN[k] > 0 ? pulseAt(arrBuf, k * MAX_ARR * 4, arrN[k], t - s.start) * pulseGain * s.level : 0;
              if (e === 0 && c === 0 && th === 0 && bm === 0) continue;
              const st = stateFor(s, sr);
              const nl = st.l2.step(st.l1.step(bl));
              const nr = st.r2.step(st.r1.step(br));
              // stereo width: distant strikes are narrower
              const a = 0.5 + 0.5 * s.width;
              const b = 0.5 - 0.5 * s.width;
              const ml = (nl * a + nr * b) * e * gain + crackNoise * c + th * 0.5 + bm;
              const mr = (nr * a + nl * b) * e * gain + crackNoise * c + th * 0.5 + bm;
              l += ml * panL[k];
              r += mr * panR[k];
            }
            L[i] = l - lowL.step(l);
            R[i] = r - lowR.step(r);
          }
        }
      },
    });
  },
};
