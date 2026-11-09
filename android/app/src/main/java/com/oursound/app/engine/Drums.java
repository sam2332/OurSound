package com.oursound.app.engine;

import java.util.Map;

/** Hand drums on a tempo-exact beat grid (port of src/engine/drums.ts; must match it). */
final class Drums {
    private Drums() {}

    static final int STYLE_COUNT = 4;
    private static final double RING = 1.6;
    private static final int STEPS = 8;
    private static final double[] STYLE_GAIN = {0.8, 1, 0.7, 1};
    private static final double[][][] PATTERNS = {
            {},
            {{1, 1}, {0, 0}, {0.75, 1}, {0, 0}, {0.8, 1}, {0, 0}, {0.75, 1}, {0, 0}},
            {{1, 1}, {0.8, 1}, {0.85, 1}, {0.8, 1}, {0.9, 1}, {0.8, 1}, {0.85, 1}, {0.8, 1}},
            {{1, 1}, {0, 0}, {0.55, 1.6}, {0.45, 1.6}, {0.85, 1}, {0.4, 1.9}, {0.6, 1.6}, {0, 0}},
    };

    private static void strokeAt(int style, double variety, int sV, double g, double[] out) {
        out[0] = 0;
        out[1] = 1;
        out[2] = g / 2;
        if (style == 0) {
            double beat = Math.floor(g / 2);
            boolean dub = g - beat * 2 == 1;
            out[0] = dub ? 0.6 : 1;
            out[1] = dub ? 1.12 : 1;
            out[2] = beat + (dub ? 0.3 : 0);
        } else {
            int step = (int) (((g % STEPS) + STEPS) % STEPS);
            double[] pat = PATTERNS[style][step];
            out[0] = pat[0];
            out[1] = pat[1];
            double r = Hash.rand01(sV, g);
            if (out[0] == 0 && r < variety * 0.3) {
                out[0] = 0.25 + 0.3 * Hash.rand01(sV ^ 0x1f, g);
                out[1] = style == 3 ? 1.9 : 1.25;
            } else if (out[0] > 0 && step != 0 && r < variety * 0.12) out[0] = 0;
        }
    }

    private static double timeOfBeat(Gen.ParamReader tempo, double b, double guess) {
        double t = guess;
        for (int k = 0; k < 3; k++) {
            double bpm = Math.max(20, tempo.value(t));
            t += ((b - tempo.integral(t) / 60) * 60) / bpm;
        }
        return t;
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader tempoP = p.get("tempo"), styleP = p.get("style"), depthP = p.get("depth"), varietyP = p.get("variety");
        int sV = seed ^ 0xd2a1;
        int sH = Hash.seedMix(seed ^ 0xd2a2), sN = Hash.seedMix(seed ^ 0xd2a3);
        final double[] stroke = new double[3];
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            int style = (int) Math.max(0, Math.min(STYLE_COUNT - 1, Math.round(styleP.value(tc))));
            double depth = Dsp.clamp01(depthP.value(tc));
            double variety = Dsp.clamp01(varietyP.value(tc));
            double tA = Math.max(0, tc - RING);
            double tB = (start + n) / sr;
            double gA = Math.floor((tempoP.integral(tA) / 60) * 2) - 1;
            double gB = Math.ceil((tempoP.integral(tB) / 60) * 2) + 1;
            double bpm0 = Math.max(20, tempoP.value(tA));
            for (double g = gA; g <= gB; g++) {
                if (g < 0) continue;
                strokeAt(style, variety, sV, g, stroke);
                double vel0 = stroke[0];
                if (vel0 <= 0) continue;
                double b = stroke[2];
                double jitter = (Hash.fastUnit(sH, g * 4) - 0.5) * 0.036 * variety;
                double hitT = timeOfBeat(tempoP, b, tA + ((b - tempoP.integral(tA) / 60) * 60) / bpm0) + jitter;
                double at = Math.round(hitT * sr);
                if (at < 0) continue;
                double vel = vel0 * STYLE_GAIN[style] * (1 - 0.35 * variety * Hash.fastUnit(sH, g * 4 + 1));
                double f0 = (55 + 155 * depth * depth) * stroke[1] * (1 + 0.04 * variety * (Hash.fastUnit(sH, g * 4 + 2) - 0.5));
                double tau = (0.55 - 0.35 * depth) / Math.sqrt(stroke[1]);
                double len = Math.min(Math.floor(RING * sr), Math.ceil(tau * 6 * sr));
                if (at + len <= start || at >= start + n) continue;
                double pan = 0.5 + (stroke[1] > 1 ? 0.18 : -0.05) + 0.2 * variety * (Hash.fastUnit(sH, g * 4 + 3) - 0.5);
                double gl = Math.min(1, 2 * (1 - pan)), gr = Math.min(1, 2 * pan);
                double from = Math.max(start, at);
                double to = Math.min(start + n, at + len);
                double skinTau = 0.004 + 0.004 * depth;
                for (double j = from; j < to; j++) {
                    double t = (j - at) / sr;
                    double ph = Dsp.TWO_PI * f0 * (t + 0.7 * 0.03 * (1 - Math.exp(-t / 0.03)));
                    double onset = t < 0.0015 ? t / 0.0015 : 1;
                    double body = Math.sin(ph) * Math.exp(-t / tau) + 0.3 * Math.sin(1.59 * ph) * Math.exp(-t / (tau * 0.35));
                    double skin = (Hash.fastSigned(sN, j) + Hash.fastSigned(sN, j - 1)) * 0.5 * Math.exp(-t / skinTau) * (0.35 + 0.4 * depth);
                    double x = (body + skin) * vel * onset;
                    int o = (int) (j - start);
                    L[o] = (float) (L[o] + x * gl);
                    R[o] = (float) (R[o] + x * gr);
                }
            }
        };
    }
}
