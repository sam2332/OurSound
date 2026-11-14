package com.oursound.app.engine;

import java.util.Map;

/** Ambient pad: slow, warm chords that drift (port of src/engine/pad.ts; must match it). */
final class Pad {
    private Pad() {}

    private static final int MOODS = 3;
    private static final double[][][] CHORDS = {
        {{0, 12, 16, 19, 26}, {5, 12, 17, 21, 24}, {-3, 12, 16, 21, 24}, {7, 14, 19, 23, 26}, {2, 14, 17, 21, 24}},
        {{0, 11, 16, 19, 26}, {5, 16, 21, 24, 28}, {-3, 12, 19, 23, 26}, {2, 14, 18, 21, 25}, {-5, 14, 19, 23, 26}},
        {{0, 12, 15, 19, 26}, {-4, 12, 15, 20, 24}, {3, 15, 19, 22, 26}, {-2, 14, 17, 22, 26}, {5, 12, 17, 20, 24}},
    };
    private static final double[] NOTE_AMP = {0.9, 0.7, 0.62, 0.55, 0.32};
    private static final int HARMONICS = 6;
    private static final double LEVEL = 0.07;

    private static int chordIndex(int sC, double c, int count) {
        if (c == 0) return 0;
        int a = (int) Math.floor(Hash.fastUnit(sC, c) * count);
        int prev = (int) Math.floor(Hash.fastUnit(sC, c - 1) * count);
        return a == prev ? (a + 1) % count : a;
    }

    private static double chordWeight(double c, double len, double x, double t) {
        double inStart = c * len - x / 2;
        double outStart = (c + 1) * len - x / 2;
        if (c > 0 && t < inStart) return 0;
        if (t >= outStart + x) return 0;
        double w = 1;
        if (c > 0 && t < inStart + x) w = Math.sin(((t - inStart) / x) * (Math.PI / 2));
        if (t > outStart) w *= Math.cos(((t - outStart) / x) * (Math.PI / 2));
        return w;
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader moodP = p.get("mood"), pitchP = p.get("pitch"), changeP = p.get("change"), brightP = p.get("brightness"), moveP = p.get("movement");
        final int sC = Hash.seedMix(seed ^ 0xa0d1), sV = Hash.seedMix(seed ^ 0xa0d2);
        final double L0 = Math.max(10, changeP.value(0));
        final double X = Math.min(0.45 * L0, 14);
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            double tEnd = (start + n) / sr;
            int mood = (int) Math.max(0, Math.min(MOODS - 1, Math.round(moodP.value(tc))));
            double bright = Dsp.clamp01(brightP.value(tc));
            double move = Dsp.clamp01(moveP.value(tc));
            double[][] chords = CHORDS[mood];
            double cA = Math.max(0, Math.floor((tc - X / 2) / L0));
            double cB = Math.floor((tEnd + X / 2) / L0);
            for (double c = cA; c <= cB; c++) {
                double w0 = chordWeight(c, L0, X, tc);
                double w1 = chordWeight(c, L0, X, tEnd);
                if (w0 <= 0 && w1 <= 0) continue;
                double[] chord = chords[chordIndex(sC, c, chords.length)];
                double key = Math.max(-6, Math.min(6, pitchP.value(c * L0)));
                for (int v = 0; v < 5; v++) {
                    double f = 65.406 * Math.pow(2, (key + chord[v]) / 12);
                    double id = (c * 8 + v) * 32;
                    double per = 9 + 8 * Hash.fastUnit(sV, id);
                    double lph = Dsp.TWO_PI * Hash.fastUnit(sV, id + 1);
                    double sw0 = 1 - 0.4 * move * (0.5 + 0.5 * Math.sin((Dsp.TWO_PI * tc) / per + lph));
                    double sw1 = 1 - 0.4 * move * (0.5 + 0.5 * Math.sin((Dsp.TWO_PI * tEnd) / per + lph));
                    double g0 = w0 * sw0 * NOTE_AMP[v] * LEVEL;
                    double g1 = w1 * sw1 * NOTE_AMP[v] * LEVEL;
                    double ramp = g0 > 1e-9 && g1 > 1e-9 ? Math.pow(g1 / g0, 1.0 / n) : 1;
                    double gStart = g0 > 1e-9 && g1 > 1e-9 ? g0 : 0.5 * (g0 + g1);
                    double detune = (3 + 5 * move) / 1200;
                    for (int side = 0; side < 2; side++) {
                        double fv = f * Math.pow(2, side == 0 ? -detune : detune);
                        double gl = side == 0 ? 0.8 : 0.35;
                        double gr = side == 0 ? 0.35 : 0.8;
                        for (int h = 1; h <= HARMONICS; h++) {
                            double fh = fv * h;
                            if (fh > 5000) break;
                            double a = (gStart / h) * Math.exp(-(h - 1) * (1.7 - 1.4 * bright));
                            double cyc = Dsp.frac(fh * tc + Hash.fastUnit(sV, id + 2 + side * 8 + h));
                            Dsp.addOsc(L, R, start, start, start + n, Dsp.TWO_PI * cyc, (Dsp.TWO_PI * fh) / sr, a, ramp, gl, gr);
                        }
                    }
                }
            }
        };
    }
}
