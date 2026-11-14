package com.oursound.app.engine;

import java.util.Map;

/** Stream: a babbling brook made of many small bubbles (port of src/engine/stream.ts; must match it). */
final class Stream {
    private Stream() {}

    private static final double SLOT = 0.004, LIFE = 0.09, LEVEL = 0.55;
    private static final int LAYERS = 3;

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader flowP = p.get("flow"), pitchP = p.get("pitch"), closeP = p.get("closeness");
        final int sB = Hash.seedMix(seed ^ 0x57e1);
        return (t0, n, sr, L, R) -> {
            java.util.Arrays.fill(L, 0, n, 0f);
            java.util.Arrays.fill(R, 0, n, 0f);
            double start = Math.round(t0 * sr);
            double tc = start / sr;
            double flow = Dsp.clamp01(flowP.value(tc));
            double pitch = Dsp.clamp01(pitchP.value(tc));
            double close = Dsp.clamp01(closeP.value(tc));
            double base = 300 + 900 * pitch;
            double pNear = 0.04 + 0.3 * flow;
            double pFar = 0.15 + 0.7 * flow;
            double ampNear = 0.25 + 0.75 * close;
            double ampFar = 0.32 - 0.14 * close;
            double sA = Math.max(0, Math.floor((tc - LIFE) / SLOT));
            double sZ = Math.floor((start + n) / sr / SLOT);
            for (double s = sA; s <= sZ; s++) {
                for (int k = 0; k < LAYERS; k++) {
                    double id = (s * LAYERS + k) * 8;
                    boolean near = k == 0;
                    if (Hash.fastUnit(sB, id) >= (near ? pNear : pFar)) continue;
                    double at = Math.round((s + Hash.fastUnit(sB, id + 1)) * SLOT * sr);
                    double spread = near ? 2.2 : 2.6;
                    double f0 = base * (near ? 1 : 1.7) * Math.pow(2, (Hash.fastUnit(sB, id + 2) - 0.5) * spread);
                    double tau = (5 + 9 * Hash.fastUnit(sB, id + 3)) / f0;
                    double len = Math.min(Math.ceil(LIFE * sr), Math.ceil(5 * tau * sr));
                    if (at + len <= start || at >= start + n) continue;
                    double sigma = (0.3 + 0.5 * Hash.fastUnit(sB, id + 4)) / tau;
                    double amp = (near ? ampNear * (0.4 + 0.6 * Hash.fastUnit(sB, id + 5)) : ampFar * (0.3 + 0.7 * Hash.fastUnit(sB, id + 5))) * LEVEL;
                    double pan = 0.5 + (near ? 0.7 : 0.95) * (Hash.fastUnit(sB, id + 6) - 0.5);
                    double gl = Math.min(1, 2 * (1 - pan)), gr = Math.min(1, 2 * pan);
                    double from = Math.max(start, at);
                    double to = Math.min(start + n, at + len);
                    for (double j = from; j < to; j++) {
                        double t = (j - at) / sr;
                        double env = (t < 0.0006 ? t / 0.0006 : 1) * Math.exp(-t / tau);
                        double x = Math.sin(Dsp.TWO_PI * f0 * (t + 0.5 * sigma * t * t)) * env * amp;
                        int o = (int) (j - start);
                        L[o] = (float) (L[o] + x * gl);
                        R[o] = (float) (R[o] + x * gr);
                    }
                }
            }
        };
    }
}
