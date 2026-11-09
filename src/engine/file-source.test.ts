import { beforeEach, describe, expect, it } from 'vitest';
import { assetCache } from './assets.ts';
import { Engine } from './core.ts';
import type { Timeline } from './model.ts';

const SR = 48000;
const FSR = 44100;
const BLOCK = 128;

/** A fake 3.2 s file: a 441 Hz sine (stereo, right channel inverted). */
function installFakeAsset(id = 'a1', duration = 3.2) {
  assetCache.clear();
  assetCache.meta.set(id, { id, name: 'fake', sampleRate: FSR, channels: 2, duration });
}

/** Plays the role of the main thread: decode any requested chunks right away. */
function serveRequests() {
  for (const { id, idx } of assetCache.takeRequests()) {
    const m = assetCache.meta.get(id)!;
    const cf = assetCache.chunkFrames(m);
    const total = Math.round(m.duration * m.sampleRate);
    const len = Math.min(cf, total - idx * cf);
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = (idx * cf + i) / m.sampleRate;
      L[i] = 0.5 * Math.sin(2 * Math.PI * 441 * t);
      R[i] = -L[i];
    }
    assetCache.put(id, idx, L, R);
  }
}

function tl(params: Record<string, number>, length = 20): Timeline {
  return {
    id: 't',
    name: 't',
    duration: 60,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [
      {
        id: 'tr',
        name: 'x',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        automation: [],
        segments: [
          {
            id: 's',
            start: 0,
            length,
            fadeIn: 0,
            fadeOut: 0,
            gainDb: 0,
            generator: 'file',
            params: { speed: 1, loop: 1, offset: 0, ...params },
            seed: 1,
            repeat: { mode: 'none' },
            automation: [],
            assetId: 'a1',
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
    serveRequests();
    L.set(bl, i);
    R.set(br, i);
  }
  return { L, R };
}

function freqOf(x: Float32Array): number {
  const c: number[] = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  return ((c.length - 1) * SR) / (c[c.length - 1] - c[0]);
}

function engine(params: Record<string, number>) {
  const e = new Engine(SR, BLOCK);
  e.load(tl(params));
  e.setMaster({ capDb: -1 });
  e.play(0);
  return e;
}

describe('audio file segments', () => {
  beforeEach(() => installFakeAsset());

  it('plays at the right pitch after resampling 44.1 → 48 kHz, in stereo', () => {
    const e = engine({});
    render(e, 0.1); // first chunk arrives
    const { L, R } = render(e, 1);
    expect(freqOf(L)).toBeCloseTo(441, 1);
    expect(L[1000] + R[1000]).toBeCloseTo(0, 5);
  });

  it('speed is tempo only: speed 2 keeps the pitch', () => {
    installFakeAsset('a1', 30);
    const e = engine({ speed: 2, loop: 0 });
    render(e, 0.1);
    expect(freqOf(render(e, 1).L)).toBeCloseTo(441, 0);
  });

  it('pitch +12 semitones doubles the pitch at normal speed', () => {
    installFakeAsset('a1', 30);
    const e = engine({ pitch: 12, loop: 0 });
    render(e, 0.1);
    expect(freqOf(render(e, 1).L)).toBeCloseTo(882, 0);
  });

  it('at speed 1 and pitch 0 the file plays exactly', () => {
    const e = engine({});
    const first = render(e, 0.1).L.length;
    const { L } = render(e, 0.2);
    // compare with the fake file's formula at 48 kHz
    let maxErr = 0;
    for (let i = 0; i < L.length; i++) {
      const t = (first + i - 240) / SR; // file time at speed 1, minus the limiter's 5 ms look-ahead
      const expected = 0.5 * Math.sin(2 * Math.PI * 441 * t);
      maxErr = Math.max(maxErr, Math.abs(L[i] - expected));
    }
    expect(maxErr).toBeLessThan(2e-3); // only the 44.1 → 48 kHz interpolation differs
  });

  it('tone darkens or brightens', () => {
    const level = (tone: number) => {
      const e = engine({ tone });
      render(e, 0.1);
      const { L } = render(e, 0.5);
      return Math.sqrt(L.reduce((s, v) => s + v * v, 0) / L.length);
    };
    // a 441 Hz tone is below the bright shelf and above the dark low-pass corner
    expect(level(-1)).toBeLessThan(level(0) * 0.9);
  });

  it('loops seamlessly (no clicks at the seam)', () => {
    const e = engine({});
    const { L } = render(e, 8); // crosses the 3.2 s file end twice
    let maxJump = 0;
    for (let i = SR * 0.2; i < L.length; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
    // a 441 Hz sine at 0.5 amplitude steps at most ~0.029 per sample at 48 kHz
    expect(maxJump).toBeLessThan(0.06);
  });

  it('without loop it stops at the end of the file', () => {
    const e = engine({ loop: 0 });
    const { L } = render(e, 5);
    const tail = L.subarray(Math.round(4 * SR));
    expect(Math.max(...tail.map(Math.abs))).toBe(0);
  });

  it('only keeps a few chunks in memory', () => {
    installFakeAsset('a1', 600); // a 10-minute file
    const e = engine({ loop: 0 });
    render(e, 30);
    expect(assetCache.size).toBeLessThan(15);
  });
});
