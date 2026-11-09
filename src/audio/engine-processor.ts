/// <reference path="./worklet-globals.d.ts" />
// AudioWorklet host for the OurSound engine (runs on the audio thread).

import { assetCache, type AssetMeta } from '../engine/assets.ts';
import { Engine, type EngineStatus } from '../engine/core.ts';
import type { MasterSettings, Timeline } from '../engine/model.ts';

export type ToProcessor =
  | { type: 'load'; timeline: Timeline }
  | { type: 'master'; settings: MasterSettings }
  | { type: 'play'; fadeSeconds?: number }
  | { type: 'pause'; fadeSeconds?: number }
  | { type: 'sleep'; seconds: number | null; fadeSeconds?: number }
  | { type: 'seek'; seconds: number }
  | { type: 'assetMeta'; metas: AssetMeta[] }
  | { type: 'assetChunk'; id: string; idx: number; L: Float32Array; R: Float32Array }
  | { type: 'assetFailed'; id: string; idx: number }
  | { type: 'statusEvery'; seconds: number };

export type FromProcessor =
  | { type: 'status'; status: EngineStatus }
  /** Watchdog heartbeat: frames this processor has rendered vs the wall clock. */
  | { type: 'heartbeat'; frames: number; wallMs: number }
  /** Chunks of imported audio the engine needs decoded. */
  | { type: 'assetNeed'; requests: { id: string; idx: number }[] };

const STATUS_EVERY_SEC = 0.25; // default; slower while the screen is off
const HEARTBEAT_EVERY_SEC = 2;

class EngineProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate, 128);
  private frames = 0;
  private nextStatus = 0;
  private nextHeartbeat = 0;
  private statusEvery = STATUS_EVERY_SEC;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToProcessor>) => {
      const m = e.data;
      switch (m.type) {
        case 'load':
          this.engine.load(m.timeline);
          break;
        case 'master':
          this.engine.setMaster(m.settings);
          break;
        case 'play':
          this.engine.play(m.fadeSeconds);
          break;
        case 'pause':
          this.engine.pause(m.fadeSeconds);
          break;
        case 'sleep':
          this.engine.setSleepTimer(m.seconds, m.fadeSeconds);
          break;
        case 'seek':
          this.engine.seek(m.seconds);
          break;
        case 'assetMeta':
          for (const meta of m.metas) assetCache.meta.set(meta.id, meta);
          return;
        case 'assetChunk':
          assetCache.put(m.id, m.idx, m.L, m.R);
          return;
        case 'assetFailed':
          assetCache.forget(m.id, m.idx);
          return;
        case 'statusEvery':
          this.statusEvery = m.seconds;
          this.nextStatus = this.frames + m.seconds * sampleRate;
          return;
      }
      this.sendStatus();
    };
  }

  private sendStatus() {
    const msg: FromProcessor = { type: 'status', status: this.engine.status() };
    this.port.postMessage(msg);
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    this.engine.process(L, R, L.length);

    this.frames += L.length;
    assetCache.clock++;
    if ((assetCache.clock & 63) === 0) {
      const requests = assetCache.takeRequests();
      if (requests.length) {
        const msg: FromProcessor = { type: 'assetNeed', requests };
        this.port.postMessage(msg);
      }
      if ((assetCache.clock & 4095) === 0) assetCache.evict();
    }
    if (this.frames >= this.nextStatus) {
      this.nextStatus = this.frames + this.statusEvery * sampleRate;
      this.sendStatus();
    }
    if (this.frames >= this.nextHeartbeat) {
      this.nextHeartbeat = this.frames + HEARTBEAT_EVERY_SEC * sampleRate;
      const hb: FromProcessor = { type: 'heartbeat', frames: this.frames, wallMs: Date.now() };
      this.port.postMessage(hb);
    }
    return true;
  }
}

registerProcessor('oursound-engine', EngineProcessor);
