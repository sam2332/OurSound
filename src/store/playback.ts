// Connects the library to the audio Player: which timeline is active, live
// updates while you edit it, and the transport state for the UI.

import { Capacitor } from '@capacitor/core';
import { create } from 'zustand';
import { NativePlayer } from '../audio/native-player.ts';
import { Player, loadSessionStats, type SessionStats } from '../audio/player.ts';
import type { EngineStatus } from '../engine/core.ts';
import { Playback } from '../native/playback.ts';
import { useLibrary } from './library.ts';
import { getTimeline } from './samples.ts';

// On the phone, audio runs in the native Android engine (an AudioTrack thread);
// in a desktop browser (development) it runs in the WebView engine.
export const player: Player | NativePlayer = Capacitor.isNativePlatform() ? new NativePlayer() : new Player();

type PlaybackState = {
  activeId: string | null;
  playing: boolean;
  status: EngineStatus;
  stats: SessionStats | null;
  lastSession: SessionStats | null;
  error: string | null;
};

export const usePlayback = create<PlaybackState>()(() => ({
  activeId: null,
  playing: false,
  status: player.getStatus(),
  stats: null,
  lastSession: loadSessionStats(),
  error: null,
}));

player.subscribe((status, stats) => {
  usePlayback.setState({ status, stats: stats ? { ...stats } : null, playing: player.playing });
});

/** Makes `id` the timeline in the player (without starting it). */
export async function activate(id: string) {
  const tl = getTimeline(id);
  if (!tl) return;
  usePlayback.setState({ activeId: id });
  await player.load(tl);
}

export async function playTimeline(id: string) {
  try {
    usePlayback.setState({ error: null });
    if (usePlayback.getState().activeId !== id) await activate(id);
    if (!player.playing) {
      await player.play();
      const sleep = useLibrary.getState().settings.defaultSleepMinutes;
      if (sleep !== null && player.getStatus().sleepRemainingSec === null) player.setSleepTimer(sleep);
    }
  } catch (err) {
    usePlayback.setState({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    usePlayback.setState({ playing: player.playing });
  }
}

export async function togglePlay(id?: string) {
  const target = id ?? usePlayback.getState().activeId;
  if (!target) return;
  if (player.playing && usePlayback.getState().activeId === target) {
    await player.pause();
    usePlayback.setState({ playing: false });
  } else {
    await playTimeline(target);
  }
}

/** Keeps the player in sync with library edits and settings. */
export function startPlaybackSync() {
  let lastTl = null as unknown;
  let lastSettings = null as unknown;
  const apply = () => {
    const lib = useLibrary.getState();
    const { activeId } = usePlayback.getState();
    if (lib.settings !== lastSettings) {
      lastSettings = lib.settings;
      player.setMaster({ capDb: lib.settings.capDb });
      player.playFadeSeconds = lib.settings.playFadeSeconds;
    }
    if (!activeId) return;
    const tl = getTimeline(activeId);
    if (!tl) {
      // active timeline was deleted
      void player.pause();
      usePlayback.setState({ activeId: null });
      return;
    }
    if (tl !== lastTl) {
      lastTl = tl;
      void player.load(tl);
    }
  };
  // Lock screen, notification and headphone buttons.
  const remote = Playback.addListener('remote', ({ action }) => {
    console.log(`[OS] media button / lock screen: ${action}`);
    if (player instanceof NativePlayer) {
      // the native engine has already played/paused; just reflect it in the UI
      player.syncRemote(action);
      usePlayback.setState({ playing: player.playing });
      return;
    }
    const id = usePlayback.getState().activeId;
    if (action === 'play' && id && !player.playing) void playTimeline(id);
    if (action === 'pause' && player.playing) void player.pause().then(() => usePlayback.setState({ playing: false }));
  });
  const a = useLibrary.subscribe(apply);
  const b = usePlayback.subscribe((s, prev) => s.activeId !== prev.activeId && apply());
  apply();
  return () => {
    a();
    b();
    void remote.then((h) => h.remove());
  };
}
