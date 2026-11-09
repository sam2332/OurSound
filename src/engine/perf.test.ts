import { expect, it } from 'vitest';
import { demoTimeline } from '../demo.ts';
import { Engine } from './core.ts';

it('renders the demo timeline much faster than real time', () => {
  const sr = 48000;
  const e = new Engine(sr, 128);
  const tl = demoTimeline();
  tl.soundtracks.forEach((t) => (t.mute = false));
  e.load(tl);
  e.setMaster({ capDb: -12 });
  e.seek(3600 * 5);
  e.play(0);
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  const seconds = 60;
  const t0 = performance.now();
  for (let i = 0; i < (seconds * sr) / 128; i++) e.process(L, R, 128);
  const ms = performance.now() - t0;
  const realtimeFactor = (seconds * 1000) / ms;
  // A phone CPU is roughly 3-5x slower than a desktop; leave lots of headroom.
  expect(realtimeFactor, `realtime factor ${realtimeFactor.toFixed(0)}x`).toBeGreaterThan(50);
});
