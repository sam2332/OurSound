package com.oursound.app.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * The OurSound engine, native edition (port of src/engine/core.ts): renders a
 * Timeline block by block from the current position, computing every sample
 * from (time, settings, seed). Not thread-safe: callers synchronize.
 */
public final class Engine {
    public static final double ABSOLUTE_MAX_CAP_DB = -1;
    public static final double DEFAULT_CAP_DB = -12;
    private static final double PLAY_FADE_IN = 3, PAUSE_FADE_OUT = 0.4, SEEK_FADE = 0.03;
    private static final double WAKE_RISE_DB = 9, WAKE_SECONDS = 15 * 60;

    public static double dbToGain(double db) {
        return Math.pow(10, db / 20);
    }

    static double gainToDb(double g) {
        return 20 * Math.log10(Math.max(g, 1e-12));
    }

    // ------------------------------------------------------------ compiled form

    private static final class LaneParam {
        final Curve curve;
        final boolean span;

        LaneParam(Model.Lane l) {
            curve = new Curve(l.points);
            span = l.span;
        }
    }

    private static final class CSeg {
        Model.Segment seg;
        Map<String, LaneParam> lanes = new HashMap<>();
        LaneParam gain;
        double end;
        Gen.Def def;
    }

    private static final class CTrack {
        Model.Soundtrack track;
        Curve gainAuto, panAuto;
        double panL, panR;
        boolean lead, follow, fill;
        List<CSeg> segments = new ArrayList<>();
    }

    // Focus mix: how the background follows the lead's loudness.
    private static final double DUCK_ATTACK = 0.4, DUCK_RELEASE = 2.5, DUCK_FLOOR_DB = -50, DUCK_RANGE_DB = 24;
    private double duckPow = 0, duckDb = 0;
    // "Fill the quiet": tracks that come in when the music drops well below its recent level.
    private static final double FILL_AVG_UP = 20, FILL_AVG_DOWN = 90, FILL_FROM_DB = 6, FILL_RANGE_DB = 8, FILL_DEPTH_DB = 40;
    private static final double FILL_SHORT = 0.6, FILL_IN = 3, FILL_OUT = 0.5;
    private double avgPow = 0, shortPow = 0, fillDb = 0;

    /** Follows the lead's loudness and sets how far the background dips. */
    private void updateDuck(double leadPow, int n) {
        if (timeline == null || timeline.focusLead == null) {
            duckPow = 0;
            duckDb = 0;
            avgPow = 0;
            shortPow = 0;
            fillDb = 0;
            return;
        }
        double time = leadPow > duckPow ? DUCK_ATTACK : DUCK_RELEASE;
        duckPow += (leadPow - duckPow) * (1 - Math.exp(-n / (sr * time)));
        double level = 10 * Math.log10(duckPow + 1e-12);
        double amount = Math.min(1, Math.max(0, (level - DUCK_FLOOR_DB) / DUCK_RANGE_DB));
        duckDb = -timeline.focusDuckDb * amount;
        double avgTime = leadPow > avgPow ? FILL_AVG_UP : FILL_AVG_DOWN;
        avgPow += (leadPow - avgPow) * (1 - Math.exp(-n / (sr * avgTime)));
        shortPow += (leadPow - shortPow) * (1 - Math.exp(-n / (sr * FILL_SHORT)));
        double avg = 10 * Math.log10(avgPow + 1e-12);
        double now = 10 * Math.log10(shortPow + 1e-12);
        double quiet = now < DUCK_FLOOR_DB ? 1 : Math.min(1, Math.max(0, (avg - now - FILL_FROM_DB) / FILL_RANGE_DB));
        double target = -FILL_DEPTH_DB * (1 - quiet);
        double fillTime = target > fillDb ? FILL_IN : FILL_OUT;
        fillDb += (target - fillDb) * (1 - Math.exp(-n / (sr * fillTime)));
    }

    private static double segmentEnd(Model.Segment s) {
        Model.Repeat r = s.repeat;
        if (r.mode == Model.REPEAT_NONE) return s.start + s.length;
        if (r.count != null) {
            double gap = r.mode == Model.REPEAT_INTERVAL ? r.every : r.maxGap;
            return s.start + (r.count - 1) * gap + s.length + 1;
        }
        if (r.until != null) return r.until + s.length + (r.mode == Model.REPEAT_RANDOM ? r.maxGap : 0);
        return Double.POSITIVE_INFINITY;
    }

    private static List<CTrack> compile(Model.Timeline tl) {
        List<CTrack> out = new ArrayList<>();
        for (Model.Soundtrack t : tl.soundtracks) {
            CTrack ct = new CTrack();
            ct.track = t;
            for (Model.Lane l : t.automation)
                if (l.points.length > 0 && "gain".equals(l.param)) ct.gainAuto = new Curve(l.points);
                else if (l.points.length > 0 && "pan".equals(l.param)) ct.panAuto = new Curve(l.points);
            double pan = Math.max(-1, Math.min(1, t.pan));
            ct.panL = Math.min(1, 1 - pan);
            ct.panR = Math.min(1, 1 + pan);
            for (Model.Segment s : t.segments) {
                Gen.Def def = Gen.REGISTRY.get(s.generator);
                if (def == null) continue; // unknown generator: skipped, never fatal
                CSeg cs = new CSeg();
                cs.seg = s;
                cs.def = def;
                for (Model.Lane l : s.automation) {
                    if (l.points.length == 0) continue;
                    LaneParam lp = new LaneParam(l);
                    if ("gain".equals(l.param)) cs.gain = lp;
                    else cs.lanes.put(l.param, lp);
                }
                cs.end = segmentEnd(s);
                ct.segments.add(cs);
            }
            out.add(ct);
        }
        return out;
    }

    // ------------------------------------------------------------ voices

    private static final class LiveVoice {
        Gen.Voice voice;
        CSeg seg;
        long lastBlock;
    }

    private static Gen.ParamReader reader(CSeg cs, String name, double instStart) {
        LaneParam lane = cs.lanes.get(name);
        Double v = cs.seg.params.get(name);
        final double fallback = v != null ? v : cs.def.defaultFor(name);
        if (lane == null) {
            return new Gen.ParamReader() {
                public double value(double t) {
                    return fallback;
                }

                public double integral(double t) {
                    return fallback * t;
                }
            };
        }
        final Curve c = lane.curve;
        final double offset = lane.span ? instStart - cs.seg.start : 0;
        final double base = c.integral(offset);
        return new Gen.ParamReader() {
            public double value(double t) {
                return c.value(t + offset);
            }

            public double integral(double t) {
                return c.integral(t + offset) - base;
            }
        };
    }

    private static Gen.Voice createVoice(CSeg cs, double k, double instStart) {
        Map<String, Gen.ParamReader> readers = new HashMap<>();
        for (String name : cs.def.names) readers.put(name, reader(cs, name, instStart));
        return cs.def.factory.create(readers, Hash.childSeed(cs.seg.seed, k), cs.seg);
    }

    // ------------------------------------------------------------ state

    private static final int STOPPED = 0, PLAYING = 1, PAUSING = 2;

    public final double sr;
    private Model.Timeline timeline;
    private List<CTrack> tracks = new ArrayList<>();
    private final Map<String, LiveVoice> voices = new HashMap<>();
    private double pos = 0;
    private int transport = STOPPED;
    private boolean ended = false;
    private long blockCount = 0;
    private double masterGain = 1;
    private final Limiter limiter;
    private double env = 0, envTarget = 0, envStep = 0;
    private Double pendingSeek = null;
    private Double sleepRemaining = null;
    private double sleepFade = 60;
    private String stoppedBy = null;

    private final float[] vL, vR, tL, tR, gainBuf;
    private final Repeat.Instances instA = new Repeat.Instances(), instB = new Repeat.Instances(), instP = new Repeat.Instances();
    /** How far ahead (s) upcoming audio-file plays get their first chunks decoded. */
    private static final double[] PREFETCH_LEADS = {0.5, 4, 12};

    /**
     * Asks for the opening chunks of imported audio that starts soon (the next
     * album track, a repeat), so it's decoded before it plays instead of
     * starting with a gap. Playing sources keep their own look-ahead.
     */
    private void prefetchFiles(double t0) {
        prefetchFiles(t0, PREFETCH_LEADS, false);
    }

    private static final double[] NOW = {0};

    /** Asks for the audio needed to play from `t` right away (playing sources included), first in line. */
    public void prefetchNow(double t) {
        if (timeline != null) prefetchFiles(t, NOW, true);
    }

    /** True when every imported file sounding at `t` has its audio decoded. */
    public boolean filesReadyAt(double t) {
        if (timeline == null) return true;
        for (CTrack ct : tracks) {
            if (ct.track.mute) continue;
            for (CSeg cs : ct.segments) {
                Model.Segment seg = cs.seg;
                if (!"file".equals(seg.generator) || seg.assetId == null || t < seg.start || t >= cs.end) continue;
                AssetStore.Meta m = AssetStore.INSTANCE.metas.get(seg.assetId);
                if (m == null) continue;
                Repeat.activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t, instP);
                for (int i = 0; i < instP.count; i++) {
                    int idx = chunkAt(seg, m, t - instP.start[i]);
                    if (idx < m.chunkCount() && !AssetStore.INSTANCE.has(m.id, idx)) return false;
                }
            }
        }
        return true;
    }

    /** Chunk a file segment reads `local` seconds into a play (ignores automation and looping). */
    private static int chunkAt(Model.Segment seg, AssetStore.Meta m, double local) {
        Double off = seg.params.get("offset"), sp = seg.params.get("speed");
        double at = (off != null ? off : 0) + local * (sp != null ? sp : 1);
        Double loop = seg.params.get("loop");
        if (loop != null && loop >= 0.5 && m.duration > 0) {
            double span = m.duration - (off != null ? off : 0);
            if (span > 0) at = (off != null ? off : 0) + ((at - (off != null ? off : 0)) % span);
        }
        return (int) Math.floor(at * m.sampleRate / m.chunkFrames());
    }

    private void prefetchFiles(double t0, double[] leads, boolean now) {
        double dur = timeline.duration;
        for (CTrack ct : tracks) {
            for (CSeg cs : ct.segments) {
                Model.Segment seg = cs.seg;
                if (!"file".equals(seg.generator) || seg.assetId == null) continue;
                AssetStore.Meta m = AssetStore.INSTANCE.metas.get(seg.assetId);
                if (m == null) continue;
                for (double lead : leads) {
                    double t = t0 + lead;
                    if (t >= dur) {
                        if (!"loop".equals(timeline.endBehavior)) continue;
                        t -= dur;
                    }
                    if (t < seg.start || t >= cs.end) continue;
                    Repeat.activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t, instP);
                    for (int i = 0; i < instP.count; i++) {
                        double local = t - instP.start[i];
                        if (!now && local > lead + 0.25) continue;
                        int idx = chunkAt(seg, m, local);
                        if (now) {
                            AssetStore.INSTANCE.request(m.id, idx + 1);
                            AssetStore.INSTANCE.urgent(m.id, idx);
                        } else {
                            AssetStore.INSTANCE.request(m.id, idx);
                            AssetStore.INSTANCE.request(m.id, idx + 1);
                        }
                    }
                }
            }
        }
    }

    public Engine(double sampleRate, int maxBlock) {
        sr = sampleRate;
        vL = new float[maxBlock];
        vR = new float[maxBlock];
        tL = new float[maxBlock];
        tR = new float[maxBlock];
        gainBuf = new float[maxBlock];
        limiter = new Limiter(sampleRate, dbToGain(DEFAULT_CAP_DB));
    }

    // ------------------------------------------------------------ control

    public void load(Model.Timeline tl) {
        timeline = tl;
        tracks = compile(tl);
        for (int i = 0; i < tracks.size(); i++) {
            CTrack ct = tracks.get(i);
            ct.lead = tl.focusLead != null && tl.focusLead.equals(ct.track.id);
            ct.fill = tl.focusLead != null && !ct.lead && tl.focusFill.contains(ct.track.id);
            ct.follow = tl.focusLead != null && !ct.lead && !ct.fill && tl.focusFollow.contains(ct.track.id);
        }
        // the lead plays first, so the background can follow it within the same block
        for (int i = 1; i < tracks.size(); i++) {
            if (tracks.get(i).lead) {
                tracks.add(0, tracks.remove(i));
                break;
            }
        }
        masterGain = dbToGain(tl.masterGainDb);
        voices.clear();
    }

    public void setCap(double capDb) {
        limiter.ceiling = dbToGain(Math.min(capDb, ABSOLUTE_MAX_CAP_DB));
    }

    public void play(double fadeSeconds) {
        if (timeline == null) return;
        if (ended) {
            ended = false;
            pos = 0;
        }
        transport = PLAYING;
        stoppedBy = null;
        if (fadeSeconds <= 0) {
            env = envTarget = 1;
            return;
        }
        env = 0;
        rampTo(1, fadeSeconds);
    }

    public void play() {
        play(PLAY_FADE_IN);
    }

    public void pause(double fadeSeconds) {
        if (transport != PLAYING) return;
        transport = PAUSING;
        rampTo(0, fadeSeconds);
    }

    public void pause() {
        pause(PAUSE_FADE_OUT);
    }

    public void setSleepTimer(Double seconds, double fadeSeconds) {
        sleepRemaining = seconds == null ? null : Math.max(0, seconds) * sr;
        sleepFade = fadeSeconds;
        if (seconds == null && transport == PLAYING && envTarget < 1 && pendingSeek == null) rampTo(1, 2);
    }

    public void seek(double seconds) {
        double dur = timeline != null ? timeline.duration : 0;
        double target = Math.max(0, Math.min(seconds, dur)) * sr;
        ended = false;
        if (transport != PLAYING) {
            pos = target;
            voices.clear();
            return;
        }
        pendingSeek = target;
        rampTo(0, SEEK_FADE);
        prefetchNow(target / sr); // decode the new spot while the old one fades out
    }

    public boolean isPlaying() {
        return transport == PLAYING;
    }

    public boolean isStopped() {
        return transport == STOPPED;
    }

    public double positionSec() {
        return pos / sr;
    }

    public double durationSec() {
        return timeline != null ? timeline.duration : 0;
    }

    public boolean ended() {
        return ended;
    }

    public double limiterDb() {
        return gainToDb(limiter.gain());
    }

    public int activeVoices() {
        return voices.size();
    }

    public Double sleepRemainingSec() {
        return sleepRemaining == null ? null : sleepRemaining / sr;
    }

    public String stoppedBy() {
        return stoppedBy;
    }

    public String timelineId() {
        return timeline != null ? timeline.id : null;
    }

    private void rampTo(double target, double seconds) {
        envTarget = target;
        envStep = 1 / Math.max(1, seconds * sr);
    }

    // ------------------------------------------------------------ rendering

    /** Renders n samples (n <= maxBlock). Returns false when fully stopped. */
    public boolean process(float[] outL, float[] outR, int n) {
        if (transport == STOPPED || timeline == null) {
            java.util.Arrays.fill(outL, 0, n, 0f);
            java.util.Arrays.fill(outR, 0, n, 0f);
            return false;
        }
        blockCount++;
        AssetStore.INSTANCE.clock = blockCount;
        renderMix(outL, outR, n);
        applyMaster(outL, outR, n);
        pos += n;
        if (sleepRemaining != null && transport == PLAYING) {
            double fadeSamples = Math.min(sleepFade * sr, sleepRemaining);
            sleepRemaining = Math.max(0, sleepRemaining - n);
            if (sleepRemaining <= fadeSamples && envTarget != 0) {
                rampTo(0, Math.max(sleepRemaining, n) / sr);
                envTarget = 0;
            }
            if (sleepRemaining == 0) {
                sleepRemaining = null;
                stoppedBy = "sleep";
                transport = env == 0 ? STOPPED : PAUSING;
                rampTo(0, PAUSE_FADE_OUT);
            }
        }
        if (pos >= timeline.duration * sr && pendingSeek == null) {
            if ("loop".equals(timeline.endBehavior)) {
                pendingSeek = 0.0;
                rampTo(0, SEEK_FADE);
            } else if (transport == PLAYING) {
                ended = true;
                stoppedBy = "end";
                transport = PAUSING;
                rampTo(0, PAUSE_FADE_OUT);
            }
        }
        return true;
    }

    private void renderMix(float[] outL, float[] outR, int n) {
        java.util.Arrays.fill(outL, 0, n, 0f);
        java.util.Arrays.fill(outR, 0, n, 0f);
        double t0 = pos / sr;
        double t1 = (pos + n - 1) / sr;
        if (blockCount % 64 == 1) prefetchFiles(t0);
        boolean anySolo = false;
        for (CTrack ct : tracks) if (ct.track.solo) anySolo = true;
        double duckFrom = duckDb;
        double fillFrom = fillDb;
        double leadPow = 0;
        boolean duckUpdated = false;

        for (CTrack ct : tracks) {
            Model.Soundtrack tr = ct.track;
            if ((ct.follow || ct.fill) && !duckUpdated) {
                updateDuck(leadPow, n);
                duckUpdated = true;
            }
            if (tr.mute || (anySolo && !tr.solo)) continue;
            double db0 = tr.gainDb + (ct.gainAuto != null ? ct.gainAuto.value(t0) : 0);
            double db1 = tr.gainDb + (ct.gainAuto != null ? ct.gainAuto.value(t1) : 0);
            if (ct.follow) {
                db0 += timeline.focusLevelDb + duckFrom;
                db1 += timeline.focusLevelDb + duckDb;
            } else if (ct.fill) {
                db0 += fillFrom;
                db1 += fillDb;
            }
            double tg0 = dbToGain(db0);
            double tg1 = dbToGain(db1);
            boolean touched = false;
            java.util.Arrays.fill(tL, 0, n, 0f);
            java.util.Arrays.fill(tR, 0, n, 0f);
            for (CSeg cs : ct.segments) {
                Model.Segment seg = cs.seg;
                if (t1 < seg.start || t0 >= cs.end) continue;
                Repeat.activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t0, instA);
                Repeat.activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t1, instB);
                for (int i = 0; i < instA.count; i++) touched = renderInstance(cs, instA.k[i], instA.start[i], t0, n) || touched;
                for (int i = 0; i < instB.count; i++) {
                    if (instA.hasK(instB.k[i])) continue;
                    touched = renderInstance(cs, instB.k[i], instB.start[i], t0, n) || touched;
                }
            }
            if (!touched) continue;
            double panL = ct.panL, panR = ct.panR;
            if (ct.panAuto != null) {
                double pan = Math.max(-1, Math.min(1, ct.panAuto.value(t0)));
                panL = Math.min(1, 1 - pan);
                panR = Math.min(1, 1 + pan);
            }
            double dg = (tg1 - tg0) / n;
            if (ct.lead) {
                double sum = 0;
                for (int i = 0; i < n; i++) {
                    double g = tg0 + dg * i;
                    double l = tL[i] * g * panL, r = tR[i] * g * panR;
                    outL[i] = (float) (outL[i] + l);
                    outR[i] = (float) (outR[i] + r);
                    sum += l * l + r * r;
                }
                // judged at the album's own level: turning the album down must not make it sound "quiet"
                double user = dbToGain(tr.gainDb);
                leadPow = sum / (2 * n) / (user * user);
                continue;
            }
            for (int i = 0; i < n; i++) {
                double g = tg0 + dg * i;
                outL[i] = (float) (outL[i] + tL[i] * g * panL);
                outR[i] = (float) (outR[i] + tR[i] * g * panR);
            }
        }
        if (!duckUpdated) updateDuck(leadPow, n);
        Iterator<LiveVoice> it = voices.values().iterator();
        while (it.hasNext()) if (it.next().lastBlock != blockCount) it.remove();
    }

    private boolean renderInstance(CSeg cs, double k, double instStart, double t0, int n) {
        Model.Segment seg = cs.seg;
        double local0 = t0 - instStart;
        String key = seg.id + ":" + (long) k;
        LiveVoice lv = voices.get(key);
        if (lv == null || lv.seg != cs) {
            lv = new LiveVoice();
            lv.voice = createVoice(cs, k, instStart);
            lv.seg = cs;
            voices.put(key, lv);
        }
        lv.lastBlock = blockCount;

        LaneParam go = cs.gain;
        double offset = go != null && go.span ? instStart - seg.start : 0;
        double db0 = seg.gainDb + (go != null ? go.curve.value(local0 + offset) : 0);
        double db1 = seg.gainDb + (go != null ? go.curve.value(local0 + n / sr + offset) : 0);
        double g0 = dbToGain(db0);
        double dg = (dbToGain(db1) - g0) / n;
        double len = seg.length;
        double fi = Math.max(0, seg.fadeIn), fo = Math.max(0, seg.fadeOut);
        String curve = seg.fadeCurve;
        boolean any = false;
        for (int i = 0; i < n; i++) {
            double lt = local0 + i / sr;
            if (lt < 0 || lt >= len) {
                gainBuf[i] = 0;
                continue;
            }
            double f = 1;
            if (fi > 0 && lt < fi) f = fadeShape(curve, lt / fi);
            double rem = len - lt;
            if (fo > 0 && rem < fo) f *= fadeShape(curve, rem / fo);
            gainBuf[i] = (float) (f * (g0 + dg * i));
            any = true;
        }
        if (!any) return false;
        lv.voice.render(local0, n, sr, vL, vR);
        for (int i = 0; i < n; i++) {
            tL[i] = (float) (tL[i] + vL[i] * gainBuf[i]);
            tR[i] = (float) (tR[i] + vR[i] * gainBuf[i]);
        }
        return true;
    }

    static double fadeShape(String curve, double x) {
        switch (curve == null ? "equal" : curve) {
            case "linear": return x;
            case "smooth": return 0.5 - 0.5 * Math.cos(Math.PI * x);
            case "gentle": return x * x;
            default: return Math.sin((Math.PI / 2) * x);
        }
    }

    private double wakeGain(double t) {
        if (timeline == null || !"wake".equals(timeline.endBehavior)) return 1;
        double from = timeline.duration - Math.min(WAKE_SECONDS, timeline.duration / 2);
        if (t <= from) return 1;
        double u = Math.min(1, (t - from) / (timeline.duration - from));
        double s = u * u * (3 - 2 * u);
        return dbToGain(WAKE_RISE_DB * s);
    }

    private void applyMaster(float[] outL, float[] outR, int n) {
        double mg = masterGain * wakeGain(pos / sr);
        for (int i = 0; i < n; i++) {
            if (env != envTarget) {
                if (env < envTarget) env = Math.min(envTarget, env + envStep);
                else env = Math.max(envTarget, env - envStep);
                if (env == envTarget) onEnvelopeReached();
            }
            double e = env * env * mg;
            outL[i] = (float) (outL[i] * e);
            outR[i] = (float) (outR[i] * e);
        }
        limiter.process(outL, outR, n);
    }

    private void onEnvelopeReached() {
        if (pendingSeek != null && env == 0) {
            pos = pendingSeek;
            pendingSeek = null;
            voices.clear();
            if (transport == PLAYING) rampTo(1, SEEK_FADE);
            return;
        }
        if (transport == PAUSING && env == 0) transport = STOPPED;
    }
}
