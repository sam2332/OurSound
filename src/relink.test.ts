import { describe, expect, it } from 'vitest';
import type { SharedFile, Timeline } from './engine/model.ts';
import { applyLinks, matchFiles, matchScore, nameSimilarity, normName } from './relink.ts';
import { PartCollector, encodeTimeline, qrParts, readShared } from './share.ts';

const f = (id: string, name: string, duration: number, size?: number, ext = '.flac'): SharedFile => ({ id, name, ext, duration, size });

describe('file names', () => {
  it('ignores track numbers, extensions and punctuation', () => {
    expect(normName('03 - Rain_Song.flac')).toBe('rain song');
    expect(normName('1-03 Rain Song.mp3')).toBe('rain song');
    expect(normName('Rain Song')).toBe('rain song');
    expect(nameSimilarity('Rain Song.flac', '07. Rain Song.flac')).toBe(1);
    expect(nameSimilarity('Rain Song', 'Rain Song (2019 Remaster)')).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity('Rain Song', 'Thunder Road')).toBeLessThan(0.3);
  });
});

describe('matching', () => {
  it('trusts exact size, then name + length', () => {
    expect(matchScore(f('a', 'Rain', 200, 1234), { name: 'whatever.flac', size: 1234, duration: 200.4 })).toBe(100);
    expect(matchScore(f('a', 'Rain', 200), { name: '02 Rain.flac', duration: 200.6 })).toBe(95);
    expect(matchScore(f('a', 'Rain', 200), { name: 'Rain.flac', duration: 260 })).toBe(0);
    expect(matchScore(f('a', 'Rain', 200), { name: 'Rain.flac' })).toBe(65); // length unknown
  });

  it('pairs each file with one distinct candidate', () => {
    const files = [f('a', 'Intro', 60), f('b', 'Outro', 90), f('c', 'Lost track', 300)];
    const cands = [
      { uri: 'u1', name: '01 Intro.flac', duration: 60.2 },
      { uri: 'u2', name: '09 Outro.flac', duration: 89.9 },
      { uri: 'u3', name: 'Outro (live).flac', duration: 240 },
    ];
    const m = matchFiles(files, cands);
    expect(m.get('a')?.candidate.uri).toBe('u1');
    expect(m.get('b')?.candidate.uri).toBe('u2');
    expect(m.has('c')).toBe(false);
  });

  it('prefers a copy already in OurSound', () => {
    const m = matchFiles([f('a', 'Rain', 100, 5)], [
      { uri: 'u1', name: 'Rain.flac', duration: 100, size: 5 },
      { libraryId: 'mine', name: 'Rain', duration: 100, size: 5 },
    ]);
    expect(m.get('a')?.candidate.libraryId).toBe('mine');
  });
});

const tl = (): Timeline => ({
  id: 'x',
  name: 'Storm "night"/2',
  duration: 3600,
  endBehavior: 'stop',
  masterGainDb: 0,
  soundtracks: [
    {
      id: 'album1',
      name: 'Album',
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      automation: [],
      segments: [
        { id: 's1', start: 0, length: 60, fadeIn: 0, fadeOut: 0, gainDb: 0, generator: 'file', params: {}, seed: 1, repeat: { mode: 'none' }, automation: [], assetId: 'as_1' },
        { id: 's2', start: 60, length: 90, fadeIn: 0, fadeOut: 0, gainDb: 0, generator: 'file', params: {}, seed: 1, repeat: { mode: 'none' }, automation: [], assetId: 'as_2' },
      ],
    },
    { id: 'rain1', name: 'Rain', gainDb: -6, pan: 0, mute: false, solo: false, automation: [], segments: [] },
  ],
  focus: { lead: 'album1', follow: ['rain1'], levelDb: -6, duckDb: 8 },
});

describe('share files', () => {
  const lib = [
    { id: 'as_1', name: 'Intro', ext: '.flac', duration: 60, size: 111 },
    { id: 'as_2', name: 'Outro', ext: '.flac', duration: 90, size: 222 },
  ];

  it('round-trips with the file list and the music-on-top links', async () => {
    const back = await readShared(await encodeTimeline(tl(), lib));
    expect(back.missingFiles?.map((x) => x.name)).toEqual(['Intro', 'Outro']);
    expect(back.focus?.lead).toBe(back.soundtracks[0].id);
    expect(back.focus?.follow).toEqual([back.soundtracks[1].id]);
    const viaCode = await readShared('Try this! ' + (await encodeTimeline(tl(), lib)) + ' enjoy');
    expect(viaCode.missingFiles?.length).toBe(2);
  });

  it('relinks files and keeps the unlinked ones listed', async () => {
    const back = await readShared(await encodeTimeline(tl(), lib));
    const [first, second] = back.missingFiles!;
    expect(back.soundtracks[0].segments.map((x) => x.assetId)).toEqual([first!.id, second!.id]);
    applyLinks(back, new Map([[first!.id, 'mine_1']]));
    expect(back.soundtracks[0].segments[0].assetId).toBe('mine_1');
    expect(back.soundtracks[0].segments[1].assetId).toBe(second!.id);
    expect(back.missingFiles?.map((x) => x.id)).toEqual([second!.id]);
  });

  it('splits big codes into QR parts scanned in any order', async () => {
    const code = await encodeTimeline(tl(), lib);
    expect(qrParts(code)).toEqual([code]);
    const parts = qrParts(code, 100, 60);
    expect(parts.length).toBeGreaterThan(2);
    const c = new PartCollector();
    expect(c.add('hello')).toBeNull();
    const order = [...parts].reverse();
    for (const p of order.slice(0, -1)) expect(c.add(p)?.done).toBe(false);
    expect(c.add(parts[0]!)?.done).toBe(true);
    const again = new PartCollector();
    for (const p of parts.slice(0, -1)) again.add(p);
    again.add(parts[1]!); // a repeat changes nothing
    const last = again.add(parts[parts.length - 1]!);
    expect(last).toEqual({ done: true, code });
    expect((await readShared(code)).name).toBe('Storm "night"/2');
  });

  it('rejects other files', async () => {
    await expect(readShared('{"hello":1}')).rejects.toThrow(/isn't an OurSound/);
    await expect(readShared('just a text')).rejects.toThrow(/isn't an OurSound/);
  });
});
