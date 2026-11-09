// Built-in sample timelines. Each one is a ready-to-play night (or nap, or
// focus session) and a worked example of what the editor can do. The Library
// shows them as Samples; "Make my copy" turns one into an editable timeline.
// Each build() returns a fresh Timeline with new ids and seeds.

import { demoTimeline } from './demo.ts';
import { GENERATORS, defaultParams } from './engine/generators.ts';
import type {
  AutomationPoint,
  CurveType,
  EndBehavior,
  GeneratorType,
  RepeatSpec,
  Segment,
  Soundtrack,
  Timeline,
} from './engine/model.ts';
import { blankTimeline, newId, newSeed } from './store/library.ts';

const MIN = 60;
const HOUR = 3600;

export const TRACK_COLORS = ['#8fa8ff', '#f0a8d0', '#c9a37a', '#7fe0a8', '#f5c26b', '#b69cff', '#7fd4e0', '#ff9f8f'];

export function makeSegment(
  generator: GeneratorType,
  opts: Partial<Omit<Segment, 'id' | 'generator'>> & { length: number },
): Segment {
  return {
    id: newId(),
    start: 0,
    fadeIn: 10,
    fadeOut: 30,
    gainDb: -12,
    seed: newSeed(),
    repeat: { mode: 'none' },
    automation: [],
    ...opts,
    // after ...opts, so an explicit `params: undefined` can't wipe the defaults
    params: { ...defaultParams(generator), ...opts.params },
    generator,
  };
}

export function makeSoundtrack(name: string, color: string, segments: Segment[], extra: Partial<Soundtrack> = {}): Soundtrack {
  return { id: newId(), name, color, gainDb: 0, pan: 0, mute: false, solo: false, automation: [], segments, ...extra };
}

/** A soundtrack with one segment of `generator` spanning the whole timeline. */
export function soundtrackFor(
  generator: GeneratorType,
  duration: number,
  index: number,
  params?: Record<string, number>,
  name?: string,
): Soundtrack {
  const label = name ?? GENERATORS[generator]?.label ?? generator;
  return makeSoundtrack(label, TRACK_COLORS[index % TRACK_COLORS.length], [
    makeSegment(generator, { length: duration, params }),
  ]);
}

// ------------------------------------------------------------------ builder helpers

/** Automation points: [time (s), value, curve to the next point]. */
function pts(...p: [number, number, CurveType?][]): AutomationPoint[] {
  return p.map(([t, v, curve]) => ({ t, v, curve: curve ?? 'smooth' }));
}

type SegOpts = {
  params?: Record<string, number>;
  gainDb?: number;
  start?: number;
  length?: number;
  fadeIn?: number;
  fadeOut?: number;
  repeat?: RepeatSpec;
  /** param → points (segment-local time); 'gain' is a dB offset */
  auto?: Record<string, AutomationPoint[]>;
  /** automation runs across all repeats instead of restarting each repeat */
  spanAuto?: boolean;
};

function seg(generator: GeneratorType, duration: number, o: SegOpts = {}): Segment {
  const s = makeSegment(generator, {
    length: o.length ?? duration - (o.start ?? 0),
    start: o.start ?? 0,
    params: o.params,
    fadeIn: o.fadeIn ?? 20,
    fadeOut: o.fadeOut ?? 60,
  });
  s.gainDb = o.gainDb ?? -12;
  if (o.repeat) s.repeat = o.repeat;
  s.automation = Object.entries(o.auto ?? {}).map(([param, points]) => ({
    param,
    points,
    scope: o.spanAuto ? 'span' : 'instance',
  }));
  return s;
}

function track(name: string, color: number, segments: Segment[], extra: Partial<Soundtrack> = {}): Soundtrack {
  return makeSoundtrack(name, TRACK_COLORS[color % TRACK_COLORS.length], segments, extra);
}

function timeline(name: string, duration: number, soundtracks: Soundtrack[], endBehavior: EndBehavior = 'stop'): Timeline {
  const tl = blankTimeline();
  return { ...tl, name, duration, soundtracks, endBehavior };
}

// ------------------------------------------------------------------ the samples

export type TemplateCategory = 'Sleep' | 'Brainwaves' | 'Noise' | 'Naps & focus' | 'Ambience';

export type Template = {
  id: string;
  name: string;
  category: TemplateCategory;
  /** One line: what it sounds like. */
  description: string;
  /** What this sample demonstrates, for people learning the editor. */
  shows: string;
  build: () => Timeline;
};

const H8 = 8 * HOUR;

export const TEMPLATES: Template[] = [
  // ---------------------------------------------------------------- sleep
  {
    id: 'descent',
    name: 'Sleep Descent',
    category: 'Sleep',
    description: '8 h · binaural 10 → 1.5 Hz over pink noise, with random brown-noise gusts',
    shows: 'Beat automation (alpha → theta → delta), random repeats, soundtrack volume automation',
    build: () => ({ ...demoTimeline(), id: newId(), name: 'Sleep Descent' }),
  },
  {
    id: 'delta',
    name: 'Deep Delta',
    category: 'Sleep',
    description: '8 h · a steady 2 Hz binaural beat over soft brown noise',
    shows: 'The simplest possible night: two soundtracks, no automation',
    build: () =>
      timeline('Deep Delta', H8, [
        track('Delta 2 Hz', 0, [seg('binaural', H8, { params: { carrier: 150, beat: 2 }, gainDb: -14, fadeIn: 60 })]),
        track('Brown noise', 2, [seg('noise', H8, { params: { color: 2, width: 1 }, gainDb: -20, fadeIn: 60 })]),
      ]),
  },
  {
    id: 'winddown',
    name: 'Wind-Down → Sleep',
    category: 'Sleep',
    description: '8 h · 30 min of relaxed alpha, crossfading into deep delta for the night, over the ocean',
    shows: 'Two segments on one soundtrack that crossfade, and a bed that fades down over the first hour',
    build: () =>
      timeline('Wind-Down → Sleep', H8, [
        track('Brainwaves', 0, [
          seg('binaural', H8, {
            length: 32 * MIN,
            params: { carrier: 220, beat: 10 },
            gainDb: -14,
            fadeIn: 30,
            fadeOut: 3 * MIN,
            auto: { beat: pts([0, 10], [30 * MIN, 8]) },
          }),
          seg('binaural', H8, {
            start: 29 * MIN,
            params: { carrier: 160, beat: 3 },
            gainDb: -15,
            fadeIn: 3 * MIN,
            fadeOut: 5 * MIN,
            auto: { beat: pts([0, 3], [60 * MIN, 1.5, 'hold']) },
          }),
        ]),
        track('Ocean', 6, [seg('ocean', H8, { params: { period: 10, size: 0.5, closeness: 0.4 }, gainDb: -14, fadeIn: 45 })], {
          automation: [{ param: 'gain', points: pts([0, 0], [HOUR, -6]) }],
        }),
      ]),
  },
  {
    id: 'rainywindow',
    name: 'Rainy Window',
    category: 'Sleep',
    description: '8 h · gentle rain, far-off thunder now and then, a quiet delta beat underneath',
    shows: 'Thunder at a low strike rate as an occasional event; tones mixed very low under ambience',
    build: () =>
      timeline('Rainy Window', H8, [
        track('Rain', 1, [seg('rain', H8, { params: { intensity: 0.4, sheets: 0.4, brightness: 0.3 }, gainDb: -13, fadeIn: 30 })]),
        track('Distant thunder', 4, [
          seg('thunder', H8, { params: { rate: 6, distance: 0.85, intensity: 0.5, variety: 0.3 }, gainDb: -14, fadeIn: 5, fadeOut: 5 }),
        ]),
        track('Delta 2.5 Hz', 0, [seg('binaural', H8, { params: { carrier: 150, beat: 2.5 }, gainDb: -24, fadeIn: 2 * MIN })]),
      ]),
  },
  {
    id: 'storm',
    name: 'Thunderstorm',
    category: 'Sleep',
    description: '8 h · rain, rolling thunder and wind; the storm drifts away over the first 3 hours',
    shows: 'Automating sound settings (rain intensity, thunder distance and rate) to tell a story',
    build: () =>
      timeline('Thunderstorm', H8, [
        track('Rain', 1, [
          seg('rain', H8, {
            params: { intensity: 0.65, sheets: 0.6, brightness: 0.45 },
            gainDb: -13,
            auto: { intensity: pts([0, 0.65], [3 * HOUR, 0.35]) },
          }),
        ]),
        track('Thunder', 4, [
          seg('thunder', H8, {
            params: { rate: 40, distance: 0.4, intensity: 0.75, variety: 0.7 },
            gainDb: -10,
            fadeIn: 5,
            auto: { distance: pts([0, 0.4], [3 * HOUR, 0.9]), rate: pts([0, 40], [3 * HOUR, 8]) },
          }),
        ]),
        track('Wind', 6, [seg('wind', H8, { params: { strength: 0.4, gusts: 0.5, pitch: 0.3 }, gainDb: -18 })]),
      ]),
  },
  {
    id: 'ocean',
    name: 'Ocean Sleep',
    category: 'Sleep',
    description: '8 h · waves that slow down over the night, theta → delta binaural',
    shows: 'Automating the wave period so the sea calms as you fall asleep',
    build: () =>
      timeline('Ocean Sleep', H8, [
        track('Ocean', 6, [
          seg('ocean', H8, {
            params: { period: 9, size: 0.6, closeness: 0.5 },
            gainDb: -13,
            auto: { period: pts([0, 8], [2 * HOUR, 13]) },
          }),
        ]),
        track('Theta → delta', 0, [
          seg('binaural', H8, { params: { carrier: 180, beat: 6 }, gainDb: -20, auto: { beat: pts([0, 6], [HOUR, 2]) } }),
        ]),
      ]),
  },
  {
    id: 'fan',
    name: 'Box Fan Night',
    category: 'Sleep',
    description: '8 h · a steady box fan with a quiet 2 Hz binaural underneath',
    shows: 'The box fan generator; try changing its speed, brightness and wobble',
    build: () =>
      timeline('Box Fan Night', H8, [
        track('Box fan', 3, [seg('fan', H8, { params: { speed: 0.55, tone: 0.35, wobble: 0.3 }, gainDb: -11, fadeIn: 8 })]),
        track('Delta 2 Hz', 0, [seg('binaural', H8, { params: { carrier: 160, beat: 2 }, gainDb: -20, fadeIn: 60 })]),
      ]),
  },
  {
    id: 'daysleeper',
    name: 'Day Sleeper',
    category: 'Sleep',
    description: '8 h · heavy masking for sleeping through daytime noise, with a gentle wake at the end',
    shows: 'Layering fan + brown noise for masking, and the "Gentle wake" ending',
    build: () =>
      timeline(
        'Day Sleeper',
        H8,
        [
          track('Brown noise', 2, [seg('noise', H8, { params: { color: 2, width: 1 }, gainDb: -10, fadeIn: 20 })]),
          track('Box fan', 3, [seg('fan', H8, { params: { speed: 0.75, tone: 0.5, wobble: 0.2 }, gainDb: -14, fadeIn: 20 })]),
          track('Delta 2 Hz', 0, [seg('binaural', H8, { params: { carrier: 140, beat: 2 }, gainDb: -24, fadeIn: 2 * MIN })]),
        ],
        'wake',
      ),
  },
  {
    id: 'wakeup',
    name: 'Gentle Wake-Up',
    category: 'Sleep',
    description: '8 h · delta all night, then the beat rises to alert alpha over the last 30 minutes',
    shows: 'A late automation ramp (2 → 10 Hz) combined with the "Gentle wake" volume rise',
    build: () =>
      timeline(
        'Gentle Wake-Up',
        H8,
        [
          track('Delta → alpha', 0, [
            seg('binaural', H8, {
              params: { carrier: 170, beat: 2 },
              gainDb: -15,
              fadeIn: 60,
              fadeOut: 10,
              auto: { beat: pts([0, 2, 'hold'], [7.5 * HOUR, 2], [8 * HOUR - 60, 10]) },
            }),
          ]),
          track('Pink noise', 1, [seg('noise', H8, { params: { color: 1, width: 1 }, gainDb: -20, fadeIn: 60 })]),
        ],
        'wake',
      ),
  },

  // ---------------------------------------------------------------- brainwaves
  {
    id: 'delta-waves',
    name: 'Delta Waves',
    category: 'Brainwaves',
    description: '8 h · 2 Hz delta for deep, dreamless sleep',
    shows: 'Delta (0.5–4 Hz): the slowest band, dominant in deep sleep',
    build: () => {
      const d = H8;
      return timeline('Delta Waves', d, [
        track('Delta Waves 2 Hz', 0, [seg('binaural', d, { params: { carrier: 150, beat: 2 }, gainDb: -14, fadeIn: 45, fadeOut: 45 })]),
        track('Brown noise', 2, [seg('noise', d, { params: { color: 2, width: 1 }, gainDb: -24, fadeIn: 45, fadeOut: 45 })]),
      ]);
    },
  },
  {
    id: 'theta-waves',
    name: 'Theta Waves',
    category: 'Brainwaves',
    description: '60 min · 6 Hz theta for deep meditation and drifting off',
    shows: 'Theta (4–8 Hz): drowsiness, dreaming and meditation',
    build: () => {
      const d = HOUR;
      return timeline('Theta Waves', d, [
        track('Theta Waves 6 Hz', 0, [seg('binaural', d, { params: { carrier: 180, beat: 6 }, gainDb: -14, fadeIn: 45, fadeOut: 45 })]),
        track('Pink noise', 1, [seg('noise', d, { params: { color: 1, width: 1 }, gainDb: -24, fadeIn: 45, fadeOut: 45 })]),
      ]);
    },
  },
  {
    id: 'alpha-waves',
    name: 'Alpha Waves',
    category: 'Brainwaves',
    description: '60 min · 10 Hz alpha for calm, relaxed rest',
    shows: 'Alpha (8–13 Hz): relaxed, eyes-closed calm',
    build: () => {
      const d = HOUR;
      return timeline('Alpha Waves', d, [
        track('Alpha Waves 10 Hz', 0, [seg('binaural', d, { params: { carrier: 200, beat: 10 }, gainDb: -14, fadeIn: 45, fadeOut: 45 })]),
        track('Pink noise', 1, [seg('noise', d, { params: { color: 1, width: 1 }, gainDb: -24, fadeIn: 45, fadeOut: 45 })]),
      ]);
    },
  },
  {
    id: 'beta-waves',
    name: 'Beta Waves',
    category: 'Brainwaves',
    description: '60 min · 18 Hz beta for alert, focused work',
    shows: 'Beta (13–30 Hz): alert, active thinking',
    build: () => {
      const d = HOUR;
      return timeline('Beta Waves', d, [
        track('Beta Waves 18 Hz', 0, [seg('binaural', d, { params: { carrier: 240, beat: 18 }, gainDb: -14, fadeIn: 45, fadeOut: 45 })]),
        track('Green noise', 3, [seg('noise', d, { params: { color: 3, width: 1 }, gainDb: -24, fadeIn: 45, fadeOut: 45 })]),
      ]);
    },
  },
  {
    id: 'gamma-waves',
    name: 'Gamma 40 Hz',
    category: 'Brainwaves',
    description: '60 min · 40 Hz gamma for peak concentration',
    shows: 'Gamma (30+ Hz): the popular 40 Hz beat',
    build: () => {
      const d = HOUR;
      return timeline('Gamma 40 Hz', d, [
        track('Gamma 40 Hz 40 Hz', 0, [seg('binaural', d, { params: { carrier: 300, beat: 40 }, gainDb: -14, fadeIn: 45, fadeOut: 45 })]),
        track('Pink noise', 1, [seg('noise', d, { params: { color: 1, width: 1 }, gainDb: -24, fadeIn: 45, fadeOut: 45 })]),
      ]);
    },
  },
  {
    id: 'schumann',
    name: 'Schumann Resonance',
    category: 'Brainwaves',
    description: '8 h · 7.83 Hz (the Earth resonance) with soft ocean waves',
    shows: 'A beat on the theta/alpha border, tuned to 7.83 Hz with 0.01 Hz precision',
    build: () =>
      timeline('Schumann Resonance', H8, [
        track('7.83 Hz', 0, [seg('binaural', H8, { params: { carrier: 136.1, beat: 7.83 }, gainDb: -14, fadeIn: 60 })]),
        track('Ocean', 6, [seg('ocean', H8, { params: { period: 11, size: 0.45, closeness: 0.35 }, gainDb: -18, fadeIn: 60 })]),
      ]),
  },

  // ---------------------------------------------------------------- noise
  {
    id: 'white-noise',
    name: 'White Noise',
    category: 'Noise',
    description: '10 h · bright, even hiss that masks everything',
    shows: 'Noise color white; change it any time in the sound settings',
    build: () => timeline('White Noise', 10 * HOUR, [track('White Noise', 0, [seg('noise', 10 * HOUR, { params: { color: 0, width: 1 }, gainDb: -18, fadeIn: 20 })])]),
  },
  {
    id: 'pink-noise',
    name: 'Pink Noise',
    category: 'Noise',
    description: '10 h · softer and balanced, like steady rain',
    shows: 'Noise color pink; change it any time in the sound settings',
    build: () => timeline('Pink Noise', 10 * HOUR, [track('Pink Noise', 1, [seg('noise', 10 * HOUR, { params: { color: 1, width: 1 }, gainDb: -14, fadeIn: 20 })])]),
  },
  {
    id: 'brown-noise',
    name: 'Brown Noise',
    category: 'Noise',
    description: '10 h · deep, rumbling, like a distant waterfall',
    shows: 'Noise color brown; change it any time in the sound settings',
    build: () => timeline('Brown Noise', 10 * HOUR, [track('Brown Noise', 2, [seg('noise', 10 * HOUR, { params: { color: 2, width: 1 }, gainDb: -12, fadeIn: 20 })])]),
  },
  {
    id: 'green-noise',
    name: 'Green Noise',
    category: 'Noise',
    description: '10 h · the middle of the spectrum, like the sound of nature',
    shows: 'Noise color green; change it any time in the sound settings',
    build: () => timeline('Green Noise', 10 * HOUR, [track('Green Noise', 3, [seg('noise', 10 * HOUR, { params: { color: 3, width: 1 }, gainDb: -12, fadeIn: 20 })])]),
  },

  // ---------------------------------------------------------------- naps & focus
  {
    id: 'nap',
    name: 'Power Nap',
    category: 'Naps & focus',
    description: '25 min · theta 6 Hz, rising to alpha 10 Hz for the last 5 minutes',
    shows: 'A short timeline; "hold" then "smooth" automation curves',
    build: () =>
      timeline('Power Nap', 25 * MIN, [
        track('Theta → alpha', 0, [
          seg('binaural', 25 * MIN, {
            params: { carrier: 210, beat: 6 },
            gainDb: -12,
            fadeIn: 30,
            fadeOut: 20,
            auto: { beat: pts([0, 6, 'hold'], [20 * MIN, 6], [24 * MIN, 10]) },
          }),
        ]),
        track('Pink noise', 1, [seg('noise', 25 * MIN, { params: { color: 1, width: 1 }, gainDb: -22, fadeIn: 30, fadeOut: 20 })]),
      ]),
  },
  {
    id: 'focus',
    name: 'Deep Focus',
    category: 'Naps & focus',
    description: '90 min · a 14 Hz beta beat for concentration over brown noise',
    shows: 'Using binaural beats for alertness instead of sleep',
    build: () =>
      timeline('Deep Focus', 90 * MIN, [
        track('Beta 14 Hz', 0, [seg('binaural', 90 * MIN, { params: { carrier: 240, beat: 14 }, gainDb: -18, fadeIn: 30 })]),
        track('Brown noise', 2, [seg('noise', 90 * MIN, { params: { color: 2, width: 1 }, gainDb: -16, fadeIn: 30 })]),
      ]),
  },
  {
    id: 'speakers',
    name: 'Focus on Speakers',
    category: 'Naps & focus',
    description: '60 min · a 10 Hz monaural beat that works without headphones, over pink noise',
    shows: 'Monaural beats: the beat is in the sound itself, so speakers work',
    build: () =>
      timeline('Focus on Speakers', HOUR, [
        track('Monaural 10 Hz', 0, [seg('monaural', HOUR, { params: { carrier: 200, beat: 10 }, gainDb: -16, fadeIn: 20 })]),
        track('Pink noise', 1, [seg('noise', HOUR, { params: { color: 1, width: 1 }, gainDb: -20, fadeIn: 20 })]),
      ]),
  },
  {
    id: 'meditation',
    name: 'Meditation',
    category: 'Naps & focus',
    description: '30 min · theta 6 Hz with soft ocean, and a deep tone swelling every few minutes',
    shows: 'A repeating segment ("every 3 min") with long fades, so each repeat swells in and out',
    build: () =>
      timeline('Meditation', 30 * MIN, [
        track('Theta 6 Hz', 0, [seg('binaural', 30 * MIN, { params: { carrier: 200, beat: 6 }, gainDb: -16, fadeIn: 45, fadeOut: 45 })]),
        track('Deep tone', 3, [
          seg('tone', 30 * MIN, {
            params: { freq: 136.1 },
            gainDb: -22,
            start: MIN,
            length: 90,
            fadeIn: 40,
            fadeOut: 45,
            repeat: { mode: 'interval', every: 3 * MIN, until: 27 * MIN },
          }),
        ]),
        track('Ocean', 6, [seg('ocean', 30 * MIN, { params: { period: 11, size: 0.4, closeness: 0.3 }, gainDb: -20, fadeIn: 45, fadeOut: 45 })]),
      ]),
  },

  // ---------------------------------------------------------------- ambience
  {
    id: 'passing',
    name: 'Storm Passing',
    category: 'Ambience',
    description: '2 h · a storm rolls in, peaks after 40 minutes, then moves away',
    shows: 'Rise-and-fall automation on several settings at once (rain, sheets, thunder, wind), and a sound that starts late',
    build: () => {
      const d = 2 * HOUR;
      return timeline('Storm Passing', d, [
        track('Rain', 1, [
          seg('rain', d, {
            params: { intensity: 0.2, sheets: 0.7, brightness: 0.45 },
            gainDb: -13,
            auto: {
              intensity: pts([0, 0.15], [40 * MIN, 0.85], [d, 0.15]),
              sheets: pts([0, 0.4], [40 * MIN, 0.9], [d, 0.3]),
            },
          }),
        ]),
        track('Thunder', 4, [
          seg('thunder', d, {
            params: { rate: 4, distance: 0.9, intensity: 0.7, variety: 0.8 },
            gainDb: -10,
            fadeIn: 5,
            auto: { distance: pts([0, 0.95], [40 * MIN, 0.25], [d, 0.95]), rate: pts([0, 4], [40 * MIN, 45], [d, 4]) },
          }),
        ]),
        track('Wind', 6, [
          seg('wind', d, {
            params: { strength: 0.3, gusts: 0.6, pitch: 0.35 },
            gainDb: -17,
            auto: { strength: pts([0, 0.2], [40 * MIN, 0.65], [d, 0.2]) },
          }),
        ]),
        // once the storm has passed, the crickets come back out
        track('Crickets', 5, [
          seg('crickets', d, { start: 85 * MIN, params: { crickets: 6, rate: 1.8, pitch: 0.45, rests: 0.35 }, gainDb: -24, fadeIn: 8 * MIN }),
        ]),
      ]);
    },
  },
  {
    id: 'seashore',
    name: 'Windy Seashore',
    category: 'Ambience',
    description: '8 h · close waves with gusting sea wind, no tones',
    shows: 'Pure ambience; pan to place the wind slightly to one side',
    build: () =>
      timeline('Windy Seashore', H8, [
        track('Waves', 6, [seg('ocean', H8, { params: { period: 8, size: 0.75, closeness: 0.75 }, gainDb: -12 })]),
        track('Sea wind', 5, [seg('wind', H8, { params: { strength: 0.45, gusts: 0.7, pitch: 0.45 }, gainDb: -17 })], { pan: 0.3 }),
      ]),
  },
  {
    id: 'campfire',
    name: 'Campfire Night',
    category: 'Ambience',
    description: '8 h · a crackling fire with a soft night breeze; it burns down to embers over the night',
    shows: 'Automation that slowly changes a sound: the fire shrinks and crackles less as the hours pass',
    build: () =>
      timeline('Campfire Night', H8, [
        track('Campfire', 4, [
          seg('campfire', H8, {
            params: { size: 0.6, crackle: 0.6, pops: 0.45 },
            gainDb: -12,
            fadeIn: 20,
            auto: {
              size: [{ t: 0, v: 0.65, curve: 'smooth' }, { t: 3 * HOUR, v: 0.4, curve: 'smooth' }, { t: H8, v: 0.2 }],
              crackle: [{ t: 0, v: 0.65, curve: 'smooth' }, { t: H8, v: 0.25 }],
              pops: [{ t: 0, v: 0.5, curve: 'smooth' }, { t: 4 * HOUR, v: 0.15 }],
            },
          }),
        ]),
        track('Night breeze', 6, [seg('wind', H8, { params: { strength: 0.2, gusts: 0.3, pitch: 0.25 }, gainDb: -24, fadeIn: 60 })], { pan: -0.2 }),
      ]),
  },
  {
    id: 'summer-night',
    name: 'Summer Night',
    category: 'Ambience',
    description: '8 h · crickets in the warm dark; as the night cools they chirp slower and drop out one by one',
    shows: 'Automating how many crickets sing and how fast, the way real crickets slow down as it gets cooler',
    build: () =>
      timeline('Summer Night', H8, [
        track('Crickets', 5, [
          seg('crickets', H8, {
            params: { crickets: 8, rate: 2.4, pitch: 0.45, rests: 0.3 },
            gainDb: -20,
            fadeIn: 30,
            auto: {
              rate: [{ t: 0, v: 2.4, curve: 'smooth' }, { t: 3 * HOUR, v: 1.4, curve: 'smooth' }, { t: H8, v: 1 }],
              crickets: [{ t: 0, v: 8, curve: 'smooth' }, { t: 4 * HOUR, v: 4, curve: 'smooth' }, { t: H8, v: 2 }],
              rests: [{ t: 0, v: 0.3, curve: 'smooth' }, { t: H8, v: 0.6 }],
            },
          }),
        ]),
        track('Night breeze', 6, [seg('wind', H8, { params: { strength: 0.15, gusts: 0.25, pitch: 0.2 }, gainDb: -26, fadeIn: 60 })], { pan: 0.15 }),
        track('Theta binaural', 0, [seg('binaural', H8, { params: { carrier: 160, beat: 5 }, gainDb: -24, fadeIn: 60 })]),
      ]),
  },
  {
    id: 'heartbeat-drum',
    name: 'Heartbeat Drum',
    category: 'Sleep',
    description: '8 h · a deep heartbeat drum by the fire that slows from 64 to 48 beats a minute, over delta waves',
    shows: 'Automating a tempo: the drum slows down smoothly, beat by beat',
    build: () =>
      timeline('Heartbeat Drum', H8, [
        track('Heartbeat drum', 2, [
          seg('drums', H8, {
            params: { style: 0, tempo: 64, depth: 0.15, variety: 0.15 },
            gainDb: -16,
            fadeIn: 30,
            auto: { tempo: [{ t: 0, v: 64, curve: 'smooth' }, { t: 45 * MIN, v: 48 }] },
          }),
        ]),
        track('Campfire', 4, [seg('campfire', H8, { params: { size: 0.35, crackle: 0.4, pops: 0.25 }, gainDb: -20, fadeIn: 30 })]),
        track('Delta binaural', 0, [seg('binaural', H8, { params: { carrier: 150, beat: 2 }, gainDb: -22, fadeIn: 60 })]),
      ]),
  },
  {
    id: 'green-brown',
    name: 'Green + Brown Noise',
    category: 'Noise',
    description: '10 h · the classic mix: deep brown rumble with green mid-range softness',
    shows: 'Several noise colors layered; balance them with each soundtrack volume',
    build: () => {
      const d = 10 * HOUR;
      return timeline('Green + Brown Noise', d, [
        track('Brown noise', 2, [seg('noise', d, { params: { color: 2, width: 1 }, gainDb: -15, fadeIn: 20 })]),
        track('Green noise', 3, [seg('noise', d, { params: { color: 3, width: 1 }, gainDb: -15, fadeIn: 20 })]),
      ]);
    },
  },
  {
    id: 'brown-pink',
    name: 'Brown + Pink Noise',
    category: 'Noise',
    description: '10 h · warm and full: brown depth with pink rain-like texture',
    shows: 'Several noise colors layered; balance them with each soundtrack volume',
    build: () => {
      const d = 10 * HOUR;
      return timeline('Brown + Pink Noise', d, [
        track('Brown noise', 2, [seg('noise', d, { params: { color: 2, width: 1 }, gainDb: -15, fadeIn: 20 })]),
        track('Pink noise', 1, [seg('noise', d, { params: { color: 1, width: 1 }, gainDb: -18, fadeIn: 20 })]),
      ]);
    },
  },
  {
    id: 'green-pink',
    name: 'Green + Pink Noise',
    category: 'Noise',
    description: '10 h · soft and natural, lighter than brown',
    shows: 'Several noise colors layered; balance them with each soundtrack volume',
    build: () => {
      const d = 10 * HOUR;
      return timeline('Green + Pink Noise', d, [
        track('Green noise', 3, [seg('noise', d, { params: { color: 3, width: 1 }, gainDb: -15, fadeIn: 20 })]),
        track('Pink noise', 1, [seg('noise', d, { params: { color: 1, width: 1 }, gainDb: -18, fadeIn: 20 })]),
      ]);
    },
  },
  {
    id: 'noise-blend',
    name: 'Deep Sleep Noise Blend',
    category: 'Noise',
    description: '10 h · brown, green and a touch of pink, mostly low and soft',
    shows: 'Several noise colors layered; balance them with each soundtrack volume',
    build: () => {
      const d = 10 * HOUR;
      return timeline('Deep Sleep Noise Blend', d, [
        track('Brown noise', 2, [seg('noise', d, { params: { color: 2, width: 1 }, gainDb: -15, fadeIn: 20 })]),
        track('Green noise', 3, [seg('noise', d, { params: { color: 3, width: 1 }, gainDb: -17, fadeIn: 20 })]),
        track('Pink noise', 1, [seg('noise', d, { params: { color: 1, width: 1 }, gainDb: -22, fadeIn: 20 })]),
      ]);
    },
  },
  {
    id: 'endless',
    name: 'Endless Pink Noise',
    category: 'Noise',
    description: '1,000 h · just pink noise, effectively forever',
    shows: 'Timelines can be thousands of hours long, at no extra cost',
    build: () =>
      timeline('Endless Pink Noise', 1000 * HOUR, [track('Pink noise', 1, [seg('noise', 1000 * HOUR, { params: { color: 1, width: 1 }, gainDb: -14 })])]),
  },
];

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ['Sleep', 'Brainwaves', 'Noise', 'Naps & focus', 'Ambience'];
