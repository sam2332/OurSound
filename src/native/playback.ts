import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Native Android plugin (android/app/src/main/java/com/oursound/app/PlaybackPlugin.java).
 * Runs a foreground "media playback" service with a notification and a partial
 * wake lock so the app keeps playing with the screen locked.
 */
export interface PlaybackPlugin {
  startService(options: { title: string; text: string }): Promise<void>;
  stopService(): Promise<void>;
  /** Paused state: no wake lock, notification shows a Play button. */
  setPaused(options?: { text?: string }): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<{ value: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  /** 'becomingNoisy' fires when headphones disconnect (audio would move to the speaker). */
  addListener(event: 'becomingNoisy', fn: () => void): Promise<PluginListenerHandle>;
  /** Lock screen, notification or headphone-button command. */
  addListener(event: 'remote', fn: (e: { action: 'play' | 'pause' }) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<PlaybackPlugin>('Playback');

const isNative = Capacitor.isNativePlatform();

/** Safe wrappers: no-ops in a desktop browser (vite dev). */
export const Playback: PlaybackPlugin = {
  startService: (o) => (isNative ? native.startService(o) : Promise.resolve()),
  stopService: () => (isNative ? native.stopService() : Promise.resolve()),
  setPaused: (o) => (isNative ? native.setPaused(o) : Promise.resolve()),
  isIgnoringBatteryOptimizations: () =>
    isNative ? native.isIgnoringBatteryOptimizations() : Promise.resolve({ value: true }),
  requestIgnoreBatteryOptimizations: () =>
    isNative ? native.requestIgnoreBatteryOptimizations() : Promise.resolve(),
  addListener: ((event: 'becomingNoisy' | 'remote', fn: (e: never) => void) =>
    isNative
      ? native.addListener(event as 'remote', fn as (e: { action: 'play' | 'pause' }) => void)
      : Promise.resolve({ remove: async () => {} })) as PlaybackPlugin['addListener'],
};
