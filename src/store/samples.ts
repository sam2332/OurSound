// Built-in sample timelines: playable as they are, read-only. "Make my copy"
// turns one into a normal, editable timeline in your library.

import type { Timeline } from '../engine/model.ts';
import { TEMPLATES, type Template } from '../templates.ts';
import { useLibrary } from './library.ts';

const PREFIX = 'sample:';

let built: Record<string, Timeline> | null = null;

/** Samples keyed by their (stable) id, built once per app start. */
export function samples(): Record<string, Timeline> {
  if (!built) {
    built = {};
    for (const t of TEMPLATES) {
      const tl = t.build();
      built[PREFIX + t.id] = { ...tl, id: PREFIX + t.id };
    }
  }
  return built;
}

export const isSample = (id: string | null | undefined) => !!id && id.startsWith(PREFIX);

export function templateForSample(id: string): Template | undefined {
  return TEMPLATES.find((t) => PREFIX + t.id === id);
}

/** A timeline from your library or the samples. */
export function getTimeline(id: string | null | undefined): Timeline | undefined {
  if (!id) return undefined;
  return useLibrary.getState().timelines[id] ?? (isSample(id) ? samples()[id] : undefined);
}

/** Copies a sample into your library as a new editable timeline; returns its id. */
export function copySample(id: string): string | null {
  const tpl = templateForSample(id);
  if (!tpl) return null;
  return useLibrary.getState().createTimeline(tpl.build());
}
