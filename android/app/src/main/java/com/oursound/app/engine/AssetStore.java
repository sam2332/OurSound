package com.oursound.app.engine;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Log;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingDeque;

/**
 * Imported audio files, decoded on demand in 5-second chunks with MediaCodec
 * on a background thread (port of src/engine/assets.ts + src/audio/assets.ts).
 * The audio thread never blocks: a chunk that isn't ready yet plays as silence.
 */
public final class AssetStore {
    private static final String TAG = "OSAssets";
    public static final double CHUNK_SEC = 5;
    public static final int LOOKAHEAD = 6;
    private static final long EVICT_AFTER_BLOCKS = 22500;

    public static final class Meta {
        public final String id, name, path;
        public final double sampleRate, duration;
        public final int channels;

        public Meta(String id, String name, String path, double sampleRate, int channels, double duration) {
            this.id = id; this.name = name; this.path = path;
            this.sampleRate = sampleRate; this.channels = channels; this.duration = duration;
        }

        public int chunkFrames() {
            return (int) Math.round(CHUNK_SEC * sampleRate);
        }

        public int chunkCount() {
            return (int) Math.ceil((duration * sampleRate) / chunkFrames());
        }
    }

    static final class Chunk {
        final float[] L, R;
        volatile long lastUse;

        Chunk(float[] l, float[] r, long use) {
            L = l; R = r; lastUse = use;
        }
    }

    public static final AssetStore INSTANCE = new AssetStore();

    public final Map<String, Meta> metas = new ConcurrentHashMap<>();
    private final Map<String, Chunk> chunks = new ConcurrentHashMap<>();
    private final Map<String, Boolean> requested = new ConcurrentHashMap<>();
    private final LinkedBlockingDeque<String> queue = new LinkedBlockingDeque<>();
    public volatile long clock = 0;
    /** Audio blocks that needed a chunk that wasn't decoded yet (played as silence). */
    public volatile long missedBlocks = 0;
    private long missClock = -1;
    private String lastMissKey = "";
    private static final int MAX_DECODERS = 3;
    private Thread worker;

    private static String key(String id, int idx) {
        return id + "#" + idx;
    }

    /** Chunk if ready; otherwise requests it. Never blocks. */
    Chunk get(String id, int idx) {
        Chunk c = chunks.get(key(id, idx));
        if (c != null) {
            c.lastUse = clock;
            return c;
        }
        Meta m = metas.get(id);
        if (m != null && idx >= 0 && idx < m.chunkCount() && missClock != clock) {
            missClock = clock;
            missedBlocks++;
            String k = key(id, idx);
            if (!k.equals(lastMissKey)) {
                lastMissKey = k;
                Log.w(TAG, "gap: needed " + m.name + " #" + idx + " now (queued " + queue.size() + ", pending " + requested.containsKey(k) + ")");
            }
            urgent(id, idx);
            return null;
        }
        request(id, idx);
        return null;
    }

    void request(String id, int idx) {
        Meta m = metas.get(id);
        if (m == null || idx < 0 || idx >= m.chunkCount()) return;
        String k = key(id, idx);
        Chunk c = chunks.get(k);
        if (c != null) {
            c.lastUse = clock;
            return;
        }
        if (requested.putIfAbsent(k, Boolean.TRUE) == null) {
            queue.offer(k);
            ensureWorker();
        }
    }

    /** Needed right now: decode it before anything queued for later. */
    void urgent(String id, int idx) {
        Meta m = metas.get(id);
        if (m == null || idx < 0 || idx >= m.chunkCount()) return;
        String k = key(id, idx);
        if (chunks.containsKey(k)) return;
        requested.put(k, Boolean.TRUE);
        queue.remove(k);
        queue.offerFirst(k);
        ensureWorker();
    }

    public boolean has(String id, int idx) {
        return chunks.containsKey(key(id, idx));
    }

    /** For tests: put a decoded chunk directly. */
    void putChunk(String id, int idx, float[] L, float[] R) {
        chunks.put(key(id, idx), new Chunk(L, R, clock));
    }

    public void evict() {
        Iterator<Map.Entry<String, Chunk>> it = chunks.entrySet().iterator();
        while (it.hasNext()) {
            if (clock - it.next().getValue().lastUse > EVICT_AFTER_BLOCKS) it.remove();
        }
    }

    public void forget(String id) {
        metas.remove(id);
        chunks.keySet().removeIf(k -> k.startsWith(id + "#"));
        synchronized (decoders) {
            Decoder d = decoders.remove(id);
            if (d != null) d.close();
        }
    }

    // ------------------------------------------------------------ decoding

    /** Open decoders, least recently used first; only a few stay open (codecs are a limited resource). */
    private final LinkedHashMap<String, Decoder> decoders = new LinkedHashMap<>(8, 0.75f, true);

    private synchronized void ensureWorker() {
        if (worker != null && worker.isAlive()) return;
        worker = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
            while (true) {
                String k;
                try {
                    k = queue.take();
                } catch (InterruptedException e) {
                    return;
                }
                int sep = k.lastIndexOf('#');
                String id = k.substring(0, sep);
                int idx = Integer.parseInt(k.substring(sep + 1));
                Meta m = metas.get(id);
                try {
                    if (m != null && !chunks.containsKey(k)) {
                        float[][] lr;
                        synchronized (decoders) {
                            Decoder d = decoders.get(id);
                            if (d == null) {
                                while (decoders.size() >= MAX_DECODERS) {
                                    Iterator<Map.Entry<String, Decoder>> eldest = decoders.entrySet().iterator();
                                    eldest.next().getValue().close();
                                    eldest.remove();
                                }
                                d = new Decoder(m);
                                decoders.put(id, d);
                            }
                            long t0 = System.nanoTime();
                            lr = d.decodeChunk(idx);
                            Log.i(TAG, String.format(java.util.Locale.US, "decoded %s #%d in %d ms, filled %d..%d of %d, queue %d, seeks %d",
                                    m.name, idx, (System.nanoTime() - t0) / 1_000_000, d.firstFilled, d.lastFilled, lr[0].length, queue.size(), d.seeks));
                        }
                        chunks.put(k, new Chunk(lr[0], lr[1], clock));
                    }
                } catch (Exception e) {
                    Log.e(TAG, "decode failed " + k, e);
                } finally {
                    requested.remove(k);
                }
            }
        }, "OurSound-decoder");
        worker.start();
    }

    /** One MediaExtractor + MediaCodec per file, kept open for sequential chunks. */
    static final class Decoder {
        final Meta meta;
        final MediaExtractor ex = new MediaExtractor();
        MediaCodec codec;
        MediaFormat format;
        int firstFilled, lastFilled; // diagnostics: frames the last chunk actually got
        // Output format, kept across chunks: the codec only announces it once.
        int outChannels;
        double outRate;
        int pcmEncoding = android.media.AudioFormat.ENCODING_PCM_16BIT;

        Decoder(Meta meta) throws Exception {
            this.meta = meta;
            ex.setDataSource(meta.path);
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    ex.selectTrack(i);
                    format = f;
                    codec = MediaCodec.createDecoderByType(mime);
                    try {
                        // full precision (24-bit FLAC etc.) when the decoder supports it
                        MediaFormat ff = new MediaFormat(f);
                        ff.setInteger(MediaFormat.KEY_PCM_ENCODING, android.media.AudioFormat.ENCODING_PCM_FLOAT);
                        codec.configure(ff, null, null, 0);
                    } catch (Exception e) {
                        codec.release();
                        codec = MediaCodec.createDecoderByType(mime);
                        codec.configure(f, null, null, 0);
                    }
                    codec.start();
                    readOutputFormat(codec.getOutputFormat());
                    break;
                }
            }
            if (codec == null) throw new IllegalStateException("no audio track");
        }

        void readOutputFormat(MediaFormat of) {
            outChannels = of.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? of.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : meta.channels;
            outRate = of.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? of.getInteger(MediaFormat.KEY_SAMPLE_RATE) : meta.sampleRate;
            pcmEncoding = of.containsKey(MediaFormat.KEY_PCM_ENCODING) ? of.getInteger(MediaFormat.KEY_PCM_ENCODING) : android.media.AudioFormat.ENCODING_PCM_16BIT;
        }

        void close() {
            try {
                codec.stop();
                codec.release();
            } catch (Exception ignored) {
            }
            ex.release();
        }

        // Streaming state: chunks asked for in order are decoded straight through,
        // counting samples, so they join seamlessly. Seeking (and trusting the
        // codec's timestamps) only happens on a jump.
        long cursor = -1; // file frame the next decoded sample belongs to (-1: unknown)
        boolean inputEnded, outputEnded;
        float[] pendL = new float[0], pendR = new float[0]; // decoded past the last chunk
        int pendN = 0;
        long pendStart = 0;
        int seeks = 0;

        private void seekNear(long frame) {
            ex.seekTo((long) (Math.max(0, frame / meta.sampleRate - 0.2) * 1e6), MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
            codec.flush();
            cursor = -1;
            inputEnded = outputEnded = false;
            pendN = 0;
            seeks++;
        }

        private void keep(double l, double r) {
            if (pendN == pendL.length) {
                int n = Math.max(4096, pendN * 2);
                pendL = java.util.Arrays.copyOf(pendL, n);
                pendR = java.util.Arrays.copyOf(pendR, n);
            }
            pendL[pendN] = (float) l;
            pendR[pendN] = (float) r;
            pendN++;
        }

        float[][] decodeChunk(int idx) {
            int cf = meta.chunkFrames();
            int total = (int) Math.ceil(meta.duration * meta.sampleRate);
            int len = Math.max(0, Math.min(cf, total - idx * cf));
            float[] L = new float[len], R = new float[len];
            long start = (long) idx * cf, end = start + len;
            firstFilled = -1;
            lastFilled = -1;

            // Continue where the previous chunk stopped, or jump.
            boolean continues = cursor >= 0 && pendStart <= start && start <= cursor;
            if (!continues) seekNear(start);

            // samples already decoded past the previous chunk
            if (continues && pendN > 0) {
                for (int i = 0; i < pendN; i++) {
                    long fpos = pendStart + i;
                    if (fpos >= start && fpos < end) put(L, R, (int) (fpos - start), pendL[i], pendR[i]);
                }
            }
            // whatever lies past this chunk is kept for the next one
            float[] oldL = pendL, oldR = pendR;
            int oldN = pendN;
            long oldStart = pendStart;
            pendN = 0;
            pendStart = end;
            if (continues) {
                for (int i = 0; i < oldN; i++) if (oldStart + i >= end) keep(oldL[i], oldR[i]);
            }

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = System.currentTimeMillis() + 10_000;
            while ((cursor < 0 || cursor < end) && !outputEnded && System.currentTimeMillis() < deadline) {
                if (!inputEnded) {
                    int in = codec.dequeueInputBuffer(2000);
                    if (in >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(in);
                        int size = ex.readSampleData(buf, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputEnded = true;
                        } else {
                            codec.queueInputBuffer(in, 0, size, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int out = codec.dequeueOutputBuffer(info, 2000);
                if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    readOutputFormat(codec.getOutputFormat());
                    continue;
                }
                if (out < 0) continue;
                ByteBuffer ob = codec.getOutputBuffer(out);
                if (ob != null && info.size > 0) {
                    ob.position(info.offset);
                    ob.limit(info.offset + info.size);
                    ob.order(ByteOrder.nativeOrder());
                    boolean isFloat = pcmEncoding == android.media.AudioFormat.ENCODING_PCM_FLOAT;
                    int bytesPer = isFloat ? 4 : 2;
                    int frames = info.size / (bytesPer * outChannels);
                    // only right after a jump do we go by the codec's timestamp; then we count
                    if (cursor < 0) cursor = Math.round(info.presentationTimeUs / 1e6 * meta.sampleRate);
                    for (int f = 0; f < frames; f++, cursor++) {
                        double l, r;
                        if (isFloat) {
                            l = ob.getFloat();
                            r = outChannels > 1 ? ob.getFloat() : l;
                            for (int c = 2; c < outChannels; c++) ob.getFloat();
                        } else {
                            l = ob.getShort() / 32768.0;
                            r = outChannels > 1 ? ob.getShort() / 32768.0 : l;
                            for (int c = 2; c < outChannels; c++) ob.getShort();
                        }
                        if (cursor >= start && cursor < end) put(L, R, (int) (cursor - start), l, r);
                        else if (cursor >= end) keep(l, r);
                    }
                }
                codec.releaseOutputBuffer(out, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputEnded = true;
            }
            return new float[][] {L, R};
        }

        private void put(float[] L, float[] R, int pos, double l, double r) {
            if (firstFilled < 0 || pos < firstFilled) firstFilled = pos;
            if (pos > lastFilled) lastFilled = pos;
            L[pos] = (float) l;
            R[pos] = (float) r;
        }
    }

    /** Reads a file's audio info (for import). */
    public static Meta probe(String id, String name, File file) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(file.getAbsolutePath());
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    double sr = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    int ch = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    double dur = f.containsKey(MediaFormat.KEY_DURATION) ? f.getLong(MediaFormat.KEY_DURATION) / 1e6 : 0;
                    if (!(dur > 0)) throw new IllegalStateException("This file seems to be empty.");
                    return new Meta(id, name, file.getAbsolutePath(), sr, ch, dur);
                }
            }
            throw new IllegalStateException("This file has no audio track.");
        } finally {
            ex.release();
        }
    }
}
