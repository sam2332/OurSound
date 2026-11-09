// Stateless, seeded randomness: the same (seed, index) always gives the same
// number, so random things (noise, thunder, random repeats) are re-derived on
// demand instead of stored.

/** 32-bit integer mix (lowbias32 by Chris Wellons). */
export function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Hash of a seed and a non-negative integer index (exact up to 2^53, enough
 * for a per-sample index thousands of hours in). Returns a uint32.
 */
export function hashIndex(seed: number, index: number): number {
  const lo = index >>> 0;
  const hi = Math.floor(index / 4294967296) >>> 0;
  return mix32(mix32(mix32(seed >>> 0) ^ lo) ^ Math.imul(hi, 0x9e3779b9));
}

/** Uniform in [0, 1). */
export function rand01(seed: number, index: number): number {
  return hashIndex(seed, index) / 4294967296;
}

/** Uniform in [-1, 1). */
export function randSigned(seed: number, index: number): number {
  return hashIndex(seed, index) / 2147483648 - 1;
}

/** Derive a child seed (e.g. per repeat instance) from a parent seed. */
export function childSeed(seed: number, k: number): number {
  return hashIndex(seed ^ 0x5bd1e995, k);
}

/**
 * Fast per-sample noise: pre-mix the seed once with seedMix(), then one hash
 * round per sample. Same output for the same (seed, index), any index.
 */
export function seedMix(seed: number): number {
  return mix32((seed ^ 0x9e3779b9) >>> 0);
}

/** Uniform in [-1, 1) for a pre-mixed seed and an integer sample index. */
export function fastSigned(seedMixed: number, index: number): number {
  const lo = index >>> 0;
  const hi = Math.floor(index / 4294967296) | 0;
  return mix32(seedMixed ^ lo ^ Math.imul(hi, 0x85ebca6b)) / 2147483648 - 1;
}

/** Uniform in [0, 1) for a pre-mixed seed (see seedMix). */
export function fastUnit(seedMixed: number, index: number): number {
  const lo = index >>> 0;
  const hi = Math.floor(index / 4294967296) | 0;
  return mix32(seedMixed ^ lo ^ Math.imul(hi, 0x85ebca6b)) / 4294967296;
}
