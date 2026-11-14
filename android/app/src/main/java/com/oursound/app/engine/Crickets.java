package com.oursound.app.engine;

import java.util.Map;

/** Crickets: a few near ones and a chorus further off (port of src/engine/crickets.ts; must match it). */
final class Crickets {
    private Crickets() {}

    private static final int MAX_CRICKETS = 16;
    private static final double PULSE_GAP = 0.024, PULSE_LEN = 0.017, LOOKBACK = 0.34;
    private static final double[] ECHO_T = {0, 0.043, 0.097, 0.171};
    private static final double[] ECHO_G = {1, 0.22, 0.13, 0.07};
    private static final double LEVEL = 0.32;

    private static double timeOfChirp(Gen.ParamReader rate, double b, double guess) {
        double t = guess;
        for (int k = 0; k < 3; k++) {
            double r = Math.max(0.2, rate.value(t));
            t += (b - rate.integral(t)) / r;
        }
        return t;
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader countP = p.get("crickets"), rateP = p.get("rate"), pitchP = p.get("pitch"), restsP = p.get("rests");
        int sC = Hash.seedMix(seed ^ 0xc71c), sJ = Hash.seedMix(seed ^ 0xc71d), sB = Hash.seedMix(seed ^ 0xc71e);
        final double[] freqMul = new double[MAX_CRICKETS], rateMul = new double[MAX_CRICKETS], off = new double[MAX_CRICKETS];
        final int[] pulses = new int[MAX_CRICKETS];
        final double[] gain = new double[MAX_CRICKETS], pan = new double[MAX_CRICKETS];
        final double[] boutLen = new double[MAX_CRICKETS], boutOff = new double[MAX_CRICKETS];
        for (int i = 0; i < MAX_CRICKETS; i++) {
            double b = i * 16;
            freqMul[i] = 1 + 0.14 * (Hash.fastUnit(sC, b) - 0.5);
            rateMul[i] = 1 + 0.16 * (Hash.fastUnit(sC, b + 1) - 0.5);
            off[i] = Hash.fastUnit(sC, b + 2);
            pulses[i] = 3 + (int) Math.floor(Hash.fastUnit(sC, b + 3) * 3);
            gain[i] = i == 0 ? 1 : i == 1 ? 0.7 : 0.18 + 0.3 * Hash.fastUnit(sC, b + 4);
            pan[i] = 0.5 + 0.8 * (Hash.fastUnit(sC, b + 5) - 0.5);
            boutLen[i] = 4 + 8 * Hash.fastUnit(sC, b + 6);
            boutOff[i] = Hash.fastUnit(sC, b + 7) * (4 + 8 * Hash.fastUnit(sC, b + 6));
        }
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            double count = Math.max(1, Math.min(MAX_CRICKETS, countP.value(tc)));
            double pitch = Dsp.clamp01(pitchP.value(tc));
            double rests = Dsp.clamp01(restsP.value(tc));
            double tA = Math.max(0, tc - LOOKBACK);
            double tB = (start + n) / sr;
            double bA = rateP.integral(tA);
            double bB = rateP.integral(tB);
            double rate0 = Math.max(0.2, rateP.value(tA));
            double baseHz = 2800 + 3200 * pitch;
            double echoLen = Math.round(ECHO_T[3] * sr);
            for (int i = 0; i < MAX_CRICKETS; i++) {
                double fade = Math.min(1, count - i);
                if (fade <= 0) break;
                double rm = rateMul[i];
                double kA = Math.max(0, Math.floor(rm * bA + off[i]) - 1);
                double kB = Math.ceil(rm * bB + off[i]) + 1;
                int np = pulses[i];
                double len = Math.ceil(((np - 1) * PULSE_GAP + PULSE_LEN) * sr);
                double f = baseHz * freqMul[i];
                double gl = Math.min(1, 2 * (1 - pan[i])), gr = Math.min(1, 2 * pan[i]);
                for (double k = kA; k <= kB; k++) {
                    double b = (k - off[i]) / rm;
                    if (b < 0) continue;
                    double r = k * 16 + i;
                    double jitter = (Hash.fastUnit(sJ, r * 4) - 0.5) * 0.016;
                    double tk = timeOfChirp(rateP, b, tA + (b - bA) / rate0) + jitter;
                    double at = Math.round(tk * sr);
                    if (at < 0 || at + len + echoLen <= start || at >= start + n) continue;
                    double bout = Math.floor((tk + boutOff[i]) / boutLen[i]);
                    if (Hash.fastUnit(sB, bout * 16 + i) < rests * 0.85) continue;
                    double amp = gain[i] * fade * (0.75 + 0.25 * Hash.fastUnit(sJ, r * 4 + 1));
                    double ph0 = Dsp.TWO_PI * Hash.fastUnit(sJ, r * 4 + 2);
                    boolean near = i < 2;
                    double h2 = near ? 0.18 : 0.05;
                    double buzz = near ? 0.22 : 0.1;
                    for (int e = 0; e < 4; e++) {
                        double ea = at + Math.round(ECHO_T[e] * sr);
                        double from = Math.max(start, ea);
                        double to = Math.min(start + n, ea + len);
                        if (from >= to) continue;
                        double eg = ECHO_G[e] * amp * LEVEL;
                        double el = e == 0 ? gl : gr, er = e == 0 ? gr : gl;
                        for (double j = from; j < to; j++) {
                            double tau = (j - ea) / sr;
                            double q = Math.floor(tau / PULSE_GAP);
                            if (q >= np) continue;
                            double u = (tau - q * PULSE_GAP) / PULSE_LEN;
                            if (u >= 1) continue;
                            double env = (u < 0.15 ? u / 0.15 : (Math.exp(-4 * (u - 0.15)) * (1 - u)) / 0.85) * (q == 0 ? 0.7 : 1);
                            double ph = Dsp.TWO_PI * f * (tau - 0.015 * PULSE_LEN * u * u) + ph0;
                            double x = (Math.sin(ph) * (1 + buzz * Math.sin(0.25 * ph)) + h2 * Math.sin(2 * ph)) * env * eg;
                            int o = (int) (j - start);
                            L[o] = (float) (L[o] + x * el);
                            R[o] = (float) (R[o] + x * er);
                        }
                    }
                }
            }
        };
    }
}
