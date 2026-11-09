package com.oursound.app.engine;

import java.util.Map;

/** Box fan, rain, wind and ocean (port of src/engine/ambient.ts). */
final class Ambient {
    private Ambient() {}

    private static final double TWO_PI = Dsp.TWO_PI;

    // ------------------------------------------------------------ box fan

    static Gen.Voice fan(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader speedP = p.get("speed"), toneP = p.get("tone"), wobbleP = p.get("wobble");
        int sL = Hash.seedMix(seed ^ 0x51f1), sR = Hash.seedMix(seed ^ 0x51f2);
        Dsp.Pink pinkL = new Dsp.Pink(), pinkR = new Dsp.Pink();
        Dsp.Brown brownL = new Dsp.Brown(), brownR = new Dsp.Brown();
        Dsp.LowPass lpL = new Dsp.LowPass(), lpR = new Dsp.LowPass(), rumbleL = new Dsp.LowPass(), rumbleR = new Dsp.LowPass();
        return Dsp.stateful(new Dsp.StatefulCore() {
            public void reset() {
                pinkL.reset(); pinkR.reset(); brownL.reset(); brownR.reset();
                lpL.reset(); lpR.reset(); rumbleL.reset(); rumbleR.reset();
            }

            public void run(double start, int n, double sr, float[] L, float[] R) {
                double t0 = start / sr;
                double speed = Dsp.clamp01(speedP.value(t0));
                double tone = Dsp.clamp01(toneP.value(t0));
                double wobble = Dsp.clamp01(wobbleP.value(t0));
                double cutoff = 350 + tone * 2600 + speed * 1400;
                lpL.setCutoff(cutoff, sr);
                lpR.setCutoff(cutoff, sr);
                rumbleL.setCutoff(140, sr);
                rumbleR.setCutoff(140, sr);
                double airGain = 0.55 + 0.6 * speed;
                double rot0 = 14 * t0 + 10 * speedP.integral(t0);
                double rotHz = 14 + 10 * speed;
                for (int i = 0; i < n; i++) {
                    double idx = start + i;
                    double rot = rot0 + (rotHz * i) / sr;
                    double blade = Math.sin(TWO_PI * 3 * rot);
                    double imbalance = Math.sin(TWO_PI * rot);
                    double am = 1 + 0.12 * blade + 0.25 * wobble * imbalance;
                    double wl = Hash.fastSigned(sL, idx), wr = Hash.fastSigned(sR, idx);
                    double airL = lpL.step(pinkL.step(wl)) * airGain * am;
                    double airR = lpR.step(pinkR.step(wr)) * airGain * am;
                    double rl = rumbleL.step(brownL.step(wl)) * 1.6;
                    double rr = rumbleR.step(brownR.step(wr)) * 1.6;
                    double hum = 0.02 * blade + 0.012 * Math.sin(TWO_PI * 6 * rot);
                    L[i] = (float) ((airL + rl + hum) * 1.15);
                    R[i] = (float) ((airR + rr + hum) * 1.15);
                }
            }
        });
    }

    // ------------------------------------------------------------ rain

    private static final int RAIN_SUB = 32;
    private static final int GRAIN_SLOT = 240;
    private static final int GRAIN_MAX = 1536;

    /** Rain as a soft falling sheet: body, roar, sheets and smooth patter (see ambient.ts). */
    static Gen.Voice rain(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader intensityP = p.get("intensity"), sheetsP = p.get("sheets"), brightP = p.get("brightness");
        int sL = Hash.seedMix(seed ^ 0x7a11), sR = Hash.seedMix(seed ^ 0x7a12);
        int sW = seed ^ 0x7a21, sP = seed ^ 0x7a22;
        int gHit = Hash.seedMix(seed ^ 0x3e01), gPos = Hash.seedMix(seed ^ 0x3e02), gLen = Hash.seedMix(seed ^ 0x3e03);
        int gAmp = Hash.seedMix(seed ^ 0x3e04), gPan = Hash.seedMix(seed ^ 0x3e05);
        Dsp.Pink pinkL = new Dsp.Pink(), pinkR = new Dsp.Pink();
        Dsp.LowPass lp1L = new Dsp.LowPass(), lp1R = new Dsp.LowPass(), lp2L = new Dsp.LowPass(), lp2R = new Dsp.LowPass();
        Dsp.LowPass hpL = new Dsp.LowPass(), hpR = new Dsp.LowPass(), roarL = new Dsp.LowPass(), roarR = new Dsp.LowPass();
        Dsp.Brown brownL = new Dsp.Brown(), brownR = new Dsp.Brown();
        return Dsp.stateful(new Dsp.StatefulCore() {
            float[] mL = new float[512], mR = new float[512];

            public void reset() {
                pinkL.reset(); pinkR.reset(); lp1L.reset(); lp1R.reset(); lp2L.reset(); lp2R.reset();
                hpL.reset(); hpR.reset(); brownL.reset(); brownR.reset(); roarL.reset(); roarR.reset();
            }

            public void run(double start, int n, double sr, float[] L, float[] R) {
                double t0 = start / sr;
                double intensity = Dsp.clamp01(intensityP.value(t0));
                double sheets = Dsp.clamp01(sheetsP.value(t0));
                double bright = Dsp.clamp01(brightP.value(t0));
                if (mL.length < n) {
                    mL = new float[n];
                    mR = new float[n];
                }
                java.util.Arrays.fill(mL, 0, n, 0f);
                java.util.Arrays.fill(mR, 0, n, 0f);

                double perSecond = 6 + 60 * intensity;
                double prob = (perSecond * GRAIN_SLOT) / sr;
                double depth = 0.9 * (1 - 0.6 * intensity);
                double firstG = Math.floor((start - GRAIN_MAX) / GRAIN_SLOT);
                double lastG = Math.floor((start + n - 1) / GRAIN_SLOT);
                for (double slot = firstG; slot <= lastG; slot++) {
                    if (Hash.fastUnit(gHit, slot) >= prob) continue;
                    double at = slot * GRAIN_SLOT + Math.floor(Hash.fastUnit(gPos, slot) * GRAIN_SLOT);
                    double len = Math.floor((0.005 + 0.027 * Hash.fastUnit(gLen, slot)) * sr);
                    if (at + len <= start || at >= start + n) continue;
                    double a = Hash.fastUnit(gAmp, slot);
                    double amp = depth * (0.25 + 0.75 * a * a);
                    double pan = Hash.fastUnit(gPan, slot);
                    double gl = Math.min(1, 2 * (1 - pan)) * amp;
                    double gr = Math.min(1, 2 * pan) * amp;
                    double from = Math.max(start, at);
                    double to = Math.min(start + n, at + len);
                    for (double j = from; j < to; j++) {
                        double e = 0.5 - 0.5 * Math.cos((Dsp.TWO_PI * (j - at)) / len);
                        int o = (int) (j - start);
                        mL[o] = (float) (mL[o] + e * gl);
                        mR[o] = (float) (mR[o] + e * gr);
                    }
                }

                hpL.setCutoff(300, sr);
                hpR.setCutoff(300, sr);
                roarL.setCutoff(260 + 300 * intensity, sr);
                roarR.setCutoff(260 + 300 * intensity, sr);
                double body = 0.5 + 1.1 * intensity;
                double roar = 0.06 + 0.4 * intensity * intensity;
                for (int i0 = 0; i0 < n; i0 += RAIN_SUB) {
                    double t = (start + i0) / sr;
                    double c = 0.6 * Dsp.valueNoise(sW, t, 9) + 0.4 * Dsp.valueNoise(sW ^ 0x31, t, 3.7);
                    double sweep = Dsp.valueNoise(sP, t, 13) - 0.5;
                    double lvl = 1 + sheets * (1.6 * c - 0.8);
                    double wl = lvl * (1 - 0.6 * sheets * sweep);
                    double wr = lvl * (1 + 0.6 * sheets * sweep);
                    double fc = (1400 + 4200 * bright) * (0.85 + 0.3 * sheets * c + 0.15 * intensity);
                    lp1L.setCutoff(fc, sr);
                    lp1R.setCutoff(fc, sr);
                    lp2L.setCutoff(fc, sr);
                    lp2R.setCutoff(fc, sr);
                    int m = Math.min(n, i0 + RAIN_SUB);
                    for (int i = i0; i < m; i++) {
                        double idx = start + i;
                        double xl = Hash.fastSigned(sL, idx), xr = Hash.fastSigned(sR, idx);
                        double yl = lp2L.step(lp1L.step(pinkL.step(xl)));
                        double yr = lp2R.step(lp1R.step(pinkR.step(xr)));
                        double bl = (yl - hpL.step(yl)) * body * (1 + mL[i]);
                        double br = (yr - hpR.step(yr)) * body * (1 + mR[i]);
                        L[i] = (float) ((bl + roarL.step(brownL.step(xl)) * roar) * wl);
                        R[i] = (float) ((br + roarR.step(brownR.step(xr)) * roar) * wr);
                    }
                }
            }
        });
    }

    // ------------------------------------------------------------ wind

    static Gen.Voice wind(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader strengthP = p.get("strength"), gustsP = p.get("gusts"), pitchP = p.get("pitch");
        int sL = Hash.seedMix(seed ^ 0x3311), sR = Hash.seedMix(seed ^ 0x3312);
        int sG = seed ^ 0x3313;
        Dsp.Pink pinkL = new Dsp.Pink(), pinkR = new Dsp.Pink();
        Dsp.BandPass bpL = new Dsp.BandPass(), bpR = new Dsp.BandPass(), whL = new Dsp.BandPass(), whR = new Dsp.BandPass();
        final int SUB = 32;
        return Dsp.stateful(new Dsp.StatefulCore() {
            public void reset() {
                pinkL.reset(); pinkR.reset(); bpL.reset(); bpR.reset(); whL.reset(); whR.reset();
            }

            public void run(double start, int n, double sr, float[] L, float[] R) {
                double t0 = start / sr;
                double strength = Dsp.clamp01(strengthP.value(t0));
                double gusts = Dsp.clamp01(gustsP.value(t0));
                double pitch = Dsp.clamp01(pitchP.value(t0));
                for (int i0 = 0; i0 < n; i0 += SUB) {
                    double t = (start + i0) / sr;
                    double g = 0.6 * Dsp.valueNoise(sG, t, 7) + 0.4 * Dsp.valueNoise(sG ^ 0x99, t, 2.3);
                    double gl = 0.5 * Dsp.valueNoise(sG ^ 0x5a, t, 5) + 0.5 * g;
                    double gr = 0.5 * Dsp.valueNoise(sG ^ 0xa5, t, 5) + 0.5 * g;
                    double amp = (0.25 + 0.9 * strength) * (1 - gusts * 0.85 + gusts * 0.85 * g * 1.6);
                    double cL = 180 + pitch * 700 + 900 * gl * (0.3 + gusts);
                    double cR = 180 + pitch * 700 + 900 * gr * (0.3 + gusts);
                    bpL.set(cL, 0.9, sr);
                    bpR.set(cR, 0.9, sr);
                    whL.set(cL * 2.6, 6, sr);
                    whR.set(cR * 2.6, 6, sr);
                    double whistle = 0.5 * gusts * g * g;
                    int m = Math.min(n, i0 + SUB);
                    for (int i = i0; i < m; i++) {
                        double idx = start + i;
                        double xl = pinkL.step(Hash.fastSigned(sL, idx));
                        double xr = pinkR.step(Hash.fastSigned(sR, idx));
                        L[i] = (float) ((bpL.step(xl) * 2.2 + whL.step(xl) * whistle) * amp);
                        R[i] = (float) ((bpR.step(xr) * 2.2 + whR.step(xr) * whistle) * amp);
                    }
                }
            }
        });
    }

    // ------------------------------------------------------------ ocean

    static Gen.Voice ocean(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader periodP = p.get("period"), sizeP = p.get("size"), closeP = p.get("closeness");
        int sL = Hash.seedMix(seed ^ 0x0ce1), sR = Hash.seedMix(seed ^ 0x0ce2);
        int sW = seed ^ 0x0ce3;
        Dsp.Pink pinkL = new Dsp.Pink(), pinkR = new Dsp.Pink();
        Dsp.Brown brownL = new Dsp.Brown(), brownR = new Dsp.Brown();
        Dsp.LowPass lpL = new Dsp.LowPass(), lpR = new Dsp.LowPass();
        final int SUB = 32;
        final double[] w = new double[2]; // amp, bright
        return Dsp.stateful(new Dsp.StatefulCore() {
            void waveAt(double t, double period) {
                double k0 = Math.floor(t / period);
                w[0] = 0;
                w[1] = 0;
                for (double k = k0 - 2; k <= k0; k++) {
                    double start = (k + (Hash.rand01(sW, k) - 0.5) * 0.5) * period;
                    double x = (t - start) / period;
                    if (x < 0 || x > 1.9) continue;
                    double size = 0.55 + 0.45 * Hash.rand01(sW ^ 0x77, k);
                    double crest = 0.42 + 0.1 * Hash.rand01(sW ^ 0x88, k);
                    double e, b;
                    if (x < crest) {
                        double u = x / crest;
                        e = u * u * u;
                        b = u * u * 0.6;
                    } else {
                        double u = x - crest;
                        e = Math.exp(-u * 2.2);
                        b = Math.exp(-u * 5) + 0.15 * Math.exp(-u * 1.5);
                    }
                    w[0] += e * size;
                    w[1] = Math.max(w[1], b * size);
                }
            }

            public void reset() {
                pinkL.reset(); pinkR.reset(); brownL.reset(); brownR.reset(); lpL.reset(); lpR.reset();
            }

            public void run(double start, int n, double sr, float[] L, float[] R) {
                double t0 = start / sr;
                double period = Math.max(4, periodP.value(t0));
                double size = Dsp.clamp01(sizeP.value(t0));
                double close = Dsp.clamp01(closeP.value(t0));
                for (int i0 = 0; i0 < n; i0 += SUB) {
                    double t = (start + i0) / sr;
                    waveAt(t, period);
                    double cutoff = 220 + w[1] * (1800 + 3500 * close);
                    lpL.setCutoff(cutoff, sr);
                    lpR.setCutoff(cutoff, sr);
                    double amp = (0.12 + w[0] * (0.5 + 0.8 * size)) * 1.5;
                    int m = Math.min(n, i0 + SUB);
                    for (int i = i0; i < m; i++) {
                        double idx = start + i;
                        double wl = Hash.fastSigned(sL, idx), wr = Hash.fastSigned(sR, idx);
                        double hl = lpL.step(pinkL.step(wl)), hr = lpR.step(pinkR.step(wr));
                        double rumble = 0.25 + 0.5 * w[0];
                        L[i] = (float) (hl * amp + brownL.step(wl) * 0.18 * rumble);
                        R[i] = (float) (hr * amp + brownR.step(wr) * 0.18 * rumble);
                    }
                }
            }
        });
    }
}
