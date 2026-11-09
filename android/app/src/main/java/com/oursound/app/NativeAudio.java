package com.oursound.app;

import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.oursound.app.engine.AssetStore;
import com.oursound.app.engine.Engine;
import com.oursound.app.engine.Model;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Native playback: a dedicated audio-priority thread renders the engine and
 * writes to an AudioTrack with a large buffer (power-saving mode). This is the
 * classic, robust way Android apps play for hours with the screen off; the
 * WebView only sends the timeline and transport commands.
 */
public final class NativeAudio {
    private static final String TAG = "OSNative";
    public static final int SR = 48000;
    private static final int BLOCK = 128;
    private static final int BLOCKS_PER_WRITE = 8; // 1024 frames ≈ 21 ms per write

    public static final NativeAudio INSTANCE = new NativeAudio();

    private final Engine engine = new Engine(SR, BLOCK);
    private final Object lock = new Object();
    private Thread thread;
    private AudioTrack track;
    private volatile double statusEverySec = 0.25;
    private volatile boolean focusLostTransient = false;
    private Context ctx;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private volatile String title = "OurSound";
    private volatile String subtitle = "";
    /** Whether the foreground service is currently in its "playing" state. */
    private volatile boolean serviceForeground = false;

    public interface StatusListener {
        void onStatus(JSObject status);
    }

    private volatile StatusListener listener;

    private NativeAudio() {}

    public void init(Context context) {
        if (ctx != null) return;
        ctx = context.getApplicationContext();
        audioManager = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        loadAssetIndex();
    }

    /**
     * Small night log (position, underruns, pauses) in the app's external files
     * dir, readable over adb: /sdcard/Android/data/com.oursound.app/files/night.log
     */
    void nightLog(String line) {
        Log.i(TAG, line);
        if (ctx == null) return;
        try {
            File dir = ctx.getExternalFilesDir(null);
            if (dir == null) return;
            File f = new File(dir, "night.log");
            if (f.length() > 512 * 1024) {
                File old = new File(dir, "night.old.log");
                //noinspection ResultOfMethodCallIgnored
                old.delete();
                //noinspection ResultOfMethodCallIgnored
                f.renameTo(old);
            }
            String stamp = new java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
            Files.write(f.toPath(), (stamp + " " + line + System.lineSeparator()).getBytes(StandardCharsets.UTF_8),
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        } catch (Exception ignored) {
        }
    }

    public void setListener(StatusListener l) {
        listener = l;
    }

    // ------------------------------------------------------------ commands

    public void load(JSONObject timeline) {
        Model.Timeline tl = Model.parse(timeline);
        subtitle = tl.name;
        synchronized (lock) {
            engine.load(tl);
        }
        emitStatus();
    }

    public void play(double fadeSeconds) {
        nightLog("play " + subtitle);
        requestFocus();
        setServicePlaying(true);
        synchronized (lock) {
            // Imported audio: the audio thread holds off (up to 1.5 s) until it's decoded.
            engine.prefetchNow(engine.positionSec());
            warmUntil = SystemClock.elapsedRealtime() + 1500;
            engine.play(fadeSeconds);
            lock.notifyAll();
        }
        ensureThread();
        emitStatus();
    }

    public void pause(double fadeSeconds) {
        synchronized (lock) {
            engine.pause(fadeSeconds);
        }
        setServicePlaying(false);
        emitStatus();
    }

    /**
     * The native side owns the service state, so overnight correctness never
     * depends on the WebView: foreground + wake lock while playing, released
     * as soon as playback stops (pause, sleep timer, end of timeline).
     */
    private void setServicePlaying(boolean playing) {
        if (ctx == null) return;
        if (playing == serviceForeground && !playing) return;
        serviceForeground = playing;
        Intent i = new Intent(ctx, PlaybackService.class)
                .setAction(PlaybackService.ACTION_UPDATE)
                .putExtra(PlaybackService.EXTRA_TITLE, title)
                .putExtra(PlaybackService.EXTRA_TEXT, subtitle)
                .putExtra(PlaybackService.EXTRA_PLAYING, playing);
        try {
            if (playing) ContextCompat.startForegroundService(ctx, i);
            else ctx.startService(i);
        } catch (Exception e) {
            Log.e(TAG, "could not update playback service", e);
        }
    }

    /**
     * Lock screen, notification, headphone buttons and audio focus act on the
     * engine directly (works even if the WebView is asleep), then tell the UI.
     */
    public void remote(String action) {
        nightLog("remote: " + action);
        if ("play".equals(action)) {
            boolean loaded;
            synchronized (lock) {
                loaded = engine.timelineId() != null;
            }
            if (loaded) play(1.0);
        } else {
            pause(0.4);
        }
        PlaybackPlugin.notifyRemote(action);
    }

    /** App swiped away: fade out quickly and release everything. */
    public void stopForAppClosed() {
        nightLog("app closed: stopping");
        synchronized (lock) {
            engine.pause(0.3);
        }
        serviceForeground = false;
        if (audioManager != null && focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
    }

    /** Current status, for the UI to pull (e.g. when the screen comes back on). */
    public JSObject statusNow() {
        final JSObject[] out = new JSObject[1];
        StatusListener prev = listener;
        listener = s -> out[0] = s;
        emitStatus();
        listener = prev;
        return out[0];
    }

    public void seek(double seconds) {
        synchronized (lock) {
            engine.seek(seconds);
        }
        emitStatus();
    }

    public void setCap(double capDb) {
        synchronized (lock) {
            engine.setCap(capDb);
        }
    }

    public void setSleep(Double seconds, double fadeSeconds) {
        synchronized (lock) {
            engine.setSleepTimer(seconds, fadeSeconds);
        }
        emitStatus();
    }

    public void setStatusEvery(double seconds) {
        statusEverySec = seconds;
    }

    // ------------------------------------------------------------ audio focus

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS:
                Log.i(TAG, "audio focus lost: pausing");
                focusLostTransient = false;
                remote("pause");
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                // e.g. a phone call: pause, and resume when it's over
                Log.i(TAG, "audio focus lost (transient): pausing");
                boolean wasPlaying;
                synchronized (lock) {
                    wasPlaying = engine.isPlaying();
                }
                focusLostTransient = wasPlaying;
                if (wasPlaying) remote("pause");
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                if (focusLostTransient) {
                    Log.i(TAG, "audio focus back: resuming");
                    focusLostTransient = false;
                    remote("play");
                }
                break;
            default:
                // AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: keep playing (the system ducks us)
        }
    };

    private void requestFocus() {
        if (audioManager == null) return;
        if (focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes())
                    .setOnAudioFocusChangeListener(focusListener)
                    .setWillPauseWhenDucked(false)
                    .build();
        }
        audioManager.requestAudioFocus(focusRequest);
    }

    private static AudioAttributes attributes() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build();
    }

    // ------------------------------------------------------------ audio thread

    private synchronized void ensureThread() {
        if (thread != null && thread.isAlive()) return;
        thread = new Thread(this::audioLoop, "OurSound-audio");
        thread.start();
    }

    private AudioTrack createTrack() {
        AudioFormat fmt = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                .setSampleRate(SR)
                .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                .build();
        int min = AudioTrack.getMinBufferSize(SR, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT);
        // Generous buffer (~370 ms): latency doesn't matter for sleep audio; robustness does.
        int bytes = Math.max(min * 4, SR * 2 * 4 * 3 / 8);
        AudioTrack t = new AudioTrack.Builder()
                .setAudioAttributes(attributes())
                .setAudioFormat(fmt)
                .setBufferSizeInBytes(bytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_POWER_SAVING)
                .build();
        Log.i(TAG, "AudioTrack ready: buffer " + t.getBufferSizeInFrames() + " frames");
        return t;
    }

    /** Until then, playback waits for imported audio to be decoded (silence meanwhile). */
    private volatile long warmUntil = 0;

    private void audioLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        float[] L = new float[BLOCK], R = new float[BLOCK];
        float[] inter = new float[BLOCK * BLOCKS_PER_WRITE * 2];
        long lastStatus = 0;
        long lastEvict = 0;
        long lastLog = 0;
        try {
            track = createTrack();
            while (true) {
                synchronized (lock) {
                    while (engine.isStopped()) {
                        if (serviceForeground) setServicePlaying(false); // sleep timer / end / fade-out finished
                        if (track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING) {
                            track.pause();
                            track.flush();
                            String by;
                            double p;
                            synchronized (lock) {
                                by = engine.stoppedBy();
                                p = engine.positionSec();
                            }
                            nightLog(String.format(java.util.Locale.US, "stopped (%s) at pos=%.1fs, underruns %d, audioGaps %d",
                                    by == null ? "paused" : by, p, track.getUnderrunCount(), AssetStore.INSTANCE.missedBlocks));
                        }
                        emitStatusLocked();
                        try {
                            lock.wait();
                        } catch (InterruptedException e) {
                            return;
                        }
                    }
                    boolean hold = warmUntil > 0 && SystemClock.elapsedRealtime() < warmUntil && !engine.filesReadyAt(engine.positionSec());
                    if (!hold && warmUntil > 0) {
                        long waited = 1500 - (warmUntil - SystemClock.elapsedRealtime());
                        Log.i(TAG, "start: waited " + waited + " ms for imported audio");
                        warmUntil = 0;
                    }
                    for (int b = 0; b < BLOCKS_PER_WRITE; b++) {
                        if (hold) {
                            java.util.Arrays.fill(L, 0f);
                            java.util.Arrays.fill(R, 0f);
                        } else {
                            engine.process(L, R, BLOCK);
                        }
                        int o = b * BLOCK * 2;
                        for (int i = 0; i < BLOCK; i++) {
                            inter[o + 2 * i] = L[i];
                            inter[o + 2 * i + 1] = R[i];
                        }
                    }
                }
                if (track.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) track.play();
                // Blocking write paces the loop to real time.
                int written = 0;
                while (written < inter.length) {
                    int w = track.write(inter, written, inter.length - written, AudioTrack.WRITE_BLOCKING);
                    if (w < 0) {
                        Log.e(TAG, "AudioTrack write error " + w + ": recreating");
                        track.release();
                        track = createTrack();
                        track.play();
                        break;
                    }
                    written += w;
                }
                long now = SystemClock.elapsedRealtime();
                if (now - lastStatus >= statusEverySec * 1000) {
                    lastStatus = now;
                    emitStatus();
                }
                if (now - lastLog >= 60_000) {
                    lastLog = now;
                    double p;
                    synchronized (lock) {
                        p = engine.positionSec();
                    }
                    nightLog(String.format(java.util.Locale.US, "playing %s pos=%.1fs underruns=%d audioGaps=%d", subtitle, p, track.getUnderrunCount(), AssetStore.INSTANCE.missedBlocks));
                }
                if (now - lastEvict > 30_000) {
                    lastEvict = now;
                    AssetStore.INSTANCE.evict();
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "audio thread crashed", t);
        }
    }

    // ------------------------------------------------------------ status

    private void emitStatus() {
        synchronized (lock) {
            emitStatusLocked();
        }
    }

    private void emitStatusLocked() {
        StatusListener l = listener;
        if (l == null) return;
        JSObject s = new JSObject();
        s.put("playing", engine.isPlaying());
        s.put("positionSec", engine.positionSec());
        s.put("durationSec", engine.durationSec());
        s.put("ended", engine.ended());
        s.put("limiterDb", engine.limiterDb());
        s.put("activeVoices", engine.activeVoices());
        Double sleep = engine.sleepRemainingSec();
        s.put("sleepRemainingSec", sleep == null ? JSONObject.NULL : sleep);
        String by = engine.stoppedBy();
        s.put("stoppedBy", by == null ? JSONObject.NULL : by);
        s.put("timelineId", engine.timelineId() == null ? JSONObject.NULL : engine.timelineId());
        s.put("underruns", track != null ? track.getUnderrunCount() : 0);
        l.onStatus(s);
    }

    // ------------------------------------------------------------ imported audio

    private File audioDir() {
        File d = new File(ctx.getFilesDir(), "audio");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private File indexFile() {
        return new File(audioDir(), "index.json");
    }

    private void loadAssetIndex() {
        try {
            File f = indexFile();
            if (!f.exists()) return;
            JSONArray a = new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                AssetStore.INSTANCE.metas.put(o.getString("id"), new AssetStore.Meta(o.getString("id"), o.getString("name"),
                        o.getString("path"), o.getDouble("sampleRate"), o.getInt("channels"), o.getDouble("duration")));
            }
        } catch (Exception e) {
            Log.e(TAG, "could not read asset index", e);
        }
    }

    private void saveAssetIndex() throws Exception {
        JSONArray a = new JSONArray();
        for (AssetStore.Meta m : AssetStore.INSTANCE.metas.values()) a.put(metaJson(m));
        Files.write(indexFile().toPath(), a.toString().getBytes(StandardCharsets.UTF_8));
    }

    public static JSObject metaJson(AssetStore.Meta m) {
        JSObject o = new JSObject();
        o.put("id", m.id);
        o.put("name", m.name);
        o.put("path", m.path);
        o.put("sampleRate", m.sampleRate);
        o.put("channels", m.channels);
        o.put("duration", m.duration);
        File f = new File(m.path);
        o.put("size", f.length());
        o.put("importedAt", f.lastModified());
        return o;
    }

    /** Called with a copied file: probes it and adds it to the library. */
    public AssetStore.Meta addAsset(String id, String name, File file) throws Exception {
        AssetStore.Meta m = AssetStore.probe(id, name, file);
        AssetStore.INSTANCE.metas.put(id, m);
        saveAssetIndex();
        return m;
    }

    public File newAssetFile(String id, String ext) {
        return new File(audioDir(), id + (ext == null ? "" : ext));
    }

    public void deleteAsset(String id) throws Exception {
        AssetStore.Meta m = AssetStore.INSTANCE.metas.get(id);
        AssetStore.INSTANCE.forget(id);
        if (m != null) {
            //noinspection ResultOfMethodCallIgnored
            new File(m.path).delete();
        }
        saveAssetIndex();
    }
}
