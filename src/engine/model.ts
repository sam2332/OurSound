// Timeline data model. Everything here is plain JSON: a timeline is just
// settings, never audio. All times are in seconds (JS doubles).
//
//   Timeline -> Soundtrack (lane) -> Segment (block) -> Automation (curves)

export type CurveType = 'hold' | 'linear' | 'smooth' | 'exp';

/** One breakpoint. `curve` shapes the ramp from this point to the next one. */
export type AutomationPoint = {
  t: number;
  v: number;
  curve?: CurveType; // default 'linear'
};

/**
 * Time scope of a segment automation lane:
 * - 'instance': time restarts at 0 on every repeat (each repeat gets the same curve)
 * - 'span':     time runs from the segment's first start across all repeats
 */
export type AutomationScope = 'instance' | 'span';

export type AutomationLane = {
  /** Param name of the segment's generator, or 'gain' (dB). */
  param: string;
  points: AutomationPoint[];
  scope?: AutomationScope; // default 'instance'
};

export type RepeatSpec =
  | { mode: 'none' }
  /** Replays every `every` seconds (start-to-start). */
  | { mode: 'interval'; every: number; count?: number | null; until?: number | null }
  /** Replays at a seeded random gap between minGap and maxGap (start-to-start). */
  | { mode: 'random'; minGap: number; maxGap: number; count?: number | null; until?: number | null };

export type GeneratorType =
  | 'binaural'
  | 'monaural'
  | 'isochronic'
  | 'tone'
  | 'noise'
  | 'fan'
  | 'rain'
  | 'thunder'
  | 'wind'
  | 'ocean'
  | 'campfire'
  | 'drums'
  | 'crickets'
  | 'stream'
  | 'bowl'
  | 'purr'
  | 'pad'
  | 'file';

export type Segment = {
  id: string;
  /** Album tracks: this track's own pause after it, overriding the album's (UI only). */
  gapAfter?: number;
  /** Drums, "My pattern": [drum][step] velocity 0..1 for the 16 steps of a bar. */
  drumPattern?: number[][];
  /** Timeline time of the first play. */
  start: number;
  /** Length of one play. */
  length: number;
  fadeIn: number;
  fadeOut: number;
  /** Segment gain in dB (automatable as 'gain', which is added to this). */
  gainDb: number;
  generator: GeneratorType;
  /** Static param values; automation lanes override individual params. */
  params: Record<string, number>;
  seed: number;
  repeat: RepeatSpec;
  automation: AutomationLane[];
  /** For 'file' segments: the imported audio asset. */
  assetId?: string;
  /** Shape of the fade in/out (default 'equal'). */
  fadeCurve?: FadeCurve;
};

/** equal: equal-power (smooth for overlaps) · linear · smooth: S-curve · gentle: slow start */
export type FadeCurve = 'equal' | 'linear' | 'smooth' | 'gentle';

export type Soundtrack = {
  id: string;
  name: string;
  color?: string;
  gainDb: number;
  pan: number; // -1..1 (equal-power; never mono-sums, so binaural stays intact)
  mute: boolean;
  solo: boolean;
  segments: Segment[];
  /** Soundtrack-level 'gain' automation (dB offset) in timeline time. */
  automation: AutomationLane[];
  /** Shown and edited as an album: imported tracks back to back (UI only; playback ignores it). */
  album?: boolean;
  /** Album only: seconds of silence after every track (UI only; the segments are laid out with it). */
  albumGap?: number;
};

/** stop: fade out at the end · loop: start over · wake: gentle volume rise over the last minutes, then stop. */
export type EndBehavior = 'stop' | 'loop' | 'wake';

/**
 * Keeps chosen background soundtracks under a lead one (usually an album):
 * they sit `levelDb` relative to their own volume, and dip by up to `duckDb`
 * while the lead is loud, coming back up in its quiet parts and gaps.
 */
export type FocusMix = {
  lead: string;
  follow: string[];
  levelDb: number;
  duckDb: number;
  /** Tracks that only come in when the music goes quiet (crickets in a soft passage, between songs). */
  fill?: string[];
};

/** An imported audio file a timeline uses that this phone hasn't linked yet (from a shared timeline). */
export type SharedFile = {
  /** The asset id the timeline's segments use. */
  id: string;
  name: string;
  /** File extension with the dot, e.g. ".flac". */
  ext?: string;
  /** Seconds. */
  duration: number;
  /** Bytes. */
  size?: number;
};

export type Timeline = {
  id: string;
  name: string;
  /** Total length in seconds (can be thousands of hours). */
  duration: number;
  endBehavior: EndBehavior;
  masterGainDb: number;
  soundtracks: Soundtrack[];
  focus?: FocusMix;
  /** Audio files still to be linked (a timeline someone shared). */
  missingFiles?: SharedFile[];
  createdAt?: number;
  updatedAt?: number;
};

export type MasterSettings = {
  /** Maximum output level in dBFS. Enforced by the brickwall limiter. */
  capDb: number;
};

export const SCHEMA_VERSION = 1;
