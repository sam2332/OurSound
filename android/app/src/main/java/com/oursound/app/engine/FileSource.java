package com.oursound.app.engine;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Plays an imported audio file as a segment (port of src/engine/file-source.ts):
 * tempo (speed) and pitch independently via aligned overlapping grains (WSOLA),
 * a tone tilt, trim start (offset), and seamless looping with a crossfade.
 */
final class FileSource {
    private FileSource() {}

    private static final double HOP = 0.04;
    private static final double ALIGN_SEARCH = 0.012;
    private static final int ALIGN_DEPTH = 6;

    /** Catmull-Rom reader across chunks. */
    private static final class FrameReader {
        final AssetStore.Meta meta;
        final int chunkFrames;
        int cachedIdx = -1;
        float[] cL, cR;

        FrameReader(AssetStore.Meta meta) {
            this.meta = meta;
            this.chunkFrames = meta.chunkFrames();
        }

        double frame(long i, boolean right) {
            if (i < 0) return 0;
            int idx = (int) (i / chunkFrames);
            if (idx != cachedIdx) {
                AssetStore.Chunk c = AssetStore.INSTANCE.get(meta.id, idx);
                cachedIdx = c != null ? idx : -1;
                cL = c != null ? c.L : null;
                cR = c != null ? c.R : null;
                if (c == null) return 0;
            }
            float[] a = right ? cR : cL;
            if (a == null) return 0;
            int o = (int) (i - (long) idx * chunkFrames);
            return o < a.length ? a[o] : 0;
        }

        double raw(long i, boolean right) {
            return frame(i, right);
        }

        double at(double pos, boolean right) {
            long i = (long) Math.floor(pos);
            double f = pos - i;
            double y0 = frame(i - 1, right), y1 = frame(i, right), y2 = frame(i + 1, right), y3 = frame(i + 2, right);
            return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
        }
    }

    static Gen.Voice create(Map<String, Gen.ParamReader> p, int seed, Model.Segment seg) {
        final Gen.ParamReader speedP = p.get("speed"), pitchP = p.get("pitch"), toneP = p.get("tone");
        final Gen.ParamReader loopP = p.get("loop"), xfadeP = p.get("xfade"), offsetP = p.get("offset");
        final String id = seg != null && seg.assetId != null ? seg.assetId : "";
        return new Gen.Voice() {
            FrameReader reader;
            AssetStore.Meta readerFor;
            final Dsp.Tilt tiltL = new Dsp.Tilt(), tiltR = new Dsp.Tilt();
            double nextIndex = Double.NaN;
            double gk = Double.NaN, gS0 = 0, gS1 = 0;
            final LinkedHashMap<Double, Double> aligned = new LinkedHashMap<>();
            double sl, srr;
            // per-block state used by sampleAt / alignedStart
            boolean loop, stereo;
            double offset, period, xf, fsr, ratio;
            AssetStore.Meta meta;

            void sampleAt(double raw) {
                sl = 0;
                srr = 0;
                if (raw < 0) return;
                FrameReader rd = reader;
                if (!loop) {
                    double s = offset + raw;
                    if (s < meta.duration) {
                        double f = s * fsr;
                        sl = rd.at(f, false);
                        srr = stereo ? rd.at(f, true) : sl;
                    }
                } else if (period > 0) {
                    double u = raw - Math.floor(raw / period) * period;
                    double f = (offset + u) * fsr;
                    double l = rd.at(f, false);
                    double r = stereo ? rd.at(f, true) : l;
                    if (u < xf && raw >= period) {
                        double w = u / xf;
                        double a = Math.sin((Math.PI / 2) * w), b = Math.cos((Math.PI / 2) * w);
                        double ft = (offset + period + u) * fsr;
                        double tl = rd.at(ft, false);
                        double tr = stereo ? rd.at(ft, true) : tl;
                        l = l * a + tl * b;
                        r = r * a + tr * b;
                    }
                    sl = l;
                    srr = r;
                }
            }

            double nominal(double k) {
                return speedP.integral(k * HOP);
            }

            double alignedStart(double k, int depth) {
                Double hit = aligned.get(k);
                if (hit != null) return hit;
                double nom = nominal(k);
                if (k <= 0 || depth >= ALIGN_DEPTH) return nom;
                double prev = alignedStart(k - 1, depth + 1);
                double ref = prev + HOP * ratio;
                double step = 3 / fsr;
                double dj = (6 / fsr) * ratio;
                int nPts = (int) Math.max(8, Math.floor((HOP * ratio) / dj));
                double best = nom, bestScore = Double.NEGATIVE_INFINITY;
                FrameReader rd = reader;
                for (double lag = -ALIGN_SEARCH; lag <= ALIGN_SEARCH; lag += step) {
                    double c = nom + lag;
                    if (c < 0) continue;
                    double xy = 0, yy = 1e-9;
                    for (int j = 0; j < nPts; j++) {
                        long ia = Math.round((offset + ref + j * dj) * fsr);
                        long ib = Math.round((offset + c + j * dj) * fsr);
                        double al = rd.raw(ia, false), bl = rd.raw(ib, false);
                        xy += al * bl;
                        yy += bl * bl;
                        if (stereo) {
                            double ar = rd.raw(ia, true), br = rd.raw(ib, true);
                            xy += ar * br;
                            yy += br * br;
                        }
                    }
                    double score = xy / Math.sqrt(yy);
                    if (score > bestScore) {
                        bestScore = score;
                        best = c;
                    }
                }
                aligned.put(k, best);
                if (aligned.size() > 16) {
                    Iterator<Double> it = aligned.keySet().iterator();
                    it.next();
                    it.remove();
                }
                return best;
            }

            @Override
            public void render(double t0, int n, double sr, float[] L, float[] R) {
                meta = AssetStore.INSTANCE.metas.get(id);
                if (meta == null) {
                    java.util.Arrays.fill(L, 0, n, 0f);
                    java.util.Arrays.fill(R, 0, n, 0f);
                    return;
                }
                if (meta != readerFor) {
                    reader = new FrameReader(meta);
                    readerFor = meta;
                }
                double speed = Math.max(0.05, speedP.value(t0));
                ratio = Math.pow(2, Math.max(-24, Math.min(24, pitchP.value(t0))) / 12);
                double tone = Math.max(-1, Math.min(1, toneP.value(t0)));
                loop = loopP.value(t0) >= 0.5;
                offset = Math.max(0, Math.min(meta.duration - 0.1, offsetP.value(t0)));
                double span = meta.duration - offset;
                xf = Math.min(Math.max(0.01, xfadeP.value(t0)), span / 4);
                period = span - xf;
                fsr = meta.sampleRate;
                stereo = meta.channels > 1;
                int chunkFrames = meta.chunkFrames();

                double startIdx = Math.round(t0 * sr);
                if (startIdx != nextIndex) {
                    tiltL.reset();
                    tiltR.reset();
                    tiltL.set(sr);
                    tiltR.set(sr);
                }
                nextIndex = startIdx + n;

                boolean exact = Math.abs(speed - 1) < 1e-9 && Math.abs(ratio - 1) < 1e-9;
                if (exact) aligned.clear();

                for (int i = 0; i < n; i++) {
                    double t = t0 + i / sr;
                    double k = Math.floor(t / HOP);
                    if (k != gk) {
                        gS0 = exact ? nominal(k) : alignedStart(k, 0);
                        gS1 = k >= 1 ? (exact ? nominal(k - 1) : alignedStart(k - 1, 0)) : 0;
                        gk = k;
                    }
                    double l = 0, r = 0;
                    {
                        double d = t - k * HOP;
                        double w = 0.5 - 0.5 * Math.cos(Math.PI * (d / HOP));
                        sampleAt(gS0 + d * ratio);
                        l += w * sl;
                        r += w * srr;
                    }
                    if (k >= 1) {
                        double d = t - (k - 1) * HOP;
                        double w = 0.5 - 0.5 * Math.cos(Math.PI * (d / HOP));
                        sampleAt(gS1 + d * ratio);
                        l += w * sl;
                        r += w * srr;
                    }
                    L[i] = (float) tiltL.step(l, tone);
                    R[i] = (float) tiltR.step(r, tone);
                }

                double endRaw = speedP.integral(t0 + n / sr);
                for (int k = 1; k <= AssetStore.LOOKAHEAD; k++) {
                    double ahead = endRaw + k * (chunkFrames / fsr) * Math.min(1, speed);
                    double s = loop && period > 0 ? offset + (ahead - Math.floor(ahead / period) * period) : offset + ahead;
                    if (s < meta.duration) AssetStore.INSTANCE.request(id, (int) Math.floor((s * fsr) / chunkFrames));
                }
                if (loop) AssetStore.INSTANCE.request(id, (int) Math.floor((offset * fsr) / chunkFrames));
            }
        };
    }
}
