package com.oursound.app.engine;

/** Which repeats of a segment are sounding at time t (port of src/engine/repeat.ts). */
public final class Repeat {
    private Repeat() {}

    public static final int MAX_OVERLAP = 8;

    /** Output buffer for activeInstances: k values and start times. */
    public static final class Instances {
        public final double[] k = new double[MAX_OVERLAP];
        public final double[] start = new double[MAX_OVERLAP];
        public int count;

        boolean hasK(double kk) {
            for (int i = 0; i < count; i++) if (k[i] == kk) return true;
            return false;
        }
    }

    public static double instanceStart(double segStart, Model.Repeat r, int seed, double k) {
        if (k < 0 || k != Math.floor(k)) return Double.NaN;
        switch (r.mode) {
            case Model.REPEAT_NONE:
                return k == 0 ? segStart : Double.NaN;
            case Model.REPEAT_INTERVAL: {
                if (r.count != null && k >= r.count) return Double.NaN;
                double s = segStart + k * r.every;
                if (r.until != null && k > 0 && s >= r.until) return Double.NaN;
                return s;
            }
            default: {
                if (r.count != null && k >= r.count) return Double.NaN;
                double P = (r.minGap + r.maxGap) / 2;
                double J = (r.maxGap - r.minGap) / 4;
                double jitter = k == 0 ? 0 : (Hash.rand01(seed ^ 0x2c1b3c6d, k) * 2 - 1) * J;
                double s = segStart + k * P + jitter;
                if (r.until != null && k > 0 && s >= r.until) return Double.NaN;
                return s;
            }
        }
    }

    public static void activeInstances(double segStart, double length, Model.Repeat r, int seed, double t, Instances out) {
        out.count = 0;
        if (t < segStart || length <= 0) return;
        double kMax;
        switch (r.mode) {
            case Model.REPEAT_NONE:
                kMax = 0;
                break;
            case Model.REPEAT_INTERVAL:
                if (!(r.every > 0)) return;
                kMax = Math.floor((t - segStart) / r.every);
                if (r.until != null) kMax = Math.min(kMax, Math.max(0, Math.ceil((r.until - segStart) / r.every) - 1));
                break;
            default: {
                double P = (r.minGap + r.maxGap) / 2;
                if (!(P > 0)) return;
                double J = (r.maxGap - r.minGap) / 4;
                kMax = Math.floor((t - segStart + J) / P);
                if (r.until != null) kMax = Math.min(kMax, Math.max(0, Math.floor((r.until - segStart + J) / P)));
            }
        }
        if (r.mode != Model.REPEAT_NONE && r.count != null) kMax = Math.min(kMax, r.count - 1);
        int scanned = 0;
        for (double k = kMax; k >= 0 && scanned < MAX_OVERLAP + 2; k--, scanned++) {
            double s = instanceStart(segStart, r, seed, k);
            if (Double.isNaN(s)) continue;
            if (s > t) continue;
            if (t < s + length) {
                out.k[out.count] = k;
                out.start[out.count] = s;
                out.count++;
                if (out.count >= MAX_OVERLAP) break;
            } else if (r.mode == Model.REPEAT_INTERVAL) {
                break;
            }
        }
    }
}
