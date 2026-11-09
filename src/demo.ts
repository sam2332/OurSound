import { defaultParams } from './engine/generators.ts';
import type { Timeline } from './engine/model.ts';

const MIN = 60;
const HOUR = 3600;

/** Phase 1 demo timeline: an 8-hour sleep descent. */
export function demoTimeline(): Timeline {
  return {
    id: 'demo',
    name: 'Sleep Descent (demo)',
    duration: 8 * HOUR,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [
      {
        id: 'binaural',
        name: 'Binaural',
        color: '#8fa8ff',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        automation: [],
        segments: [
          {
            id: 'binaural-descent',
            start: 0,
            length: 8 * HOUR,
            fadeIn: 10,
            fadeOut: 60,
            gainDb: -6,
            generator: 'binaural',
            params: defaultParams('binaural'),
            seed: 1,
            repeat: { mode: 'none' },
            automation: [
              {
                // alpha → theta → delta
                param: 'beat',
                points: [
                  { t: 0, v: 10, curve: 'smooth' },
                  { t: 15 * MIN, v: 6, curve: 'smooth' },
                  { t: 45 * MIN, v: 3, curve: 'smooth' },
                  { t: 90 * MIN, v: 1.5, curve: 'hold' },
                ],
              },
              {
                param: 'carrier',
                points: [
                  { t: 0, v: 200, curve: 'exp' },
                  { t: 2 * HOUR, v: 160 },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'pink',
        name: 'Pink noise bed',
        color: '#f0a8d0',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        // the whole bed slowly settles 4 dB quieter over two hours
        automation: [
          {
            param: 'gain',
            points: [
              { t: 0, v: 0, curve: 'smooth' },
              { t: 2 * HOUR, v: -4 },
            ],
          },
        ],
        segments: [
          {
            id: 'pink-bed',
            start: 0,
            length: 8 * HOUR,
            fadeIn: 20,
            fadeOut: 60,
            gainDb: -18,
            generator: 'noise',
            params: { color: 1, width: 1 },
            seed: 2,
            repeat: { mode: 'none' },
            automation: [],
          },
        ],
      },
      {
        id: 'gusts',
        name: 'Brown gusts (random repeat)',
        color: '#c9a37a',
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        automation: [],
        segments: [
          {
            id: 'gust',
            start: 30,
            length: 40,
            fadeIn: 15,
            fadeOut: 20,
            gainDb: -14,
            generator: 'noise',
            params: { color: 2, width: 1 },
            seed: 3,
            // a gust every 2–6 minutes, never on a predictable beat
            repeat: { mode: 'random', minGap: 2 * MIN, maxGap: 6 * MIN },
            automation: [],
          },
        ],
      },
      {
        id: 'drone',
        name: 'Deep drone (every 15 min)',
        color: '#7fe0a8',
        gainDb: 0,
        pan: 0,
        mute: true,
        solo: false,
        automation: [],
        segments: [
          {
            id: 'drone-swell',
            start: 0,
            length: 5 * MIN,
            fadeIn: 90,
            fadeOut: 90,
            gainDb: -20,
            generator: 'tone',
            params: { freq: 100 },
            seed: 4,
            repeat: { mode: 'interval', every: 15 * MIN },
            automation: [],
          },
        ],
      },
    ],
  };
}
