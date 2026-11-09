package com.oursound.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

/**
 * Foreground "media playback" service. The audio itself is generated in the
 * WebView's AudioWorklet; this service
 *  - keeps the app at foreground priority with a partial wake lock while playing,
 *  - shows a media notification + lock-screen controls (MediaSession), so
 *    play/pause works from the lock screen and headphone buttons,
 *  - reports headphones disconnecting so the app can pause.
 */
public class PlaybackService extends Service {
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_PLAYING = "playing";
    static final String ACTION_UPDATE = "com.oursound.app.UPDATE";
    static final String ACTION_PLAY = "com.oursound.app.PLAY";
    static final String ACTION_PAUSE = "com.oursound.app.PAUSE";
    private static final String TAG = "OSService";
    private static final String CHANNEL_ID = "oursound_playback";
    private static final int NOTIFICATION_ID = 4810;
    private static final long LOG_INTERVAL_MS = 60_000;

    private PowerManager.WakeLock wakeLock;
    private MediaSessionCompat session;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long startedAt;
    private boolean noisyRegistered = false;
    private boolean playing = false;
    private String title = "OurSound";
    private String text = "";

    private final Runnable logTick = new Runnable() {
        @Override
        public void run() {
            long sec = (SystemClock.elapsedRealtime() - startedAt) / 1000;
            Log.i(TAG, "alive " + sec + "s playing=" + playing + " wakeLockHeld=" + (wakeLock != null && wakeLock.isHeld()));
            handler.postDelayed(this, LOG_INTERVAL_MS);
        }
    };

    /** Headphones unplugged / Bluetooth disconnected: tell the app so it can pause. */
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                Log.i(TAG, "audio becoming noisy (headphones disconnected)");
                NativeAudio.INSTANCE.pause(0.2); // never play out of the speaker
                PlaybackPlugin.notifyBecomingNoisy();
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSessionCompat(this, "OurSound");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                NativeAudio.INSTANCE.remote("play");
            }

            @Override
            public void onPause() {
                NativeAudio.INSTANCE.remote("pause");
            }

            @Override
            public void onStop() {
                NativeAudio.INSTANCE.remote("pause");
            }
        });
        session.setActive(true);
        startedAt = SystemClock.elapsedRealtime();
        handler.post(logTick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_PLAY.equals(action)) {
            // Go foreground right away while the notification tap allows it; the app follows.
            playing = true;
            applyState();
            NativeAudio.INSTANCE.remote("play");
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            playing = false;
            applyState();
            NativeAudio.INSTANCE.remote("pause");
            return START_NOT_STICKY;
        }
        if (intent != null) {
            if (intent.hasExtra(EXTRA_TITLE)) title = intent.getStringExtra(EXTRA_TITLE);
            if (intent.hasExtra(EXTRA_TEXT)) text = intent.getStringExtra(EXTRA_TEXT);
            playing = intent.getBooleanExtra(EXTRA_PLAYING, true);
        }
        applyState();
        return START_NOT_STICKY;
    }

    private void applyState() {
        session.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, text)
                .build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_STOP)
                .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
                .build());

        Notification n = buildNotification();
        if (playing) {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OurSound::Playback");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) wakeLock.acquire();
            if (!noisyRegistered) {
                IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    registerReceiver(noisyReceiver, f, Context.RECEIVER_NOT_EXPORTED);
                } else {
                    registerReceiver(noisyReceiver, f);
                }
                noisyRegistered = true;
            }
            Log.i(TAG, "playing, wake lock held");
        } else {
            // Paused: let the phone sleep, keep a dismissable notification with a Play button.
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTIFICATION_ID, n);
            Log.i(TAG, "paused, wake lock released");
        }
    }

    private PendingIntent serviceIntent(String action, int code) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while OurSound is playing");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Action toggle = playing
                ? new NotificationCompat.Action(android.R.drawable.ic_media_pause, "Pause", serviceIntent(ACTION_PAUSE, 1))
                : new NotificationCompat.Action(android.R.drawable.ic_media_play, "Play", serviceIntent(ACTION_PLAY, 2));
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(playing ? text : "Paused · " + text)
                .setSmallIcon(playing ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause)
                .setContentIntent(pi)
                .setOngoing(playing)
                .setSilent(true)
                .addAction(toggle)
                .setStyle(new MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0))
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    /**
     * The app was swiped away from recent apps: stop playing. (The audio runs
     * in our own process, which this service keeps alive, so without this it
     * would keep playing after the app is "closed".)
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "app removed from recents: stopping playback");
        NativeAudio.INSTANCE.stopForAppClosed();
        handler.postDelayed(() -> {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
        }, 600);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(logTick);
        if (noisyRegistered) {
            unregisterReceiver(noisyReceiver);
            noisyRegistered = false;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        session.setActive(false);
        session.release();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(NOTIFICATION_ID);
        Log.i(TAG, "stopped");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
