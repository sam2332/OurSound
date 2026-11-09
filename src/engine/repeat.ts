// Resolves which repeats ("instances") of a segment are playing at time t.
// Pure arithmetic: no list of repeats is ever built, so a segment that repeats
// a million times costs the same as one that plays once.

import type { RepeatSpec } from './model.ts';
import { rand01 } from './hash.ts';

/** Max simultaneously sounding repeats of one segment (when length > gap). */
export const MAX_OVERLAP = 8;

export type Instance = {
  /** Repeat index: 0 = first play. */
  k: number;
  /** Timeline time this instance starts. */
  start: number;
};

/** Start time of instance k, or NaN if instance k does not exist. */
export function instanceStart(
  segStart: number,
  repeat: RepeatSpec,
  seed: number,
  k: number,
): number {
  if (k < 0 || !Number.isInteger(k)) return NaN;
  switch (repeat.mode) {
    case 'none':
      return k === 0 ? segStart : NaN;
    case 'interval': {
      if (repeat.count != null && k >= repeat.count) return NaN;
      const s = segStart + k * repeat.every;
      if (repeat.until != null && k > 0 && s >= repeat.until) return NaN;
      return s;
    }
    case 'random': {
      if (repeat.count != null && k >= repeat.count) return NaN;
      const s = randomStart(segStart, repeat.minGap, repeat.maxGap, seed, k);
      if (repeat.until != null && k > 0 && s >= repeat.until) return NaN;
      return s;
    }
  }
}

/**
 * Jittered grid: instance k sits at k·P plus a jitter in [-J, J], with
 * P = (min+max)/2 and J = (max-min)/4. Consecutive gaps then always fall in
 * [minGap, maxGap], and any instance is found in O(1).
 */
function randomStart(segStart: number, minGap: number, maxGap: number, seed: number, k: number): number {
  const P = (minGap + maxGap) / 2;
  const J = (maxGap - minGap) / 4;
  const jitter = k === 0 ? 0 : (rand01(seed ^ 0x2c1b3c6d, k) * 2 - 1) * J;
  return segStart + k * P + jitter;
}

/**
 * All instances sounding at time t (start <= t < start + length),
 * newest first, at most MAX_OVERLAP.
 */
export function activeInstances(
  segStart: number,
  length: number,
  repeat: RepeatSpec,
  seed: number,
  t: number,
  out: Instance[] = [],
): Instance[] {
  out.length = 0;
  if (t < segStart || length <= 0) return out;

  let kMax: number;
  switch (repeat.mode) {
    case 'none':
      kMax = 0;
      break;
    case 'interval':
      if (!(repeat.every > 0)) return out;
      kMax = Math.floor((t - segStart) / repeat.every);
      if (repeat.until != null) {
        kMax = Math.min(kMax, Math.max(0, Math.ceil((repeat.until - segStart) / repeat.every) - 1));
      }
      break;
    case 'random': {
      const P = (repeat.minGap + repeat.maxGap) / 2;
      if (!(P > 0)) return out;
      const J = (repeat.maxGap - repeat.minGap) / 4;
      kMax = Math.floor((t - segStart + J) / P);
      if (repeat.until != null) {
        kMax = Math.min(kMax, Math.max(0, Math.floor((repeat.until - segStart + J) / P)));
      }
      break;
    }
  }
  // Never start scanning past the last instance that exists, or a long-ago
  // final repeat that is still sounding would be missed.
  if (repeat.mode !== 'none' && repeat.count != null) {
    kMax = Math.min(kMax, repeat.count - 1);
  }

  // Walk back from the latest candidate while instances could still be sounding.
  for (let k = kMax, scanned = 0; k >= 0 && scanned < MAX_OVERLAP + 2; k--, scanned++) {
    const s = instanceStart(segStart, repeat, seed, k);
    if (Number.isNaN(s)) continue;
    if (s > t) continue;
    if (t < s + length) {
      out.push({ k, start: s });
      if (out.length >= MAX_OVERLAP) break;
    } else if (repeat.mode === 'interval') {
      break; // older interval instances ended even earlier
    }
  }
  return out;
}
