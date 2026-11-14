// Writes reference renders from the TypeScript engine so the native Java
// engine can be checked against it (android/app/src/test/.../GoldenTest.java).
// Only runs when GOLDEN_DIR is set:  GOLDEN_DIR=android/app/src/test/resources/golden npx vitest run src/engine/golden.test.ts

import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assetCache } from './assets.ts';
import { Engine } from './core.ts';
import { defaultParams } from './generators.ts';
import type { GeneratorType, Timeline } from './model.ts';
import { TEMPLATES } from '../templates.ts';

const dir = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.GOLDEN_DIR;
const SR = 48000;

function single(g: GeneratorType, params: Record<string, number> = {}, extra: Partial<Timeline['soundtracks'][0]['segments'][0]> = {}): Timeline {
  return {
    id: 'g-' + g,
    name: g,
    duration: 4 * 3600,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [
      {
        id: 't',
        name: 't',
        gainDb: 0,
        pan: 0.2,
        mute: false,
        solo: false,
        automation: [],
        segments: [
          {
            id: 's',
            start: 0,
            length: 4 * 3600,
            fadeIn: 2,
            fadeOut: 2,
            gainDb: -12,
            generator: g,
            params: { ...defaultParams(g), ...params },
            seed: 424242,
            repeat: { mode: 'none' },
            automation: [],
            ...extra,
          },
        ],
      },
    ],
  };
}

type Case = { name: string; timeline: Timeline; seek: number; seconds: number; capDb: number };

/** Synthetic 20 s "file" at 44.1 kHz, generated the same way in GoldenTest.java. */
export const SYNTH = { id: 'synth', sampleRate: 44100, channels: 2, duration: 20 };
export function synthFrame(i: number): [number, number] {
  const t = i / 44100;
  return [0.5 * Math.sin(2 * Math.PI * 441 * t) + 0.2 * Math.sin(2 * Math.PI * 1234.5 * t), 0.4 * Math.sin(2 * Math.PI * 300 * t + 1)];
}
function installSynth() {
  assetCache.clear();
  assetCache.meta.set(SYNTH.id, { ...SYNTH, name: 'synth' });
  const m = assetCache.meta.get(SYNTH.id)!;
  const cf = assetCache.chunkFrames(m);
  const total = Math.ceil(m.duration * m.sampleRate);
  for (let idx = 0; idx * cf < total; idx++) {
    const len = Math.min(cf, total - idx * cf);
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    for (let j = 0; j < len; j++) [L[j], R[j]] = synthFrame(idx * cf + j);
    assetCache.put(SYNTH.id, idx, L, R);
  }
}

it.skipIf(!dir)('writes golden renders', () => {
  const cases: Case[] = [
    {
      name: 'binaural-auto',
      timeline: single('binaural', {}, { automation: [{ param: 'beat', points: [{ t: 0, v: 10, curve: 'smooth' }, { t: 600, v: 2, curve: 'exp' }, { t: 1200, v: 4 }] }] }),
      seek: 301.7,
      seconds: 1,
      capDb: -1,
    },
    { name: 'monaural', timeline: single('monaural'), seek: 10, seconds: 0.5, capDb: -1 },
    { name: 'isochronic', timeline: single('isochronic'), seek: 10, seconds: 0.5, capDb: -1 },
    { name: 'tone-repeat', timeline: single('tone', {}, { length: 3, repeat: { mode: 'random', minGap: 4, maxGap: 9 } }), seek: 100, seconds: 6, capDb: -1 },
    { name: 'white', timeline: single('noise', { color: 0, width: 0.6 }), seek: 50, seconds: 0.5, capDb: -1 },
    { name: 'pink', timeline: single('noise', { color: 1, width: 1 }), seek: 7200, seconds: 0.5, capDb: -1 },
    { name: 'brown', timeline: single('noise', { color: 2, width: 1 }), seek: 33, seconds: 0.5, capDb: -1 },
    { name: 'green', timeline: single('noise', { color: 3, width: 1 }), seek: 900, seconds: 0.5, capDb: -1 },
    { name: 'blue', timeline: single('noise', { color: 4, width: 0.5 }), seek: 12, seconds: 0.5, capDb: -1 },
    { name: 'violet', timeline: single('noise', { color: 5, width: 1 }), seek: 3333, seconds: 0.5, capDb: -1 },
    { name: 'fan', timeline: single('fan', {}, { automation: [{ param: 'speed', points: [{ t: 0, v: 0.2 }, { t: 100, v: 0.9 }] }] }), seek: 40, seconds: 1, capDb: -1 },
    { name: 'rain', timeline: single('rain', { sheets: 0.9 }), seek: 1000, seconds: 2, capDb: -1 },
    {
      name: 'rain-auto',
      timeline: single('rain', { brightness: 0.7 }, {
        automation: [
          { param: 'intensity', points: [{ t: 0, v: 0.1, curve: 'smooth' }, { t: 60, v: 0.95 }] },
          { param: 'sheets', points: [{ t: 0, v: 1, curve: 'linear' }, { t: 60, v: 0.2 }] },
        ],
      }),
      seek: 31,
      seconds: 2,
      capDb: -1,
    },
    { name: 'wind', timeline: single('wind'), seek: 77, seconds: 1, capDb: -1 },
    { name: 'ocean', timeline: single('ocean'), seek: 123, seconds: 1, capDb: -1 },
    { name: 'campfire', timeline: single('campfire', { size: 0.7, crackle: 0.8, pops: 1 }), seek: 412, seconds: 3, capDb: -1 },
    { name: 'drums-tribal', timeline: single('drums', { style: 3, tempo: 96, depth: 0.5, variety: 0.7 }), seek: 1800, seconds: 3, capDb: -1 },
    { name: 'drums-heartbeat', timeline: single('drums', { style: 0, tempo: 58, depth: 0.15 }), seek: 30, seconds: 3, capDb: -1 },
    {
      name: 'drums-tempo-auto',
      timeline: single('drums', { style: 2 }, { automation: [{ param: 'tempo', points: [{ t: 0, v: 40, curve: 'smooth' }, { t: 600, v: 150 }] }] }),
      seek: 250,
      seconds: 3,
      capDb: -1,
    },
    { name: 'crickets', timeline: single('crickets', { crickets: 9, rate: 2.6, pitch: 0.3, rests: 0.4 }), seek: 905, seconds: 3, capDb: -1 },
    {
      name: 'crickets-auto',
      timeline: single('crickets', {}, {
        automation: [
          { param: 'rate', points: [{ t: 0, v: 3.5, curve: 'smooth' }, { t: 300, v: 0.8 }] },
          { param: 'crickets', points: [{ t: 0, v: 2, curve: 'linear' }, { t: 300, v: 14 }] },
        ],
      }),
      seek: 120,
      seconds: 3,
      capDb: -1,
    },
    { name: 'stream', timeline: single('stream', { flow: 0.8, pitch: 0.3, closeness: 0.7 }), seek: 777, seconds: 2, capDb: -1 },
    { name: 'bowl', timeline: single('bowl', { rate: 6, variety: 0.9 }), seek: 125, seconds: 4, capDb: -1 },
    { name: 'purr', timeline: single('purr', { breaths: 26, rumble: 0.8 }), seek: 61, seconds: 3, capDb: -1 },
    { name: 'pad', timeline: single('pad', { mood: 1, change: 20, pitch: 2, movement: 0.9 }), seek: 1195, seconds: 10, capDb: -1 },
    {
      name: 'drums-pattern',
      timeline: single('drums', { style: 4, tempo: 92, variety: 0.6 }, {
        drumPattern: [
          [1, 0, 0, 0, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 0, 1, 0, 0, 0],
          [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0.5],
          [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
          [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
        ],
      }),
      seek: 300,
      seconds: 3,
      capDb: -1,
    },
    { name: 'thunder', timeline: single('thunder', { rate: 120, distance: 0.3, variety: 0.8 }), seek: 600, seconds: 8, capDb: -1 },
    { name: 'pink-dark', timeline: single('noise', { color: 1, width: 1, tone: -0.8 }), seek: 400, seconds: 0.5, capDb: -1 },
    { name: 'white-bright', timeline: single('noise', { color: 0, width: 1, tone: 0.7 }), seek: 9, seconds: 0.5, capDb: -1 },
    ...(['linear', 'smooth', 'gentle', 'equal'] as const).map((fc) => ({
      name: 'fade-' + fc,
      timeline: single('tone', {}, { length: 4, fadeIn: 1.5, fadeOut: 1.5, fadeCurve: fc }),
      seek: 0,
      seconds: 4,
      capDb: -1,
    })),
    {
      name: 'pan-auto',
      timeline: (() => {
        const t = single('binaural');
        t.soundtracks[0].automation = [{ param: 'pan', points: [{ t: 0, v: -1, curve: 'smooth' }, { t: 20, v: 1 }] }];
        return t;
      })(),
      seek: 3,
      seconds: 8,
      capDb: -1,
    },
    { name: 'file-exact', timeline: single('file', { speed: 1, pitch: 0, loop: 1, xfade: 0.35 }, { assetId: 'synth', fadeIn: 0 }), seek: 18.5, seconds: 3, capDb: -1 },
    { name: 'file-tempo', timeline: single('file', { speed: 1.4, pitch: 0, loop: 1, xfade: 1.2 }, { assetId: 'synth', fadeIn: 0 }), seek: 7, seconds: 3, capDb: -1 },
    { name: 'file-pitch', timeline: single('file', { speed: 0.8, pitch: -5, tone: 0.5, loop: 0 }, { assetId: 'synth', fadeIn: 0 }), seek: 2, seconds: 2, capDb: -1 },
    {
      name: 'file-auto',
      timeline: single('file', { loop: 1 }, {
        assetId: 'synth',
        fadeIn: 0,
        automation: [
          { param: 'speed', points: [{ t: 0, v: 0.7, curve: 'linear' }, { t: 10, v: 1.6 }] },
          { param: 'pitch', points: [{ t: 0, v: 3, curve: 'smooth' }, { t: 10, v: -3 }] },
          { param: 'tone', points: [{ t: 0, v: -1, curve: 'linear' }, { t: 10, v: 1 }] },
        ],
      }),
      seek: 4,
      seconds: 2,
      capDb: -1,
    },
    {
      name: 'focus-duck',
      timeline: (() => {
        const bg = single('noise', { color: 1, width: 1 }).soundtracks[0];
        bg.id = 'bg';
        const lead = single('file', { loop: 1 }, { assetId: 'synth', start: 1, length: 3, fadeIn: 0.2, fadeOut: 0.5 }).soundtracks[0];
        lead.id = 'lead';
        lead.pan = 0;
        const t = single('noise');
        t.soundtracks = [bg, lead];
        t.focus = { lead: 'lead', follow: ['bg'], levelDb: -4, duckDb: 10 };
        return t;
      })(),
      seek: 0,
      seconds: 6,
      capDb: -1,
    },
    {
      name: 'focus-fill',
      timeline: (() => {
        const bg = single('crickets', { crickets: 6, rests: 0 }).soundtracks[0];
        bg.id = 'bg';
        const lead = single('file', { loop: 1 }, { assetId: 'synth', start: 0.5, length: 2.5, fadeIn: 0.2, fadeOut: 0.5 }).soundtracks[0];
        lead.id = 'lead';
        lead.pan = 0;
        const t = single('noise');
        t.soundtracks = [bg, lead];
        t.focus = { lead: 'lead', follow: [], fill: ['bg'], levelDb: 0, duckDb: 0 };
        return t;
      })(),
      seek: 0,
      seconds: 7,
      capDb: -1,
    },
    { name: 'limiter', timeline: { ...single('noise', { color: 0, width: 1 }), masterGainDb: 18 }, seek: 5, seconds: 0.5, capDb: -20 },
  ];
  // a few complete samples (built once, then frozen as JSON for both engines)
  for (const id of ['descent', 'winddown', 'storm', 'meditation']) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    cases.push({ name: 'sample-' + id, timeline: t.build(), seek: id === 'meditation' ? 170 : 1830, seconds: 2, capDb: -12 });
  }

  mkdirSync(dir!, { recursive: true });
  installSynth();
  const index: { name: string; seek: number; seconds: number; capDb: number }[] = [];
  for (const c of cases) {
    const e = new Engine(SR, 128);
    e.load(c.timeline);
    e.setMaster({ capDb: c.capDb });
    e.seek(c.seek);
    e.play(0);
    const n = Math.round((c.seconds * SR) / 128) * 128;
    const out = new Float32Array(n * 2);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < n; i += 128) {
      e.process(L, R, 128);
      for (let j = 0; j < 128; j++) {
        out[2 * (i + j)] = L[j];
        out[2 * (i + j) + 1] = R[j];
      }
    }
    writeFileSync(`${dir}/${c.name}.json`, JSON.stringify(c.timeline));
    writeFileSync(`${dir}/${c.name}.f32`, new Uint8Array(out.buffer));
    index.push({ name: c.name, seek: c.seek, seconds: c.seconds, capDb: c.capDb });
  }
  writeFileSync(`${dir}/index.json`, JSON.stringify(index, null, 1));
});
