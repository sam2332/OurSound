package com.oursound.app.engine;

import java.util.Map;

/** Tones and noise (port of src/engine/generators.ts). */
final class Tones {
    private Tones() {}

    private static final double TWO_PI = Dsp.TWO_PI;

    private static double frac(double x) {
        return x - Math.floor(x);
    }

    private static void renderSine(Gen.ParamReader freq, double t0, int n, double sr, double amp, float[] out, boolean add) {
        double phase = frac(freq.integral(t0));
        double f0 = freq.value(t0);
        double f1 = freq.value(t0 + n / sr);
        double df = (f1 - f0) / n;
        double f = f0;
        for (int i = 0; i < n; i++) {
            double s = Math.sin(TWO_PI * phase) * amp;
            out[i] = (float) (add ? out[i] + s : s);
            phase += (f + 0.5 * df) / sr;
            if (phase >= 1) phase -= Math.floor(phase);
            f += df;
        }
    }

    private static Gen.ParamReader sum(Gen.ParamReader a, Gen.ParamReader b) {
        return new Gen.ParamReader() {
            public double value(double t) {
                return a.value(t) + b.value(t);
            }

            public double integral(double t) {
                return a.integral(t) + b.integral(t);
            }
        };
    }

    static Gen.Voice binaural(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader carrier = p.get("carrier");
        Gen.ParamReader right = sum(carrier, p.get("beat"));
        return (t0, n, sr, L, R) -> {
            renderSine(carrier, t0, n, sr, Gen.TONE_PEAK, L, false);
            renderSine(right, t0, n, sr, Gen.TONE_PEAK, R, false);
        };
    }

    static Gen.Voice monaural(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader carrier = p.get("carrier");
        Gen.ParamReader upper = sum(carrier, p.get("beat"));
        return (t0, n, sr, L, R) -> {
            renderSine(carrier, t0, n, sr, Gen.TONE_PEAK * 0.5, L, false);
            renderSine(upper, t0, n, sr, Gen.TONE_PEAK * 0.5, L, true);
            System.arraycopy(L, 0, R, 0, n);
        };
    }

    static Gen.Voice isochronic(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader tone = p.get("tone"), rate = p.get("rate"), duty = p.get("duty");
        return (t0, n, sr, L, R) -> {
            renderSine(tone, t0, n, sr, Gen.TONE_PEAK, L, false);
            double pp = frac(rate.integral(t0));
            double r0 = rate.value(t0);
            double r1 = rate.value(t0 + n / sr);
            double dr = (r1 - r0) / n;
            double r = r0;
            double d = Math.min(1, Math.max(0.05, duty.value(t0)));
            for (int i = 0; i < n; i++) {
                double x = pp / d;
                double env = x < 1 ? 0.5 - 0.5 * Math.cos(TWO_PI * x) : 0;
                L[i] = (float) (L[i] * env);
                pp += (r + 0.5 * dr) / sr;
                if (pp >= 1) pp -= Math.floor(pp);
                r += dr;
            }
            System.arraycopy(L, 0, R, 0, n);
        };
    }

    static Gen.Voice tone(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader freq = p.get("freq");
        return (t0, n, sr, L, R) -> {
            renderSine(freq, t0, n, sr, Gen.TONE_PEAK, L, false);
            System.arraycopy(L, 0, R, 0, n);
        };
    }

    // ------------------------------------------------------------ noise

    private static final double WHITE_SCALE = Gen.NOMINAL_RMS * Math.sqrt(3);
    private static final double PINK_SCALE = 0.14;
    private static final double BROWN_SCALE = 4.38;
    private static final double GREEN_SCALE = 0.329;
    private static final double BLUE_SCALE = 0.2394;
    private static final double VIOLET_SCALE = 0.3073;
    private static final double GREEN_HZ = 500;
    static final int NOISE_COLORS = 6;
    private static final int NOISE_WARMUP = 8192;

    /** Kellet's refined pink filter + a leaky-integrator brown. */
    private static final class Colorer {
        double b0, b1, b2, b3, b4, b5, b6, brown, prevPink, prevWhite;
        final Dsp.BandPass bp = new Dsp.BandPass();

        void reset() {
            b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0;
            brown = 0;
            prevPink = 0;
            prevWhite = 0;
            bp.reset();
        }

        double green(double w) {
            return bp.step(pink(w));
        }

        double blue(double w) {
            double p = pink(w);
            double out = p - prevPink;
            prevPink = p;
            return out;
        }

        double violet(double w) {
            double out = w - prevWhite;
            prevWhite = w;
            return out;
        }

        double pink(double w) {
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.969 * b2 + w * 0.153852;
            b3 = 0.8665 * b3 + w * 0.3104856;
            b4 = 0.55 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.016898;
            double out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
            b6 = w * 0.115926;
            return out;
        }

        double brownStep(double w) {
            brown = (brown + 0.02 * w) / 1.02;
            return brown;
        }
    }

    static Gen.Voice noise(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader colorP = p.get("color"), widthP = p.get("width"), toneP = p.get("tone");
        Dsp.Tilt tiltL = new Dsp.Tilt(), tiltR = new Dsp.Tilt();
        int seedL = Hash.seedMix(seed ^ 0x1234567);
        int seedR = Hash.seedMix(seed ^ 0x7654321);
        Colorer cl = new Colorer(), cr = new Colorer();
        return new Gen.Voice() {
            double nextIndex = Double.NaN;
            int lastColor = -1;
            double sl, srr, tone;

            void step(int color, double idx) {
                double wl = Hash.fastSigned(seedL, idx);
                double wr = Hash.fastSigned(seedR, idx);
                if (color == 0) {
                    sl = wl * WHITE_SCALE;
                    srr = wr * WHITE_SCALE;
                } else if (color == 1) {
                    sl = cl.pink(wl) * PINK_SCALE;
                    srr = cr.pink(wr) * PINK_SCALE;
                } else if (color == 2) {
                    sl = cl.brownStep(wl) * BROWN_SCALE;
                    srr = cr.brownStep(wr) * BROWN_SCALE;
                } else if (color == 3) {
                    sl = cl.green(wl) * GREEN_SCALE;
                    srr = cr.green(wr) * GREEN_SCALE;
                } else if (color == 4) {
                    sl = cl.blue(wl) * BLUE_SCALE;
                    srr = cr.blue(wr) * BLUE_SCALE;
                } else {
                    sl = cl.violet(wl) * VIOLET_SCALE;
                    srr = cr.violet(wr) * VIOLET_SCALE;
                }
                sl = tiltL.step(sl, tone);
                srr = tiltR.step(srr, tone);
            }

            @Override
            public void render(double t0, int n, double sr, float[] L, float[] R) {
                int color = (int) Math.round(Math.min(NOISE_COLORS - 1, Math.max(0, colorP.value(t0))));
                double width = Math.min(1, Math.max(0, widthP.value(t0)));
                tone = Math.max(-1, Math.min(1, toneP.value(t0)));
                double start = Math.round(t0 * sr);
                if (start != nextIndex || color != lastColor) {
                    cl.reset();
                    cr.reset();
                    cl.bp.set(GREEN_HZ, 0.6, sr);
                    cr.bp.set(GREEN_HZ, 0.6, sr);
                    tiltL.reset();
                    tiltR.reset();
                    tiltL.set(sr);
                    tiltR.set(sr);
                    for (double i = start - NOISE_WARMUP; i < start; i++) step(color, i);
                    lastColor = color;
                }
                double a = 0.5 * (1 + width), b = 0.5 * (1 - width);
                for (int i = 0; i < n; i++) {
                    step(color, start + i);
                    L[i] = (float) (a * sl + b * srr);
                    R[i] = (float) (a * srr + b * sl);
                }
                nextIndex = start + n;
            }
        };
    }
}
