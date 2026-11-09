// An "album": several imported audio files on one soundtrack, back to back,
// each starting exactly where the previous one ends. The album is edited as a
// whole (order, loop, speed/pitch/tone); these helpers keep the segments packed.

import type { Segment, Soundtrack } from './engine/model.ts';
import { TRACK_COLORS, makeSegment, makeSoundtrack } from './templates.ts';

export type AlbumTrack = { id: string; name: string; duration: number };

/** A tiny fade at each join, just enough to avoid clicks (gapless otherwise). */
const JOIN_FADE = 0.02;

export function albumSegments(tracks: AlbumTrack[], startAt = 0): Segment[] {
  let at = startAt;
  return tracks.map((t) => {
    const seg = makeSegment('file', {
      start: at,
      length: t.duration,
      params: { speed: 1, loop: 0, offset: 0 },
      fadeIn: JOIN_FADE,
      fadeOut: JOIN_FADE,
    });
    seg.gainDb = -6;
    seg.assetId = t.id;
    at += t.duration;
    return seg;
  });
}

export function albumSoundtrack(tracks: AlbumTrack[], name: string, colorIndex: number, startAt = 0): Soundtrack {
  const st = makeSoundtrack(name, TRACK_COLORS[colorIndex % TRACK_COLORS.length], albumSegments(tracks, startAt));
  st.album = true;
  return st;
}

export const albumLength = (tracks: AlbumTrack[]) => tracks.reduce((s, t) => s + t.duration, 0);

/** Albums made here, and older ones: several imported files on one soundtrack. */
export const isAlbum = (t: Soundtrack) =>
  t.album === true || (t.segments.length > 1 && t.segments.every((s) => s.generator === 'file'));

/** True when the album starts over after its last track. */
export const albumLoops = (t: Soundtrack) => t.segments.length > 0 && t.segments.every((s) => s.repeat.mode === 'interval');

/** Timeline start and length of one pass through the album. */
export function albumSpan(t: Soundtrack): { start: number; length: number } {
  if (!t.segments.length) return { start: 0, length: 0 };
  const start = Math.min(...t.segments.map((s) => s.start));
  const end = Math.max(...t.segments.map((s) => s.start + s.length));
  return { start, length: end - start };
}

/** Seconds one track takes to play: what's left of the file after its trim, at its speed. */
export function playedLength(seg: Segment, fileDuration: number | undefined): number {
  const speed = Math.max(0.05, seg.params.speed ?? 1);
  if (fileDuration === undefined) return seg.length;
  return Math.max(1, (fileDuration - (seg.params.offset ?? 0)) / speed);
}

/**
 * Lays the tracks out again in array order, back to back from the album's
 * start, each as long as it actually plays, and sets the album loop.
 * `durationOf` gives a file's full length (unknown files keep their length).
 */
export function repackAlbum(t: Soundtrack, durationOf: (assetId: string) => number | undefined, loop = albumLoops(t)) {
  let at = albumSpan(t).start;
  for (const s of t.segments) {
    s.start = at;
    s.length = playedLength(s, s.assetId ? durationOf(s.assetId) : undefined);
    s.params.loop = 0;
    at += s.length;
  }
  const total = at - (t.segments[0]?.start ?? 0);
  for (const s of t.segments) s.repeat = loop && total > 0 ? { mode: 'interval', every: total } : { mode: 'none' };
  t.album = true;
}

/** Which track plays at timeline time `pos` (-1 between or after). */
export function trackAt(t: Soundtrack, pos: number): number {
  const { start, length } = albumSpan(t);
  if (length <= 0 || pos < start) return -1;
  let p = pos;
  if (albumLoops(t)) p = start + ((pos - start) % length);
  return t.segments.findIndex((s) => p >= s.start && p < s.start + s.length);
}
