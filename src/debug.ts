// Test hooks for on-device verification over the WebView debugger (adb).
// Only reachable through the developer tools connection; nothing in the UI uses it.

import { deleteAsset, importAudioFile, listAssets } from './audio/assets.ts';
import { useLibrary } from './store/library.ts';
import { activate, player, playTimeline, usePlayback } from './store/playback.ts';
import { TEMPLATES } from './templates.ts';

declare global {
  interface Window {
    __os?: Record<string, unknown>;
  }
}

window.__os = { useLibrary, usePlayback, player, playTimeline, activate, importAudioFile, listAssets, deleteAsset, TEMPLATES };
