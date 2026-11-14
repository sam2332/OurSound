package com.oursound.app.engine;

/** DSP building blocks (port of src/engine/dsp.ts). */
public final class Dsp {
    private Dsp() {}

    public static final double TWO_PI = Math.PI * 2;
    static final int WARMUP = 4096;
    static final int CHUNK = 128;

    public static double clamp01(double x) {
        return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    public static final class LowPass {
        private double y = 0, a = 0;

        public void setCutoff(double hz, double sr) {
            a = 1 - Math.exp((-TWO_PI * Math.min(hz, sr * 0.45)) / sr);
        }

        public double step(double x) {
            y += a * (x - y);
            return y;
        }

        public void reset() {
            y = 0;
        }
    }

    public static final class BandPass {
        private double b0, b2, a1, a2, x1, x2, y1, y2;

        public void set(double hz, double q, double sr) {
            double w = (TWO_PI * Math.min(hz, sr * 0.45)) / sr;
            double alpha = Math.sin(w) / (2 * q);
            double a0 = 1 + alpha;
            b0 = alpha / a0;
            b2 = -alpha / a0;
            a1 = (-2 * Math.cos(w)) / a0;
            a2 = (1 - alpha) / a0;
        }

        public double step(double x) {
            double y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            return y;
        }

        public void reset() {
            x1 = x2 = y1 = y2 = 0;
        }
    }

    /** Paul Kellet's economy pink filter. */
    public static final class Pink {
        private double b0, b1, b2;

        public double step(double w) {
            b0 = 0.99765 * b0 + w * 0.099046;
            b1 = 0.963 * b1 + w * 0.2965164;
            b2 = 0.57 * b2 + w * 1.0526913;
            return (b0 + b1 + b2 + w * 0.1848) * 0.2;
        }

        public void reset() {
            b0 = b1 = b2 = 0;
        }
    }

    public static final class Brown {
        private double y;

        public double step(double w) {
            y = (y + 0.02 * w) / 1.02;
            return y * 3.5;
        }

        public void reset() {
            y = 0;
        }
    }

    /** Smooth, time-pure random curve in [0, 1]. */
    public static double valueNoise(int seed, double t, double period) {
        double x = t / period;
        double i = Math.floor(x);
        double f = x - i;
        double a = Hash.rand01(seed, i);
        double b = Hash.rand01(seed, i + 1);
        double u = 0.5 - 0.5 * Math.cos(Math.PI * f);
        return a + (b - a) * u;
    }

    /** Tone tilt: -1 dark (toward a 700 Hz low-pass), +1 bright (boost above ~2.5 kHz). */
    public static final class Tilt {
        private final LowPass lo = new LowPass(), hi = new LowPass();

        public void set(double sr) {
            lo.setCutoff(700, sr);
            hi.setCutoff(2500, sr);
        }

        public double step(double x, double tone) {
            double l = lo.step(x);
            double h = x - hi.step(x);
            return tone < 0 ? x + -tone * (l - x) : x + tone * 1.5 * h;
        }

        public void reset() {
            lo.reset();
            hi.reset();
        }
    }

    /** A sample-by-sample renderer with state. */
    public interface StatefulCore {
        void reset();

        void run(double start, int n, double sr, float[] L, float[] R);
    }

    /** Wraps a stateful core so it can be entered at any time (warm-up on a jump). */
    public static Gen.Voice stateful(StatefulCore core) {
        return new Gen.Voice() {
            double next = Double.NaN;
            final float[] sl = new float[CHUNK];
            final float[] srr = new float[CHUNK];

            @Override
            public void render(double t0, int n, double sr, float[] L, float[] R) {
                double start = Math.round(t0 * sr);
                if (start != next) {
                    core.reset();
                    for (double i = start - WARMUP; i < start; i += CHUNK) core.run(i, (int) Math.min(CHUNK, start - i), sr, sl, srr);
                }
                core.run(start, n, sr, L, R);
                next = start + n;
            }
        };
    }

    /** Port of addOsc in dsp.ts: a decaying sine by recurrence, added to L/R over [from, to). */
    public static void addOsc(float[] L, float[] R, double start, double from, double to, double phase, double w,
            double amp, double decay, double gl, double gr) {
        double c2 = 2 * Math.cos(w);
        double y1 = Math.sin(phase - w);
        double y0 = Math.sin(phase);
        double e = amp;
        for (double j = from; j < to; j++) {
            double x = y0 * e;
            int o = (int) (j - start);
            L[o] = (float) (L[o] + x * gl);
            R[o] = (float) (R[o] + x * gr);
            double y2 = c2 * y0 - y1;
            y1 = y0;
            y0 = y2;
            e *= decay;
        }
    }

    public static double frac(double x) {
        return x - Math.floor(x);
    }
}
