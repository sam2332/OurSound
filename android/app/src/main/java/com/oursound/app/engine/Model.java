package com.oursound.app.engine;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/** Timeline data parsed from the app's JSON (see src/engine/model.ts). */
public final class Model {
    private Model() {}

    public static final int REPEAT_NONE = 0, REPEAT_INTERVAL = 1, REPEAT_RANDOM = 2;

    public static final class Lane {
        public String param;
        public Curve.Point[] points;
        public boolean span;
    }

    public static final class Repeat {
        public int mode = REPEAT_NONE;
        public double every, minGap, maxGap;
        public Double count, until; // null = not set
    }

    public static final class Segment {
        public String id;
        public double start, length, fadeIn, fadeOut, gainDb;
        public String generator;
        public Map<String, Double> params = new HashMap<>();
        public int seed;
        public Repeat repeat = new Repeat();
        public Lane[] automation;
        public String assetId;
        public String fadeCurve = "equal";
    }

    public static final class Soundtrack {
        public String id;
        public double gainDb, pan;
        public boolean mute, solo;
        public Segment[] segments;
        public Lane[] automation;
    }

    public static final class Timeline {
        public String id;
        public String name;
        public double duration;
        public String endBehavior = "stop";
        public double masterGainDb;
        public Soundtrack[] soundtracks;
        /** Focus mix (see FocusMix in model.ts); focusLead null = off. */
        public String focusLead;
        public java.util.Set<String> focusFollow = new java.util.HashSet<>();
        /** Tracks that only come in when the lead goes quiet. */
        public java.util.Set<String> focusFill = new java.util.HashSet<>();
        public double focusLevelDb, focusDuckDb;
    }

    private static Lane[] lanes(JSONArray a) {
        if (a == null) return new Lane[0];
        Lane[] out = new Lane[a.length()];
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            Lane l = new Lane();
            l.param = o.optString("param");
            l.span = "span".equals(o.optString("scope", "instance"));
            JSONArray pts = o.optJSONArray("points");
            int n = pts == null ? 0 : pts.length();
            l.points = new Curve.Point[n];
            for (int j = 0; j < n; j++) {
                JSONObject p = pts.optJSONObject(j);
                l.points[j] = new Curve.Point(p.optDouble("t"), p.optDouble("v"), Curve.curveType(p.optString("curve", null)));
            }
            out[i] = l;
        }
        return out;
    }

    private static Double optNum(JSONObject o, String k) {
        if (!o.has(k) || o.isNull(k)) return null;
        return o.optDouble(k);
    }

    public static Timeline parse(JSONObject j) {
        Timeline t = new Timeline();
        t.id = j.optString("id");
        t.name = j.optString("name");
        t.duration = j.optDouble("duration", 60);
        t.endBehavior = j.optString("endBehavior", "stop");
        t.masterGainDb = j.optDouble("masterGainDb", 0);
        JSONObject fo = j.optJSONObject("focus");
        if (fo != null && fo.has("lead")) {
            t.focusLead = fo.optString("lead");
            JSONArray fa = fo.optJSONArray("follow");
            if (fa != null) for (int i = 0; i < fa.length(); i++) t.focusFollow.add(fa.optString(i));
            JSONArray fi = fo.optJSONArray("fill");
            if (fi != null) for (int i = 0; i < fi.length(); i++) t.focusFill.add(fi.optString(i));
            t.focusLevelDb = fo.optDouble("levelDb", 0);
            t.focusDuckDb = Math.max(0, Math.min(30, fo.optDouble("duckDb", 0)));
        }
        JSONArray st = j.optJSONArray("soundtracks");
        int n = st == null ? 0 : st.length();
        t.soundtracks = new Soundtrack[n];
        for (int i = 0; i < n; i++) {
            JSONObject so = st.optJSONObject(i);
            Soundtrack s = new Soundtrack();
            s.id = so.optString("id");
            s.gainDb = so.optDouble("gainDb", 0);
            s.pan = so.optDouble("pan", 0);
            s.mute = so.optBoolean("mute", false);
            s.solo = so.optBoolean("solo", false);
            s.automation = lanes(so.optJSONArray("automation"));
            JSONArray segs = so.optJSONArray("segments");
            int m = segs == null ? 0 : segs.length();
            s.segments = new Segment[m];
            for (int k = 0; k < m; k++) {
                JSONObject g = segs.optJSONObject(k);
                Segment sg = new Segment();
                sg.id = g.optString("id");
                sg.start = g.optDouble("start", 0);
                sg.length = g.optDouble("length", 1);
                sg.fadeIn = g.optDouble("fadeIn", 0);
                sg.fadeOut = g.optDouble("fadeOut", 0);
                sg.gainDb = g.optDouble("gainDb", 0);
                sg.generator = g.optString("generator");
                sg.seed = Hash.toInt32(g.optDouble("seed", 1));
                sg.assetId = g.has("assetId") ? g.optString("assetId") : null;
                sg.fadeCurve = g.optString("fadeCurve", "equal");
                JSONObject ps = g.optJSONObject("params");
                if (ps != null) {
                    JSONArray names = ps.names();
                    for (int q = 0; names != null && q < names.length(); q++) {
                        String name = names.optString(q);
                        sg.params.put(name, ps.optDouble(name));
                    }
                }
                JSONObject r = g.optJSONObject("repeat");
                if (r != null) {
                    String mode = r.optString("mode", "none");
                    if ("interval".equals(mode)) {
                        sg.repeat.mode = REPEAT_INTERVAL;
                        sg.repeat.every = r.optDouble("every", 60);
                    } else if ("random".equals(mode)) {
                        sg.repeat.mode = REPEAT_RANDOM;
                        sg.repeat.minGap = r.optDouble("minGap", 60);
                        sg.repeat.maxGap = r.optDouble("maxGap", 120);
                    }
                    sg.repeat.count = optNum(r, "count");
                    sg.repeat.until = optNum(r, "until");
                }
                sg.automation = lanes(g.optJSONArray("automation"));
                s.segments[k] = sg;
            }
            t.soundtracks[i] = s;
        }
        return t;
    }
}
