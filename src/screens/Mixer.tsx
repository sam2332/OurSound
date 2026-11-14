import { FeedbackButton } from './FeedbackSheet.tsx';
import { DrumPad } from './DrumPad.tsx';
import { MissingFilesCard } from './SharedImport.tsx';
import {
  ArrowLeft,
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  Copy,
  Disc3,
  FileAudio,
  LineChart,
  Loader2,
  Pause,
  Play,
  Plus,
  Redo2,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { importAudioFile, importAudioNative, importAudioNativeMany, usesNativeAssets, type StoredAsset } from '../audio/assets.ts';
import type { AlbumTrack } from '../album.ts';
import { AlbumSheet } from './AlbumSheet.tsx';
import { AlbumCard, isAlbum } from './AlbumCard.tsx';
import { useAssets } from '../audio/useAssets.ts';
import { useStore } from 'zustand';
import { BANDS, bandFor, brainwaveParam } from '../brainwaves.ts';
import { catalog, type CatalogItem } from '../catalog.ts';
import { GENERATORS, NOISE_COLORS } from '../engine/generators.ts';
import type { RepeatSpec, Segment, Soundtrack, Timeline } from '../engine/model.ts';
import { useLibrary, newId, newSeed } from '../store/library.ts';
import { togglePlay, usePlayback } from '../store/playback.ts';
import { TRACK_COLORS, makeSegment, makeSoundtrack } from '../templates.ts';
import {
  Button,
  Card,
  Confirm,
  IconButton,
  Segmented,
  Sheet,
  Slider,
  TimeInput,
  cx,
  fmtClock,
  fmtDuration,
} from '../ui/controls.tsx';

const MIN = 60;

export function MixerScreen({ id }: { id: string }) {
  const tl = useLibrary((s) => s.timelines[id]);
  const update = useLibrary((s) => s.updateTimeline);
  const back = useLibrary((s) => s.back);
  const navigate = useLibrary((s) => s.navigate);
  const activeId = usePlayback((s) => s.activeId);
  const playing = usePlayback((s) => s.playing && s.activeId === id);
  const position = usePlayback((s) => (s.activeId === id ? s.status.positionSec : 0));
  const { undo, redo, pastStates, futureStates } = useStore(useLibrary.temporal);
  const [addOpen, setAddOpen] = useState(false);
  const saveAsTemplate = useLibrary((s) => s.saveAsTemplate);
  const [savedTemplate, setSavedTemplate] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const albumInput = useRef<HTMLInputElement>(null);
  const [album, setAlbum] = useState<AlbumTrack[] | null>(null);
  const assets = useAssets();

  if (!tl) return null;
  const edit = (recipe: (d: Timeline) => void) => update(id, recipe);

  const addSoundtrack = (item: CatalogItem) => {
    edit((d) => {
      const seg = makeSegment(item.generator, { length: d.duration, params: item.params });
      if (item.gainDb !== undefined) seg.gainDb = item.gainDb;
      d.soundtracks.push(makeSoundtrack(item.label, TRACK_COLORS[d.soundtracks.length % TRACK_COLORS.length], [seg]));
    });
    setAddOpen(false);
  };

  const addAsset = (asset: StoredAsset) => {
    edit((d) => {
      // Short sounds (rain clips, songs) loop to fill the timeline; long recordings play once.
      const short = asset.duration < 30 * MIN;
      const seg = makeSegment('file', {
        length: short ? d.duration : Math.min(d.duration, asset.duration),
        params: { speed: 1, loop: short ? 1 : 0, offset: 0 },
        fadeIn: 5,
        fadeOut: 10,
      });
      seg.gainDb = -6;
      seg.assetId = asset.id;
      d.soundtracks.push(makeSoundtrack(asset.name, TRACK_COLORS[d.soundtracks.length % TRACK_COLORS.length], [seg]));
    });
    setAddOpen(false);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      addAsset(await importAudioFile(file));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <IconButton label="Back" onClick={back}>
          <ArrowLeft size={20} />
        </IconButton>
        <input
          className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-xl font-bold outline-none focus:bg-card"
          value={tl.name}
          aria-label="Timeline name"
          onChange={(e) => edit((d) => void (d.name = e.target.value))}
        />
        <IconButton label="Undo" onClick={() => undo()} disabled={pastStates.length === 0}>
          <Undo2 size={18} />
        </IconButton>
        <IconButton label="Redo" onClick={() => redo()} disabled={futureStates.length === 0}>
          <Redo2 size={18} />
        </IconButton>
        <FeedbackButton />
      </header>

      <MissingFilesCard timeline={tl} />

      <Card>
        <div className="flex items-center gap-3">
          <IconButton
            label={playing ? 'Pause' : 'Play'}
            active={playing}
            onClick={() => void togglePlay(id)}
            className="h-14 w-14"
          >
            {playing ? <Pause size={26} /> : <Play size={26} className="ml-1" />}
          </IconButton>
          <div className="flex-1">
            <div className="text-2xl font-bold tabular-nums">
              {fmtClock(activeId === id ? position : 0)}
              <span className="ml-2 text-base font-normal text-muted">/ {fmtClock(tl.duration)}</span>
            </div>
            <div className="text-sm text-muted">{fmtDuration(tl.duration)} timeline</div>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button onClick={() => navigate({ name: 'editor', id })}>
            <SlidersHorizontal size={18} /> Open timeline editor
          </Button>
          <Button
            ariaLabel="Save as template"
            onClick={() => {
              saveAsTemplate(id);
              setSavedTemplate(true);
              setTimeout(() => setSavedTemplate(false), 3500);
            }}
          >
            <BookmarkPlus size={18} />
          </Button>
        </div>
        {savedTemplate && (
          <p className="text-sm text-ok">Saved as a template. Find it under New timeline in the Library.</p>
        )}
      </Card>

      <Card>
        <h2 className="font-semibold text-muted">Timeline</h2>
        <TimeInput
          label="Length"
          value={tl.duration}
          min={60}
          showSeconds={false}
          onChange={(v) => edit((d) => void (d.duration = Math.max(60, v)))}
        />
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted">At the end</span>
          <Segmented
            value={tl.endBehavior}
            onChange={(v) => edit((d) => void (d.endBehavior = v))}
            options={[
              { value: 'stop', label: 'Stop' },
              { value: 'loop', label: 'Start over' },
              { value: 'wake', label: 'Gentle wake' },
            ]}
          />
        </div>
        <Slider
          label="Master volume"
          value={tl.masterGainDb}
          min={-30}
          max={6}
          step={1}
          unit="dB"
          onChange={(v) => edit((d) => void (d.masterGainDb = v))}
        />
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Soundtracks</h2>
        <span className="text-sm text-muted">{tl.soundtracks.length}</span>
      </div>

      {tl.soundtracks.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-muted">
          No soundtracks yet. Add a binaural beat, noise, or ambience to start.
        </p>
      )}

      {tl.soundtracks.map((t, i) => (
        isAlbum(t) ? (
          <AlbumCard key={t.id} timeline={tl} track={t} index={i} edit={edit} />
        ) : (
          <TrackCard key={t.id} timeline={tl} track={t} index={i} edit={edit} />
        )
      ))}

      <Button variant="primary" onClick={() => setAddOpen(true)}>
        <Plus size={20} /> Add soundtrack
      </Button>

      <AlbumSheet tracks={album} timeline={tl} onClose={() => setAlbum(null)} onAdd={(recipe) => edit(recipe)} />

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add soundtrack">
        <div className="flex flex-col gap-2">
          <h3 className="mt-1 text-sm font-semibold text-muted">Your audio</h3>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button
            onClick={async () => {
              if (!usesNativeAssets) return fileInput.current?.click();
              setImporting(true);
              setImportError(null);
              try {
                const a = await importAudioNative();
                if (a) addAsset(a);
              } catch (err) {
                setImportError(err instanceof Error ? err.message : String(err));
              } finally {
                setImporting(false);
              }
            }}
            disabled={importing}
            className="justify-start"
          >
            {importing ? <Loader2 size={18} className="animate-spin" /> : <FileAudio size={18} />}
            {importing ? 'Importing…' : 'Import an audio file (MP3, M4A, WAV…)'}
          </Button>
          <input
            ref={albumInput}
            type="file"
            multiple
            accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac"
            className="hidden"
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (!files.length) return;
              setImporting(true);
              setImportError(null);
              const got: StoredAsset[] = [];
              for (const f of files) {
                try {
                  got.push(await importAudioFile(f));
                } catch (err) {
                  setImportError(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              setImporting(false);
              if (got.length) {
                setAddOpen(false);
                setAlbum(got);
              }
            }}
          />
          <Button
            onClick={async () => {
              if (!usesNativeAssets) return albumInput.current?.click();
              setImporting(true);
              setImportError(null);
              try {
                const r = await importAudioNativeMany();
                if (r?.failed.length) setImportError(r.failed.join(String.fromCharCode(10)));
                if (r && r.assets.length) {
                  setAddOpen(false);
                  setAlbum(r.assets);
                }
              } catch (err) {
                setImportError(err instanceof Error ? err.message : String(err));
              } finally {
                setImporting(false);
              }
            }}
            disabled={importing}
            className="justify-start"
          >
            <Disc3 size={18} /> Import an album (several files, played in order)
          </Button>
          {importError && <p className="whitespace-pre-line text-sm text-danger">{importError}</p>}
          {assets.map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => addAsset(a)}
              className="rounded-xl bg-card-2 p-3 text-left active:scale-[0.99]"
            >
              <div className="font-semibold">{a.name}</div>
              <div className="text-sm text-muted">
                {fmtDuration(Math.round(a.duration))} · imported audio
              </div>
            </button>
          ))}
        </div>
        {catalog().map((g) => (
          <div key={g.title} className="flex flex-col gap-2">
            <h3 className="mt-1 text-sm font-semibold text-muted">{g.title}</h3>
            {g.items.map((item) => (
              <button
                type="button"
                key={item.key}
                onClick={() => addSoundtrack(item)}
                className="rounded-xl bg-card-2 p-3 text-left active:scale-[0.99]"
              >
                <div className="font-semibold">{item.label}</div>
                <div className="text-sm text-muted">{item.description}</div>
              </button>
            ))}
          </div>
        ))}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------- soundtrack

function TrackCard({
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
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useLibrary((s) => s.navigate);
  const color = track.color ?? TRACK_COLORS[index % TRACK_COLORS.length];
  const editTrack = (recipe: (t: Soundtrack) => void) =>
    edit((d) => {
      const t = d.soundtracks.find((x) => x.id === track.id);
      if (t) recipe(t);
    });
  const focusLead = timeline.soundtracks.find((x) => x.id === timeline.focus?.lead)?.name;
  const fills = !!focusLead && !!timeline.focus?.fill?.includes(track.id);
  const under = !!focusLead && !fills && !!timeline.focus?.follow.includes(track.id);
  const summary = [
    track.segments.map(segmentSummary).join(' · '),
    fills ? `in the quiet parts of ${focusLead}` : under ? `under ${focusLead}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const hasTrackAuto = track.automation.some((l) => l.points.length > 0);

  return (
    <div
      className={cx('flex flex-col gap-3 rounded-2xl border border-line bg-card p-4', track.mute && 'opacity-60')}
      style={{ borderLeft: `4px solid ${color}` }}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <input
            className="w-full rounded-md bg-transparent font-semibold outline-none focus:bg-card-2"
            value={track.name}
            aria-label="Soundtrack name"
            onChange={(e) => editTrack((t) => void (t.name = e.target.value))}
          />
          <div className="truncate text-xs text-muted">{summary || 'No segments'}</div>
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
        hint={hasTrackAuto ? <span className="text-xs text-accent">+ volume curve</span> : undefined}
      />

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center gap-1 rounded-lg py-1 text-sm text-muted"
      >
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {open ? 'Less' : 'Sound, timing & repeats'}
      </button>

      {open && (
        <div className="flex flex-col gap-4">
          <Slider
            label="Pan"
            value={track.pan}
            min={-1}
            max={1}
            step={0.05}
            color={color}
            format={(v) => (Math.abs(v) < 0.025 ? 'Center' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`)}
            onChange={(v) => editTrack((t) => void (t.pan = v))}
            disabled={track.automation.some((l) => l.param === 'pan' && l.points.length > 0)}
            hint={
              track.segments[0] ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({ name: 'editor', id: timeline.id, focus: { trackId: track.id, segId: track.segments[0].id, param: 'pan' } });
                  }}
                  className="rounded-full bg-bg/40 px-2 py-0.5 text-xs text-accent"
                >
                  {track.automation.some((l) => l.param === 'pan' && l.points.length > 0) ? 'moves over time · edit' : 'over time'}
                </button>
              ) : undefined
            }
          />
          {track.segments.map((seg, si) => (
            <SegmentEditor
              key={seg.id}
              seg={seg}
              index={si}
              count={track.segments.length}
              duration={timeline.duration}
              color={color}
              editSeg={(recipe) =>
                editTrack((t) => {
                  const s = t.segments.find((x) => x.id === seg.id);
                  if (s) recipe(s);
                })
              }
              remove={() => editTrack((t) => void (t.segments = t.segments.filter((x) => x.id !== seg.id)))}
              onEditOverTime={(param) =>
                navigate({ name: 'editor', id: timeline.id, focus: { trackId: track.id, segId: seg.id, param } })
              }
            />
          ))}
          <div className="grid grid-cols-3 gap-2">
            <Button
              className="px-1 text-sm"
              onClick={() =>
                editTrack((t) => {
                  const last = t.segments[t.segments.length - 1];
                  const start = last ? Math.min(timeline.duration - 60, last.start + last.length) : 0;
                  const base = last ?? makeSegment('noise', { length: 30 * MIN });
                  t.segments.push({
                    ...structuredClone(base),
                    id: newId(),
                    seed: newSeed(),
                    start: Math.max(0, start),
                    length: Math.max(60, Math.min(30 * MIN, timeline.duration - start)),
                    repeat: { mode: 'none' },
                    automation: [],
                  });
                })
              }
            >
              <Plus size={16} /> Segment
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
        title="Delete soundtrack?"
        message={`"${track.name}" and its segments will be removed. You can undo this.`}
        confirmLabel="Delete"
        onConfirm={() =>
          edit((d) => {
            d.soundtracks = d.soundtracks.filter((x) => x.id !== track.id);
            if (d.focus) {
              d.focus.follow = d.focus.follow.filter((id) => id !== track.id);
              if (d.focus.fill) d.focus.fill = d.focus.fill.filter((id) => id !== track.id);
            }
          })
        }
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function repeatSummary(r: RepeatSpec): string {
  if (r.mode === 'interval') return `every ${fmtDuration(r.every)}`;
  if (r.mode === 'random') return `every ${fmtDuration(r.minGap)}–${fmtDuration(r.maxGap)}`;
  return '';
}

function segmentSummary(s: Segment): string {
  const g = GENERATORS[s.generator]?.label ?? s.generator;
  const color = s.generator === 'noise' ? ` (${NOISE_COLORS[Math.round(s.params.color ?? 1)]})` : '';
  const rep = repeatSummary(s.repeat);
  return `${g}${color}${rep ? ', ' + rep : ''}${s.automation.length ? ', automated' : ''}`;
}

// ---------------------------------------------------------------- segment

export function SegmentEditor({
  seg,
  index,
  count,
  duration,
  color,
  editSeg,
  remove,
  onEditOverTime,
}: {
  seg: Segment;
  index: number;
  count: number;
  duration: number;
  color: string;
  editSeg: (recipe: (s: Segment) => void) => void;
  remove: () => void;
  /** Open the timeline editor's automation lanes for this setting ('gain' = volume). */
  onEditOverTime?: (param: string) => void;
}) {
  const overTimeButton = (param: string) =>
    onEditOverTime ? (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          onEditOverTime(param);
        }}
        className="inline-flex items-center gap-1 rounded-full bg-bg/40 px-2 py-0.5 text-xs text-accent"
        aria-label="Change this over time in the timeline"
      >
        <LineChart size={12} /> over time
      </button>
    ) : undefined;
  /** A setting that follows a curve: no locked slider, a way into the timeline instead. */
  const curveRow = (param: string, label: string) => (
    <div key={param} className="flex items-center justify-between gap-2 rounded-lg bg-bg/40 px-3 py-2 text-sm">
      <span className="min-w-0">
        <span className="text-muted">{label}</span>
        <span className="block text-xs text-accent">Changes over time</span>
      </span>
      <span className="flex shrink-0 gap-1">
        {onEditOverTime && (
          <button
            type="button"
            onClick={() => onEditOverTime(param)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-bg"
          >
            Edit curve
          </button>
        )}
        <button
          type="button"
          onClick={() => editSeg((s) => void (s.automation = s.automation.filter((l) => l.param !== param)))}
          className="rounded-lg bg-card px-3 py-1.5 text-xs text-muted"
        >
          Make steady
        </button>
      </span>
    </div>
  );
  const def = GENERATORS[seg.generator];
  const automated = new Set(seg.automation.filter((l) => l.points.length > 0).map((l) => l.param));
  const r = seg.repeat;
  const bwParam = brainwaveParam(seg.generator);
  const bwValue = bwParam ? (seg.params[bwParam] ?? def?.params.find((p) => p.name === bwParam)?.default ?? 0) : 0;
  const currentBand = bwParam ? bandFor(bwValue) : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card-2 p-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          {def?.label ?? seg.generator}
          {count > 1 && <span className="ml-2 text-sm font-normal text-muted">segment {index + 1}</span>}
        </span>
        {count > 1 && (
          <IconButton label="Delete segment" onClick={remove} className="h-9 w-9 bg-transparent text-danger">
            <Trash2 size={16} />
          </IconButton>
        )}
      </div>

      {bwParam && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Brainwave band</span>
          <div className="grid grid-cols-5 gap-1">
            {BANDS.map((b) => (
              <button
                key={b.id}
                type="button"
                disabled={automated.has(bwParam)}
                onClick={() => editSeg((s) => void (s.params[bwParam] = b.pick))}
                className={cx(
                  'rounded-lg px-1 py-2 text-xs disabled:opacity-40',
                  currentBand?.id === b.id ? 'bg-accent font-semibold text-bg' : 'bg-bg/40 text-muted',
                )}
              >
                {b.name}
                <span className="block text-[10px] opacity-80">
                  {b.min}–{b.max} Hz
                </span>
              </button>
            ))}
          </div>
          <span className="text-xs text-muted">
            {automated.has(bwParam)
              ? 'The beat changes over time, moving between bands.'
              : currentBand
                ? `${currentBand.name} · ${currentBand.use}`
                : 'Below the delta band'}
          </span>
        </div>
      )}

      {def?.params.filter((p) => !(seg.generator === 'file' && p.name === 'xfade' && !automated.has('xfade') && !automated.has('loop') && (seg.params.loop ?? 1) < 0.5)).map((p) =>
        p.options && automated.has(p.name) ? (
          curveRow(p.name, p.label)
        ) : p.options ? (
          <div key={p.name} className="flex flex-col gap-1 text-sm">
            <span className="flex items-center justify-between">
              <span className="text-muted">{p.label}</span>
              {overTimeButton(p.name)}
            </span>
            <Segmented
              value={Math.round(seg.params[p.name] ?? p.default)}
              onChange={(v) => editSeg((s) => void (s.params[p.name] = v))}
              options={p.options.map((label, i) => ({ value: i, label }))}
            />
          </div>
        ) : automated.has(p.name) ? (
          curveRow(p.name, p.label)
        ) : (
          <Slider
            key={p.name}
            label={p.label}
            value={seg.params[p.name] ?? p.default}
            min={p.min}
            max={p.max}
            unit={p.unit}
            color={color}
            hint={overTimeButton(p.name)}
            onChange={(v) => editSeg((s) => void (s.params[p.name] = v))}
          />
        ),
      )}

      {seg.generator === 'drums' && <DrumPad seg={seg} color={color} editSeg={editSeg} />}

      <Slider
        label="Segment volume"
        value={seg.gainDb}
        min={-40}
        max={6}
        step={1}
        unit="dB"
        color={color}
        hint={overTimeButton('gain')}
        onChange={(v) => editSeg((s) => void (s.gainDb = v))}
      />
      {automated.has('gain') && curveRow('gain', 'Segment volume curve')}

      <TimeInput label="Starts at" value={seg.start} onChange={(v) => editSeg((s) => void (s.start = Math.min(v, duration)))} />
      <TimeInput label="Plays for" value={seg.length} min={1} onChange={(v) => editSeg((s) => void (s.length = Math.max(1, v)))} />
      <div className="flex flex-col gap-3">
        <Slider
          label="Fade in"
          value={seg.fadeIn}
          min={0}
          max={600}
          step={1}
          unit="s"
          color={color}
          onChange={(v) => editSeg((s) => void (s.fadeIn = v))}
        />
        <Slider
          label="Fade out"
          value={seg.fadeOut}
          min={0}
          max={600}
          step={1}
          unit="s"
          color={color}
          onChange={(v) => editSeg((s) => void (s.fadeOut = v))}
        />
        {(seg.fadeIn > 0 || seg.fadeOut > 0) && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Fade shape</span>
            <Segmented
              value={seg.fadeCurve ?? 'equal'}
              onChange={(v) => editSeg((s) => void (s.fadeCurve = v))}
              options={[
                { value: 'equal', label: 'Even' },
                { value: 'smooth', label: 'S-curve' },
                { value: 'linear', label: 'Straight' },
                { value: 'gentle', label: 'Gentle' },
              ]}
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <span className="text-muted">Repeat</span>
        <Segmented
          value={r.mode}
          onChange={(mode) =>
            editSeg((s) => {
              if (mode === s.repeat.mode) return;
              const gap = Math.max(s.length * 2, 10 * MIN);
              s.repeat =
                mode === 'none'
                  ? { mode: 'none' }
                  : mode === 'interval'
                    ? { mode: 'interval', every: gap }
                    : { mode: 'random', minGap: gap / 2, maxGap: gap * 1.5 };
            })
          }
          options={[
            { value: 'none', label: 'Once' },
            { value: 'interval', label: 'Every…' },
            { value: 'random', label: 'Randomly' },
          ]}
        />
        {r.mode === 'interval' && (
          <TimeInput
            label="Every (start to start)"
            value={r.every}
            min={1}
            onChange={(v) => editSeg((s) => void (s.repeat = { ...r, every: Math.max(1, v) }))}
          />
        )}
        {r.mode === 'random' && (
          <>
            <TimeInput
              label="Shortest gap"
              value={r.minGap}
              min={1}
              onChange={(v) =>
                editSeg((s) => void (s.repeat = { ...r, minGap: Math.max(1, v), maxGap: Math.max(r.maxGap, v) }))
              }
            />
            <TimeInput
              label="Longest gap"
              value={r.maxGap}
              min={1}
              onChange={(v) =>
                editSeg((s) => void (s.repeat = { ...r, maxGap: Math.max(1, v), minGap: Math.min(r.minGap, v) }))
              }
            />
          </>
        )}
        {r.mode !== 'none' && (
          <div className="flex flex-col gap-1">
            <span className="text-muted">Stop repeating</span>
            <Segmented
              className="w-full"
              value={r.until == null ? 'end' : 'at'}
              onChange={(v) =>
                editSeg((s) => void (s.repeat = { ...r, until: v === 'end' ? null : Math.min(duration, seg.start + 2 * 3600) }))
              }
              options={[
                { value: 'end', label: 'Never' },
                { value: 'at', label: 'After a time' },
              ]}
            />
          </div>
        )}
        {r.mode !== 'none' && r.until != null && (
          <TimeInput label="No new repeats after" value={r.until} onChange={(v) => editSeg((s) => void (s.repeat = { ...r, until: v }))} />
        )}
      </div>
    </div>
  );
}
