package com.oursound.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import com.oursound.app.engine.AssetStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

@CapacitorPlugin(
        name = "Playback",
        permissions = {
                @Permission(alias = "audio", strings = { "android.permission.READ_MEDIA_AUDIO" }),
                @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        })
public class PlaybackPlugin extends Plugin {
    private static PlaybackPlugin instance;

    @Override
    public void load() {
        instance = this;
        NativeAudio.INSTANCE.init(getContext());
        NativeAudio.INSTANCE.setListener((status) -> notifyListeners("engineStatus", status));
    }

    // ------------------------------------------------------------ finding audio files on the phone

    private String audioAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    /** Lists every audio file Android knows about (asks for permission first). */
    /** Posts a feedback report to a Discord webhook: JSON body plus an optional text attachment. */
    @PluginMethod
    public void postFeedback(PluginCall call) {
        String url = call.getString("url");
        String payload = call.getString("payload", "{}");
        String fileName = call.getString("fileName");
        String fileText = call.getString("fileText");
        if (url == null || !url.matches("^https://[^/]+/api/webhooks/.+")) {
            call.reject("No feedback address set");
            return;
        }
        new Thread(() -> {
            java.net.HttpURLConnection c = null;
            try {
                String boundary = "----oursound" + System.nanoTime();
                c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                c.setDoOutput(true);
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                String crlf = "\r\n";
                StringBuilder b = new StringBuilder();
                b.append("--").append(boundary).append(crlf)
                        .append("Content-Disposition: form-data; name=\"payload_json\"").append(crlf)
                        .append("Content-Type: application/json").append(crlf).append(crlf)
                        .append(payload).append(crlf);
                if (fileName != null && fileText != null) {
                    b.append("--").append(boundary).append(crlf)
                            .append("Content-Disposition: form-data; name=\"files[0]\"; filename=\"")
                            .append(fileName.replace("\"", "")).append("\"").append(crlf)
                            .append("Content-Type: application/json").append(crlf).append(crlf)
                            .append(fileText).append(crlf);
                }
                b.append("--").append(boundary).append("--").append(crlf);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(b.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                if (code >= 200 && code < 300) call.resolve();
                else call.reject("Discord answered " + code);
            } catch (Exception e) {
                call.reject("Couldn't send: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void scanAudio(PluginCall call) {
        if (getPermissionState(audioAlias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(audioAlias(), call, "scanAudioPermission");
            return;
        }
        new Thread(() -> scanMediaStore(call), "OurSound-scan").start();
    }

    @PermissionCallback
    private void scanAudioPermission(PluginCall call) {
        if (getPermissionState(audioAlias()) != PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("denied", true);
            ret.put("files", new JSONArray());
            call.resolve(ret);
            return;
        }
        new Thread(() -> scanMediaStore(call), "OurSound-scan").start();
    }

    private void scanMediaStore(PluginCall call) {
        JSONArray files = new JSONArray();
        Uri base = android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String folderCol = Build.VERSION.SDK_INT >= 29 ? android.provider.MediaStore.MediaColumns.RELATIVE_PATH : android.provider.MediaStore.MediaColumns.DATA;
        String[] cols = {
                android.provider.MediaStore.MediaColumns._ID,
                android.provider.MediaStore.MediaColumns.DISPLAY_NAME,
                android.provider.MediaStore.MediaColumns.SIZE,
                android.provider.MediaStore.Audio.AudioColumns.DURATION,
                folderCol,
        };
        try (Cursor c = getContext().getContentResolver().query(base, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("uri", android.content.ContentUris.withAppendedId(base, c.getLong(0)).toString());
                    o.put("name", c.getString(1) != null ? c.getString(1) : "");
                    o.put("size", c.getLong(2));
                    o.put("duration", c.getLong(3) / 1000.0);
                    String folder = c.getString(4);
                    if (folder != null && Build.VERSION.SDK_INT < 29) folder = new File(folder).getParent();
                    o.put("folder", folder != null ? folder.replaceAll("/+$", "") : "");
                    files.put(o);
                } catch (Exception ignored) {
                }
            }
        } catch (Exception e) {
            call.reject("Couldn't search for music: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    /** Lets the user pick a folder, then lists the audio files in it (and its subfolders). */
    @PluginMethod
    public void scanFolder(PluginCall call) {
        startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "scanFolderResult");
    }

    @ActivityCallback
    private void scanFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri tree = data.getData();
        new Thread(() -> {
            JSONArray files = new JSONArray();
            java.util.ArrayDeque<String[]> todo = new java.util.ArrayDeque<>();
            todo.add(new String[] { android.provider.DocumentsContract.getTreeDocumentId(tree), "" });
            String[] cols = {
                    android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,
                    android.provider.DocumentsContract.Document.COLUMN_SIZE,
            };
            int seen = 0;
            while (!todo.isEmpty() && seen < 50000) {
                String[] dir = todo.poll();
                Uri kids = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir[0]);
                try (Cursor c = getContext().getContentResolver().query(kids, cols, null, null, null)) {
                    while (c != null && c.moveToNext()) {
                        seen++;
                        String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                        if (android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                            todo.add(new String[] { id, dir[1].isEmpty() ? name : dir[1] + "/" + name });
                        } else if ((mime != null && mime.startsWith("audio/")) || (name != null && name.matches("(?i).*\\.(flac|mp3|m4a|aac|ogg|opus|wav|aiff?|wma)$"))) {
                            JSONObject o = new JSONObject();
                            o.put("uri", android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                            o.put("name", name);
                            o.put("size", c.isNull(3) ? 0 : c.getLong(3));
                            o.put("folder", dir[1]);
                            files.put(o);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        }, "OurSound-scan").start();
    }

    /** Copies one found file (by uri) into OurSound. */
    @PluginMethod
    public void importAudioUri(PluginCall call) {
        String u = call.getString("uri");
        if (u == null) {
            call.reject("uri missing");
            return;
        }
        new Thread(() -> {
            try {
                call.resolve(NativeAudio.metaJson(copyIn(Uri.parse(u))));
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not import this file.");
            }
        }, "OurSound-import").start();
    }

    // ------------------------------------------------------------ native engine

    @PluginMethod
    public void engineLoad(PluginCall call) {
        JSObject tl = call.getObject("timeline");
        if (tl == null) {
            call.reject("timeline missing");
            return;
        }
        try {
            NativeAudio.INSTANCE.load(new JSONObject(tl.toString()));
            call.resolve();
        } catch (Exception e) {
            call.reject("could not load timeline: " + e.getMessage());
        }
    }

    @PluginMethod
    public void enginePlay(PluginCall call) {
        NativeAudio.INSTANCE.play(call.getDouble("fadeSeconds", 3.0));
        call.resolve();
    }

    @PluginMethod
    public void enginePause(PluginCall call) {
        NativeAudio.INSTANCE.pause(call.getDouble("fadeSeconds", 0.4));
        call.resolve();
    }

    @PluginMethod
    public void engineSeek(PluginCall call) {
        NativeAudio.INSTANCE.seek(call.getDouble("seconds", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void engineSetCap(PluginCall call) {
        NativeAudio.INSTANCE.setCap(call.getDouble("capDb", -12.0));
        call.resolve();
    }

    @PluginMethod
    public void engineSleep(PluginCall call) {
        Double seconds = call.getData().isNull("seconds") ? null : call.getDouble("seconds");
        NativeAudio.INSTANCE.setSleep(seconds, call.getDouble("fadeSeconds", 60.0));
        call.resolve();
    }

    @PluginMethod
    public void engineGetStatus(PluginCall call) {
        JSObject s = NativeAudio.INSTANCE.statusNow();
        call.resolve(s != null ? s : new JSObject());
    }

    @PluginMethod
    public void engineStatusEvery(PluginCall call) {
        NativeAudio.INSTANCE.setStatusEvery(call.getDouble("seconds", 0.25));
        call.resolve();
    }

    // ------------------------------------------------------------ sharing

    /** Google's code scanner (from Play services): no camera permission needed. */
    @PluginMethod
    public void scanQr(PluginCall call) {
        com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions opts =
                new com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                        .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE)
                        .build();
        com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(getActivity(), opts)
                .startScan()
                .addOnSuccessListener(barcode -> {
                    JSObject ret = new JSObject();
                    ret.put("text", barcode.getRawValue());
                    call.resolve(ret);
                })
                .addOnCanceledListener(() -> {
                    JSObject ret = new JSObject();
                    ret.put("cancelled", true);
                    call.resolve(ret);
                })
                .addOnFailureListener(e -> call.reject(e.getMessage() != null ? e.getMessage() : "The scanner isn't available."));
    }

    // ------------------------------------------------------------ imported audio (native)

    @PluginMethod
    public void listAssets(PluginCall call) {
        JSONArray a = new JSONArray();
        for (AssetStore.Meta m : AssetStore.INSTANCE.metas.values()) a.put(NativeAudio.metaJson(m));
        JSObject ret = new JSObject();
        ret.put("assets", a);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteAsset(PluginCall call) {
        try {
            NativeAudio.INSTANCE.deleteAsset(call.getString("id"));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Opens the system file picker; the chosen file is copied into the app and probed. */
    @PluginMethod
    public void importAudio(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("audio/*");
        startActivityForResult(call, i, "importResult");
    }

    @ActivityCallback
    private void importResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri uri = data.getData();
        new Thread(() -> {
            String id = "as_" + UUID.randomUUID();
            String name = displayName(uri);
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
            File dest = NativeAudio.INSTANCE.newAssetFile(id, ext);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 OutputStream out = new FileOutputStream(dest)) {
                if (in == null) throw new IllegalStateException("Could not open the file.");
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                AssetStore.Meta m = NativeAudio.INSTANCE.addAsset(id, name.replaceAll("\\.[^.]+$", ""), dest);
                call.resolve(NativeAudio.metaJson(m));
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                dest.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not import this file.");
            }
        }, "OurSound-import").start();
    }

    /** Opens the system file picker allowing several files (an album); keeps the picked order. */
    @PluginMethod
    public void importAudioMany(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("audio/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "importManyResult");
    }

    @ActivityCallback
    private void importManyResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (result.getResultCode() == android.app.Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        if (uris.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        new Thread(() -> {
            JSONArray assets = new JSONArray();
            JSONArray failed = new JSONArray();
            for (Uri uri : uris) {
                try {
                    assets.put(NativeAudio.metaJson(copyIn(uri)));
                } catch (Exception e) {
                    failed.put(displayName(uri) + ": " + (e.getMessage() != null ? e.getMessage() : "could not import"));
                }
            }
            JSObject ret = new JSObject();
            ret.put("assets", assets);
            ret.put("failed", failed);
            call.resolve(ret);
        }, "OurSound-import").start();
    }

    /** Copies one picked file into the app's storage and adds it to the library. */
    private AssetStore.Meta copyIn(Uri uri) throws Exception {
        String id = "as_" + UUID.randomUUID();
        String name = displayName(uri);
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
        File dest = NativeAudio.INSTANCE.newAssetFile(id, ext);
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(dest)) {
            if (in == null) throw new IllegalStateException("Could not open the file.");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return NativeAudio.INSTANCE.addAsset(id, name.replaceAll("\\.[^.]+$", ""), dest);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            dest.delete();
            throw e;
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        }
        return "Imported audio";
    }

    /** Called by PlaybackService for lock-screen / notification / headphone-button commands. */
    static void notifyRemote(String action) {
        PlaybackPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        p.notifyListeners("remote", data);
    }

    /** Called by PlaybackService when headphones disconnect. */
    static void notifyBecomingNoisy() {
        PlaybackPlugin p = instance;
        if (p != null) p.notifyListeners("becomingNoisy", new JSObject());
    }

    @PluginMethod
    public void startService(PluginCall call) {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            // Notification permission only affects whether the notification is visible;
            // the foreground service itself runs either way.
            ActivityCompat.requestPermissions(getActivity(),
                    new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4811);
        }
        Intent i = new Intent(ctx, PlaybackService.class)
                .setAction(PlaybackService.ACTION_UPDATE)
                .putExtra(PlaybackService.EXTRA_TITLE, call.getString("title", "OurSound"))
                .putExtra(PlaybackService.EXTRA_TEXT, call.getString("text", "Playing"))
                .putExtra(PlaybackService.EXTRA_PLAYING, true);
        ContextCompat.startForegroundService(ctx, i);
        call.resolve();
    }

    /** Paused: release the wake lock, keep a notification with a Play button. */
    @PluginMethod
    public void setPaused(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(ctx, PlaybackService.class)
                .setAction(PlaybackService.ACTION_UPDATE)
                .putExtra(PlaybackService.EXTRA_PLAYING, false);
        if (call.hasOption("text")) i.putExtra(PlaybackService.EXTRA_TEXT, call.getString("text"));
        try {
            ctx.startService(i);
        } catch (IllegalStateException e) {
            // app in the background without a running service: nothing to show
        }
        call.resolve();
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PlaybackService.class));
        call.resolve();
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject ret = new JSObject();
        ret.put("value", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(ret);
    }

    @SuppressLint("BatteryLife")
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(i);
        call.resolve();
    }
}
