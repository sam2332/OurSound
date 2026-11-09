// Pure helpers for the timeline editor: zoom, ruler ticks, snapping and
// which repeats of a segment are visible. No DOM here, so it's unit-tested.

import type { Segment } from '../engine/model.ts';
import { instanceStart } from '../engine/repeat.ts';

export type View = {
  /** Timeline time at the left edge of the lanes (seconds). */
  start: number;
  /** Zoom: pixels per second. */
  pxPerSec: number;
};

export const MIN_PX_PER_SEC = 1e-6; // ~3,000 h across a phone screen and beyond
export const MAX_PX_PER_SEC = 400;

export const timeToX = (v: View, t: number, laneLeft: number) => laneLeft + (t - v.start) * v.pxPerSec;
export const xToTime = (v: View, x: number, laneLeft: number) => v.start + (x - laneLeft) / v.pxPerSec;

export function clampView(v: View, duration: number, laneWidth: number): View {
  const fit = laneWidth / Math.max(duration, 1);
  const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(Math.min(fit, MIN_PX_PER_SEC * 10), Math.max(MIN_PX_PER_SEC, v.pxPerSec)));
  const visible = laneWidth / pxPerSec;
  // allow a little slack past the end so the last segment edge can be grabbed
  const maxStart = Math.max(0, duration - visible * 0.9);
  return { pxPerSec, start: Math.min(maxStart, Math.max(0, v.start)) };
}

/** Zoom by `factor` keeping time `anchorT` under the same x. */
export function zoomAround(v: View, factor: number, anchorT: number): View {
  const pxPerSec = v.pxPerSec * factor;
  const start = anchorT - (anchorT - v.start) * (v.pxPerSec / pxPerSec);
  return { start, pxPerSec };
}

export function fitView(duration: number, laneWidth: number): View {
  return { start: 0, pxPerSec: laneWidth / Math.max(duration, 1) };
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const STEPS = [
  1, 2, 5, 10, 15, 30,
  MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 5 * DAY, 10 * DAY, 20 * DAY, 50 * DAY, 100 * DAY,
];

/** Ruler step (seconds) giving labels at least `minPx` apart. */
export function tickStep(pxPerSec: number, minPx = 64): number {
  for (const s of STEPS) if (s * pxPerSec >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

/** Label for a ruler tick, adapted to the step size. */
export function tickLabel(t: number, step: number): string {
  if (step >= DAY) {
    const d = Math.round(t / DAY);
    return `${d}d`;
  }
  const h = Math.floor(t / HOUR);
  const m = Math.floor((t % HOUR) / MIN);
  const s = Math.round(t % MIN);
  if (step >= HOUR) return `${h}h`;
  if (step >= MIN) return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
  return `${h > 0 ? h + ':' : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

/** Snap a time to a grid that's fine at the current zoom (1/4 of a tick). */
export function snap(t: number, pxPerSec: number): number {
  const grid = Math.max(1, tickStep(pxPerSec) / 4);
  return Math.round(t / grid) * grid;
}

/**
 * Start times of the repeats of `seg` that overlap [from, to], at most `limit`.
 * The first play (k = 0) is included when visible.
 */
export function visibleInstances(seg: Segment, from: number, to: number, limit = 400): { k: number; start: number }[] {
  const out: { k: number; start: number }[] = [];
  const r = seg.repeat;
  if (r.mode === 'none') {
    if (seg.start <= to && seg.start + seg.length >= from) out.push({ k: 0, start: seg.start });
    return out;
  }
  const period = r.mode === 'interval' ? r.every : (r.minGap + r.maxGap) / 2;
  if (!(period > 0)) return out;
  const slack = r.mode === 'random' ? (r.maxGap - r.minGap) / 4 : 0;
  let k = Math.max(0, Math.floor((from - seg.length - seg.start - slack) / period));
  for (; out.length < limit; k++) {
    const s = instanceStart(seg.start, r, seg.seed, k);
    if (Number.isNaN(s)) {
      if (r.count != null && k >= r.count) break;
      if (r.until != null && seg.start + k * period - slack > r.until) break;
      continue;
    }
    if (s - slack > to) break;
    if (s + seg.length >= from && s <= to) out.push({ k, start: s });
  }
  return out;
}
