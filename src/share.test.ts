import { describe, expect, it } from 'vitest';
import { QR_MAX_CHARS, decodeTimeline, encodeTimeline } from './share.ts';
import { TEMPLATES } from './templates.ts';

describe('sharing codes', () => {
  it('round-trips every sample and fits in one QR code', async () => {
    for (const t of TEMPLATES) {
      const tl = t.build();
      const code = await encodeTimeline(tl);
      expect(code.length, `${t.name}: ${code.length} chars`).toBeLessThan(QR_MAX_CHARS);
      const back = await decodeTimeline(code);
      expect(back.name).toBe(tl.name);
      expect(back.duration).toBe(tl.duration);
      expect(back.soundtracks.length).toBe(tl.soundtracks.length);
      expect(back.soundtracks[0].segments[0].params).toEqual(tl.soundtracks[0].segments[0].params);
      expect(back.soundtracks[0].segments[0].automation.length).toBe(tl.soundtracks[0].segments[0].automation.length);
    }
  });

  it('still reads old codes', async () => {
    const old =
      'OURSOUND1:' +
      btoa(String.fromCharCode(...new Uint8Array(await new Response(new Blob([JSON.stringify({ name: 'Old', duration: 60, soundtracks: [{ id: 't0', name: 'A', segments: [] }] })]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    expect((await decodeTimeline(old)).name).toBe('Old');
  });

  it('round-trips every detail of a timeline', async () => {
    for (const t of TEMPLATES) {
      const tl = t.build();
      const back = await decodeTimeline(await encodeTimeline(tl));
      const norm = (x: typeof tl) =>
        JSON.parse(JSON.stringify(x.soundtracks.map((s) => ({ ...s, id: 0, segments: s.segments.map((g) => ({ ...g, id: 0 })) }))), (_k, v) =>
          typeof v === 'number' ? Math.round(v * 1000) / 1000 : v,
        );
      expect(norm(back), t.name).toEqual(norm(tl));
    }
  });

  it('rejects other text and damaged codes', async () => {
    await expect(decodeTimeline('hello')).rejects.toThrow(/isn't an OurSound/);
    await expect(decodeTimeline('OURSOUND1:abc')).rejects.toThrow(/damaged/);
    await expect(decodeTimeline('OURSOUND2:ABC')).rejects.toThrow(/damaged/);
  });
});
