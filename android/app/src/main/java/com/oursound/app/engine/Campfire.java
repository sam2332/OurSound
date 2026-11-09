package com.oursound.app.engine;

import java.util.Map;

/** Campfire: flame roar, crackles and pops (port of src/engine/campfire.ts; must match it). */
final class Campfire {
    private Campfire() {}

    private static final int CRACKLE_SLOT = 96;
    private static final int CRACKLE_LEN = 96;
    private static final int POP_SLOT = 4800;
    private static final int POP_LEN = 7200;
    private static final int SPARKS = 4;

    private static void click(float[] L, float[] R, double start, int n, double at, double tau, double len, double amp,
                              double crisp, double pan, int noise) {
        double from = Math.max(start, at);
        double to = Math.min(start + n, at + len);
        if (from >= to) return;
        double gl = Math.min(1, 2 * (1 - pan)), gr = Math.min(1, 2 * pan);
        double n1 = Hash.fastSigned(noise, from - 1), n2 = Hash.fastSigned(noise, from - 2);
        for (double j = from; j < to; j++) {
            double k = j - at;
            double n0 = Hash.fastSigned(noise, j);
            double x = crisp * (n0 - n1) * 0.6 + (1 - crisp) * (n0 + n1 + n2) * 0.4;
            double e = amp * (k < 2 ? (k + 1) / 2 : Math.exp(-(k - 2) / tau));
            int o = (int) (j - start);
            L[o] = (float) (L[o] + x * e * gl);
            R[o] = (float) (R[o] + x * e * gr);
            n2 = n1;
            n1 = n0;
        }
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader sizeP = p.get("size"), crackleP = p.get("crackle"), popsP = p.get("pops");
        int sL = Hash.seedMix(seed ^ 0xf1a1), sR = Hash.seedMix(seed ^ 0xf1a2);
        int sF = seed ^ 0xf1a3, sB = seed ^ 0xf1a4;
        int cHit = Hash.seedMix(seed ^ 0xc401), cPos = Hash.seedMix(seed ^ 0xc402), cAmp = Hash.seedMix(seed ^ 0xc403);
        int cTau = Hash.seedMix(seed ^ 0xc404), cPan = Hash.seedMix(seed ^ 0xc405), cNoise = Hash.seedMix(seed ^ 0xc406);
        int pHit = Hash.seedMix(seed ^ 0xb001), pRnd = Hash.seedMix(seed ^ 0xb002), pNoise = Hash.seedMix(seed ^ 0xb003);
        Dsp.Brown brownL = new Dsp.Brown(), brownR = new Dsp.Brown();
        Dsp.Pink pinkL = new Dsp.Pink(), pinkR = new Dsp.Pink();
        Dsp.LowPass lpL = new Dsp.LowPass(), lpR = new Dsp.LowPass(), roarL = new Dsp.LowPass(), roarR = new Dsp.LowPass();
        final int SUB = 32;
        return Dsp.stateful(new Dsp.StatefulCore() {
            public void reset() {
                brownL.reset(); brownR.reset(); pinkL.reset(); pinkR.reset();
                lpL.reset(); lpR.reset(); roarL.reset(); roarR.reset();
            }

            public void run(double start, int n, double sr, float[] L, float[] R) {
                double t0 = start / sr;
                double size = Dsp.clamp01(sizeP.value(t0));
                double crackle = Dsp.clamp01(crackleP.value(t0));
                double pops = Dsp.clamp01(popsP.value(t0));

                roarL.setCutoff(300 + 350 * size, sr);
                roarR.setCutoff(300 + 350 * size, sr);
                lpL.setCutoff(900 + 900 * size, sr);
                lpR.setCutoff(900 + 900 * size, sr);
                for (int i0 = 0; i0 < n; i0 += SUB) {
                    double t = (start + i0) / sr;
                    double flick = 0.55 * Dsp.valueNoise(sF, t, 0.35) + 0.45 * Dsp.valueNoise(sF ^ 0x2b, t, 1.9);
                    double fl = 0.7 * flick + 0.3 * Dsp.valueNoise(sF ^ 0x5c, t, 0.6);
                    double fr = 0.7 * flick + 0.3 * Dsp.valueNoise(sF ^ 0xc5, t, 0.6);
                    double roar = 0.25 + 0.7 * size;
                    double air = 0.08 + 0.2 * size;
                    int m = Math.min(n, i0 + SUB);
                    for (int i = i0; i < m; i++) {
                        double idx = start + i;
                        double wl = Hash.fastSigned(sL, idx), wr = Hash.fastSigned(sR, idx);
                        L[i] = (float) (roarL.step(brownL.step(wl)) * roar * (0.55 + 0.9 * fl) + lpL.step(pinkL.step(wl)) * air * fl);
                        R[i] = (float) (roarR.step(brownR.step(wr)) * roar * (0.55 + 0.9 * fr) + lpR.step(pinkR.step(wr)) * air * fr);
                    }
                }

                double firstC = Math.floor((start - CRACKLE_LEN) / CRACKLE_SLOT);
                double lastC = Math.floor((start + n - 1) / CRACKLE_SLOT);
                for (double slot = firstC; slot <= lastC; slot++) {
                    double ts = (slot * CRACKLE_SLOT) / sr;
                    double b = Dsp.valueNoise(sB, ts, 0.45) * Dsp.valueNoise(sB ^ 0x77, ts, 3.1);
                    double perSecond = crackle * (3 + 260 * b * b * (0.4 + 0.6 * size));
                    if (Hash.fastUnit(cHit, slot) >= (perSecond * CRACKLE_SLOT) / sr) continue;
                    double at = slot * CRACKLE_SLOT + Math.floor(Hash.fastUnit(cPos, slot) * CRACKLE_SLOT);
                    double r = Hash.fastUnit(cAmp, slot);
                    double tau = (0.04 + 0.3 * Hash.fastUnit(cTau, slot)) * (sr / 1000);
                    click(L, R, start, n, at, tau, CRACKLE_LEN, 0.9 * r * r * (0.4 + 0.6 * size), 0.85, Hash.fastUnit(cPan, slot), cNoise);
                }

                double firstP = Math.floor((start - POP_LEN) / POP_SLOT);
                double lastP = Math.floor((start + n - 1) / POP_SLOT);
                double popProb = pops * pops * 0.06;
                for (double slot = firstP; slot <= lastP; slot++) {
                    if (Hash.fastUnit(pHit, slot) >= popProb) continue;
                    double base = slot * 16;
                    double at = slot * POP_SLOT + Math.floor(Hash.fastUnit(pRnd, base) * POP_SLOT);
                    if (at + POP_LEN <= start || at >= start + n) continue;
                    double loud = 0.5 + 0.5 * Hash.fastUnit(pRnd, base + 1);
                    double pan = 0.2 + 0.6 * Hash.fastUnit(pRnd, base + 2);
                    double tau = (1.5 + 3 * Hash.fastUnit(pRnd, base + 3)) * (sr / 1000);
                    click(L, R, start, n, at, tau, Math.ceil(tau * 7), 1.6 * loud, 0.3, pan, pNoise);
                    double sparks = Math.floor(Hash.fastUnit(pRnd, base + 4) * (SPARKS + 1));
                    for (int s = 0; s < sparks; s++) {
                        double r = base + 5 + s * 2;
                        double sAt = at + Math.floor((0.01 + 0.12 * Hash.fastUnit(pRnd, r)) * sr);
                        double sTau = (0.05 + 0.25 * Hash.fastUnit(pRnd, r + 1)) * (sr / 1000);
                        double sPan = Math.min(1, Math.max(0, pan + 0.4 * (Hash.fastUnit(pRnd, r + 1) - 0.5)));
                        click(L, R, start, n, sAt, sTau, CRACKLE_LEN, 0.7 * loud, 0.9, sPan, cNoise);
                    }
                }
            }
        });
    }
}
