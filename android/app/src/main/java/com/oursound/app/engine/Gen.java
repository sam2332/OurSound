package com.oursound.app.engine;

import java.util.HashMap;
import java.util.Map;

/** Generator interfaces and the registry (port of the GENERATORS table). */
public final class Gen {
    private Gen() {}

    public static final double NOMINAL_RMS = 0.25;
    public static final double TONE_PEAK = NOMINAL_RMS * Math.sqrt(2);

    public interface ParamReader {
        double value(double t);

        /** Integral from the instance start (t = 0) to t. */
        double integral(double t);
    }

    public interface Voice {
        /** Render n samples from instance-local time t0 (overwrite). */
        void render(double t0, int n, double sr, float[] L, float[] R);
    }

    public interface Factory {
        Voice create(Map<String, ParamReader> p, int seed, Model.Segment seg);
    }

    public static final class Def {
        public final String type;
        public final String[] names;
        public final double[] defaults;
        public final Factory factory;

        Def(String type, String[] names, double[] defaults, Factory factory) {
            this.type = type;
            this.names = names;
            this.defaults = defaults;
            this.factory = factory;
        }

        public double defaultFor(String name) {
            for (int i = 0; i < names.length; i++) if (names[i].equals(name)) return defaults[i];
            return 0;
        }
    }

    /** Multiplies a generator's output by k (level calibration). */
    static Def trimmed(Def d, double k) {
        return new Def(d.type, d.names, d.defaults, (p, seed, seg) -> {
            Voice v = d.factory.create(p, seed, seg);
            return (t0, n, sr, L, R) -> {
                v.render(t0, n, sr, L, R);
                for (int i = 0; i < n; i++) {
                    L[i] = (float) (L[i] * k);
                    R[i] = (float) (R[i] * k);
                }
            };
        });
    }

    public static final Map<String, Def> REGISTRY = new HashMap<>();

    static void register(Def d) {
        REGISTRY.put(d.type, d);
    }

    static {
        register(new Def("binaural", new String[] {"carrier", "beat"}, new double[] {200, 4}, Tones::binaural));
        register(new Def("monaural", new String[] {"carrier", "beat"}, new double[] {200, 4}, Tones::monaural));
        register(new Def("isochronic", new String[] {"tone", "rate", "duty"}, new double[] {200, 4, 0.5}, Tones::isochronic));
        register(new Def("tone", new String[] {"freq"}, new double[] {432}, Tones::tone));
        register(new Def("noise", new String[] {"color", "width", "tone"}, new double[] {1, 1, 0}, Tones::noise));
        register(trimmed(new Def("fan", new String[] {"speed", "tone", "wobble"}, new double[] {0.5, 0.4, 0.3}, Ambient::fan), 0.49));
        register(trimmed(new Def("rain", new String[] {"intensity", "drops", "brightness"}, new double[] {0.5, 0.5, 0.5}, Ambient::rain), 1.53));
        register(trimmed(new Def("thunder", new String[] {"rate", "distance", "intensity", "variety"}, new double[] {8, 0.5, 0.7, 0.6}, Thunder::create), 0.5));
        register(trimmed(new Def("wind", new String[] {"strength", "gusts", "pitch"}, new double[] {0.5, 0.5, 0.4}, Ambient::wind), 1.42));
        register(trimmed(new Def("ocean", new String[] {"period", "size", "closeness"}, new double[] {9, 0.6, 0.5}, Ambient::ocean), 0.96));
        register(trimmed(new Def("campfire", new String[] {"size", "crackle", "pops"}, new double[] {0.5, 0.5, 0.4}, Campfire::create), 2));
        register(trimmed(new Def("drums", new String[] {"tempo", "style", "depth", "variety"}, new double[] {60, 1, 0.3, 0.3}, Drums::create), 1));
        register(trimmed(new Def("crickets", new String[] {"crickets", "rate", "pitch", "rests"}, new double[] {5, 2, 0.5, 0.3}, Crickets::create), 0.6));
        register(new Def("file", new String[] {"speed", "pitch", "tone", "loop", "xfade", "offset"}, new double[] {1, 0, 0, 1, 0.35, 0}, FileSource::create));
    }
}
