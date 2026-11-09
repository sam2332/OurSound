package com.oursound.app.engine;

import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * The native engine must sound exactly like the TypeScript engine (which has
 * its own test suite). Reference renders come from src/engine/golden.test.ts.
 */
public class GoldenTest {
    private static byte[] read(String name) throws Exception {
        try (InputStream in = GoldenTest.class.getClassLoader().getResourceAsStream("golden/" + name)) {
            if (in == null) throw new IllegalStateException("missing golden/" + name);
            return in.readAllBytes();
        }
    }

    /** Same synthetic 20 s file as src/engine/golden.test.ts. */
    private static void installSynth() {
        AssetStore.Meta m = new AssetStore.Meta("synth", "synth", "", 44100, 2, 20);
        AssetStore.INSTANCE.metas.put("synth", m);
        int cf = m.chunkFrames();
        int total = (int) Math.ceil(m.duration * m.sampleRate);
        for (int idx = 0; (long) idx * cf < total; idx++) {
            int len = Math.min(cf, total - idx * cf);
            float[] L = new float[len], R = new float[len];
            for (int j = 0; j < len; j++) {
                double t = (double) (idx * cf + j) / 44100;
                L[j] = (float) (0.5 * Math.sin(2 * Math.PI * 441 * t) + 0.2 * Math.sin(2 * Math.PI * 1234.5 * t));
                R[j] = (float) (0.4 * Math.sin(2 * Math.PI * 300 * t + 1));
            }
            AssetStore.INSTANCE.putChunk("synth", idx, L, R);
        }
    }

    @Test
    public void nativeEngineMatchesTypeScriptEngine() throws Exception {
        installSynth();
        JSONArray index = new JSONArray(new String(read("index.json"), StandardCharsets.UTF_8));
        StringBuilder report = new StringBuilder();
        boolean ok = true;
        for (int c = 0; c < index.length(); c++) {
            JSONObject cs = index.getJSONObject(c);
            String name = cs.getString("name");
            Model.Timeline tl = Model.parse(new JSONObject(new String(read(name + ".json"), StandardCharsets.UTF_8)));
            ByteBuffer bb = ByteBuffer.wrap(read(name + ".f32")).order(ByteOrder.LITTLE_ENDIAN);
            float[] expected = new float[bb.remaining() / 4];
            bb.asFloatBuffer().get(expected);

            Engine e = new Engine(48000, 128);
            e.load(tl);
            e.setCap(cs.getDouble("capDb"));
            e.seek(cs.getDouble("seek"));
            e.play(0);
            int n = expected.length / 2;
            float[] L = new float[128], R = new float[128];
            double maxDiff = 0, peak = 0;
            int worst = -1;
            for (int i = 0; i < n; i += 128) {
                e.process(L, R, 128);
                for (int j = 0; j < 128; j++) {
                    double dl = Math.abs(L[j] - expected[2 * (i + j)]);
                    double dr = Math.abs(R[j] - expected[2 * (i + j) + 1]);
                    if (Math.max(dl, dr) > maxDiff) {
                        maxDiff = Math.max(dl, dr);
                        worst = i + j;
                    }
                    peak = Math.max(peak, Math.abs(expected[2 * (i + j)]));
                }
            }
            boolean pass = maxDiff < 1e-4 && peak > 1e-4;
            ok &= pass;
            report.append(String.format("%-20s maxDiff=%.2e peak=%.3f worst@%d %s%n", name, maxDiff, peak, worst, pass ? "OK" : "FAIL"));
        }
        System.out.println(report);
        assertTrue(report.toString(), ok);
    }
}
