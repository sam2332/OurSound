package com.oursound.app.engine;

import java.util.Arrays;
import java.util.Comparator;

/**
 * Automation curve (port of src/engine/automation.ts): value(t) and the exact
 * integral from 0, so oscillator phase is known at any time without history.
 */
public final class Curve {
    public static final int HOLD = 0, LINEAR = 1, SMOOTH = 2, EXP = 3;

    public static final class Point {
        public final double t, v;
        public final int curve;

        public Point(double t, double v, int curve) {
            this.t = t;
            this.v = v;
            this.curve = curve;
        }
    }

    public static int curveType(String s) {
        if (s == null) return LINEAR;
        switch (s) {
            case "hold": return HOLD;
            case "smooth": return SMOOTH;
            case "exp": return EXP;
            default: return LINEAR;
        }
    }

    final double[] ts, vs, cum;
    final int[] curves;

    public Curve(Point[] points) {
        Point[] p = points.clone();
        Arrays.sort(p, Comparator.comparingDouble(a -> a.t));
        int n = p.length;
        ts = new double[n];
        vs = new double[n];
        curves = new int[n];
        cum = new double[n];
        for (int i = 0; i < n; i++) {
            ts[i] = p[i].t;
            vs[i] = p[i].v;
            curves[i] = p[i].curve;
        }
        cum[0] = vs[0] * ts[0];
        for (int i = 1; i < n; i++) {
            double d = ts[i] - ts[i - 1];
            cum[i] = cum[i - 1] + (d > 0 ? shapeIntegral(curves[i - 1], vs[i - 1], vs[i], d, 1) : 0);
        }
    }

    static double shape(int curve, double v0, double v1, double u) {
        switch (curve) {
            case HOLD: return v0;
            case SMOOTH: return v0 + (v1 - v0) * 0.5 * (1 - Math.cos(Math.PI * u));
            case EXP:
                if (v0 > 0 && v1 > 0) return v0 * Math.pow(v1 / v0, u);
                return v0 + (v1 - v0) * u;
            default: return v0 + (v1 - v0) * u;
        }
    }

    static double shapeIntegral(int curve, double v0, double v1, double d, double u) {
        switch (curve) {
            case HOLD: return d * v0 * u;
            case SMOOTH: return d * (v0 * u + (v1 - v0) * 0.5 * (u - Math.sin(Math.PI * u) / Math.PI));
            case EXP:
                if (v0 > 0 && v1 > 0 && v0 != v1) {
                    double lr = Math.log(v1 / v0);
                    return (d * v0 * (Math.exp(lr * u) - 1)) / lr;
                }
                return d * (v0 * u + (v1 - v0) * 0.5 * u * u);
            default: return d * (v0 * u + (v1 - v0) * 0.5 * u * u);
        }
    }

    private int find(double t) {
        if (t < ts[0]) return -1;
        int hi = ts.length - 1;
        if (t >= ts[hi]) return hi;
        int lo = 0;
        while (lo < hi) {
            int mid = (lo + hi + 1) >> 1;
            if (ts[mid] <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    public double value(double t) {
        int i = find(t);
        if (i < 0) return vs[0];
        if (i >= ts.length - 1) return vs[vs.length - 1];
        double d = ts[i + 1] - ts[i];
        double u = d > 0 ? (t - ts[i]) / d : 1;
        return shape(curves[i], vs[i], vs[i + 1], u);
    }

    public double integral(double t) {
        int i = find(t);
        if (i < 0) return vs[0] * t;
        int last = ts.length - 1;
        if (i >= last) return cum[last] + vs[last] * (t - ts[last]);
        double d = ts[i + 1] - ts[i];
        double u = d > 0 ? (t - ts[i]) / d : 0;
        return cum[i] + shapeIntegral(curves[i], vs[i], vs[i + 1], d, u);
    }
}
