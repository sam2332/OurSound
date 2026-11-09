import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { demoTimeline } from '../demo.ts';
import { parseTimeline } from '../engine/schema.ts';
import { TEMPLATES } from '../templates.ts';
import { useLibrary } from './library.ts';

describe('library store', () => {
  it('starts empty, then creates, duplicates and deletes', async () => {
    await useLibrary.getState().init();
    const s = useLibrary.getState();
    expect(s.order).toHaveLength(0);

    const id = s.createTimeline();
    expect(useLibrary.getState().order[0]).toBe(id);

    const copy = useLibrary.getState().duplicateTimeline(id);
    const a = useLibrary.getState().timelines[id];
    const b = useLibrary.getState().timelines[copy];
    expect(b.name).toBe(`${a.name} (copy)`);
    expect(b.id).not.toBe(a.id);

    useLibrary.getState().deleteTimeline(copy);
    expect(useLibrary.getState().timelines[copy]).toBeUndefined();
  });

  it('edits are undoable', async () => {
    const id = useLibrary.getState().createTimeline();
    await new Promise((r) => setTimeout(r, 450)); // history groups rapid edits
    useLibrary.getState().updateTimeline(id, (d) => void (d.name = 'Renamed'));
    await new Promise((r) => setTimeout(r, 450));
    expect(useLibrary.getState().timelines[id].name).toBe('Renamed');
    useLibrary.temporal.getState().undo();
    expect(useLibrary.getState().timelines[id].name).toBe('New timeline');
  });
});

describe('templates and samples', () => {
  it('save as template keeps a fully independent copy', () => {
    const id = useLibrary.getState().createTimeline(TEMPLATES[1].build());
    useLibrary.getState().saveAsTemplate(id);
    const tpl = useLibrary.getState().userTemplates[0];
    expect(tpl.name).toBe(TEMPLATES[1].name);
    expect(tpl.id).not.toBe(id);
    useLibrary.getState().updateTimeline(id, (d) => void (d.name = 'changed'));
    expect(useLibrary.getState().userTemplates[0].name).toBe(TEMPLATES[1].name);
    useLibrary.getState().deleteUserTemplate(tpl.id);
    expect(useLibrary.getState().userTemplates).toHaveLength(0);
  });

  it('samples are read-only and copying one makes an editable timeline', async () => {
    const { samples, copySample, getTimeline } = await import('./samples.ts');
    const all = samples();
    expect(Object.keys(all)).toHaveLength(TEMPLATES.length);
    const sampleId = Object.keys(all)[0];
    expect(useLibrary.getState().timelines[sampleId]).toBeUndefined();
    expect(getTimeline(sampleId)?.name).toBe(TEMPLATES[0].name);
    const copyId = copySample(sampleId)!;
    expect(useLibrary.getState().timelines[copyId].name).toBe(TEMPLATES[0].name);
  });

  it('every sample has unique ids, valid segments, and sounds within its duration', () => {
    for (const t of TEMPLATES) {
      const tl = t.build();
      const ids = new Set<string>();
      for (const tr of tl.soundtracks) {
        expect(ids.has(tr.id), t.name).toBe(false);
        ids.add(tr.id);
        for (const sg of tr.segments) {
          expect(sg.start + 1, t.name).toBeLessThan(tl.duration);
          expect(sg.length, t.name).toBeGreaterThan(0);
          for (const lane of sg.automation) for (const p of lane.points) expect(p.t, `${t.name} ${lane.param}`).toBeLessThanOrEqual(sg.length);
        }
      }
    }
  });
});

describe('schema', () => {
  it('accepts the demo and every template', () => {
    expect(() => parseTimeline(demoTimeline())).not.toThrow();
    for (const t of TEMPLATES) expect(() => parseTimeline(t.build()), t.name).not.toThrow();
  });

  it('rejects garbage and fills defaults', () => {
    expect(() => parseTimeline({ name: 'x' })).toThrow();
    const tl = parseTimeline({ id: 'a', name: 'b', duration: 60 });
    expect(tl.endBehavior).toBe('stop');
    expect(tl.soundtracks).toEqual([]);
  });
});
