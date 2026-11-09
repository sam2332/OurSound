package com.oursound.app.engine;

/** Stereo-linked look-ahead brickwall limiter (port of src/engine/limiter.ts). */
public final class Limiter {
    private final int D;
    private final float[] dl, dr;
    private final double[] qIdx, qVal;
    private int qHead = 0, qTail = 0;
    private final double[] box;
    private double boxSum;
    private int boxPos = 0;
    private double env = 1;
    private double n = 0;
    private final double release;
    public double ceiling;

    public Limiter(double sampleRate, double ceiling) {
        D = Math.max(1, (int) Math.round(0.005 * sampleRate));
        dl = new float[D];
        dr = new float[D];
        qIdx = new double[D + 3];
        qVal = new double[D + 3];
        box = new double[D];
        java.util.Arrays.fill(box, 1);
        boxSum = D;
        release = 1 - Math.exp(-1 / (0.25 * sampleRate));
        this.ceiling = ceiling;
    }

    public double gain() {
        return boxSum / D;
    }

    public void process(float[] L, float[] R, int len) {
        int cap = D + 3;
        double ceil = ceiling;
        for (int i = 0; i < len; i++) {
            double xl = L[i];
            double xr = R[i];
            double peak = Math.max(Math.abs(xl), Math.abs(xr));
            double need = peak > ceil ? ceil / peak : 1;
            double idx = n++;
            while (qTail != qHead) {
                int back = (qTail - 1 + cap) % cap;
                if (qVal[back] >= need) qTail = back;
                else break;
            }
            qIdx[qTail] = idx;
            qVal[qTail] = need;
            qTail = (qTail + 1) % cap;
            while (qIdx[qHead] < idx - D) qHead = (qHead + 1) % cap;
            double windowMin = qVal[qHead];
            if (windowMin < env) env = windowMin;
            else env += (windowMin - env) * release;
            boxSum += env - box[boxPos];
            box[boxPos] = env;
            boxPos = (boxPos + 1) % D;
            double g = boxSum / D;
            int p = (int) (idx % D);
            double ol = dl[p] * g;
            double or = dr[p] * g;
            dl[p] = (float) xl;
            dr[p] = (float) xr;
            L[i] = (float) (ol > ceil ? ceil : ol < -ceil ? -ceil : ol);
            R[i] = (float) (or > ceil ? ceil : or < -ceil ? -ceil : or);
        }
    }
}
