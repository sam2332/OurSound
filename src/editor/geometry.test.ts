import { describe, expect, it } from 'vitest';
import type { Segment } from '../engine/model.ts';
import { clampView, fitView, snap, tickLabel, tickStep, timeToX, visibleInstances, xToTime, zoomAround } from './geometry.ts';

const seg = (repeat: Segment['repeat'], start = 100, length = 10): Segment => ({
  id: 's',
  start,
  length,
  fadeIn: 0,
  fadeOut: 0,
  gainDb: 0,
  generator: 'tone',
  params: {},
  seed: 3,
  repeat,
  automation: [],
});

describe('editor geometry', () => {
  it('converts time and x both ways', () => {
    const v = { start: 3600, pxPerSec: 0.5 };
    expect(xToTime(v, timeToX(v, 5000, 90), 90)).toBeCloseTo(5000);
  });

  it('zooming keeps the anchor time under the finger', () => {
    const v = { start: 0, pxPerSec: 0.1 };
    const anchor = 1234;
    const x = timeToX(v, anchor, 0);
    const z = zoomAround(v, 3, anchor);
    expect(timeToX(z, anchor, 0)).toBeCloseTo(x);
  });

  it('fits 3,000 hours and clamps panning', () => {
    const v = fitView(3000 * 3600, 300);
    expect(v.pxPerSec * 3000 * 3600).toBeCloseTo(300);
    expect(clampView({ start: -50, pxPerSec: v.pxPerSec }, 3000 * 3600, 300).start).toBe(0);
  });

  it('picks readable ruler steps and labels', () => {
    expect(tickStep(1)).toBe(120); // 1 px/s: 60 s would be only 60 px apart
    expect(tickStep(300 / (8 * 3600))).toBe(2 * 3600);
    expect(tickLabel(7200, 3600)).toBe('2h');
    expect(tickLabel(90 * 60, 600)).toBe('1:30');
    expect(tickLabel(95, 5)).toBe('1:35');
    expect(tickLabel(86400 * 3, 86400)).toBe('3d');
  });

  it('snaps to a quarter of the ruler step', () => {
    expect(snap(3601, 1)).toBe(3600); // grid 30 s at 1 px/s
  });

  it('lists only the repeats in view, including far into the timeline', () => {
    const s = seg({ mode: 'interval', every: 60 });
    const vis = visibleInstances(s, 1_000_000, 1_000_300);
    expect(vis.length).toBeGreaterThanOrEqual(5);
    for (const i of vis) expect(i.start + 10).toBeGreaterThanOrEqual(1_000_000);
    expect(visibleInstances(seg({ mode: 'interval', every: 60, count: 3 }), 0, 1e6).length).toBe(3);
    expect(visibleInstances(seg({ mode: 'none' }), 0, 50)).toEqual([]);
    const r = visibleInstances(seg({ mode: 'random', minGap: 30, maxGap: 90 }), 5000, 6000);
    expect(r.length).toBeGreaterThan(8);
  });
});
