import { describe, expect, it } from 'vitest';
import { albumSoundtrack } from './album.ts';
import type { Timeline } from './engine/model.ts';
import { encodeTimeline, qrParts, readShared } from './share.ts';
import { TEMPLATES } from './templates.ts';

/** An album timeline like a real one: 11 tracks over two templates' worth of sound. */
function albumTimeline() {
  const names = ['Intro', 'The Pot', 'Vicarious', 'Jambi', 'Wings for Marie', '10,000 Days', 'Rosetta Stoned', 'Intension', 'Right in Two', 'Viginti Tres', 'Lipan Conjuring'];
  const lib = names.map((n, i) => ({
    id: 'as_' + crypto.randomUUID(),
    name: `${String(i + 1).padStart(2, '0')} - ${n}`,
    ext: '.flac',
    duration: 180 + ((i * 97.123) % 500),
    size: 20_000_000 + Math.floor(Math.random() * 40_000_000),
  }));
  const base: Timeline = structuredClone(TEMPLATES[0]!.build());
  base.soundtracks.push(albumSoundtrack(lib, 'Album 10000 days', 0));
  base.focus = { lead: base.soundtracks.at(-1)!.id, follow: [base.soundtracks[0]!.id], levelDb: -6, duckDb: 8 };
  return { tl: base, lib };
}

describe('code size', () => {
  it('keeps an 11-track album timeline small', async () => {
    const { tl, lib } = albumTimeline();
    const code = await encodeTimeline(tl, lib);
    const parts = qrParts(code);
    console.log(`album timeline code: ${code.length} chars, ${parts.length} QR code(s) of ${parts.map((p) => p.length).join(', ')}`);
    for (const t of TEMPLATES) console.log(`  ${t.name}: ${(await encodeTimeline(t.build())).length} chars`);
    const back = await readShared(code);
    expect(back.soundtracks.length).toBe(tl.soundtracks.length);
    expect(back.missingFiles?.length).toBe(11);
  });
});
