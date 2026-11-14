// The OurSound engine: renders a Timeline block by block from the current
// position. Pure TypeScript with no Web Audio dependency, so it runs inside
// the AudioWorklet on the phone and inside Vitest on the PC.

import { Param } from './automation.ts';
import { GENERATORS, type ParamReader, type Voice } from './generators.ts';
import { childSeed } from './hash.ts';
import type { AutomationLane, MasterSettings, Segment, Soundtrack, Timeline } from './model.ts';
import { Limiter } from './limiter.ts';
import { activeInstances, type Instance } from './repeat.ts';
import { assetCache } from './assets.ts';

/** How far ahead (s) upcoming audio-file plays get their first chunks decoded. */
const PREFETCH_LEADS = [0.5, 4, 12];

// Focus mix: how the background follows the lead's loudness.
const DUCK_ATTACK = 0.4; // s, dipping when the music gets loud
const DUCK_RELEASE = 2.5; // s, coming back in quiet parts
const DUCK_FLOOR_DB = -50; // lead level (block RMS, dBFS) where dipping starts
const DUCK_RANGE_DB = 24; // ...and is full this much above it
// "Fill the quiet": tracks that come in when the music drops well below its recent level.
const FILL_SHORT = 0.6; // s, how fast fill tracks hear the music go quiet
const FILL_AVG_UP = 20; // s, the recent level rises this slowly...
const FILL_AVG_DOWN = 90; // s, ...and forgets loud parts this slowly
const FILL_FROM_DB = 6; // dB under the recent level where fill tracks start coming in
const FILL_RANGE_DB = 8; // ...and are fully in this much further down
const FILL_DEPTH_DB = 40; // how far down fill tracks sit while the music plays
const FILL_IN = 3; // s, fading in
const FILL_OUT = 0.5; // s, getting out of the way

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));

/** Hard upper bound for the cap, whatever the settings say. */
export const ABSOLUTE_MAX_CAP_DB = -1;
export const DEFAULT_CAP_DB = -12;

const PLAY_FADE_IN = 3; // s, every press of Play fades in from silence
const PAUSE_FADE_OUT = 0.4; // s
const SEEK_FADE = 0.03; // s, dip out/in around a jump
/** 'wake' end: volume rises by this much over the last WAKE_SECONDS (the cap still applies). */
const WAKE_RISE_DB = 9;
const WAKE_SECONDS = 15 * 60;

// ------------------------------------------------------------ compiled form

type LaneParam = { param: Param; span: boolean };

type CompiledSegment = {
  seg: Segment;
  laneParams: Map<string, LaneParam>;
  gain: LaneParam | null; // dB offset automation
  /** Last time this segment can be sounding (Infinity for open-ended repeats). */
  end: number;
};

type CompiledTrack = {
  track: Soundtrack;
  gainAuto: Param | null; // dB offset in timeline time
  panAuto: Param | null; // pan (-1..1) in timeline time
  panL: number;
  panR: number;
  /** Focus mix roles. */
  lead: boolean;
  follow: boolean;
  /** Only plays in the lead's quiet moments. */
  fill: boolean;
  segments: CompiledSegment[];
};

function lanesFor(lanes: AutomationLane[]): Map<string, LaneParam> {
  const m = new Map<string, LaneParam>();
  for (const l of lanes) {
    if (l.points.length === 0) continue;
    m.set(l.param, { param: new Param(l.points[0].v, l.points), span: l.scope === 'span' });
  }
  return m;
}

function segmentEnd(seg: Segment): number {
  const r = seg.repeat;
  if (r.mode === 'none') return seg.start + seg.length;
  if (r.count != null) {
    const gap = r.mode === 'interval' ? r.every : r.maxGap;
    return seg.start + (r.count - 1) * gap + seg.length + 1;
  }
  if (r.until != null) return r.until + seg.length + (r.mode === 'random' ? r.maxGap : 0);
  return Infinity;
}

function compileTimeline(tl: Timeline): CompiledTrack[] {
  return tl.soundtracks.map((track) => {
    const trackLanes = lanesFor(track.automation);
    // Balance law: center = unity on both sides, channels are never summed.
    const pan = Math.max(-1, Math.min(1, track.pan));
    return {
      track,
      gainAuto: trackLanes.get('gain')?.param ?? null,
      panAuto: trackLanes.get('pan')?.param ?? null,
      panL: Math.min(1, 1 - pan),
      panR: Math.min(1, 1 + pan),
      lead: tl.focus?.lead === track.id,
      follow:
        !!tl.focus && tl.focus.lead !== track.id && tl.focus.follow.includes(track.id) && !tl.focus.fill?.includes(track.id),
      fill: !!tl.focus && tl.focus.lead !== track.id && !!tl.focus.fill?.includes(track.id),
      // Segments of a type this build can't play are skipped, never fatal.
      segments: track.segments.filter((seg) => GENERATORS[seg.generator] !== undefined).map((seg) => {
        const laneParams = lanesFor(seg.automation);
        const gain = laneParams.get('gain') ?? null;
        laneParams.delete('gain');
        return { seg, laneParams, gain, end: segmentEnd(seg) };
      }),
    };
  });
}

/** Fade gain for progress x in [0, 1] (0 = silent end, 1 = full). */
export function fadeShape(curve: string, x: number): number {
  switch (curve) {
    case 'linear':
      return x;
    case 'smooth':
      return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case 'gentle':
      return x * x;
    default:
      return Math.sin((Math.PI / 2) * x); // equal-power
  }
}

// ------------------------------------------------------------ voices

type LiveVoice = {
  voice: Voice;
  inst: Instance;
  seg: CompiledSegment;
  lastBlock: number;
};

/** Binds a segment param to an instance: lane time → instance-local time. */
function makeReader(cs: CompiledSegment, name: string, instStart: number): ParamReader {
  const lane = cs.laneParams.get(name);
  const fallback = cs.seg.params[name] ?? defaultFor(cs.seg, name);
  if (!lane) {
    return { value: () => fallback, integral: (t) => fallback * t };
  }
  const p = lane.param;
  // 'span' lanes run from the segment's first start; 'instance' lanes restart each repeat.
  const offset = lane.span ? instStart - cs.seg.start : 0;
  const base = p.integral(offset);
  return {
    value: (t) => p.value(t + offset),
    integral: (t) => p.integral(t + offset) - base,
  };
}

function defaultFor(seg: Segment, name: string): number {
  return GENERATORS[seg.generator]?.params.find((d) => d.name === name)?.default ?? 0;
}

function createVoice(cs: CompiledSegment, inst: Instance): Voice {
  const def = GENERATORS[cs.seg.generator]!;
  const readers: Record<string, ParamReader> = {};
  for (const d of def.params) readers[d.name] = makeReader(cs, d.name, inst.start);
  return def.create(readers, childSeed(cs.seg.seed, inst.k), cs.seg);
}

// ------------------------------------------------------------ engine

export type EngineStatus = {
  playing: boolean;
  positionSec: number;
  durationSec: number;
  ended: boolean;
  /** Current limiter gain reduction in dB (0 = not limiting). */
  limiterDb: number;
  activeVoices: number;
  /** Seconds until the sleep timer stops playback (null = no timer). */
  sleepRemainingSec: number | null;
  /** Why playback last stopped on its own. */
  stoppedBy: 'end' | 'sleep' | null;
};

type Transport = 'stopped' | 'playing' | 'pausing';

export class Engine {
  readonly sr: number;
  private timeline: Timeline | null = null;
  private tracks: CompiledTrack[] = [];
  private voices = new Map<string, LiveVoice>();

  /** Position in samples. A double: exact up to 2^53 samples (~5,000 years at 48 kHz). */
  private pos = 0;
  private transport: Transport = 'stopped';
  private ended = false;
  private blockCount = 0;

  private masterGain = 1;
  private readonly limiter: Limiter;

  // Transport envelope (play fade-in / pause fade-out / seek dip).
  private env = 0;
  private envTarget = 0;
  private envStep = 0;
  private pendingSeek: number | null = null;

  // Sleep timer: counts down in played samples (exact, unaffected by app throttling).
  private sleepRemaining: number | null = null;
  private sleepFade = 60;
  private stoppedBy: 'end' | 'sleep' | null = null;

  // Scratch buffers (allocated once; the audio thread must not allocate per block).
  private vL: Float32Array;
  private vR: Float32Array;
  private tL: Float32Array;
  private tR: Float32Array;
  private gainBuf: Float32Array;
  private instScratch: Instance[] = [];
  private instScratch2: Instance[] = [];
  private instScratchP: Instance[] = [];
  // Focus mix state: smoothed lead power and the current background dip (dB).
  private duckPow = 0;
  private duckDb = 0;
  // Fill tracks: the lead's recent (slow) power and their current level (dB).
  private avgPow = 0;
  private shortPow = 0;
  private fillDb = 0;

  constructor(sampleRate: number, maxBlock = 512) {
    this.sr = sampleRate;
    this.vL = new Float32Array(maxBlock);
    this.vR = new Float32Array(maxBlock);
    this.tL = new Float32Array(maxBlock);
    this.tR = new Float32Array(maxBlock);
    this.gainBuf = new Float32Array(maxBlock);
    this.limiter = new Limiter(sampleRate, dbToGain(DEFAULT_CAP_DB));
  }

  // ---------------------------------------------------------- control

  load(tl: Timeline) {
    this.timeline = tl;
    this.tracks = compileTimeline(tl);
    // the lead plays first, so the background can follow it within the same block
    const li = this.tracks.findIndex((t) => t.lead);
    if (li > 0) this.tracks.unshift(...this.tracks.splice(li, 1));
    this.masterGain = dbToGain(tl.masterGainDb);
    // Voices are re-created from the new settings; tone phase is analytic,
    // so this is seamless.
    this.voices.clear();
  }

  setMaster(settings: MasterSettings) {
    this.limiter.ceiling = dbToGain(Math.min(settings.capDb, ABSOLUTE_MAX_CAP_DB));
  }

  /** Starts playback, fading in from silence over `fadeSeconds`. */
  play(fadeSeconds = PLAY_FADE_IN) {
    if (!this.timeline) return;
    if (this.ended) {
      this.ended = false;
      this.pos = 0;
    }
    this.transport = 'playing';
    this.stoppedBy = null;
    if (fadeSeconds <= 0) {
      this.env = this.envTarget = 1;
      return;
    }
    this.env = 0;
    this.rampTo(1, fadeSeconds);
  }

  pause(fadeSeconds = PAUSE_FADE_OUT) {
    if (this.transport !== 'playing') return;
    this.transport = 'pausing';
    this.rampTo(0, fadeSeconds);
  }

  /**
   * Stops playback after `seconds` of playing time, fading out over the last
   * `fadeSeconds` (or less if the timer is shorter). null cancels the timer.
   */
  setSleepTimer(seconds: number | null, fadeSeconds = 60) {
    this.sleepRemaining = seconds === null ? null : Math.max(0, seconds) * this.sr;
    this.sleepFade = fadeSeconds;
    // Cancelling during the fade-out brings the volume back.
    if (seconds === null && this.transport === 'playing' && this.envTarget < 1 && this.pendingSeek === null) {
      this.rampTo(1, 2);
    }
  }

  seek(seconds: number) {
    const dur = this.timeline?.duration ?? 0;
    const target = Math.max(0, Math.min(seconds, dur)) * this.sr;
    this.ended = false;
    if (this.transport !== 'playing') {
      this.pos = target;
      this.voices.clear();
      return;
    }
    this.pendingSeek = target;
    this.rampTo(0, SEEK_FADE);
  }

  status(): EngineStatus {
    return {
      playing: this.transport === 'playing',
      positionSec: this.pos / this.sr,
      durationSec: this.timeline?.duration ?? 0,
      ended: this.ended,
      limiterDb: gainToDb(this.limiter.gain),
      activeVoices: this.voices.size,
      sleepRemainingSec: this.sleepRemaining === null ? null : this.sleepRemaining / this.sr,
      stoppedBy: this.stoppedBy,
    };
  }

  private rampTo(target: number, seconds: number) {
    this.envTarget = target;
    this.envStep = 1 / Math.max(1, seconds * this.sr);
  }

  // ---------------------------------------------------------- rendering

  /** Renders n samples (n <= maxBlock). Returns false when fully stopped. */
  process(outL: Float32Array, outR: Float32Array, n: number): boolean {
    if (this.transport === 'stopped' || !this.timeline) {
      outL.fill(0, 0, n);
      outR.fill(0, 0, n);
      return false;
    }
    this.blockCount++;
    this.renderMix(outL, outR, n);
    this.applyMaster(outL, outR, n);

    this.pos += n;
    if (this.sleepRemaining !== null && this.transport === 'playing') {
      const fadeSamples = Math.min(this.sleepFade * this.sr, this.sleepRemaining);
      this.sleepRemaining = Math.max(0, this.sleepRemaining - n);
      if (this.sleepRemaining <= fadeSamples && this.envTarget !== 0) {
        // Fade over whatever time is left; the envelope hitting 0 stops playback.
        this.rampTo(0, Math.max(this.sleepRemaining, n) / this.sr);
        this.envTarget = 0;
      }
      if (this.sleepRemaining === 0) {
        this.sleepRemaining = null;
        this.stoppedBy = 'sleep';
        this.transport = this.env === 0 ? 'stopped' : 'pausing';
        this.rampTo(0, PAUSE_FADE_OUT);
      }
    }
    const tl = this.timeline;
    if (this.pos >= tl.duration * this.sr && this.pendingSeek === null) {
      if (tl.endBehavior === 'loop') {
        this.pendingSeek = 0;
        this.rampTo(0, SEEK_FADE);
      } else if (this.transport === 'playing') {
        this.ended = true;
        this.stoppedBy = 'end';
        this.transport = 'pausing';
        this.rampTo(0, PAUSE_FADE_OUT);
      }
    }
    return true;
  }

  /**
   * Asks for the opening chunks of imported audio that starts soon (the next
   * album track, a repeat), so it's decoded before it plays instead of
   * starting with a gap. Playing sources keep their own look-ahead.
   */
  private prefetchFiles(t0: number) {
    const tl = this.timeline;
    if (!tl) return;
    for (const ct of this.tracks) {
      for (const cs of ct.segments) {
        const seg = cs.seg;
        if (seg.generator !== 'file' || !seg.assetId) continue;
        const m = assetCache.meta.get(seg.assetId);
        if (!m) continue;
        for (const lead of PREFETCH_LEADS) {
          let t = t0 + lead;
          if (t >= tl.duration) {
            if (tl.endBehavior !== 'loop') continue;
            t -= tl.duration;
          }
          if (t < seg.start || t >= cs.end) continue;
          for (const inst of activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t, this.instScratchP)) {
            const local = t - inst.start;
            if (local > lead + 0.25) continue;
            const at = (seg.params.offset ?? 0) + local * (seg.params.speed ?? 1);
            const idx = Math.floor((at * m.sampleRate) / assetCache.chunkFrames(m));
            assetCache.request(m.id, idx);
            assetCache.request(m.id, idx + 1);
          }
        }
      }
    }
  }

  /** Follows the lead's loudness and sets how far the background dips. */
  private updateDuck(leadPow: number, n: number) {
    const f = this.timeline?.focus;
    if (!f) {
      this.duckPow = 0;
      this.duckDb = 0;
      this.avgPow = 0;
      this.shortPow = 0;
      this.fillDb = 0;
      return;
    }
    const time = leadPow > this.duckPow ? DUCK_ATTACK : DUCK_RELEASE;
    this.duckPow += (leadPow - this.duckPow) * (1 - Math.exp(-n / (this.sr * time)));
    const level = 10 * Math.log10(this.duckPow + 1e-12);
    const amount = Math.min(1, Math.max(0, (level - DUCK_FLOOR_DB) / DUCK_RANGE_DB));
    this.duckDb = -f.duckDb * amount;
    // Fill tracks: in when the music is far under its recent level, or silent.
    const avgTime = leadPow > this.avgPow ? FILL_AVG_UP : FILL_AVG_DOWN;
    this.avgPow += (leadPow - this.avgPow) * (1 - Math.exp(-n / (this.sr * avgTime)));
    this.shortPow += (leadPow - this.shortPow) * (1 - Math.exp(-n / (this.sr * FILL_SHORT)));
    const avg = 10 * Math.log10(this.avgPow + 1e-12);
    const now = 10 * Math.log10(this.shortPow + 1e-12);
    const quiet = now < DUCK_FLOOR_DB ? 1 : Math.min(1, Math.max(0, (avg - now - FILL_FROM_DB) / FILL_RANGE_DB));
    const target = -FILL_DEPTH_DB * (1 - quiet);
    const fillTime = target > this.fillDb ? FILL_IN : FILL_OUT;
    this.fillDb += (target - this.fillDb) * (1 - Math.exp(-n / (this.sr * fillTime)));
  }

  private renderMix(outL: Float32Array, outR: Float32Array, n: number) {
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    const sr = this.sr;
    const t0 = this.pos / sr;
    const t1 = (this.pos + n - 1) / sr;
    if (this.blockCount % 64 === 1) this.prefetchFiles(t0);
    const anySolo = this.tracks.some((t) => t.track.solo);
    const focus = this.timeline?.focus;
    const duckFrom = this.duckDb;
    const fillFrom = this.fillDb;
    let leadPow = 0;
    let duckUpdated = false;

    for (const ct of this.tracks) {
      const tr = ct.track;
      if ((ct.follow || ct.fill) && !duckUpdated) {
        this.updateDuck(leadPow, n);
        duckUpdated = true;
      }
      if (tr.mute || (anySolo && !tr.solo)) continue;
      let trackDbStart = tr.gainDb + (ct.gainAuto ? ct.gainAuto.value(t0) : 0);
      let trackDbEnd = tr.gainDb + (ct.gainAuto ? ct.gainAuto.value(t1) : 0);
      if (ct.follow && focus) {
        trackDbStart += focus.levelDb + duckFrom;
        trackDbEnd += focus.levelDb + this.duckDb;
      } else if (ct.fill && focus) {
        trackDbStart += fillFrom;
        trackDbEnd += this.fillDb;
      }
      const tg0 = dbToGain(trackDbStart);
      const tg1 = dbToGain(trackDbEnd);
      let touched = false;
      this.tL.fill(0, 0, n);
      this.tR.fill(0, 0, n);

      for (const cs of ct.segments) {
        const seg = cs.seg;
        if (t1 < seg.start || t0 >= cs.end) continue;
        // Instances sounding at the block start, plus any starting inside the block.
        const a = activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t0, this.instScratch);
        const b = activeInstances(seg.start, seg.length, seg.repeat, seg.seed, t1, this.instScratch2);
        for (const inst of a) touched = this.renderInstance(cs, inst, t0, n) || touched;
        for (const inst of b) {
          if (a.some((x) => x.k === inst.k)) continue;
          touched = this.renderInstance(cs, inst, t0, n) || touched;
        }
      }

      if (!touched) continue;
      let panL = ct.panL;
      let panR = ct.panR;
      if (ct.panAuto) {
        // balance law, never summing channels (keeps binaural intact)
        const pan = Math.max(-1, Math.min(1, ct.panAuto.value(t0)));
        panL = Math.min(1, 1 - pan);
        panR = Math.min(1, 1 + pan);
      }
      const dg = (tg1 - tg0) / n;
      if (ct.lead) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const g = tg0 + dg * i;
          const l = this.tL[i] * g * panL;
          const r = this.tR[i] * g * panR;
          outL[i] += l;
          outR[i] += r;
          sum += l * l + r * r;
        }
        // judged at the album's own level: turning the album down must not make it sound "quiet"
        const user = dbToGain(tr.gainDb);
        leadPow = sum / (2 * n) / (user * user);
        continue;
      }
      for (let i = 0; i < n; i++) {
        const g = tg0 + dg * i;
        outL[i] += this.tL[i] * g * panL;
        outR[i] += this.tR[i] * g * panR;
      }
    }
    if (!duckUpdated) this.updateDuck(leadPow, n);

    // Drop voices that stopped sounding.
    for (const [key, v] of this.voices) {
      if (v.lastBlock !== this.blockCount) this.voices.delete(key);
    }
  }

  /** Renders one instance into the track bus. Returns true if it produced sound. */
  private renderInstance(cs: CompiledSegment, inst: Instance, t0: number, n: number): boolean {
    const seg = cs.seg;
    const sr = this.sr;
    const local0 = t0 - inst.start;
    const key = seg.id + ':' + inst.k;
    let lv = this.voices.get(key);
    if (!lv || lv.seg !== cs) {
      lv = { voice: createVoice(cs, inst), inst, seg: cs, lastBlock: 0 };
      this.voices.set(key, lv);
    }
    lv.lastBlock = this.blockCount;

    // Per-sample gain: segment dB + gain automation, fades, and the [0, length) gate.
    const gainOffset = cs.gain;
    const offset = gainOffset && gainOffset.span ? inst.start - seg.start : 0;
    const db0 = seg.gainDb + (gainOffset ? gainOffset.param.value(local0 + offset) : 0);
    const db1 = seg.gainDb + (gainOffset ? gainOffset.param.value(local0 + n / sr + offset) : 0);
    const g0 = dbToGain(db0);
    const dg = (dbToGain(db1) - g0) / n;
    const len = seg.length;
    const fi = Math.max(0, seg.fadeIn);
    const fo = Math.max(0, seg.fadeOut);
    const curve = seg.fadeCurve ?? 'equal';
    const gb = this.gainBuf;
    let any = false;
    for (let i = 0; i < n; i++) {
      const lt = local0 + i / sr;
      if (lt < 0 || lt >= len) {
        gb[i] = 0;
        continue;
      }
      let f = 1;
      if (fi > 0 && lt < fi) f = fadeShape(curve, lt / fi);
      const rem = len - lt;
      if (fo > 0 && rem < fo) f *= fadeShape(curve, rem / fo);
      gb[i] = f * (g0 + dg * i);
      any = true;
    }
    if (!any) return false;

    lv.voice.render(local0, n, sr, this.vL, this.vR);
    const tL = this.tL;
    const tR = this.tR;
    const vL = this.vL;
    const vR = this.vR;
    for (let i = 0; i < n; i++) {
      tL[i] += vL[i] * gb[i];
      tR[i] += vR[i] * gb[i];
    }
    return true;
  }

  /** Extra gain for the 'wake' end behaviour: a smooth rise over the last minutes. Time-pure. */
  private wakeGain(t: number): number {
    const tl = this.timeline;
    if (!tl || tl.endBehavior !== 'wake') return 1;
    const from = tl.duration - Math.min(WAKE_SECONDS, tl.duration / 2);
    if (t <= from) return 1;
    const u = Math.min(1, (t - from) / (tl.duration - from));
    const s = u * u * (3 - 2 * u);
    return dbToGain(WAKE_RISE_DB * s);
  }

  private applyMaster(outL: Float32Array, outR: Float32Array, n: number) {
    const mg = this.masterGain * this.wakeGain(this.pos / this.sr);
    for (let i = 0; i < n; i++) {
      // transport envelope
      if (this.env !== this.envTarget) {
        if (this.env < this.envTarget) this.env = Math.min(this.envTarget, this.env + this.envStep);
        else this.env = Math.max(this.envTarget, this.env - this.envStep);
        if (this.env === this.envTarget) this.onEnvelopeReached();
      }
      const e = this.env * this.env * mg; // squared: perceptually smoother than linear
      outL[i] *= e;
      outR[i] *= e;
    }
    // Look-ahead brickwall limiter at the user's cap (stereo-linked).
    this.limiter.process(outL, outR, n);
  }

  private onEnvelopeReached() {
    if (this.pendingSeek !== null && this.env === 0) {
      this.pos = this.pendingSeek;
      this.pendingSeek = null;
      this.voices.clear();
      if (this.transport === 'playing') this.rampTo(1, SEEK_FADE);
      return;
    }
    if (this.transport === 'pausing' && this.env === 0) {
      this.transport = 'stopped';
    }
  }
}
