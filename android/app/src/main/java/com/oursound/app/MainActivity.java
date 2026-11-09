package com.oursound.app;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaybackPlugin.class);
        super.onCreate(savedInstanceState);
        // The audio engine runs in the WebView's renderer process. By default
        // Android lowers that process's priority when the WebView isn't visible
        // (screen off), which starves the audio thread and makes it stutter.
        // Keep it "important" (tied to our foreground playback service) at all times.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && getBridge() != null) {
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }
}
