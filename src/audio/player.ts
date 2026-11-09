// Main-thread controller: owns the AudioContext, talks to the engine worklet,
// keeps the Android foreground service in step, and runs a watchdog that
// rebuilds the audio pipeline if Android/WebView audio misbehaves.
//
// Because the engine is time-pure, a rebuild resumes at exactly the same
// position and sounds the same; only a 1-second fade marks it.

import workletUrl from './engine-processor.ts?worker&url';
import type { FromProcessor, ToProcessor } from './engine-processor.ts';
import type { EngineStatus } from '../engine/core.ts';
import type { MasterSettings, Timeline } from '../engine/model.ts';
import { Playback } from '../native/playback.ts';
import { assetMetas, decodeChunk, listAssets, onAssetsChanged } from './assets.ts';

export const SAMPLE_RATE = 48000;

/** Health of the current listening session (persisted so it survives an app restart). */
export type SessionStats = {
  startedAtMs: number;
  lastHeartbeatMs: number;
  /** Wall-clock seconds spent playing. */
  playingSeconds: number;
  /** Times the watchdog rebuilt the audio pipeline. */
  recoveries: number;
  lastRecoveryReason: string | null;
  /** Times playback paused because headphones disconnected. */
  headphoneDisconnects: number;
};

const STATS_KEY = 'oursound.session';
// Watchdog thresholds.
// Android pre-fills a large output buffer when audio starts, and after a short
// CPU starvation Chrome catches up in a burst, so the audio clock can briefly
// run ahead of the wall clock. Rebuilding doesn't help with that (it causes an
// audible restart), so we only act on the real WebView fault, where audio runs
// at ~2x real time *for a sustained period*, or on a true stall.
const DRIFT_WARMUP_MS = 6000;
const DRIFT_MIN_WINDOW_SEC = 30; // judge the rate over at least this long
const DRIFT_FAULT_RATE = 1.6; // sustained rate that means the 2x fault
const STALL_MS = 15000; // no heartbeat for this long while playing = stalled
const REBUILD_MIN_GAP_MS = 60_000;
const REBUILD_MAX_PER_10MIN = 3;
const SERVICE_REASSERT_MS = 30_000; // keep the foreground service asserted while playing
const SUSPEND_AFTER_PAUSE_MS = 800;

export function loadSessionStats(): SessionStats | null {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? (JSON.parse(raw) as SessionStats) : null;
  } catch {
    return null;
  }
}

function saveSessionStats(s: SessionStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable
  }
}

type Listener = (status: EngineStatus, stats: SessionStats | null) => void;

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private timeline: Timeline | null = null;
  private master: MasterSettings = { capDb: -12 };
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
  /** Fade-in on Play, seconds (from settings). */
  playFadeSeconds = 3;
  private sleepFadeSeconds = 60;
  private stats: SessionStats | null = null;
  /** Drift baseline, taken once the warm-up is over (null = not armed yet). */
  private driftBase: { frames: number; wallMs: number } | null = null;
  private driftArmAt = 0;
  private lastHeartbeatWall = 0;
  private watchdogTimer: number | null = null;
  private suspendTimer: number | null = null;
  private rebuilding = false;
  private rebuildTimes: number[] = [];
  private lastServiceAssert = 0;
  private listeners = new Set<Listener>();
  /** Every transport operation runs in order, one at a time (no races). */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor() {
    Playback.addListener('becomingNoisy', () => {
      // Headphones disconnected: pause rather than play out of the phone speaker.
      if (!this.wantPlaying) return;
      if (this.stats) this.stats.headphoneDisconnects++;
      console.log('[OS] headphones disconnected, pausing');
      void this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      // Fewer status updates while nobody is looking (saves battery overnight).
      this.send({ type: 'statusEvery', seconds: document.hidden ? 5 : 0.25 });
      this.emit();
    });
    onAssetsChanged((list) => this.send({ type: 'assetMeta', metas: assetMetas(list) }));
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (this.wantPlaying) void this.requestRebuild('audio device changed');
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status, this.stats);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    // Nobody can see the UI with the screen off: skip re-rendering to save battery.
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const fn of this.listeners) fn(this.status, this.stats);
  }

  private send(msg: ToProcessor) {
    this.node?.port.postMessage(msg);
  }

  // ------------------------------------------------------------ pipeline

  private async buildPipeline() {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    if (!ctx.audioWorklet) throw new Error('AudioWorklet is not supported in this WebView');
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'oursound-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<FromProcessor>) => this.onMessage(e.data);
    ctx.onstatechange = () => {
      console.log(`[OS] context state -> ${ctx.state}`);
      if (this.wantPlaying && ctx === this.ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
        // Android interrupted us (e.g. a call or audio focus change): try to resume.
        ctx.resume().catch(() => void this.requestRebuild(`context ${ctx.state}`));
      }
    };
    this.ctx = ctx;
    this.node = node;
    this.resetDrift();
    this.lastHeartbeatWall = Date.now();
    if (this.timeline) this.send({ type: 'load', timeline: this.timeline });
    this.send({ type: 'master', settings: this.master });
    void listAssets().then((list) => this.send({ type: 'assetMeta', metas: assetMetas(list) }));
    // Resume where we were (also covers seeks made before the first Play).
    this.send({ type: 'seek', seconds: this.status.positionSec });
    if (this.status.sleepRemainingSec !== null) {
      this.send({ type: 'sleep', seconds: this.status.sleepRemainingSec, fadeSeconds: this.sleepFadeSeconds });
    }
  }

  private async teardown() {
    const ctx = this.ctx;
    const node = this.node;
    this.ctx = null;
    this.node = null;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    if (ctx) {
      ctx.onstatechange = null;
      await ctx.close().catch(() => undefined);
    }
  }

  /** Rate-limited rebuild request (a restart is audible, so never loop on it). */
  private requestRebuild(reason: string) {
    const now = Date.now();
    this.rebuildTimes = this.rebuildTimes.filter((t) => now - t < 600_000);
    const last = this.rebuildTimes[this.rebuildTimes.length - 1] ?? 0;
    if (this.rebuilding || now - last < REBUILD_MIN_GAP_MS || this.rebuildTimes.length >= REBUILD_MAX_PER_10MIN) {
      console.log(`[OS] watchdog: not rebuilding (${reason}): rate-limited`);
      return Promise.resolve();
    }
    this.rebuildTimes.push(now);
    return this.serial(() => this.rebuild(reason));
  }

  /** Rebuilds the whole audio pipeline and resumes at the current position. */
  private async rebuild(reason: string) {
    if (this.rebuilding || !this.wantPlaying) return;
    this.rebuilding = true;
    try {
      const pos = this.status.positionSec;
      console.log(`[OS] watchdog: rebuilding audio (${reason}) at ${pos.toFixed(1)}s`);
      if (this.stats) {
        this.stats.recoveries++;
        this.stats.lastRecoveryReason = reason;
        saveSessionStats(this.stats);
      }
      await this.teardown();
      await this.buildPipeline();
      if (this.wantPlaying) {
        await this.ctx!.resume();
        this.send({ type: 'play', fadeSeconds: 1 });
      }
    } catch (err) {
      console.error('[OS] rebuild failed', err);
    } finally {
      this.rebuilding = false;
      this.emit();
    }
  }

  // ------------------------------------------------------------ messages & watchdog

  private onMessage(m: FromProcessor) {
    if (m.type === 'status') {
      this.status = m.status;
      const stoppedItself = m.status.ended || (!m.status.playing && m.status.stoppedBy === 'sleep');
      if (this.wantPlaying && stoppedItself) {
        this.wantPlaying = false;
        void this.serial(() => this.afterStop());
      }
      this.emit();
      return;
    }
    if (m.type === 'assetNeed') {
      for (const { id, idx } of m.requests) void this.serveChunk(id, idx);
      return;
    }
    // heartbeat
    const now = m.wallMs;
    if (this.stats && this.wantPlaying) {
      const dt = (now - this.lastHeartbeatWall) / 1000;
      if (dt > 0 && dt < 60) this.stats.playingSeconds += dt;
      this.stats.lastHeartbeatMs = now;
      saveSessionStats(this.stats);
    }
    this.lastHeartbeatWall = now;
    // Belt and braces: keep the foreground service (and its CPU priority) asserted.
    if (this.wantPlaying && now - this.lastServiceAssert > SERVICE_REASSERT_MS) {
      this.lastServiceAssert = now;
      void Playback.startService({ title: 'OurSound', text: this.timeline?.name ?? 'Playing' });
    }
    if (!this.wantPlaying || this.ctx?.state !== 'running') {
      this.resetDrift();
      return;
    }
    if (!this.driftBase) {
      if (now >= this.driftArmAt) this.driftBase = { frames: m.frames, wallMs: now };
      return;
    }
    const audioSec = (m.frames - this.driftBase.frames) / SAMPLE_RATE;
    const wallSec = (now - this.driftBase.wallMs) / 1000;
    if (wallSec < DRIFT_MIN_WINDOW_SEC) return;
    const rate = audioSec / wallSec;
    if (rate > DRIFT_FAULT_RATE) {
      void this.requestRebuild(`audio running ${rate.toFixed(2)}x real time for ${wallSec.toFixed(0)}s`);
    } else if (rate < 1.05 && rate > 0.95) {
      // healthy: slide the window forward so old catch-up bursts don't linger
      this.driftBase = { frames: m.frames, wallMs: now };
    }
  }

  /** Imported-audio chunks decoded and delivered (for diagnostics). */
  chunksServed = 0;

  /** Decodes a chunk of an imported file and hands it to the audio thread. */
  private async serveChunk(id: string, idx: number) {
    const node = this.node;
    try {
      const chunk = await decodeChunk(id, idx);
      if (!chunk || this.node !== node) throw new Error('unavailable');
      node?.port.postMessage({ type: 'assetChunk', id, idx, L: chunk.L, R: chunk.R } satisfies ToProcessor, [
        chunk.L.buffer,
        chunk.R.buffer,
      ]);
      this.chunksServed++;
    } catch (err) {
      if ((err as Error).message !== 'unavailable') console.error(`[OS] could not decode ${id} chunk ${idx}`, err);
      if (this.node === node) node?.port.postMessage({ type: 'assetFailed', id, idx } satisfies ToProcessor);
    }
  }

  private resetDrift() {
    this.driftBase = null;
    this.driftArmAt = Date.now() + DRIFT_WARMUP_MS;
  }

  private startWatchdog() {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = window.setInterval(() => {
      if (!this.wantPlaying || this.rebuilding) return;
      if (Date.now() - this.lastHeartbeatWall > STALL_MS) {
        void this.requestRebuild('audio stalled');
      }
    }, 2000);
  }

  private stopWatchdog() {
    if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  // ------------------------------------------------------------ public API

  /**
   * Loads (or live-updates) the timeline to play. Switching to a different
   * timeline stops playback and starts it from the beginning.
   */
  load(timeline: Timeline) {
    return this.serial(() => this.loadNow(timeline));
  }

  private async loadNow(timeline: Timeline) {
    const switching = this.timeline !== null && this.timeline.id !== timeline.id;
    if (switching && this.wantPlaying) await this.pauseNow();
    this.timeline = timeline;
    this.status = { ...this.status, durationSec: timeline.duration };
    this.send({ type: 'load', timeline });
    if (switching) {
      this.stats = null;
      this.seek(0);
    }
    this.emit();
  }

  setMaster(settings: MasterSettings) {
    this.master = settings;
    this.send({ type: 'master', settings });
  }

  play() {
    return this.serial(() => this.playNow());
  }

  private async playNow() {
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (!this.ctx) await this.buildPipeline();
    this.wantPlaying = true;
    await this.ctx!.resume();
    this.send({ type: 'play', fadeSeconds: this.playFadeSeconds });
    this.lastHeartbeatWall = Date.now();
    this.resetDrift();
    if (!this.stats || this.status.ended || this.status.positionSec === 0) {
      this.stats = {
        startedAtMs: Date.now(),
        lastHeartbeatMs: Date.now(),
        playingSeconds: 0,
        recoveries: 0,
        lastRecoveryReason: null,
        headphoneDisconnects: 0,
      };
      saveSessionStats(this.stats);
    }
    this.startWatchdog();
    this.lastServiceAssert = Date.now();
    await Playback.startService({ title: 'OurSound', text: this.timeline?.name ?? 'Playing' });
    this.emit();
  }

  pause() {
    return this.serial(() => this.pauseNow());
  }

  private async pauseNow() {
    this.wantPlaying = false;
    this.send({ type: 'pause' });
    await this.afterStop();
  }

  private async afterStop() {
    this.stopWatchdog();
    if (this.wantPlaying) return; // a Play came in meanwhile: stay foreground
    // Keep a paused notification (with Play) so lock-screen controls still work.
    await Playback.setPaused({ text: this.timeline?.name ?? '' });
    // Let the fade-out finish, then suspend the context to save battery.
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = null;
      if (!this.wantPlaying) void this.ctx?.suspend();
    }, SUSPEND_AFTER_PAUSE_MS);
    this.emit();
  }

  /** Stops playback after `minutes` of playing (fading out over the last minute). null cancels. */
  setSleepTimer(minutes: number | null) {
    const seconds = minutes === null ? null : minutes * 60;
    this.sleepFadeSeconds = Math.min(60, (seconds ?? 60) / 2);
    this.status = { ...this.status, sleepRemainingSec: seconds };
    this.send({ type: 'sleep', seconds, fadeSeconds: this.sleepFadeSeconds });
    this.emit();
  }

  get currentTimelineId(): string | null {
    return this.timeline?.id ?? null;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  seek(seconds: number) {
    this.status = { ...this.status, positionSec: seconds };
    this.send({ type: 'seek', seconds });
    this.emit();
  }

  get playing() {
    return this.wantPlaying;
  }
}
