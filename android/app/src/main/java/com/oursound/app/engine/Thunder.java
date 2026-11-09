package com.oursound.app.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Procedural thunder with strike types, bursts and movement (port of src/engine/thunder.ts). */
public final class Thunder {
    private Thunder() {}

    public static final double SLOT = 6;
    private static final double MAX_LEN = 46, TAIL = 6;
    static final int LOOKBACK = (int) Math.ceil((MAX_LEN + TAIL + 2) / SLOT) + 1;
    private static final double ACTIVITY_PERIOD = 240;
    private static final int SUB = 32;

    public static final int BOOM = 0, FLICKER = 1, RUMBLE = 2, GROWL = 3, SKYROLL = 4;

    static final class Roll {
        double at, attack, decay, amp;

        Roll(double at, double attack, double decay, double amp) {
            this.at = at; this.attack = attack; this.decay = decay; this.amp = amp;
        }
    }

    static final class Crack {
        double at, amp, decay;

        Crack(double at, double amp, double decay) {
            this.at = at; this.amp = amp; this.decay = decay;
        }
    }

    public static final class Strike {
        public double slot;
        public int type;
        public double start, dur, near, cutoff, width, thump, panFrom, panTo, grumbleRate, grumbleDepth, level;
        public int grumbleSeed;
        Roll[] rolls;
        Crack[] cracks;
    }

    public static double stormActivity(int seed, double t, double variety) {
        double cell = Dsp.valueNoise(seed ^ 0xac71, t, ACTIVITY_PERIOD * 4);
        double burst = Dsp.valueNoise(seed ^ 0x3c19, t, ACTIVITY_PERIOD);
        double v = 0.45 * cell + 0.55 * burst;
        double bursty = 0.3 + 4.07 * v * v * v;
        return 1 + (bursty - 1) * Dsp.clamp01(variety);
    }

    private static int pickType(double r, double near, double variety) {
        double far = 1 - near;
        double[] base = {near * near * 2, near * 0.9, 1, far * far * 2, 0.3 + 0.5 * far};
        double sharp = 1 + 3 * (1 - Dsp.clamp01(variety));
        double[] w = new double[5];
        double total = 0;
        for (int i = 0; i < 5; i++) {
            w[i] = Math.pow(base[i] + 1e-3, sharp);
            total += w[i];
        }
        double acc = 0;
        for (int i = 0; i < 5; i++) {
            acc += w[i] / total;
            if (r < acc) return i;
        }
        return RUMBLE;
    }

    private static double between(double r, double a, double b) {
        return a + (b - a) * r;
    }

    private static int hashSeed(int seed, double slot) {
        return (int) Math.floor(Hash.rand01(seed ^ 0x51ed27, slot) * 2147483648.0);
    }

    /** The strike in `slot`, or null. Pure function of its arguments. */
    public static Strike strikeFor(int seed, double slot, double perHour, double distance, double variety) {
        double tMid = (slot + 0.5) * SLOT;
        double p = Math.min(0.95, ((perHour * SLOT) / 3600) * stormActivity(seed, tMid, variety));
        if (Hash.rand01(seed, slot) >= p) return null;
        final int[] k = {0};
        java.util.function.DoubleSupplier r = () -> Hash.rand01(seed ^ (0x9e3779b1 * (++k[0])), slot);

        double near = Dsp.clamp01(1 - distance + (r.getAsDouble() - 0.5) * (0.2 + 0.6 * variety));
        int type = pickType(r.getAsDouble(), near, variety);
        double start = slot * SLOT + r.getAsDouble() * (SLOT - 0.5);
        double delay = (1 - near) * 0.6;
        double pan0 = (r.getAsDouble() - 0.5) * 1.2;
        List<Roll> rolls = new ArrayList<>();
        List<Crack> cracks = new ArrayList<>();
        double dur, cutoff, thump = 0, panTo = pan0, width, grumbleRate, grumbleDepth, level = 1;

        Strike s = new Strike();
        s.slot = slot;
        s.type = type;
        s.start = start;
        s.near = near;
        switch (type) {
            case BOOM: {
                dur = between(r.getAsDouble(), 6, 14);
                cracks.add(new Crack(0, 0.35 + 0.65 * near, between(r.getAsDouble(), 0.05, 0.13)));
                thump = 0.5 + 0.5 * near;
                rolls.add(new Roll(0.03, between(r.getAsDouble(), 0.06, 0.2), between(r.getAsDouble(), 1, 2.5), 1));
                int extra = 1 + (int) Math.floor(r.getAsDouble() * 3);
                for (int i = 0; i < extra; i++) {
                    double at = between(r.getAsDouble(), 0.5, dur * 0.5);
                    double attack = between(r.getAsDouble(), 0.2, 0.7);
                    double decay = between(r.getAsDouble(), 1.5, 3.5);
                    double amp = between(r.getAsDouble(), 0.3, 0.7);
                    rolls.add(new Roll(at, attack, decay, amp));
                }
                cutoff = 320 + 900 * near;
                width = 0.8;
                panTo = pan0 + (r.getAsDouble() - 0.5) * 0.3;
                grumbleRate = between(r.getAsDouble(), 7, 14);
                grumbleDepth = 0.35;
                break;
            }
            case FLICKER: {
                dur = between(r.getAsDouble(), 6, 12);
                int strokes = 2 + (int) Math.floor(r.getAsDouble() * 3);
                double at = 0;
                for (int i = 0; i < strokes; i++) {
                    double camp = (0.3 + 0.6 * near) * between(r.getAsDouble(), 0.6, 1);
                    double cdecay = between(r.getAsDouble(), 0.04, 0.09);
                    cracks.add(new Crack(at, camp, cdecay));
                    double attack = between(r.getAsDouble(), 0.05, 0.15);
                    double decay = between(r.getAsDouble(), 0.6, 1.5);
                    double amp = between(r.getAsDouble(), 0.5, 0.9);
                    rolls.add(new Roll(at + 0.02, attack, decay, amp));
                    at += between(r.getAsDouble(), 0.15, 0.55);
                }
                double attack = between(r.getAsDouble(), 0.3, 0.8);
                double decay = between(r.getAsDouble(), 2, 4);
                rolls.add(new Roll(at + 0.1, attack, decay, 0.8));
                thump = 0.45 * near;
                cutoff = 360 + 800 * near;
                width = 0.85;
                panTo = pan0 + (r.getAsDouble() - 0.5) * 0.5;
                grumbleRate = between(r.getAsDouble(), 8, 15);
                grumbleDepth = 0.3;
                break;
            }
            case RUMBLE: {
                dur = between(r.getAsDouble(), 10, 24);
                int n = 4 + (int) Math.floor(r.getAsDouble() * 5);
                for (int i = 0; i < n; i++) {
                    double at = i == 0 ? 0 : r.getAsDouble() * dur * 0.7;
                    double attack = between(r.getAsDouble(), 0.3, 1.2);
                    double decay = between(r.getAsDouble(), 1.5, 4);
                    double amp = i == 0 ? 1 : between(r.getAsDouble(), 0.35, 0.9);
                    rolls.add(new Roll(at, attack, decay, amp));
                }
                if (near > 0.6) cracks.add(new Crack(0, 0.4 * near, 0.06));
                thump = 0.3 * near * near;
                cutoff = 160 + 620 * near;
                width = 0.9;
                double dir = r.getAsDouble() < 0.5 ? -1 : 1;
                panTo = pan0 + dir * between(r.getAsDouble(), 0.3, 0.8);
                grumbleRate = between(r.getAsDouble(), 4, 10);
                grumbleDepth = 0.5;
                break;
            }
            case GROWL: {
                dur = between(r.getAsDouble(), 8, 20);
                int n = 3 + (int) Math.floor(r.getAsDouble() * 3);
                for (int i = 0; i < n; i++) {
                    double at = r.getAsDouble() * dur * 0.6;
                    double attack = between(r.getAsDouble(), 1, 2.5);
                    double decay = between(r.getAsDouble(), 2, 5);
                    double amp = between(r.getAsDouble(), 0.4, 0.85);
                    rolls.add(new Roll(at, attack, decay, amp));
                }
                cutoff = 70 + 180 * near;
                width = 0.55;
                panTo = pan0 + (r.getAsDouble() - 0.5) * 0.4;
                grumbleRate = between(r.getAsDouble(), 3, 7);
                grumbleDepth = 0.45;
                level = 0.8;
                break;
            }
            default: { // skyroll
                dur = between(r.getAsDouble(), 28, 45);
                int n = 7 + (int) Math.floor(r.getAsDouble() * 5);
                for (int i = 0; i < n; i++) {
                    double at = ((double) i / n) * dur * 0.85 + r.getAsDouble() * 2;
                    double attack = between(r.getAsDouble(), 0.6, 2);
                    double decay = between(r.getAsDouble(), 2, 5);
                    double amp = between(r.getAsDouble(), 0.3, 0.8);
                    rolls.add(new Roll(at, attack, decay, amp));
                }
                s.cutoff = 120 + 420 * near;
                s.width = 1;
                double side = r.getAsDouble() < 0.5 ? -1 : 1;
                s.panTo = -side * 0.8;
                s.grumbleRate = between(r.getAsDouble(), 5, 12);
                s.grumbleDepth = 0.55;
                s.dur = dur;
                s.thump = 0;
                s.panFrom = side * 0.8;
                s.grumbleSeed = hashSeed(seed, slot);
                s.level = 0.9;
                for (Roll x : rolls) x.at += delay;
                s.rolls = rolls.toArray(new Roll[0]);
                s.cracks = cracks.toArray(new Crack[0]);
                return s;
            }
        }
        level *= 1 - 0.4 * Dsp.clamp01(variety) * r.getAsDouble();
        for (Roll x : rolls) x.at += delay;
        for (Crack x : cracks) x.at += delay * 0.2;
        s.dur = dur;
        s.cutoff = cutoff;
        s.width = width;
        s.rolls = rolls.toArray(new Roll[0]);
        s.cracks = cracks.toArray(new Crack[0]);
        s.thump = thump;
        s.panFrom = pan0;
        s.panTo = panTo;
        s.grumbleRate = grumbleRate;
        s.grumbleDepth = grumbleDepth;
        s.grumbleSeed = hashSeed(seed, slot);
        s.level = level;
        return s;
    }

    static double rumbleEnvelope(Strike s, double t) {
        double x = t - s.start;
        if (x < 0 || x > s.dur + TAIL) return 0;
        double e = 0;
        for (Roll r : s.rolls) {
            double u = x - r.at;
            if (u <= 0) continue;
            double a = u < r.attack ? 0.5 - 0.5 * Math.cos((Math.PI * u) / r.attack) : 1;
            double d = u < r.attack ? 1 : Math.exp(-(u - r.attack) / r.decay);
            e += r.amp * a * d;
        }
        if (e == 0) return 0;
        double g = Dsp.valueNoise(s.grumbleSeed, x, 1 / s.grumbleRate);
        double grumble = 1 - s.grumbleDepth + s.grumbleDepth * 2.2 * g * g;
        double tail = x > s.dur ? Math.max(0, 1 - (x - s.dur) / TAIL) : 1;
        double norm = Math.sqrt(Math.max(1, s.rolls.length / 2.0));
        return (e / norm) * grumble * tail * s.level;
    }

    static double crackEnvelope(Strike s, double t) {
        double e = 0;
        for (Crack c : s.cracks) {
            double x = t - s.start - c.at;
            if (x < 0 || x > c.decay * 9) continue;
            double a = x < 0.002 ? x / 0.002 : 1;
            double rip = 0.55 + 0.45 * Dsp.valueNoise(s.grumbleSeed ^ 0x77, x, 1.0 / 70);
            e += c.amp * a * Math.exp(-x / c.decay) * rip;
        }
        return e * s.level;
    }

    static double thumpAt(Strike s, double t) {
        if (s.thump == 0) return 0;
        double x = t - s.start - 0.02;
        if (x < 0 || x > 1.6) return 0;
        double env = x < 0.012 ? x / 0.012 : Math.exp(-(x - 0.012) / 0.32);
        double phase = 36 * x + 24 * 0.12 * (1 - Math.exp(-x / 0.12));
        return Math.sin(Dsp.TWO_PI * phase) * env * s.thump * s.level;
    }

    private static double strikeEnd(Strike s) {
        return s.start + s.dur + TAIL;
    }

    private static final class StrikeState {
        final Dsp.LowPass l1 = new Dsp.LowPass(), l2 = new Dsp.LowPass(), r1 = new Dsp.LowPass(), r2 = new Dsp.LowPass();
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        Gen.ParamReader rateP = p.get("rate"), distP = p.get("distance"), intP = p.get("intensity"), varP = p.get("variety");
        final int sEv = seed ^ 0x7d3a;
        final int sL = Hash.seedMix(seed ^ 0x6b1), sR = Hash.seedMix(seed ^ 0x6b2);
        final Dsp.Brown brownL = new Dsp.Brown(), brownR = new Dsp.Brown();
        final Strike[] strikes = new Strike[LOOKBACK];
        final Map<Double, StrikeState> states = new HashMap<>();
        final double[] envA = new double[LOOKBACK], envB = new double[LOOKBACK];
        final double[] crA = new double[LOOKBACK], crB = new double[LOOKBACK];
        final double[] panL = new double[LOOKBACK], panR = new double[LOOKBACK];

        return Dsp.stateful(new Dsp.StatefulCore() {
            double lastSlot = Double.NaN, lastRate = Double.NaN, lastDistance = Double.NaN, lastVariety = Double.NaN;
            double prevWl = 0;

            StrikeState stateFor(Strike s, double sr) {
                StrikeState st = states.get(s.slot);
                if (st == null) {
                    st = new StrikeState();
                    st.l1.setCutoff(s.cutoff, sr);
                    st.r1.setCutoff(s.cutoff, sr);
                    st.l2.setCutoff(s.cutoff * 1.4, sr);
                    st.r2.setCutoff(s.cutoff * 1.4, sr);
                    states.put(s.slot, st);
                }
                return st;
            }

            public void reset() {
                brownL.reset();
                brownR.reset();
                states.clear();
                prevWl = 0;
            }

            public void run(double start, int n, double sr, float[] L, float[] R) {
                double t0 = start / sr;
                double t1 = (start + n) / sr;
                double rate = Math.max(0, rateP.value(t0));
                double distance = Dsp.clamp01(distP.value(t0));
                double intensity = Dsp.clamp01(intP.value(t0));
                double variety = Dsp.clamp01(varP.value(t0));
                double slot = Math.floor(t0 / SLOT);
                if (slot != lastSlot || Math.abs(rate - lastRate) > 0.01 || Math.abs(distance - lastDistance) > 0.01
                        || Math.abs(variety - lastVariety) > 0.01 || Double.isNaN(lastSlot)) {
                    for (int k = 0; k < LOOKBACK; k++) strikes[k] = strikeFor(sEv, slot - k, rate, distance, variety);
                    lastSlot = slot;
                    lastRate = rate;
                    lastDistance = distance;
                    lastVariety = variety;
                }
                boolean any = false;
                for (int k = 0; k < LOOKBACK; k++) {
                    Strike s = strikes[k];
                    if (s != null && s.start <= t1 && strikeEnd(s) >= t0) any = true;
                    else if (s != null) states.remove(s.slot);
                }
                if (!any) {
                    brownL.reset();
                    brownR.reset();
                    states.clear();
                    java.util.Arrays.fill(L, 0, n, 0f);
                    java.util.Arrays.fill(R, 0, n, 0f);
                    return;
                }
                double gain = 3.6 * (0.35 + 0.65 * intensity);
                for (int i0 = 0; i0 < n; i0 += SUB) {
                    int m = Math.min(n, i0 + SUB);
                    double ta = (start + i0) / sr;
                    double tb = (start + m) / sr;
                    for (int k = 0; k < LOOKBACK; k++) {
                        Strike s = strikes[k];
                        if (s == null || s.start > tb || strikeEnd(s) < ta) {
                            envA[k] = envB[k] = crA[k] = crB[k] = 0;
                            continue;
                        }
                        envA[k] = rumbleEnvelope(s, ta);
                        envB[k] = rumbleEnvelope(s, tb);
                        crA[k] = crackEnvelope(s, ta);
                        crB[k] = crackEnvelope(s, tb);
                        double u = Dsp.clamp01((0.5 * (ta + tb) - s.start) / (s.dur + TAIL));
                        double pan = Math.max(-1, Math.min(1, s.panFrom + (s.panTo - s.panFrom) * (u * u * (3 - 2 * u))));
                        panL[k] = Math.min(1, 1 - pan);
                        panR[k] = Math.min(1, 1 + pan);
                    }
                    for (int i = i0; i < m; i++) {
                        double idx = start + i;
                        double wl = Hash.fastSigned(sL, idx), wr = Hash.fastSigned(sR, idx);
                        double bl = brownL.step(wl), br = brownR.step(wr);
                        double crackNoise = (wl - prevWl) * 0.7;
                        prevWl = wl;
                        double f = (double) (i - i0) / (m - i0);
                        double t = idx / sr;
                        double l = 0, r = 0;
                        for (int k = 0; k < LOOKBACK; k++) {
                            Strike s = strikes[k];
                            if (s == null) continue;
                            double e = envA[k] + (envB[k] - envA[k]) * f;
                            double c = crA[k] + (crB[k] - crA[k]) * f;
                            double th = thumpAt(s, t);
                            if (e == 0 && c == 0 && th == 0) continue;
                            StrikeState st = stateFor(s, sr);
                            double nl = st.l2.step(st.l1.step(bl));
                            double nr = st.r2.step(st.r1.step(br));
                            double a = 0.5 + 0.5 * s.width, b = 0.5 - 0.5 * s.width;
                            double ml = (nl * a + nr * b) * e * gain + crackNoise * c + th * 0.5;
                            double mr = (nr * a + nl * b) * e * gain + crackNoise * c + th * 0.5;
                            l += ml * panL[k];
                            r += mr * panR[k];
                        }
                        L[i] = (float) l;
                        R[i] = (float) r;
                    }
                }
            }
        });
    }
}
