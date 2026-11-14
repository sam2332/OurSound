package com.oursound.app.engine;

import java.util.Map;

/** Singing bowl: struck now and then, ringing for a long time (port of src/engine/bowl.ts; must match it). */
final class Bowl {
    private Bowl() {}

    private static final double[] RATIO = {1, 2.76, 5.4, 8.93};
    private static final double[] AMP = {1, 0.5, 0.26, 0.12};
    private static final double[] DECAY = {1, 0.55, 0.3, 0.18};
    private static final double[] SPLIT = {0.5, 1.3, 2.4, 3.6};
    private static final double[] BOWLS = {1, 1.335, 1.498};
    private static final double LEVEL = 0.2;

    private static double timeOfStrike(Gen.ParamReader rate, double b, double guess) {
        double t = guess;
        for (int k = 0; k < 3; k++) {
            double r = Math.max(0.1, rate.value(t)) / 60;
            t += (b - rate.integral(t) / 60) / r;
        }
        return t;
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader rateP = p.get("rate"), pitchP = p.get("pitch"), ringP = p.get("ring"), varP = p.get("variety");
        final int sS = Hash.seedMix(seed ^ 0xb041);
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            double pitch = Dsp.clamp01(pitchP.value(tc));
            double ring = Dsp.clamp01(ringP.value(tc));
            double variety = Dsp.clamp01(varP.value(tc));
            double f1 = 110 * Math.pow(2, 2 * pitch);
            double tau1 = 5 + 20 * ring;
            double tA = Math.max(0, tc - 5 * tau1);
            double tB = (start + n) / sr;
            double bA = rateP.integral(tA) / 60;
            double bB = rateP.integral(tB) / 60;
            double rate0 = Math.max(0.1, rateP.value(tA)) / 60;
            double kA = Math.max(0, Math.floor(bA) - 1);
            double kB = Math.ceil(bB) + 1;
            for (double k = kA; k <= kB; k++) {
                double id = k * 16;
                double b = k + 0.15;
                double gap = 1 / rate0;
                double jitter = (Hash.fastUnit(sS, id) - 0.5) * 0.5 * variety * gap;
                double tk = timeOfStrike(rateP, b, tA + (b - bA) / rate0) + jitter;
                double at = Math.round(tk * sr);
                if (at < 0 || at >= start + n) continue;
                double vel = (0.65 + 0.35 * Hash.fastUnit(sS, id + 1)) * LEVEL;
                if (vel * Math.exp(-(start - at) / (sr * tau1)) < 1e-6) continue;
                int pick = Hash.fastUnit(sS, id + 2) < variety * 0.6 ? 1 + (int) Math.floor(Hash.fastUnit(sS, id + 3) * 2) : 0;
                double f = f1 * BOWLS[pick];
                double from = Math.max(start, at);
                double to = start + n;
                double attackEnd = Math.min(to, at + Math.ceil(0.004 * sr));
                for (int m = 0; m < 4; m++) {
                    double tau = tau1 * DECAY[m];
                    double decay = Math.exp(-1 / (sr * tau));
                    double split = SPLIT[m] * (0.6 + 0.8 * Hash.fastUnit(sS, id + 4 + m));
                    for (int side = 0; side < 2; side++) {
                        double fm = f * RATIO[m] + (side == 0 ? -0.5 : 0.5) * split;
                        double w = (Dsp.TWO_PI * fm) / sr;
                        double ph0 = Dsp.TWO_PI * Hash.fastUnit(sS, id + 8 + m * 2 + side);
                        double gl = side == 0 ? 0.78 : 0.32;
                        double gr = side == 0 ? 0.32 : 0.78;
                        double a = vel * AMP[m] * 0.5;
                        if (from < attackEnd) {
                            for (double j = from; j < attackEnd; j++) {
                                double t = (j - at) / sr;
                                double x = Math.sin(w * (j - at) + ph0) * a * Math.exp(-t / tau) * (t / 0.004);
                                int o = (int) (j - start);
                                L[o] = (float) (L[o] + x * gl);
                                R[o] = (float) (R[o] + x * gr);
                            }
                        }
                        double f2 = Math.max(from, attackEnd);
                        if (f2 < to) Dsp.addOsc(L, R, start, f2, to, w * (f2 - at) + ph0, w, a * Math.exp(-(f2 - at) / (sr * tau)), decay, gl, gr);
                    }
                }
                double knockEnd = Math.min(to, at + Math.ceil(0.08 * sr));
                for (double j = from; j < knockEnd; j++) {
                    double t = (j - at) / sr;
                    double x = Math.sin(Dsp.TWO_PI * f * 2.3 * t) * Math.exp(-t / 0.012) * (t < 0.001 ? t / 0.001 : 1) * vel * 0.12;
                    int o = (int) (j - start);
                    L[o] = (float) (L[o] + x * 0.55);
                    R[o] = (float) (R[o] + x * 0.55);
                }
            }
        };
    }
}
