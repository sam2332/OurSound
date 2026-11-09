import { CloudRain, Music } from 'lucide-react';
import type { FocusMix, Soundtrack, Timeline } from '../engine/model.ts';
import { TRACK_COLORS } from '../templates.ts';
import { Segmented, Slider, cx } from '../ui/controls.tsx';

/** Sounds that make a good bed under music. Brainwave tones keep their level by default. */
const AMBIENT = new Set(['noise', 'fan', 'rain', 'thunder', 'wind', 'ocean', 'campfire']);

const ROOM = [
  { value: 0, label: 'Off' },
  { value: 4, label: 'Gentle' },
  { value: 8, label: 'Medium' },
  { value: 14, label: 'Strong' },
];

export function defaultFocus(tl: Timeline, leadId: string): FocusMix {
  const follow = tl.soundtracks
    .filter((t) => t.id !== leadId && t.segments.some((s) => AMBIENT.has(s.generator)))
    .map((t) => t.id);
  return { lead: leadId, follow, levelDb: -6, duckDb: 8 };
}

/**
 * "Keep the music on top": one level for all the background sounds under an
 * album, plus an automatic dip while the music plays.
 */
export function FocusMixPanel({
  timeline,
  lead,
  color,
  edit,
}: {
  timeline: Timeline;
  lead: Soundtrack;
  color: string;
  edit: (recipe: (d: Timeline) => void) => void;
}) {
  const f = timeline.focus?.lead === lead.id ? timeline.focus : undefined;
  const others = timeline.soundtracks.filter((t) => t.id !== lead.id);
  const setFocus = (recipe: (f: FocusMix) => void) =>
    edit((d) => {
      if (d.focus?.lead === lead.id) recipe(d.focus);
    });

  if (!f) {
    return (
      <button
        type="button"
        disabled={others.length === 0}
        onClick={() => edit((d) => void (d.focus = defaultFocus(d, lead.id)))}
        className="flex items-center gap-3 rounded-xl border border-dashed border-line p-3 text-left disabled:opacity-50"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-card-2" style={{ color }}>
          <Music size={18} />
        </span>
        <span className="min-w-0 text-sm">
          <span className="block font-semibold">Keep the music on top</span>
          <span className="block text-xs text-muted">
            {others.length === 0
              ? 'Add rain, thunder or other sounds first.'
              : timeline.focus
                ? 'Another album leads the mix now. Tap to make this one lead.'
                : 'Set the rain, thunder and other sounds under this album, and let them dip while it plays.'}
          </span>
        </span>
      </button>
    );
  }

  const level = Math.round(f.levelDb);
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Music size={16} style={{ color }} /> Music on top
        </span>
        <button type="button" onClick={() => edit((d) => void delete d.focus)} className="rounded-full px-2 py-0.5 text-xs text-muted">
          Turn off
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <CloudRain size={14} /> Background sounds
        </span>
        <div className="flex flex-wrap gap-1.5">
          {others.map((t) => {
            const on = f.follow.includes(t.id);
            const c = t.color ?? TRACK_COLORS[timeline.soundtracks.indexOf(t) % TRACK_COLORS.length];
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setFocus((x) => {
                    x.follow = on ? x.follow.filter((id) => id !== t.id) : [...x.follow, t.id];
                  })
                }
                className={cx(
                  'flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
                  on ? 'border-transparent bg-bg/60 font-semibold' : 'border-line text-muted',
                )}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: on ? c : 'transparent', boxShadow: `inset 0 0 0 1px ${c}` }} />
                <span className="truncate">{t.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Slider
        label="Background level"
        value={f.levelDb}
        min={-24}
        max={6}
        step={1}
        color={color}
        disabled={f.follow.length === 0}
        format={() => (level === 0 ? 'Unchanged' : level < 0 ? `${-level} dB quieter` : `${level} dB louder`)}
        onChange={(v) => setFocus((x) => void (x.levelDb = v))}
      />

      <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Make room while the music plays</span>
        <Segmented
          value={ROOM.reduce((best, o) => (Math.abs(o.value - f.duckDb) < Math.abs(best - f.duckDb) ? o.value : best), 0)}
          onChange={(v) => setFocus((x) => void (x.duckDb = v))}
          options={ROOM}
        />
        <span className="text-xs text-muted">
          {f.duckDb === 0
            ? 'The background stays at one steady level.'
            : `The background dips up to ${f.duckDb} dB when the music is loud and drifts back in quiet parts and between tracks.`}
        </span>
      </div>
    </div>
  );
}
