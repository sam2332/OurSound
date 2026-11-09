import { describe, expect, it } from 'vitest';
import { valueNoise } from './ambient.ts';
import { Engine } from './core.ts';
import { defaultParams } from './generators.ts';
import type { GeneratorType, Timeline } from './model.ts';

const SR = 48000;
const BLOCK = 128;

function tlFor(g: GeneratorType, params: Record<string, number> = {}): Timeline {
  return {
    id: 't',
    name: 't',
    duration: 10 * 3600,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [
      {
        id: 'a',
        name: 'a',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        automation: [],
        segments: [
          {
            id: 's',
            start: 0,
            length: 10 * 3600,
            fadeIn: 0,
            fadeOut: 0,
            gainDb: -12,
            generator: g,
            params: { ...defaultParams(g), ...params },
            seed: 77,
            repeat: { mode: 'none' },
            automation: [],
          },
        ],
      },
    ],
  };
}

function render(e: Engine, seconds: number) {
  const n = Math.round((seconds * SR) / BLOCK) * BLOCK;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  for (let i = 0; i < n; i += BLOCK) {
    e.process(bl, br, BLOCK);
    L.set(bl, i);
    R.set(br, i);
  }
  return { L, R };
}

function engineAt(tl: Timeline, seconds: number) {
  const e = new Engine(SR, BLOCK);
  e.load(tl);
  e.setMaster({ capDb: -1 });
  e.seek(seconds);
  e.play(0);
  return e;
}

describe('ambient generators', () => {
  for (const g of ['fan', 'rain', 'thunder', 'wind', 'ocean', 'campfire', 'drums'] as GeneratorType[]) {
    it(`${g}: finite, audible, and the same after a seek`, () => {
      const tl = tlFor(g, g === 'thunder' ? { rate: 60, distance: 0.2 } : {});
      // play through from 5 h, vs seek straight to 5 h + 3 s
      const a = engineAt(tl, 5 * 3600);
      render(a, 3);
      const through = render(a, 2);
      const b = engineAt(tl, a.status().positionSec - 2);
      const seeked = render(b, 2);
      let maxDiff = 0;
      let finite = true;
      for (let i = 480; i < through.L.length; i++) {
        if (!Number.isFinite(through.L[i]) || !Number.isFinite(through.R[i])) finite = false;
        maxDiff = Math.max(maxDiff, Math.abs(through.L[i] - seeked.L[i]), Math.abs(through.R[i] - seeked.R[i]));
      }
      expect(finite).toBe(true);
      expect(maxDiff).toBeLessThan(5e-3);
    });
  }

  it('fan speed changes the blade rate', () => {
    const slow = render(engineAt(tlFor('fan', { speed: 0, wobble: 0 }), 10), 1).L;
    const fast = render(engineAt(tlFor('fan', { speed: 1, wobble: 0 }), 10), 1).L;
    // more air at higher speed
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(fast)).toBeGreaterThan(rms(slow));
  });

  it('thunder: silence between strikes at a low rate', () => {
    const e = engineAt(tlFor('thunder', { rate: 1, variety: 0 }), 0);
    const { L } = render(e, 60);
    expect(L.filter((v) => v === 0).length).toBeGreaterThan(L.length * 0.3);
  });

  it('drums: tempo automation keeps every beat in place after a seek', () => {
    const t = tlFor('drums', { style: 3, variety: 0.5 });
    t.soundtracks[0]!.segments[0]!.automation = [{ param: 'tempo', points: [{ t: 0, v: 50, curve: 'smooth' }, { t: 7200, v: 140 }] }];
    const a = engineAt(t, 3000);
    render(a, 3);
    const through = render(a, 2);
    const b = engineAt(t, a.status().positionSec - 2);
    const seeked = render(b, 2);
    let maxDiff = 0;
    for (let i = 480; i < through.L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(through.L[i]! - seeked.L[i]!));
    expect(maxDiff).toBeLessThan(5e-3);
  });

  it('drums: faster tempo, more strokes', () => {
    const count = (bpm: number) => {
      const { L } = render(engineAt(tlFor('drums', { tempo: bpm, style: 1, variety: 0 }), 60), 8);
      let onsets = 0;
      for (let i = 1; i < L.length; i++) if (Math.abs(L[i]!) > 0.02 && Math.abs(L[i - 1]!) <= 0.02 && i > 4800) onsets++;
      return onsets;
    };
    expect(count(120)).toBeGreaterThan(count(60));
  });

  it('value noise is smooth and time-pure', () => {
    expect(valueNoise(3, 12.34, 2)).toBe(valueNoise(3, 12.34, 2));
    let maxStep = 0;
    for (let t = 0; t < 100; t += 0.01) maxStep = Math.max(maxStep, Math.abs(valueNoise(3, t + 0.01, 2) - valueNoise(3, t, 2)));
    expect(maxStep).toBeLessThan(0.02);
  });
});
