package com.oursound.app.engine;

import java.util.Map;

/** Purring cat: a low flutter that swells with each breath (port of src/engine/purr.ts; must match it). */
final class Purr {
    private Purr() {}

    private static final double GRAIN = 0.045, LEVEL = 0.9;

    private static double pulseRate(double p) {
        return 20 + 12 * p;
    }

    private static double breathEnv(double ph) {
        if (ph < 0.56) {
            double s = Math.sin((Math.PI * ph) / 0.56);
            return Math.sqrt(s);
        }
        if (ph >= 0.6 && ph < 0.96) {
            double s = Math.sin((Math.PI * (ph - 0.6)) / 0.36);
            return 0.55 * Math.sqrt(s);
        }
        return 0;
    }

    private static double timeOfPulse(Gen.ParamReader pitch, double b, double guess) {
        double t = guess;
        for (int k = 0; k < 3; k++) {
            double r = pulseRate(Dsp.clamp01(pitch.value(t)));
            t += (b - (20 * t + 12 * pitch.integral(t))) / r;
        }
        return t;
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader breathsP = p.get("breaths"), pitchP = p.get("pitch"), rumbleP = p.get("rumble");
        final int sP = Hash.seedMix(seed ^ 0x9a11), sN = Hash.seedMix(seed ^ 0x9a12);
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            double rumble = Dsp.clamp01(rumbleP.value(tc));
            double tA = Math.max(0, tc - GRAIN);
            double tB = (start + n) / sr;
            double cA = 20 * tA + 12 * pitchP.integral(tA);
            double cB = 20 * tB + 12 * pitchP.integral(tB);
            double r0 = pulseRate(Dsp.clamp01(pitchP.value(tA)));
            double len = Math.ceil(GRAIN * sr);
            for (double k = Math.max(0, Math.floor(cA) - 1); k <= Math.ceil(cB) + 1; k++) {
                double id = k * 8;
                double tk = timeOfPulse(pitchP, k, tA + (k - cA) / r0) + (Hash.fastUnit(sP, id) - 0.5) * 0.004;
                double at = Math.round(tk * sr);
                if (at < 0 || at + len <= start || at >= start + n) continue;
                double bph = Dsp.frac(breathsP.integral(tk) / 60);
                double env = breathEnv(bph);
                if (env <= 0) continue;
                boolean inhale = bph >= 0.6;
                double amp = env * (0.8 + 0.4 * Hash.fastUnit(sP, id + 1)) * LEVEL;
                double fb = (inhale ? 85 : 70) * (0.9 + 0.2 * Hash.fastUnit(sP, id + 2));
                double noiseAmt = 0.25 + 0.75 * rumble;
                double from = Math.max(start, at);
                double to = Math.min(start + n, at + len);
                for (double j = from; j < to; j++) {
                    double t = (j - at) / sr;
                    double att = t < 0.002 ? t / 0.002 : 1;
                    double body = Math.sin(Dsp.TWO_PI * fb * t) * Math.exp(-t / 0.011) + 0.45 * Math.sin(Dsp.TWO_PI * fb * 2.1 * t) * Math.exp(-t / 0.006);
                    double nl = (Hash.fastSigned(sN, j) + Hash.fastSigned(sN, j - 1) + Hash.fastSigned(sN, j - 2) + Hash.fastSigned(sN, j - 3)) * 0.25;
                    double nr = (Hash.fastSigned(sN, j + 7919) + Hash.fastSigned(sN, j + 7918) + Hash.fastSigned(sN, j + 7917) + Hash.fastSigned(sN, j + 7916)) * 0.25;
                    double ne = Math.exp(-t / (inhale ? 0.005 : 0.008)) * noiseAmt * 0.9;
                    double b = body * (1.1 - 0.5 * rumble);
                    int o = (int) (j - start);
                    L[o] = (float) (L[o] + (b + nl * ne) * amp * att);
                    R[o] = (float) (R[o] + (b + nr * ne) * amp * att);
                }
            }
        };
    }
}
