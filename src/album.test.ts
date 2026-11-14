import { describe, expect, it } from 'vitest';
import { albumLength, albumLoops, albumSoundtrack, isAlbum, repackAlbum, trackAt } from './album.ts';

describe('album', () => {
  it('places tracks back to back in the chosen order', () => {
    const tracks = [
      { id: 'a', name: 'One', duration: 200.5 },
      { id: 'b', name: 'Two', duration: 61 },
      { id: 'c', name: 'Three', duration: 333.25 },
    ];
    const st = albumSoundtrack(tracks, 'My album', 0, 10);
    expect(st.segments.map((s) => s.assetId)).toEqual(['a', 'b', 'c']);
    expect(st.segments[0].start).toBe(10);
    for (let i = 1; i < st.segments.length; i++) {
      const prev = st.segments[i - 1];
      expect(st.segments[i].start).toBeCloseTo(prev.start + prev.length, 9);
    }
    expect(albumLength(tracks)).toBeCloseTo(594.75);
    for (const s of st.segments) {
      expect(s.params.loop).toBe(0);
      expect(s.repeat.mode).toBe('none');
    }
  });
});

describe('album editing', () => {
  const tracks = [
    { id: 'a', name: 'One', duration: 100 },
    { id: 'b', name: 'Two', duration: 50 },
  ];
  const dur = (id: string) => tracks.find((t) => t.id === id)?.duration;

  it('loops the whole album, each track every album length', () => {
    const st = albumSoundtrack(tracks, 'A', 0, 5);
    expect(isAlbum(st)).toBe(true);
    expect(albumLoops(st)).toBe(false);
    repackAlbum(st, dur, true);
    expect(albumLoops(st)).toBe(true);
    for (const s of st.segments) expect(s.repeat).toEqual({ mode: 'interval', every: 150 });
    expect(trackAt(st, 5 + 150 + 120)).toBe(1);
    expect(trackAt(st, 2)).toBe(-1);
  });

  it('repacks after a speed change and a reorder', () => {
    const st = albumSoundtrack(tracks, 'A', 0, 0);
    for (const s of st.segments) s.params.speed = 2;
    st.segments.reverse();
    repackAlbum(st, dur, true);
    expect(st.segments.map((s) => [s.assetId, s.start, s.length])).toEqual([
      ['b', 0, 25],
      ['a', 25, 50],
    ]);
    expect(st.segments[0].repeat).toEqual({ mode: 'interval', every: 75 });
  });

  it('leaves the album pause after each track, with per-track overrides', () => {
    const st = albumSoundtrack(tracks, 'A', 0, 0);
    st.albumGap = 30;
    st.segments[1].gapAfter = 0;
    repackAlbum(st, dur, true);
    expect(st.segments.map((s) => s.start)).toEqual([0, 130]);
    // loops right after the last track, since that track has no pause
    expect(st.segments[0].repeat).toEqual({ mode: 'interval', every: 180 });
    expect(trackAt(st, 110)).toBe(-1);
    expect(trackAt(st, 140)).toBe(1);
    expect(trackAt(st, 185)).toBe(0);
    st.segments[1].gapAfter = undefined;
    repackAlbum(st, dur, true);
    expect(st.segments[0].repeat).toEqual({ mode: 'interval', every: 210 });
    expect(trackAt(st, 195)).toBe(-1);
  });
});
