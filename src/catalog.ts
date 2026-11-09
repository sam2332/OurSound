// What you can add as a soundtrack, grouped for the "Add soundtrack" sheet.

import { GENERATORS } from './engine/generators.ts';
import type { GeneratorType } from './engine/model.ts';

export type CatalogItem = {
  key: string;
  label: string;
  description: string;
  generator: GeneratorType;
  params?: Record<string, number>;
  gainDb?: number;
};

export type CatalogGroup = { title: string; items: CatalogItem[] };

const ALL: CatalogGroup[] = [
  {
    title: 'Brainwave tones (headphones)',
    items: [
      { key: 'binaural', label: 'Binaural beat', description: 'Different tone in each ear; the brain hears the beat', generator: 'binaural' },
      { key: 'monaural', label: 'Monaural beat', description: 'Two tones mixed; works without headphones too', generator: 'monaural' },
      { key: 'isochronic', label: 'Isochronic tone', description: 'A tone pulsing on and off', generator: 'isochronic' },
      { key: 'tone', label: 'Pure tone', description: 'A single steady sine tone', generator: 'tone', gainDb: -18 },
    ],
  },
  {
    title: 'Noise',
    items: [
      { key: 'white', label: 'White noise', description: 'Bright, even hiss', generator: 'noise', params: { color: 0, width: 1 }, gainDb: -20 },
      { key: 'pink', label: 'Pink noise', description: 'Softer, balanced; like steady rain', generator: 'noise', params: { color: 1, width: 1 }, gainDb: -16 },
      { key: 'brown', label: 'Brown noise', description: 'Deep rumble, like a distant waterfall', generator: 'noise', params: { color: 2, width: 1 }, gainDb: -14 },
      { key: 'green', label: 'Green noise', description: 'Centered on the mid range, like the sound of nature', generator: 'noise', params: { color: 3, width: 1 }, gainDb: -14 },
      { key: 'blue', label: 'Blue noise', description: 'Bright and airy, more treble than white', generator: 'noise', params: { color: 4, width: 1 }, gainDb: -20 },
      { key: 'violet', label: 'Violet noise', description: 'Very bright hiss, mostly high frequencies', generator: 'noise', params: { color: 5, width: 1 }, gainDb: -22 },
    ],
  },
  {
    title: 'Ambience',
    items: [
      { key: 'fan', label: 'Box fan', description: 'Motor hum and blade whoosh; adjustable speed', generator: 'fan' },
      { key: 'rain', label: 'Rain', description: 'Soft rain that falls in sheets and waves', generator: 'rain' },
      { key: 'thunder', label: 'Thunder', description: 'Rolling thunder at random times', generator: 'thunder' },
      { key: 'wind', label: 'Wind', description: 'Gusting wind', generator: 'wind' },
      { key: 'ocean', label: 'Ocean waves', description: 'Waves rolling in and out', generator: 'ocean' },
      { key: 'campfire', label: 'Campfire', description: 'Crackling fire with pops and a soft roar', generator: 'campfire' },
      { key: 'crickets', label: 'Crickets', description: 'A summer-night chorus; can come in only when the music goes quiet', generator: 'crickets' },
      { key: 'drums', label: 'Drums', description: 'Slow hand drums: heartbeat, steady, shamanic or tribal', generator: 'drums' },
    ],
  },
];

/** Only items whose generator exists in this build. */
export function catalog(): CatalogGroup[] {
  return ALL.map((g) => ({ ...g, items: g.items.filter((i) => GENERATORS[i.generator]) })).filter(
    (g) => g.items.length > 0,
  );
}
