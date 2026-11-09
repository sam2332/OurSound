// Player backed by the native Android engine (a classic audio thread writing
// to AudioTrack inside the app process). Same public API as the WebView
// Player, so the rest of the app doesn't care which one runs.

import type { EngineStatus } from '../engine/core.ts';
import type { MasterSettings, Timeline } from '../engine/model.ts';
import { NativeEngine, type NativeStatus } from '../native/engine-plugin.ts';
import { Playback } from '../native/playback.ts';
import type { SessionStats } from './player.ts';

const STATS_KEY = 'oursound.session';
const SERVICE_REASSERT_MS = 30_000;

function saveStats(s: SessionStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable
  }
}

type Listener = (status: EngineStatus, stats: SessionStats | null) => void;

export class NativePlayer {
  private timeline: Timeline | null = null;
  private wantPlaying = false;
  private status: EngineStatus = {
    playing: false,
    positionSec: 0,
    durationSec: 0,
    ended: false,
    limiterDb: 0,
    activeVoices: 0,
    sleepRemainingSec: null,
    stoppedBy: null,
  };
  playFadeSeconds = 3;
  chunksServed = 0;
  underruns = 0;
  private stats: SessionStats | null = null;
  private lastStatusWall = 0;
  private listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    void NativeEngine.addListener('engineStatus', (s) => this.onStatus(s));
    // The native side already paused; just mirror it.
    Playback.addListener('becomingNoisy', () => {
      if (!this.wantPlaying) return;
      if (this.stats) this.stats.headphoneDisconnects++;
      this.wantPlaying = false;
      this.emit();
    });
    document.addEventListener('visibilitychange', () => {
      void NativeEngine.engineStatusEvery({ seconds: document.hidden ? 5 : 0.25 });
      // Status messages can stall while the screen is off; pull the truth when it's back.
      if (!document.hidden) void NativeEngine.engineGetStatus().then((s) => s && this.onStatus(s));
      this.emit();
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private onStatus(s: NativeStatus) {
    const now = Date.now();
    if (this.stats && this.wantPlaying && s.playing) {
      const dt = (now - this.lastStatusWall) / 1000;
      if (dt > 0 && dt < 60) this.stats.playingSeconds += dt;
      this.stats.lastHeartbeatMs = now;
      saveStats(this.stats);
    }
    this.lastStatusWall = now;
    this.underruns = s.underruns;
    const { timelineId: _id, underruns: _u, ...status } = s;
    this.status = status;
    // The native engine manages the playback service itself; just mirror its state.
    const stoppedItself = s.ended || (!s.playing && s.stoppedBy === 'sleep');
    if (this.wantPlaying && stoppedItself) this.wantPlaying = false;
    void SERVICE_REASSERT_MS;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status, this.stats);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const fn of this.listeners) fn(this.status, this.stats);
  }

  load(timeline: Timeline) {
    return this.serial(async () => {
      const switching = this.timeline !== null && this.timeline.id !== timeline.id;
      if (switching && this.wantPlaying) await this.pauseNow();
      this.timeline = timeline;
      this.status = { ...this.status, durationSec: timeline.duration };
      await NativeEngine.engineLoad({ timeline });
      if (switching) {
        this.stats = null;
        this.status = { ...this.status, positionSec: 0 };
        await NativeEngine.engineSeek({ seconds: 0 });
      }
      this.emit();
    });
  }

  setMaster(settings: MasterSettings) {
    void NativeEngine.engineSetCap({ capDb: settings.capDb });
  }

  play() {
    return this.serial(async () => {
      this.wantPlaying = true;
      await NativeEngine.enginePlay({ fadeSeconds: this.playFadeSeconds });
      if (!this.stats || this.status.ended || this.status.positionSec === 0) {
        this.stats = {
          startedAtMs: Date.now(),
          lastHeartbeatMs: Date.now(),
          playingSeconds: 0,
          recoveries: 0,
          lastRecoveryReason: null,
          headphoneDisconnects: 0,
        };
        saveStats(this.stats);
      }
      this.lastStatusWall = Date.now();
      this.emit();
    });
  }

  pause() {
    return this.serial(() => this.pauseNow());
  }

  private async pauseNow() {
    this.wantPlaying = false;
    await NativeEngine.enginePause({});
    this.emit();
  }

  setSleepTimer(minutes: number | null) {
    const seconds = minutes === null ? null : minutes * 60;
    this.status = { ...this.status, sleepRemainingSec: seconds };
    void NativeEngine.engineSleep({ seconds, fadeSeconds: Math.min(60, (seconds ?? 60) / 2) });
    this.emit();
  }

  seek(seconds: number) {
    this.status = { ...this.status, positionSec: seconds };
    void NativeEngine.engineSeek({ seconds });
    this.emit();
  }

  /** Lock screen / headphones / audio focus: the native engine already acted. */
  syncRemote(action: 'play' | 'pause') {
    this.wantPlaying = action === 'play';
    this.emit();
  }

  get currentTimelineId() {
    return this.timeline?.id ?? null;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  get playing() {
    return this.wantPlaying;
  }
}
