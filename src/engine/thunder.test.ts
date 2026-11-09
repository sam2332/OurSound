import { describe, expect, it } from 'vitest';
import { THUNDER_SLOT, rumbleEnvelope, strikeFor, type Strike, type StrikeType } from './thunder.ts';

const HOURS = 20;
const slots = (HOURS * 3600) / THUNDER_SLOT;

function strikes(rate: number, distance: number, variety: number, seed = 11): Strike[] {
  const out: Strike[] = [];
  for (let s = 0; s < slots; s++) {
    const k = strikeFor(seed, s, rate, distance, variety);
    if (k) out.push(k);
  }
  return out;
}

describe('thunder variety', () => {
  it('follows the strikes-per-hour setting on average', () => {
    for (const v of [0, 0.6, 1]) {
      const n = strikes(12, 0.5, v).length / HOURS;
      expect(n, `variety ${v}`).toBeGreaterThan(8);
      expect(n, `variety ${v}`).toBeLessThan(16);
    }
  });

  it('is reproducible', () => {
    expect(strikeFor(3, 1234, 20, 0.4, 0.7)).toEqual(strikeFor(3, 1234, 20, 0.4, 0.7));
  });

  it('variety makes strikes come in bursts and lulls', () => {
    const dispersion = (v: number) => {
      const per10 = new Array(HOURS * 6).fill(0);
      for (const s of strikes(20, 0.5, v)) per10[Math.floor(s.start / 600)]++;
      const mean = per10.reduce((a, b) => a + b, 0) / per10.length;
      const variance = per10.reduce((a, b) => a + (b - mean) ** 2, 0) / per10.length;
      return variance / mean;
    };
    // lulls have a floor (so storms never go quiet for long), which caps how bursty it gets
    expect(dispersion(1)).toBeGreaterThan(dispersion(0) * 1.4);
  });

  it('mixes strike types, weighted by distance', () => {
    const count = (list: Strike[]) => {
      const c: Partial<Record<StrikeType, number>> = {};
      for (const s of list) c[s.type] = (c[s.type] ?? 0) + 1;
      return c;
    };
    const wild = count(strikes(30, 0.5, 1));
    expect(Object.keys(wild).length).toBe(5); // all five types occur
    const farCalm = count(strikes(30, 0.95, 0));
    const total = Object.values(farCalm).reduce((a, b) => a + b, 0);
    expect((farCalm.boom ?? 0) / total).toBeLessThan(0.02); // no close booms in a calm distant storm
    const nearCalm = count(strikes(30, 0.05, 0));
    const tn = Object.values(nearCalm).reduce((a, b) => a + b, 0);
    expect(((nearCalm.boom ?? 0) + (nearCalm.flicker ?? 0)) / tn).toBeGreaterThan(0.5);
  });

  it('close strikes crack and thump; sky rolls travel across', () => {
    const near = strikes(30, 0.05, 0.6).filter((s) => s.type === 'boom');
    expect(near.length).toBeGreaterThan(5);
    for (const s of near) {
      expect(s.cracks.length).toBeGreaterThan(0);
      expect(s.thump).toBeGreaterThan(0);
    }
    const rolls = strikes(30, 0.6, 1).filter((s) => s.type === 'skyroll');
    expect(rolls.length).toBeGreaterThan(3);
    for (const s of rolls) {
      expect(Math.sign(s.panFrom)).toBe(-Math.sign(s.panTo));
      expect(s.dur).toBeGreaterThan(27);
    }
  });

  it('rumbles roll in separate booms instead of swelling smoothly (like wind)', () => {
    const s = strikes(30, 0.5, 0.6).find((x) => x.type === 'rumble')!;
    let peaks = 0;
    let prev = rumbleEnvelope(s, s.start);
    let rising = false;
    for (let t = s.start; t < s.start + s.dur; t += 0.01) {
      const e = rumbleEnvelope(s, t);
      if (rising && e < prev) peaks++;
      rising = e > prev;
      prev = e;
    }
    expect(peaks / s.dur).toBeGreaterThan(2); // several bumps per second
  });
});
