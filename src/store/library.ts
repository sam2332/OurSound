// App state: the timeline library, settings and navigation.
// Timelines are a few KB of JSON each, saved to IndexedDB on the phone.

import { get, set } from 'idb-keyval';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { temporal } from 'zundo';
import { DEFAULT_CAP_DB } from '../engine/core.ts';
import type { Timeline } from '../engine/model.ts';
import { parseTimeline } from '../engine/schema.ts';

export type Settings = {
  /** Maximum output (dBFS), enforced by the limiter. */
  capDb: number;
  /** Fade-in every time Play is pressed (seconds). */
  playFadeSeconds: number;
  /** Sleep timer preset applied when playback starts (minutes, null = off). */
  defaultSleepMinutes: number | null;
  /** Shown the headphone tips once. */
  seenTips: boolean;
};

export type Screen =
  | { name: 'library' }
  | { name: 'mixer'; id: string }
  | { name: 'editor'; id: string; focus?: { trackId: string; segId: string; param: string } }
  | { name: 'settings' };

type LibraryState = {
  ready: boolean;
  timelines: Record<string, Timeline>;
  /** Your own templates, made with "Save as template". */
  userTemplates: Timeline[];
  order: string[];
  settings: Settings;
  stack: Screen[];

  init(): Promise<void>;
  createTimeline(template?: Timeline): string;
  saveAsTemplate(id: string): void;
  deleteUserTemplate(id: string): void;
  importTimeline(data: unknown): string;
  duplicateTimeline(id: string): string;
  deleteTimeline(id: string): void;
  updateTimeline(id: string, recipe: (draft: Timeline) => void): void;
  setSettings(patch: Partial<Settings>): void;
  navigate(screen: Screen): void;
  replace(screen: Screen): void;
  back(): boolean;
};

const STORAGE_KEY = 'oursound.library.v1';

export const DEFAULT_SETTINGS: Settings = {
  capDb: DEFAULT_CAP_DB,
  playFadeSeconds: 3,
  defaultSleepMinutes: null,
  seenTips: false,
};

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

/** Fresh ids for a copied timeline so it is fully independent. */
function withNewIds(tl: Timeline, name?: string): Timeline {
  const now = Date.now();
  const ids = new Map(tl.soundtracks.map((t) => [t.id, newId()]));
  const focus = tl.focus && ids.has(tl.focus.lead)
    ? { ...tl.focus, lead: ids.get(tl.focus.lead)!, follow: tl.focus.follow.filter((f) => ids.has(f)).map((f) => ids.get(f)!) }
    : undefined;
  return {
    ...structuredClone(tl),
    id: newId(),
    name: name ?? tl.name,
    createdAt: now,
    updatedAt: now,
    focus,
    soundtracks: tl.soundtracks.map((t) => ({
      ...structuredClone(t),
      id: ids.get(t.id)!,
      segments: t.segments.map((s) => ({ ...structuredClone(s), id: newId() })),
    })),
  };
}

export function blankTimeline(): Timeline {
  const now = Date.now();
  return {
    id: newId(),
    name: 'New timeline',
    duration: 8 * 3600,
    endBehavior: 'stop',
    masterGainDb: 0,
    soundtracks: [],
    createdAt: now,
    updatedAt: now,
  };
}

// Group rapid edits (dragging a slider) into one undo step.
function debounceHistory<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstArgs: Parameters<T> | null = null;
  return ((...args: Parameters<T>) => {
    if (!firstArgs) firstArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...firstArgs!);
      firstArgs = null;
      timer = null;
    }, ms);
  }) as T;
}

export const useLibrary = create<LibraryState>()(
  temporal(
    immer((set_, getState) => ({
      ready: false,
      timelines: {},
      userTemplates: [],
      order: [],
      settings: DEFAULT_SETTINGS,
      stack: [{ name: 'library' }],

      async init() {
        let saved:
          | { timelines?: Record<string, unknown>; order?: string[]; settings?: Partial<Settings>; userTemplates?: unknown[] }
          | undefined;
        try {
          saved = await get(STORAGE_KEY);
        } catch (err) {
          console.error('[OS] could not read library', err);
        }
        const timelines: Record<string, Timeline> = {};
        for (const [id, raw] of Object.entries(saved?.timelines ?? {})) {
          try {
            timelines[id] = parseTimeline(raw);
          } catch (err) {
            console.error(`[OS] skipping invalid timeline ${id}`, err);
          }
        }
        let order = (saved?.order ?? []).filter((id) => timelines[id]);
        for (const id of Object.keys(timelines)) if (!order.includes(id)) order.push(id);
        const userTemplates: Timeline[] = [];
        for (const raw of saved?.userTemplates ?? []) {
          try {
            userTemplates.push(parseTimeline(raw));
          } catch (err) {
            console.error('[OS] skipping invalid template', err);
          }
        }
        set_((s) => {
          s.timelines = timelines;
          s.order = order;
          s.settings = { ...DEFAULT_SETTINGS, ...saved?.settings };
          s.userTemplates = userTemplates;
          s.ready = true;
        });
        useLibrary.temporal.getState().clear();
      },

      createTimeline(template) {
        const tl = template ? withNewIds(template) : blankTimeline();
        set_((s) => {
          s.timelines[tl.id] = tl;
          s.order.unshift(tl.id);
        });
        return tl.id;
      },

      saveAsTemplate(id) {
        const src = getState().timelines[id];
        if (!src) return;
        const tpl = withNewIds(src);
        set_((s) => {
          s.userTemplates.unshift(tpl);
        });
      },

      deleteUserTemplate(id) {
        set_((s) => {
          s.userTemplates = s.userTemplates.filter((t) => t.id !== id);
        });
      },

      importTimeline(data) {
        const tl = withNewIds(parseTimeline(data));
        set_((s) => {
          s.timelines[tl.id] = tl;
          s.order.unshift(tl.id);
        });
        return tl.id;
      },

      duplicateTimeline(id) {
        const src = getState().timelines[id];
        const copy = withNewIds(src, `${src.name} (copy)`);
        set_((s) => {
          s.timelines[copy.id] = copy;
          s.order.splice(s.order.indexOf(id) + 1, 0, copy.id);
        });
        return copy.id;
      },

      deleteTimeline(id) {
        set_((s) => {
          delete s.timelines[id];
          s.order = s.order.filter((x) => x !== id);
          s.stack = s.stack.filter((sc) => !('id' in sc) || sc.id !== id);
          if (s.stack.length === 0) s.stack = [{ name: 'library' }];
        });
      },

      updateTimeline(id, recipe) {
        set_((s) => {
          const tl = s.timelines[id];
          if (!tl) return;
          recipe(tl);
          tl.updatedAt = Date.now();
        });
      },

      setSettings(patch) {
        set_((s) => {
          Object.assign(s.settings, patch);
        });
      },

      navigate(screen) {
        set_((s) => {
          s.stack.push(screen);
        });
      },

      replace(screen) {
        set_((s) => {
          s.stack[s.stack.length - 1] = screen;
        });
      },

      back() {
        if (getState().stack.length <= 1) return false;
        set_((s) => {
          s.stack.pop();
        });
        return true;
      },
    })),
    {
      // Only timeline content is undoable (not navigation or settings).
      partialize: (s) => ({ timelines: s.timelines, order: s.order }),
      equality: (a, b) => a.timelines === b.timelines && a.order === b.order,
      limit: 200,
      handleSet: (handleSet) => debounceHistory(handleSet, 400),
    },
  ),
);

/** Saves the library to IndexedDB shortly after any change. */
export function startAutosave() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return useLibrary.subscribe((s, prev) => {
    if (!s.ready) return;
    if (
      s.timelines === prev.timelines &&
      s.order === prev.order &&
      s.settings === prev.settings &&
      s.userTemplates === prev.userTemplates
    )
      return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const { timelines, order, settings, userTemplates } = useLibrary.getState();
      set(STORAGE_KEY, { timelines, order, settings, userTemplates }).catch((err) =>
        console.error('[OS] could not save library', err),
      );
    }, 400);
  });
}

export const currentScreen = (s: LibraryState) => s.stack[s.stack.length - 1];
