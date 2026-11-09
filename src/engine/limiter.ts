// Stereo-linked look-ahead brickwall limiter.
//
// The signal is delayed by `lookahead` samples while the gain is computed from
// the upcoming samples, so gain reduction eases in *before* a peak instead of
// clamping it (no distortion). The same gain goes to both ears, so binaural
// left/right differences are never altered.
//
// Guarantee: output never exceeds the ceiling. The smoothed gain at a peak is
// the average of window minimums that all include that peak, so it is always
// at or below what the peak needs. A final clamp backs this up.

export class Limiter {
  private readonly D: number;
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  // Monotonic deque of (sample index, need) for the running window minimum.
  private readonly qIdx: Float64Array;
  private readonly qVal: Float64Array;
  private qHead = 0;
  private qTail = 0;
  // Box filter over D values of the released gain.
  private readonly box: Float64Array;
  private boxSum: number;
  private boxPos = 0;
  private env = 1;
  private n = 0; // samples processed
  private readonly release: number;
  ceiling: number;

  constructor(sampleRate: number, ceiling: number, lookaheadSec = 0.005, releaseSec = 0.25) {
    this.D = Math.max(1, Math.round(lookaheadSec * sampleRate));
    this.dl = new Float32Array(this.D);
    this.dr = new Float32Array(this.D);
    this.qIdx = new Float64Array(this.D + 3);
    this.qVal = new Float64Array(this.D + 3);
    this.box = new Float64Array(this.D).fill(1);
    this.boxSum = this.D;
    this.release = 1 - Math.exp(-1 / (releaseSec * sampleRate));
    this.ceiling = ceiling;
  }

  /** Current gain reduction as a linear factor (1 = not limiting). */
  get gain(): number {
    return this.boxSum / this.D;
  }

  reset() {
    this.dl.fill(0);
    this.dr.fill(0);
    this.qHead = this.qTail = 0;
    this.box.fill(1);
    this.boxSum = this.D;
    this.env = 1;
  }

  /** Processes in place. */
  process(L: Float32Array, R: Float32Array, len: number) {
    const D = this.D;
    const cap = D + 3; // window holds up to D+1, plus the push before the drop
    const ceil = this.ceiling;
    for (let i = 0; i < len; i++) {
      const xl = L[i];
      const xr = R[i];
      const peak = Math.max(Math.abs(xl), Math.abs(xr));
      const need = peak > ceil ? ceil / peak : 1;
      const idx = this.n++;

      // push `need` into the min-deque, dropping larger values from the back
      while (this.qTail !== this.qHead) {
        const back = (this.qTail - 1 + cap) % cap;
        if (this.qVal[back] >= need) this.qTail = back;
        else break;
      }
      this.qIdx[this.qTail] = idx;
      this.qVal[this.qTail] = need;
      this.qTail = (this.qTail + 1) % cap;
      // keep the window [idx-D, idx]: it must include the sample leaving the delay line
      while (this.qIdx[this.qHead] < idx - D) this.qHead = (this.qHead + 1) % cap;
      const windowMin = this.qVal[this.qHead];

      // instant attack toward the window minimum, smooth release
      if (windowMin < this.env) this.env = windowMin;
      else this.env += (windowMin - this.env) * this.release;

      // box-average the gain over D samples
      this.boxSum += this.env - this.box[this.boxPos];
      this.box[this.boxPos] = this.env;
      this.boxPos = (this.boxPos + 1) % D;
      const g = this.boxSum / D;

      // output the delayed sample
      const p = idx % D;
      const ol = this.dl[p] * g;
      const or = this.dr[p] * g;
      this.dl[p] = xl;
      this.dr[p] = xr;
      L[i] = ol > ceil ? ceil : ol < -ceil ? -ceil : ol;
      R[i] = or > ceil ? ceil : or < -ceil ? -ceil : or;
    }
  }
}
