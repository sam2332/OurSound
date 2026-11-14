import { describe, expect, it } from 'vitest';
import { Engine } from './core.ts';
import { defaultParams } from './generators.ts';
import type { FocusMix, GeneratorType, Soundtrack, Timeline } from './model.ts';

function track(id: string, g: GeneratorType, gainDb: number, start = 0): Soundtrack {
  return {
    id,
    name: id,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    automation: [],
    segments: [
      { id: id + 's', start, length: 600, fadeIn: 0, fadeOut: 0, gainDb, generator: g, params: defaultParams(g), seed: 7, repeat: { mode: 'none' }, automation: [] },
    ],
  };
}

/** RMS of the background alone (lead output subtracted) between `from` and `to` seconds. */
function bgRms(focus: FocusMix | undefined, leadStart = 0, from = 4, to = 5, leadDrop?: { at: number; db: number }, leadVolume = 0) {
  const mk = (withBg: boolean): Timeline => ({
    id: 't',
    name: 't',
    duration: 600,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [
      ...(withBg ? [track('bg', 'noise', -20)] : []),
      (() => {
        const t = track('lead', 'tone', -10, leadStart);
        t.gainDb = leadVolume;
        // a quiet passage: the lead drops `db` at `at` seconds
        if (leadDrop)
          t.automation = [{ param: 'gain', points: [{ t: 0, v: 0, curve: 'hold' }, { t: leadDrop.at, v: leadDrop.db, curve: 'hold' }] }];
        return t;
      })(),
    ],
    focus,
  });
  const render = (tl: Timeline) => {
    const e = new Engine(48000, 128);
    e.load(tl);
    e.setMaster({ capDb: 0 });
    e.play(0);
    const L = new Float32Array(128), R = new Float32Array(128);
    const out: number[] = [];
    for (let b = 0; b < (to * 48000) / 128; b++) {
      e.process(L, R, 128);
      if (b * 128 >= from * 48000) out.push(...L);
    }
    return out;
  };
  const both = render(mk(true));
  const lead = render(mk(false));
  let s = 0;
  for (let i = 0; i < both.length; i++) s += (both[i] - lead[i]) ** 2;
  return Math.sqrt(s / both.length);
}

describe('focus mix', () => {
  const db = (a: number, b: number) => 20 * Math.log10(a / b);

  it('sets the background level relative to its own volume', () => {
    const plain = bgRms(undefined);
    const lower = bgRms({ lead: 'lead', follow: ['bg'], levelDb: -6, duckDb: 0 });
    expect(db(lower, plain)).toBeCloseTo(-6, 0);
  });

  it('dips the background while the lead plays, and lets it back up when it stops', () => {
    const plain = bgRms(undefined);
    const ducked = bgRms({ lead: 'lead', follow: ['bg'], levelDb: 0, duckDb: 10 });
    expect(db(ducked, plain)).toBeLessThan(-7);
    // lead hasn't started yet: no dip
    const before = bgRms({ lead: 'lead', follow: ['bg'], levelDb: 0, duckDb: 10 }, 300);
    expect(db(before, plain)).toBeCloseTo(0, 1);
  });

  it('fill tracks stay out while the lead plays and come in when it is silent', () => {
    const plain = bgRms(undefined);
    const fill: FocusMix = { lead: 'lead', follow: [], fill: ['bg'], levelDb: 0, duckDb: 0 };
    expect(db(bgRms(fill), plain)).toBeLessThan(-30);
    expect(db(bgRms(fill, 300), plain)).toBeCloseTo(0, 1);
  });

  it('fill tracks come in during a quiet passage of the lead', () => {
    const plain = bgRms(undefined, 0, 50, 51);
    const fill: FocusMix = { lead: 'lead', follow: [], fill: ['bg'], levelDb: 0, duckDb: 0 };
    // loud until 40 s, then 18 dB quieter: in by 50 s
    expect(db(bgRms(fill, 0, 38, 39, { at: 40, db: -18 }), plain)).toBeLessThan(-30);
    expect(db(bgRms(fill, 0, 50, 51, { at: 40, db: -18 }), plain)).toBeGreaterThan(-3);
  });

  it('turning the album down does not let fill tracks in', () => {
    const plain = bgRms(undefined);
    const fill: FocusMix = { lead: 'lead', follow: [], fill: ['bg'], levelDb: 0, duckDb: 0 };
    expect(db(bgRms(fill, 0, 4, 5, undefined, -40), plain)).toBeLessThan(-30);
  });
});
