import { Eraser } from 'lucide-react';
import { CUSTOM_STYLE, DRUM_LANES, DRUM_PRESETS, DRUM_STEPS, DRUM_STYLES, emptyPattern } from '../engine/drums.ts';
import type { Segment } from '../engine/model.ts';
import { cx } from '../ui/controls.tsx';

const SHORT = ['Low', 'Mid', 'High', 'Shaker', 'Wood'];
const HALF = DRUM_STEPS / 2;

/** Next velocity when a pad is tapped: off → loud → soft → off. */
const nextVel = (v: number) => (v === 0 ? 1 : v > 0.75 ? 0.5 : 0);

/**
 * A 16-step drum pad (one bar of four beats), shown as two rows of two beats
 * so the pads stay big enough to tap. Editing a preset copies it into "My pattern".
 */
export function DrumPad({ seg, color, editSeg }: { seg: Segment; color: string; editSeg: (recipe: (s: Segment) => void) => void }) {
  const style = Math.max(0, Math.min(DRUM_STYLES.length - 1, Math.round(seg.params.style ?? 1)));
  const mine = style === CUSTOM_STYLE;
  const shown = mine ? (seg.drumPattern ?? DRUM_PRESETS[1]!) : DRUM_PRESETS[style]!;
  const vel = (lane: number, step: number) => shown[lane]?.[step] ?? 0;

  const tap = (lane: number, step: number) =>
    editSeg((s) => {
      const base = DRUM_LANES.map((_, l) => Array.from({ length: DRUM_STEPS }, (_, i) => shown[l]?.[i] ?? 0));
      base[lane]![step] = nextVel(base[lane]![step]!);
      s.drumPattern = base;
      s.params.style = CUSTOM_STYLE;
    });

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted">Drum pad</span>
        <button
          type="button"
          onClick={() =>
            editSeg((s) => {
              s.drumPattern = emptyPattern();
              s.params.style = CUSTOM_STYLE;
            })
          }
          className="inline-flex items-center gap-1 rounded-full bg-bg/40 px-2 py-0.5 text-xs text-muted"
        >
          <Eraser size={12} /> Clear
        </button>
      </div>
      {[0, 1].map((half) => (
        <div key={half} className="flex flex-col gap-1">
          <div className="grid grid-cols-[3.25rem_repeat(8,minmax(0,1fr))] gap-1 text-[10px] text-muted">
            <span />
            {Array.from({ length: HALF }, (_, i) => {
              const step = half * HALF + i;
              return (
                <span key={i} className="text-center tabular-nums">
                  {step % 4 === 0 ? `${step / 4 + 1}` : '·'}
                </span>
              );
            })}
          </div>
          {SHORT.map((name, lane) => (
            <div key={lane} className="grid grid-cols-[3.25rem_repeat(8,minmax(0,1fr))] items-center gap-1">
              <span className="truncate text-xs text-muted">{name}</span>
              {Array.from({ length: HALF }, (_, i) => {
                const step = half * HALF + i;
                const v = vel(lane, step);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-label={`${DRUM_LANES[lane]}, step ${step + 1}: ${v === 0 ? 'off' : v > 0.75 ? 'loud' : 'soft'}`}
                    onClick={() => tap(lane, step)}
                    className={cx('h-8 rounded-md transition-colors', v === 0 && (step % 4 === 0 ? 'bg-bg/70' : 'bg-bg/40'))}
                    style={v > 0 ? { background: color, opacity: v > 0.75 ? 1 : 0.45 } : undefined}
                  />
                );
              })}
            </div>
          ))}
        </div>
      ))}
      <span className="text-xs text-muted">
        {mine
          ? style === CUSTOM_STYLE && !seg.drumPattern
            ? 'Starting from the Steady rhythm. Tap a pad: loud, soft, off.'
            : 'Tap a pad: loud, then soft, then off. Numbers are the four beats of the bar.'
          : `Showing the ${DRUM_STYLES[style]} rhythm${style === 0 ? ' (it plays a little looser than shown)' : ''}. Tap a pad to make your own from it.`}
      </span>
    </div>
  );
}
