// Automation curves, evaluated directly at any time (no baked buffers).
//
// Besides the value, we provide the exact integral of the curve from t=0,
// which oscillators use to get their phase at any time instantly:
//   phase(t) = frac( ∫₀ᵗ freq(τ) dτ )
// so seeking to hour 2,000 is as cheap as seeking to second 1, with no drift.

import type { AutomationPoint, CurveType } from './model.ts';

export type CompiledCurve = {
  ts: Float64Array;
  vs: Float64Array;
  curves: CurveType[];
  /** cum[i] = ∫₀^{ts[i]} v dt */
  cum: Float64Array;
};

/** Value at fraction u∈[0,1] of a segment from v0 to v1. */
function shape(curve: CurveType, v0: number, v1: number, u: number): number {
  switch (curve) {
    case 'hold':
      return v0;
    case 'smooth':
      return v0 + (v1 - v0) * 0.5 * (1 - Math.cos(Math.PI * u));
    case 'exp':
      if (v0 > 0 && v1 > 0) return v0 * Math.pow(v1 / v0, u);
      return v0 + (v1 - v0) * u;
    case 'linear':
    default:
      return v0 + (v1 - v0) * u;
  }
}

/** ∫ of the segment from its start to fraction u, for a segment of duration d. */
function shapeIntegral(curve: CurveType, v0: number, v1: number, d: number, u: number): number {
  switch (curve) {
    case 'hold':
      return d * v0 * u;
    case 'smooth':
      return d * (v0 * u + (v1 - v0) * 0.5 * (u - Math.sin(Math.PI * u) / Math.PI));
    case 'exp':
      if (v0 > 0 && v1 > 0 && v0 !== v1) {
        const lr = Math.log(v1 / v0);
        return (d * v0 * (Math.exp(lr * u) - 1)) / lr;
      }
      return d * (v0 * u + (v1 - v0) * 0.5 * u * u);
    case 'linear':
    default:
      return d * (v0 * u + (v1 - v0) * 0.5 * u * u);
  }
}

export function compileCurve(points: AutomationPoint[]): CompiledCurve | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const n = sorted.length;
  const ts = new Float64Array(n);
  const vs = new Float64Array(n);
  const curves: CurveType[] = [];
  for (let i = 0; i < n; i++) {
    ts[i] = sorted[i].t;
    vs[i] = sorted[i].v;
    curves.push(sorted[i].curve ?? 'linear');
  }
  const cum = new Float64Array(n);
  // Before the first point the value holds at vs[0].
  cum[0] = vs[0] * ts[0];
  for (let i = 1; i < n; i++) {
    const d = ts[i] - ts[i - 1];
    cum[i] = cum[i - 1] + (d > 0 ? shapeIntegral(curves[i - 1], vs[i - 1], vs[i], d, 1) : 0);
  }
  return { ts, vs, curves, cum };
}

/** Index i of the last point with ts[i] <= t, or -1 if t is before the first point. */
function findSegment(c: CompiledCurve, t: number): number {
  const ts = c.ts;
  let lo = 0;
  let hi = ts.length - 1;
  if (t < ts[0]) return -1;
  if (t >= ts[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function curveValue(c: CompiledCurve, t: number): number {
  const i = findSegment(c, t);
  if (i < 0) return c.vs[0];
  if (i >= c.ts.length - 1) return c.vs[c.vs.length - 1];
  const d = c.ts[i + 1] - c.ts[i];
  const u = d > 0 ? (t - c.ts[i]) / d : 1;
  return shape(c.curves[i], c.vs[i], c.vs[i + 1], u);
}

/** ∫₀ᵗ value dτ (t may be negative; value holds before the first point). */
export function curveIntegral(c: CompiledCurve, t: number): number {
  const i = findSegment(c, t);
  if (i < 0) return c.vs[0] * t;
  const last = c.ts.length - 1;
  if (i >= last) return c.cum[last] + c.vs[last] * (t - c.ts[last]);
  const d = c.ts[i + 1] - c.ts[i];
  const u = d > 0 ? (t - c.ts[i]) / d : 0;
  return c.cum[i] + shapeIntegral(c.curves[i], c.vs[i], c.vs[i + 1], d, u);
}

/**
 * A parameter: either a constant or an automation curve.
 * Gives value(t) and integral(t) uniformly.
 */
export class Param {
  readonly curve: CompiledCurve | null;
  readonly constant: number;
  constructor(constant: number, points?: AutomationPoint[]) {
    this.constant = constant;
    this.curve = points && points.length > 0 ? compileCurve(points) : null;
  }
  value(t: number): number {
    return this.curve ? curveValue(this.curve, t) : this.constant;
  }
  integral(t: number): number {
    return this.curve ? curveIntegral(this.curve, t) : this.constant * t;
  }
  get automated(): boolean {
    return this.curve !== null;
  }
}
