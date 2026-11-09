import { ArrowDown, ArrowUp, AudioLines, ChevronDown, ChevronUp, Copy, Disc3, LineChart, Loader2, Plus, Repeat, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { albumLoops, albumSegments, albumSpan, isAlbum, repackAlbum, trackAt } from '../album.ts';
import { importAudioFile, importAudioNativeMany, usesNativeAssets, type StoredAsset } from '../audio/assets.ts';
import { useAssets } from '../audio/useAssets.ts';
import type { Segment, Soundtrack, Timeline } from '../engine/model.ts';
import { newId, newSeed, useLibrary } from '../store/library.ts';
import { usePlayback } from '../store/playback.ts';
import { TRACK_COLORS } from '../templates.ts';
import { FocusMixPanel } from './FocusMix.tsx';
import { Button, Confirm, IconButton, Slider, TimeInput, cx, fmtDuration } from '../ui/controls.tsx';

export { isAlbum };

/** 3:41 or 1:02:03 */
function fmtTrack(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const panLabel = (v: number) => (Math.abs(v) < 0.025 ? 'Center' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`);

/**
 * A soundtrack of imported tracks played back to back, shown like an album:
 * one loop switch, a numbered track list, and sound settings for the whole
 * album. Per-track details stay folded away until a track is tapped.
 */
export function AlbumCard({
  timeline,
  track,
  index,
  edit,
}: {
  timeline: Timeline;
  track: Soundtrack;
  index: number;
  edit: (recipe: (d: Timeline) => void) => void;
}) {
  const navigate = useLibrary((s) => s.navigate);
  const assets = useAssets();
  const playingHere = usePlayback((s) => s.activeId === timeline.id && s.playing);
  const position = usePlayback((s) => (s.activeId === timeline.id ? s.status.positionSec : -1));
  const [showAll, setShowAll] = useState(false);
  const [openTrack, setOpenTrack] = useState<string | null>(null);
  const [soundOpen, setSoundOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const color = track.color ?? TRACK_COLORS[index % TRACK_COLORS.length];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const durationOf = (id: string) => byId.get(id)?.duration;
  const nameOf = (seg: Segment, i: number) => (seg.assetId && byId.get(seg.assetId)?.name) || `Track ${i + 1}`;

  const editTrack = (recipe: (t: Soundtrack) => void) =>
    edit((d) => {
      const t = d.soundtracks.find((x) => x.id === track.id);
      if (t) recipe(t);
    });
  /** Change the album, then lay its tracks out again so they stay back to back. */
  const editAlbum = (recipe: (t: Soundtrack) => void, loop?: boolean) =>
    editTrack((t) => {
      recipe(t);
      repackAlbum(t, durationOf, loop);
    });

  const segs = track.segments;
  const loops = albumLoops(track);
  const span = albumSpan(track);
  const first = segs[0];
  const last = segs[segs.length - 1];
  const nowIndex = playingHere && position >= 0 ? trackAt(track, position) : -1;
  const visible = showAll || segs.length <= 6 ? segs : segs.slice(0, 5);

  // What happens over the length of the timeline, in plain words.
  const room = timeline.duration - span.start;
  let story: string;
  if (span.length > room) {
    const cut = trackAt({ ...track, segments: segs.map((s) => ({ ...s, repeat: { mode: 'none' as const } })) }, timeline.duration - 0.001);
    story = `The timeline ends during track ${cut + 1}.`;
  } else if (loops) {
    const times = room / span.length;
    story = times >= 1.95 ? `Plays about ${Math.floor(times + 0.05)}× to fill the ${fmtDuration(timeline.duration)} timeline.` : 'Starts over after the last track.';
  } else {
    const after = room - span.length;
    story = after > 60 ? `Plays once, then ${fmtDuration(after)} without the album.` : 'Plays once and fills the timeline.';
  }

  const common = (param: string, fallback: number) => first?.params[param] ?? fallback;
  const setAll = (param: string, v: number) => editAlbum((t) => t.segments.forEach((s) => void (s.params[param] = v)));
  const anyAutomated = (param: string) => segs.some((s) => s.automation.some((l) => l.param === param && l.points.length > 0));
  const panAutomated = track.automation.some((l) => l.param === 'pan' && l.points.length > 0);

  const addTracks = (got: StoredAsset[]) =>
    editAlbum((t) => {
      const end = t.segments.length ? Math.max(...t.segments.map((s) => s.start + s.length)) : 0;
      const fresh = albumSegments(got, end);
      const tpl = t.segments[0];
      for (const s of fresh) {
        if (tpl) {
          // new tracks sound like the rest of the album
          for (const k of ['speed', 'pitch', 'tone']) if (tpl.params[k] !== undefined) s.params[k] = tpl.params[k];
          s.gainDb = tpl.gainDb;
        }
        t.segments.push(s);
      }
    });

  const pickTracks = async () => {
    if (!usesNativeAssets) return fileInput.current?.click();
    setAdding(true);
    setAddError(null);
    try {
      const r = await importAudioNativeMany();
      if (r?.failed.length) setAddError(r.failed.join(String.fromCharCode(10)));
      if (r?.assets.length) addTracks(r.assets);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const move = (i: number, d: number) =>
    editAlbum((t) => {
      const j = i + d;
      if (j < 0 || j >= t.segments.length) return;
      const start = Math.min(...t.segments.map((s) => s.start));
      [t.segments[i], t.segments[j]] = [t.segments[j], t.segments[i]];
      t.segments[0].start = start; // the album keeps its place in the timeline
    });

  return (
    <div
      className={cx('flex flex-col gap-3 rounded-2xl border border-line bg-card p-4', track.mute && 'opacity-60')}
      style={{ borderLeft: `4px solid ${color}` }}
    >
      {/* header: cover, name, summary, solo and on/off */}
      <div className="flex items-center gap-3">
        <div
          className="grid h-12 w-12 shrink-0 place-items-center rounded-xl text-bg"
          style={{ background: color }}
          aria-hidden
        >
          <Disc3 size={26} className={cx(playingHere && !track.mute && 'animate-[spin_4s_linear_infinite]')} />
        </div>
        <div className="min-w-0 flex-1">
          <input
            className="w-full rounded-md bg-transparent font-semibold outline-none focus:bg-card-2"
            value={track.name}
            aria-label="Album name"
            onChange={(e) => editTrack((t) => void (t.name = e.target.value))}
          />
          <div className="truncate text-xs text-muted">
            Album · {segs.length} {segs.length === 1 ? 'track' : 'tracks'} · {fmtDuration(Math.round(span.length))}
            {loops && ' · loops'}
          </div>
        </div>
        <button
          type="button"
          aria-pressed={track.solo}
          onClick={() => editTrack((t) => void (t.solo = !t.solo))}
          className={cx('h-9 w-9 rounded-full text-sm font-bold', track.solo ? 'bg-warn text-bg' : 'bg-card-2 text-muted')}
        >
          S
        </button>
        <button
          type="button"
          aria-pressed={!track.mute}
          onClick={() => editTrack((t) => void (t.mute = !t.mute))}
          className={cx('h-9 min-w-14 rounded-full px-3 text-sm font-bold', track.mute ? 'bg-card-2 text-muted' : 'text-bg')}
          style={track.mute ? undefined : { background: color }}
        >
          {track.mute ? 'Off' : 'On'}
        </button>
      </div>

      <Slider
        label="Volume"
        value={track.gainDb}
        min={-40}
        max={6}
        step={1}
        unit="dB"
        color={color}
        onChange={(v) => editTrack((t) => void (t.gainDb = v))}
      />

      {/* the one loop switch for the whole album */}
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-card-2 p-1">
          {[
            { loop: false, label: 'Play once', icon: <AudioLines size={16} /> },
            { loop: true, label: 'Loop album', icon: <Repeat size={16} /> },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={loops === o.loop}
              onClick={() => loops !== o.loop && editAlbum(() => {}, o.loop)}
              className={cx(
                'flex items-center justify-center gap-2 rounded-lg py-2 text-sm transition-colors',
                loops === o.loop ? 'font-semibold text-bg' : 'text-muted',
              )}
              style={loops === o.loop ? { background: color } : undefined}
            >
              {o.icon} {o.label}
            </button>
          ))}
        </div>
        <p className="px-1 text-xs text-muted">{story}</p>
      </div>

      <FocusMixPanel timeline={timeline} lead={track} color={color} edit={edit} />

      {/* track list */}
      <ol className="flex flex-col overflow-hidden rounded-xl bg-card-2">
        {visible.map((seg, i) => {
          const now = i === nowIndex;
          const open = openTrack === seg.id;
          return (
            <li key={seg.id} className={cx('border-line', i > 0 && 'border-t')}>
              <button
                type="button"
                onClick={() => setOpenTrack(open ? null : seg.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-bg/30"
                aria-expanded={open}
              >
                <span className="w-6 shrink-0 text-center text-sm tabular-nums" style={now ? { color } : undefined}>
                  {now ? <AudioLines size={16} className="mx-auto animate-pulse" /> : <span className="text-muted">{i + 1}</span>}
                </span>
                <span className={cx('min-w-0 flex-1 truncate', now && 'font-semibold')} style={now ? { color } : undefined}>
                  {nameOf(seg, i)}
                </span>
                {seg.gainDb !== (first?.gainDb ?? seg.gainDb) && (
                  <span className="shrink-0 rounded-full bg-bg/40 px-1.5 text-[10px] text-muted">{seg.gainDb > (first?.gainDb ?? 0) ? 'louder' : 'quieter'}</span>
                )}
                <span className="shrink-0 text-sm text-muted tabular-nums">{fmtTrack(seg.length)}</span>
              </button>
              {open && (
                <div className="flex flex-col gap-3 bg-bg/30 px-3 pt-2 pb-3">
                  <Slider
                    label="Track volume"
                    value={seg.gainDb}
                    min={-30}
                    max={6}
                    step={1}
                    unit="dB"
                    color={color}
                    onChange={(v) => editTrack((t) => void (t.segments.find((s) => s.id === seg.id)!.gainDb = v))}
                  />
                  <TimeInput
                    label="Skip the first"
                    value={seg.params.offset ?? 0}
                    onChange={(v) =>
                      editAlbum((t) => {
                        const s = t.segments.find((x) => x.id === seg.id)!;
                        const full = seg.assetId ? durationOf(seg.assetId) : undefined;
                        s.params.offset = Math.max(0, full ? Math.min(full - 1, v) : v);
                      })
                    }
                  />
                  <div className="flex items-center gap-2">
                    <IconButton label="Move track up" onClick={() => move(i, -1)} disabled={i === 0} className="h-9 w-9">
                      <ArrowUp size={16} />
                    </IconButton>
                    <IconButton label="Move track down" onClick={() => move(i, 1)} disabled={i === segs.length - 1} className="h-9 w-9">
                      <ArrowDown size={16} />
                    </IconButton>
                    <button
                      type="button"
                      onClick={() => navigate({ name: 'editor', id: timeline.id, focus: { trackId: track.id, segId: seg.id, param: 'gain' } })}
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-card px-3 py-1.5 text-xs text-accent"
                    >
                      <LineChart size={12} /> Show in timeline
                    </button>
                    <span className="flex-1" />
                    <IconButton
                      label="Remove track from album"
                      disabled={segs.length <= 1}
                      onClick={() => {
                        setOpenTrack(null);
                        editAlbum((t) => {
                          const start = Math.min(...t.segments.map((s) => s.start));
                          t.segments = t.segments.filter((x) => x.id !== seg.id);
                          if (t.segments[0]) t.segments[0].start = start;
                        });
                      }}
                      className="h-9 w-9 bg-transparent text-danger"
                    >
                      <X size={16} />
                    </IconButton>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {segs.length > visible.length || (showAll && segs.length > 6) ? (
          <li className="border-t border-line">
            <button type="button" onClick={() => setShowAll(!showAll)} className="w-full py-2 text-sm text-muted">
              {showAll ? 'Show fewer' : `Show all ${segs.length} tracks`}
            </button>
          </li>
        ) : null}
      </ol>

      <button
        type="button"
        onClick={() => setSoundOpen(!soundOpen)}
        className="flex items-center justify-center gap-1 rounded-lg py-1 text-sm text-muted"
      >
        {soundOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {soundOpen ? 'Less' : 'Album sound, fades & tracks'}
      </button>

      {soundOpen && (
        <div className="flex flex-col gap-4">
          <p className="-mb-2 text-xs text-muted">These apply to every track.</p>
          <Slider
            label="Speed (tempo)"
            value={common('speed', 1)}
            min={0.5}
            max={1.5}
            step={0.01}
            color={color}
            disabled={anyAutomated('speed')}
            format={(v) => (Math.abs(v - 1) < 0.005 ? 'Normal' : `${v.toFixed(2)}×`)}
            onChange={(v) => setAll('speed', v)}
          />
          <Slider
            label="Pitch"
            value={common('pitch', 0)}
            min={-12}
            max={12}
            step={0.5}
            color={color}
            disabled={anyAutomated('pitch')}
            format={(v) => (v === 0 ? 'Normal' : `${v > 0 ? '+' : ''}${v} st`)}
            onChange={(v) => setAll('pitch', v)}
          />
          <Slider
            label="Tone (dark ↔ bright)"
            value={common('tone', 0)}
            min={-1}
            max={1}
            step={0.05}
            color={color}
            disabled={anyAutomated('tone')}
            format={(v) => (Math.abs(v) < 0.025 ? 'Natural' : v < 0 ? `Darker ${Math.round(-v * 100)}` : `Brighter ${Math.round(v * 100)}`)}
            onChange={(v) => setAll('tone', v)}
          />
          <Slider
            label="Pan"
            value={track.pan}
            min={-1}
            max={1}
            step={0.05}
            color={color}
            format={panLabel}
            disabled={panAutomated}
            onChange={(v) => editTrack((t) => void (t.pan = v))}
          />
          {first && last && (
            <>
              <Slider
                label="Fade in at the start"
                value={first.fadeIn}
                min={0}
                max={300}
                step={1}
                unit="s"
                color={color}
                onChange={(v) => editTrack((t) => void (t.segments[0].fadeIn = Math.max(0.02, v)))}
              />
              <Slider
                label="Fade out at the end"
                value={last.fadeOut}
                min={0}
                max={300}
                step={1}
                unit="s"
                color={color}
                onChange={(v) => editTrack((t) => void (t.segments[t.segments.length - 1].fadeOut = Math.max(0.02, v)))}
              />
            </>
          )}

          <input
            ref={fileInput}
            type="file"
            multiple
            accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac"
            className="hidden"
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (!files.length) return;
              setAdding(true);
              setAddError(null);
              const got: StoredAsset[] = [];
              for (const f of files) {
                try {
                  got.push(await importAudioFile(f));
                } catch (err) {
                  setAddError(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              setAdding(false);
              if (got.length) addTracks(got);
            }}
          />
          {addError && <p className="whitespace-pre-line text-sm text-danger">{addError}</p>}
          <div className="grid grid-cols-3 gap-2">
            <Button className="px-1 text-sm" onClick={() => void pickTracks()} disabled={adding}>
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Tracks
            </Button>
            <Button
              className="px-1 text-sm"
              onClick={() =>
                edit((d) => {
                  const src = d.soundtracks.find((x) => x.id === track.id);
                  if (!src) return;
                  const copy = structuredClone(src);
                  copy.id = newId();
                  copy.name = `${src.name} (copy)`;
                  copy.color = TRACK_COLORS[d.soundtracks.length % TRACK_COLORS.length];
                  copy.segments.forEach((s) => {
                    s.id = newId();
                    s.seed = newSeed();
                  });
                  d.soundtracks.splice(d.soundtracks.indexOf(src) + 1, 0, copy);
                })
              }
            >
              <Copy size={16} /> Copy
            </Button>
            <Button variant="danger" className="px-1 text-sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} /> Delete
            </Button>
          </div>
        </div>
      )}

      <Confirm
        open={confirmDelete}
        title="Delete album?"
        message={`"${track.name}" and its ${segs.length} tracks will be removed from this timeline. You can undo this.`}
        confirmLabel="Delete"
        onConfirm={() =>
          edit((d) => {
            d.soundtracks = d.soundtracks.filter((x) => x.id !== track.id);
            if (d.focus?.lead === track.id) delete d.focus;
          })
        }
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
