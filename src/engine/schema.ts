// Zod schema for timelines: validates anything loaded from storage or
// imported from a file, and fills defaults for fields added later.

import { z } from 'zod';
import type { Timeline } from './model.ts';

const curve = z.enum(['hold', 'linear', 'smooth', 'exp']);

const point = z.object({
  t: z.number().finite(),
  v: z.number().finite(),
  curve: curve.optional(),
});

const lane = z.object({
  param: z.string(),
  points: z.array(point),
  scope: z.enum(['instance', 'span']).optional(),
});

const positive = z.number().finite().positive();
const count = z.number().int().positive().nullable().optional();
const until = z.number().finite().nullable().optional();

const repeat = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('interval'), every: positive, count, until }),
  z.object({ mode: z.literal('random'), minGap: positive, maxGap: positive, count, until }),
]);

export const GENERATOR_TYPES = [
  'binaural',
  'monaural',
  'isochronic',
  'tone',
  'noise',
  'fan',
  'rain',
  'thunder',
  'wind',
  'ocean',
  'campfire',
  'drums',
  'crickets',
  'file',
] as const;

const segment = z.object({
  id: z.string(),
  start: z.number().finite().min(0),
  length: positive,
  fadeIn: z.number().finite().min(0).default(0),
  fadeOut: z.number().finite().min(0).default(0),
  gainDb: z.number().finite().default(0),
  generator: z.enum(GENERATOR_TYPES),
  params: z.record(z.string(), z.number().finite()).default({}),
  seed: z.number().int().default(1),
  repeat: repeat.default({ mode: 'none' }),
  automation: z.array(lane).default([]),
  assetId: z.string().optional(),
  fadeCurve: z.enum(['equal', 'linear', 'smooth', 'gentle']).optional(),
});

const soundtrack = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  gainDb: z.number().finite().default(0),
  pan: z.number().min(-1).max(1).default(0),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
  segments: z.array(segment).default([]),
  automation: z.array(lane).default([]),
  album: z.boolean().optional(),
});

export const timelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  duration: positive,
  endBehavior: z.enum(['stop', 'loop', 'wake']).default('stop'),
  masterGainDb: z.number().finite().default(0),
  soundtracks: z.array(soundtrack).default([]),
  focus: z
    .object({
      lead: z.string(),
      follow: z.array(z.string()).default([]),
      levelDb: z.number().finite().default(0),
      duckDb: z.number().finite().min(0).max(30).default(0),
      fill: z.array(z.string()).optional(),
    })
    .optional(),
  missingFiles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        ext: z.string().optional(),
        duration: z.number().finite().min(0),
        size: z.number().finite().min(0).optional(),
      }),
    )
    .optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

/** Parses unknown data into a Timeline, or throws a readable error. */
export function parseTimeline(data: unknown): Timeline {
  return timelineSchema.parse(data) as Timeline;
}
