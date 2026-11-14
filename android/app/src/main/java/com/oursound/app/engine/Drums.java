package com.oursound.app.engine;

import java.util.Map;

/** Hand drums: a small kit played from a 16-step pattern (port of src/engine/drums.ts; must match it). */
final class Drums {
    private Drums() {}

    private static final int STYLES = 5, CUSTOM_STYLE = 4, STEPS = 16, LANES = 5;
    private static final double RING = 1.3, LEVEL = 0.62;
    private static final double[] STYLE_GAIN = {0.85, 1, 0.75, 0.85, 0.85};
    private static final double[] LANE_LEN = {RING, 0.9, 0.5, 0.2, 0.15};
    private static final double[] LANE_PAN = {0.5, 0.4, 0.62, 0.7, 0.36};

    private static double[] row(double... stepVel) {
        double[] r = new double[STEPS];
        for (int i = 0; i + 1 < stepVel.length; i += 2) r[(int) stepVel[i]] = stepVel[i + 1];
        return r;
    }

    /** Same presets as DRUM_PRESETS in drums.ts: [style][lane][step]. */
    private static final double[][][] PRESETS = {
        {row(0, 1, 1, 0.6, 4, 1, 5, 0.6, 8, 1, 9, 0.6, 12, 1, 13, 0.6), row(), row(), row(), row()},
        {row(0, 1, 4, 0.75, 8, 0.8, 12, 0.75), row(), row(), row(2, 0.25, 6, 0.25, 10, 0.25, 14, 0.25), row()},
        {row(0, 1, 2, 0.8, 4, 0.85, 6, 0.8, 8, 0.9, 10, 0.8, 12, 0.85, 14, 0.8), row(), row(), row(), row()},
        {
            row(0, 1, 8, 0.85),
            row(4, 0.55, 6, 0.45, 12, 0.6),
            row(10, 0.45, 15, 0.3),
            row(1, 0.2, 3, 0.25, 5, 0.2, 7, 0.25, 9, 0.2, 11, 0.25, 13, 0.2, 15, 0.25),
            row(2, 0.3, 14, 0.3),
        },
    };

    private static double timeOfBeat(Gen.ParamReader tempo, double b, double guess) {
        double t = guess;
        for (int k = 0; k < 3; k++) {
            double bpm = Math.max(20, tempo.value(t));
            t += ((b - tempo.integral(t) / 60) * 60) / bpm;
        }
        return t;
    }

    private static double softNoise(int s, double j, int n) {
        double x = 0;
        for (int i = 0; i < n; i++) x += Hash.fastSigned(s, j - i);
        return x / n;
    }

    private static double stroke(int lane, double t, double tune, double ratio, int sN, double j) {
        double TP = Dsp.TWO_PI;
        if (lane == 0) {
            double f0 = 58 * tune * ratio;
            double ph = TP * f0 * (t + 0.18 * 0.025 * (1 - Math.exp(-t / 0.025)));
            double onset = t < 0.002 ? t / 0.002 : 1;
            double body = Math.sin(ph) * Math.exp(-t / 0.45) + 0.3 * Math.sin(1.47 * ph) * Math.exp(-t / 0.16);
            double beater = 0.22 * Math.sin(TP * f0 * 3.1 * t) * Math.exp(-t / 0.006);
            double skin = 0.22 * softNoise(sN, j, 6) * Math.exp(-t / 0.01);
            return (body + beater + skin) * onset;
        }
        if (lane == 1) {
            double f0 = 125 * tune * ratio;
            double ph = TP * f0 * (t + 0.1 * 0.02 * (1 - Math.exp(-t / 0.02)));
            double onset = t < 0.0015 ? t / 0.0015 : 1;
            double body = Math.sin(ph) * Math.exp(-t / 0.28) + 0.4 * Math.sin(1.59 * ph) * Math.exp(-t / 0.14) + 0.2 * Math.sin(2.14 * ph) * Math.exp(-t / 0.1);
            double skin = 0.3 * softNoise(sN, j, 3) * Math.exp(-t / 0.006);
            return (body * 0.85 + skin) * onset;
        }
        if (lane == 2) {
            double f0 = 260 * tune * ratio;
            double ph = TP * f0 * t;
            double onset = t < 0.001 ? t / 0.001 : 1;
            double body = Math.sin(ph) * Math.exp(-t / 0.12) + 0.5 * Math.sin(1.5 * ph) * Math.exp(-t / 0.07);
            double slap = 0.55 * softNoise(sN, j, 2) * Math.exp(-t / 0.004);
            return (body * 0.7 + slap) * onset;
        }
        if (lane == 3) {
            double nz = (Hash.fastSigned(sN, j) - Hash.fastSigned(sN, j - 1)) * 0.5;
            double env = t < 0.006 ? t / 0.006 : Math.exp(-(t - 0.006) / 0.035);
            return nz * env * 0.5;
        }
        double fw = 820 * (0.85 + 0.3 * (tune - 0.8) / 0.6);
        double onset = t < 0.0005 ? t / 0.0005 : 1;
        return (0.45 * Math.sin(TP * fw * t) * Math.exp(-t / 0.025) + 0.25 * Math.sin(TP * fw * 1.57 * t) * Math.exp(-t / 0.015)) * onset;
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader tempoP = p.get("tempo"), styleP = p.get("style"), depthP = p.get("depth"), varP = p.get("variety");
        final int sV = seed ^ 0xd2a1, sH = Hash.seedMix(seed ^ 0xd2a2), sN = Hash.seedMix(seed ^ 0xd2a3);
        final double[][] custom = seg != null ? seg.drumPattern : null;
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            int style = (int) Math.max(0, Math.min(STYLES - 1, Math.round(styleP.value(tc))));
            double depth = Dsp.clamp01(depthP.value(tc));
            double variety = Dsp.clamp01(varP.value(tc));
            double tune = 0.8 + 0.6 * depth;
            double[][] pattern = style == CUSTOM_STYLE ? (custom != null ? custom : PRESETS[1]) : PRESETS[style];
            double tA = Math.max(0, tc - RING);
            double tB = (start + n) / sr;
            double gA = Math.floor((tempoP.integral(tA) / 60) * 4) - 2;
            double gB = Math.ceil((tempoP.integral(tB) / 60) * 4) + 1;
            double bpm0 = Math.max(20, tempoP.value(tA));
            for (double g = gA; g <= gB; g++) {
                if (g < 0) continue;
                int step = (int) (g % STEPS);
                for (int lane = 0; lane < LANES; lane++) {
                    double vel = lane < pattern.length && pattern[lane] != null && step < pattern[lane].length ? pattern[lane][step] : 0;
                    double ratio = 1;
                    double pos = g / 4;
                    if (style == 0) {
                        if (lane != 0 || (g % 4 != 0 && g % 4 != 1)) continue;
                        boolean dub = g % 4 == 1;
                        vel = dub ? 0.6 : 1;
                        ratio = dub ? 1.12 : 1;
                        pos = Math.floor(g / 4) + (dub ? 0.3 : 0);
                    } else {
                        double r = Hash.rand01(sV, g * 8 + lane);
                        if (vel == 0 && (lane == 2 || lane == 3) && r < variety * 0.12) vel = 0.15 + 0.2 * Hash.rand01(sV ^ 0x1f, g * 8 + lane);
                        else if (vel > 0 && step != 0 && r < variety * 0.08) vel = 0;
                    }
                    if (vel <= 0) continue;
                    double id = (g * 8 + lane) * 4;
                    double jitter = (Hash.fastUnit(sH, id) - 0.5) * 0.036 * variety;
                    double hitT = timeOfBeat(tempoP, pos, tA + ((pos - tempoP.integral(tA) / 60) * 60) / bpm0) + jitter;
                    double at = Math.round(hitT * sr);
                    if (at < 0) continue;
                    double len = Math.ceil(LANE_LEN[lane] * sr);
                    if (at + len <= start || at >= start + n) continue;
                    double amp = vel * STYLE_GAIN[style] * (1 - 0.3 * variety * Hash.fastUnit(sH, id + 1)) * LEVEL;
                    double tn = tune * (1 + 0.03 * variety * (Hash.fastUnit(sH, id + 2) - 0.5));
                    double pan = LANE_PAN[lane] + 0.16 * variety * (Hash.fastUnit(sH, id + 3) - 0.5);
                    double gl = Math.min(1, 2 * (1 - pan)), gr = Math.min(1, 2 * pan);
                    double from = Math.max(start, at);
                    double to = Math.min(start + n, at + len);
                    for (double j = from; j < to; j++) {
                        double x = stroke(lane, (j - at) / sr, tn, ratio, sN, j) * amp;
                        int o = (int) (j - start);
                        L[o] = (float) (L[o] + x * gl);
                        R[o] = (float) (R[o] + x * gr);
                    }
                }
            }
        };
    }
}
