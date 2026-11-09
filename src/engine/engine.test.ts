import { describe, expect, it } from 'vitest';
import { compileCurve, curveIntegral, curveValue } from './automation.ts';
import { Engine } from './core.ts';
import { Limiter } from './limiter.ts';
import { defaultParams } from './generators.ts';
import type { CurveType, Segment, Soundtrack, Timeline } from './model.ts';
import { activeInstances, instanceStart } from './repeat.ts';

const SR = 48000;
const BLOCK = 128;
const HOUR = 3600;

function seg(partial: Partial<Segment> & Pick<Segment, 'generator'>): Segment {
  return {
    id: 's' + Math.random().toString(36).slice(2),
    start: 0,
    length: 10,
    fadeIn: 0,
    fadeOut: 0,
    gainDb: 0,
    params: defaultParams(partial.generator),
    seed: 1234,
    repeat: { mode: 'none' },
    automation: [],
    ...partial,
  };
}

function timeline(segments: Segment[], extra: Partial<Soundtrack> = {}, duration = 10): Timeline {
  return {
    id: 't',
    name: 'test',
    duration,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [
      { id: 'tr', name: 'track', gainDb: 0, pan: 0, mute: false, solo: false, automation: [], segments, ...extra },
    ],
  };
}

/** Renders `seconds` of audio from the engine's current position. */
function render(engine: Engine, seconds: number) {
  const n = Math.round((seconds * SR) / BLOCK) * BLOCK;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  for (let i = 0; i < n; i += BLOCK) {
    engine.process(bl, br, BLOCK);
    L.set(bl, i);
    R.set(br, i);
  }
  return { L, R };
}

function makeEngine(tl: Timeline, capDb = -1) {
  const e = new Engine(SR, BLOCK);
  e.load(tl);
  e.setMaster({ capDb });
  return e;
}

/** Frequency estimate from upward zero crossings (with sub-sample interpolation). */
function freqOf(x: Float32Array): number {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((crossings.length - 1) * SR) / (crossings[crossings.length - 1] - crossings[0]);
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** Max sample difference, skipping the limiter's 5 ms look-ahead delay (which starts empty after a seek). */
function maxDiff(a: Float32Array, b: Float32Array, skip = 480): number {
  let m = 0;
  for (let i = skip; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

// ------------------------------------------------------------------ automation

describe('automation', () => {
  const curves: CurveType[] = ['hold', 'linear', 'smooth', 'exp'];
  for (const curve of curves) {
    it(`integral matches numeric integration (${curve})`, () => {
      const c = compileCurve([
        { t: 1, v: 10, curve },
        { t: 5, v: 2, curve },
        { t: 9, v: 6, curve },
      ])!;
      const T = 12;
      const steps = 200000;
      let numeric = 0;
      for (let i = 0; i < steps; i++) numeric += curveValue(c, ((i + 0.5) / steps) * T) * (T / steps);
      expect(curveIntegral(c, T)).toBeCloseTo(numeric, 3);
    });
  }

  it('holds the first value before and the last value after', () => {
    const c = compileCurve([
      { t: 10, v: 3 },
      { t: 20, v: 7 },
    ])!;
    expect(curveValue(c, 0)).toBe(3);
    expect(curveValue(c, 15)).toBe(5);
    expect(curveValue(c, 1e9)).toBe(7);
  });
});

// ------------------------------------------------------------------ repeats

describe('repeats', () => {
  it('interval: plays every N seconds with silence between', () => {
    const r = { mode: 'interval' as const, every: 60 };
    expect(activeInstances(100, 8, r, 1, 99)).toEqual([]);
    expect(activeInstances(100, 8, r, 1, 100)).toEqual([{ k: 0, start: 100 }]);
    expect(activeInstances(100, 8, r, 1, 120)).toEqual([]);
    expect(activeInstances(100, 8, r, 1, 100 + 60 * 1000 + 3)).toEqual([{ k: 1000, start: 100 + 60000 }]);
  });

  it('interval: count and until stop repeating', () => {
    expect(activeInstances(0, 8, { mode: 'interval', every: 60, count: 3 }, 1, 180 + 1)).toEqual([]);
    expect(activeInstances(0, 8, { mode: 'interval', every: 60, count: 3 }, 1, 120 + 1)).toHaveLength(1);
    expect(activeInstances(0, 8, { mode: 'interval', every: 60, until: 130 }, 1, 180 + 1)).toEqual([]);
  });

  it('interval: a long final repeat is still found long after', () => {
    // 5 repeats every minute, each one an hour long: the last one ends at 4min + 1h.
    const r = { mode: 'interval' as const, every: 60, count: 5 };
    const found = activeInstances(0, HOUR, r, 1, HOUR + 200);
    expect(found.map((i) => i.k)).toEqual([4]);
  });

  it('interval: overlapping repeats all sound', () => {
    const found = activeInstances(0, 30, { mode: 'interval', every: 10 }, 1, 35);
    expect(found.map((i) => i.k)).toEqual([3, 2, 1]);
  });

  it('random: gaps always fall within [minGap, maxGap] and are reproducible', () => {
    const r = { mode: 'random' as const, minGap: 600, maxGap: 2100 };
    let prev = instanceStart(0, r, 42, 0);
    for (let k = 1; k < 5000; k++) {
      const s = instanceStart(0, r, 42, k);
      expect(s - prev).toBeGreaterThanOrEqual(600 - 1e-9);
      expect(s - prev).toBeLessThanOrEqual(2100 + 1e-9);
      expect(instanceStart(0, r, 42, k)).toBe(s);
      prev = s;
    }
  });

  it('random: lookup at any time finds the right instance', () => {
    const r = { mode: 'random' as const, minGap: 60, maxGap: 300 };
    for (let k = 1; k < 2000; k += 97) {
      const s = instanceStart(0, r, 7, k);
      expect(activeInstances(0, 20, r, 7, s + 5)).toContainEqual({ k, start: s });
    }
  });
});

// ------------------------------------------------------------------ generators

describe('binaural', () => {
  it('left = carrier, right = carrier + beat', () => {
    const e = makeEngine(timeline([seg({ generator: 'binaural', params: { carrier: 200, beat: 4 } })]));
    e.play(0);
    const { L, R } = render(e, 2);
    expect(freqOf(L)).toBeCloseTo(200, 2);
    expect(freqOf(R)).toBeCloseTo(204, 2);
  });

  it('seeking gives exactly the same samples as playing through (with automation)', () => {
    const s = seg({
      generator: 'binaural',
      length: 20,
      automation: [
        {
          param: 'beat',
          points: [
            { t: 0, v: 10, curve: 'smooth' },
            { t: 15, v: 2 },
          ],
        },
        {
          param: 'carrier',
          points: [
            { t: 0, v: 220, curve: 'exp' },
            { t: 20, v: 150 },
          ],
        },
      ],
    });
    const tl = timeline([s], {}, 20);
    const a = makeEngine(tl);
    a.play(0);
    render(a, 7.5);
    const fromStart = render(a, 1);

    const b = makeEngine(tl);
    b.seek(a.status().positionSec - 1);
    b.play(0);
    const fromSeek = render(b, 1);

    expect(maxDiff(fromStart.L, fromSeek.L)).toBeLessThan(1e-4);
    expect(maxDiff(fromStart.R, fromSeek.R)).toBeLessThan(1e-4);
  });

  it('stays accurate 2,999 hours in', () => {
    const tl = timeline([seg({ generator: 'binaural', length: 3000 * HOUR, params: { carrier: 200, beat: 2.5 } })], {}, 3000 * HOUR);
    const e = makeEngine(tl);
    e.seek(2999 * HOUR + 0.123);
    e.play(0);
    const { L, R } = render(e, 2);
    expect(freqOf(L)).toBeCloseTo(200, 2);
    expect(freqOf(R)).toBeCloseTo(202.5, 2);
  });
});

describe('noise', () => {
  for (const [color, name] of [
    [0, 'white'],
    [1, 'pink'],
    [2, 'brown'],
  ] as const) {
    it(`${name} noise sits at nominal level and is reproducible after a seek`, () => {
      const tl = timeline([seg({ generator: 'noise', length: 60, gainDb: -12, params: { color, width: 1 } })], {}, 60);
      const a = makeEngine(tl);
      a.play(0);
      render(a, 10);
      const through = render(a, 2);
      const level = rms(through.L);
      expect(level).toBeGreaterThan(0.25 * 0.8 * 0.2512);
      expect(level).toBeLessThan(0.25 * 1.2 * 0.2512);

      const b = makeEngine(tl);
      b.seek(a.status().positionSec - 2);
      b.play(0);
      const seeked = render(b, 2);
      expect(maxDiff(through.L, seeked.L)).toBeLessThan(2e-3);
    });
  }
});

// ------------------------------------------------------------------ mixer / master

describe('limiter', () => {
  it('passes quiet audio through untouched (just delayed)', () => {
    const lim = new Limiter(SR, 0.5);
    const L = new Float32Array(2000).map((_, i) => 0.3 * Math.sin(i / 10));
    const R = L.map((v) => -v);
    const inL = L.slice();
    lim.process(L, R, L.length);
    const D = 240;
    for (let i = D; i < 2000; i++) expect(L[i]).toBeCloseTo(inL[i - D], 6);
  });

  it('reduces a sudden loud burst smoothly and never above the ceiling', () => {
    const lim = new Limiter(SR, 0.25);
    const n = 9600;
    const L = new Float32Array(n).map((_, i) => (i > 4000 && i < 5000 ? 0.9 : 0.1) * Math.sin(i / 7));
    const R = L.slice();
    lim.process(L, R, n);
    let peak = 0;
    let maxJump = 0;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(L[i]));
      if (i > 0) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
    }
    expect(peak).toBeLessThanOrEqual(0.25 + 1e-7);
    expect(maxJump).toBeLessThan(0.2); // no clicks: input slope is at most 0.9/7 ≈ 0.13
  });
});

describe('master', () => {
  it('never exceeds the volume cap, even when everything is too loud', () => {
    const loud = [0, 1, 2].map((i) =>
      seg({ id: 'n' + i, generator: i === 0 ? 'noise' : 'binaural', gainDb: 18, params: i === 0 ? { color: 0, width: 1 } : { carrier: 100 + i * 50, beat: 3 } }),
    );
    const e = makeEngine(timeline(loud), -20);
    e.play(0);
    const { L, R } = render(e, 3);
    const ceil = Math.pow(10, -20 / 20);
    let peak = 0;
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    expect(peak).toBeLessThanOrEqual(ceil + 1e-7);
  });

  it('fades in from silence on play', () => {
    const e = makeEngine(timeline([seg({ generator: 'tone' })]));
    e.play();
    const { L } = render(e, 0.05);
    expect(Math.abs(L[0])).toBeLessThan(1e-6);
  });

  it('mute and solo', () => {
    const tl: Timeline = timeline([seg({ generator: 'tone' })]);
    tl.soundtracks.push({ ...tl.soundtracks[0], id: 'tr2', segments: [seg({ generator: 'tone', params: { freq: 300 } })] });
    tl.soundtracks[1].solo = true;
    const e = makeEngine(tl);
    e.play(0);
    expect(freqOf(render(e, 1).L)).toBeCloseTo(300, 1);
  });

  it('stops at the end of the timeline', () => {
    const e = makeEngine(timeline([seg({ generator: 'tone' })], {}, 1));
    e.play(0);
    render(e, 2);
    expect(e.status().ended).toBe(true);
    expect(e.status().playing).toBe(false);
  });

  it('sleep timer fades out and stops on time', () => {
    const e = makeEngine(timeline([seg({ generator: 'tone', length: 100 })], {}, 100));
    e.play(0);
    e.setSleepTimer(10, 4);
    const { L } = render(e, 12);
    const at = (sec: number) => rms(L.subarray(Math.round(sec * SR), Math.round((sec + 0.2) * SR)));
    expect(at(5)).toBeGreaterThan(0.15); // full level before the fade
    expect(at(8)).toBeLessThan(at(5)); // fading
    expect(at(10.5)).toBe(0); // stopped
    expect(e.status().playing).toBe(false);
    expect(e.status().stoppedBy).toBe('sleep');
  });

  it('cancelling the sleep timer during its fade restores the volume', () => {
    const e = makeEngine(timeline([seg({ generator: 'tone', length: 100 })], {}, 100));
    e.play(0);
    e.setSleepTimer(10, 8);
    render(e, 6);
    e.setSleepTimer(null);
    const { L } = render(e, 6);
    expect(rms(L.subarray(L.length - 9600))).toBeGreaterThan(0.15);
    expect(e.status().playing).toBe(true);
  });

  it("'wake' end: the volume rises gently near the end, then stops", () => {
    const tl = timeline([seg({ generator: 'tone', length: 3600 })], {}, 3600);
    tl.endBehavior = 'wake';
    const e = makeEngine(tl);
    e.seek(3600 - 16 * 60);
    e.play(0);
    const before = rms(render(e, 1).L);
    e.seek(3600 - 2);
    const near = rms(render(e, 1).L);
    expect(near / before).toBeGreaterThan(2); // ~+9 dB
    render(e, 3);
    expect(e.status().ended).toBe(true);
  });

  it('a repeating segment only sounds during its repeats', () => {
    const s = seg({ generator: 'tone', length: 1, repeat: { mode: 'interval', every: 3 } });
    const e = makeEngine(timeline([s], {}, 10));
    e.play(0);
    const { L } = render(e, 7);
    const at = (sec: number) => rms(L.subarray(Math.round(sec * SR), Math.round((sec + 0.2) * SR)));
    expect(at(0.3)).toBeGreaterThan(0.1);
    expect(at(1.5)).toBe(0);
    expect(at(3.3)).toBeGreaterThan(0.1);
    expect(at(4.5)).toBe(0);
    expect(at(6.3)).toBeGreaterThan(0.1);
  });
});
