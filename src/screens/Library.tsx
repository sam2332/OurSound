import { Capacitor } from '@capacitor/core';
import { BookmarkPlus, Copy, CopyPlus, QrCode, MoreVertical, Pause, Play, Plus, ScanLine, Settings as SettingsIcon, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import logo from '../assets/logo.svg';
import { GENERATORS } from '../engine/generators.ts';
import type { Timeline } from '../engine/model.ts';
import { useLibrary } from '../store/library.ts';
import { togglePlay, usePlayback } from '../store/playback.ts';
import { copySample, samples, templateForSample } from '../store/samples.ts';
import { TEMPLATES, TEMPLATE_CATEGORIES } from '../templates.ts';
import { ReceiveButtons, ShareSheet } from './ShareSheets.tsx';
import { scanShared } from './SharedImport.tsx';
import { Button, Confirm, IconButton, Sheet, cx, fmtDuration } from '../ui/controls.tsx';
import { FeedbackButton } from './FeedbackSheet.tsx';

function TrackDots({ tl }: { tl: Timeline }) {
  return (
    <div className="mt-1 flex gap-1">
      {tl.soundtracks.slice(0, 8).map((t) => (
        <span
          key={t.id}
          className={cx('h-1.5 w-5 rounded-full', t.mute && 'opacity-30')}
          style={{ background: t.color ?? 'var(--color-accent)' }}
        />
      ))}
    </div>
  );
}

function summary(tl: Timeline) {
  const n = tl.soundtracks.length;
  return `${fmtDuration(tl.duration)} · ${n} soundtrack${n === 1 ? '' : 's'}${tl.endBehavior === 'loop' ? ' · loops' : tl.endBehavior === 'wake' ? ' · gentle wake' : ''}`;
}

function TimelineRow({
  tl,
  subtitle,
  onOpen,
  onMore,
}: {
  tl: Timeline;
  subtitle?: string;
  onOpen: () => void;
  onMore?: () => void;
}) {
  const activeId = usePlayback((s) => s.activeId);
  const playing = usePlayback((s) => s.playing);
  const isActive = activeId === tl.id;
  const isPlaying = isActive && playing;
  return (
    <li className={cx('flex items-center gap-3 rounded-2xl border bg-card p-3', isActive ? 'border-accent/60' : 'border-line')}>
      <IconButton
        label={isPlaying ? `Pause ${tl.name}` : `Play ${tl.name}`}
        active={isPlaying}
        onClick={() => void togglePlay(tl.id)}
        className="h-12 w-12"
      >
        {isPlaying ? <Pause size={22} /> : <Play size={22} className="ml-0.5" />}
      </IconButton>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="truncate font-semibold">{tl.name}</div>
        <div className="line-clamp-2 text-sm text-muted">{subtitle ?? summary(tl)}</div>
        <TrackDots tl={tl} />
      </button>
      {onMore && (
        <IconButton label={`More options for ${tl.name}`} onClick={onMore} className="bg-transparent">
          <MoreVertical size={20} />
        </IconButton>
      )}
    </li>
  );
}

export function LibraryScreen() {
  const timelines = useLibrary((s) => s.timelines);
  const order = useLibrary((s) => s.order);
  const userTemplates = useLibrary((s) => s.userTemplates);
  const navigate = useLibrary((s) => s.navigate);
  const createTimeline = useLibrary((s) => s.createTimeline);
  const duplicateTimeline = useLibrary((s) => s.duplicateTimeline);
  const deleteTimeline = useLibrary((s) => s.deleteTimeline);
  const saveAsTemplate = useLibrary((s) => s.saveAsTemplate);
  const deleteUserTemplate = useLibrary((s) => s.deleteUserTemplate);
  const activeId = usePlayback((s) => s.activeId);
  const playing = usePlayback((s) => s.playing);
  const [newOpen, setNewOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sampleOpen, setSampleOpen] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const all = samples();

  const create = (tl?: Timeline) => {
    const id = createTimeline(tl);
    setNewOpen(false);
    navigate({ name: 'mixer', id });
  };

  const copy = (sampleId: string) => {
    const id = copySample(sampleId);
    setSampleOpen(null);
    if (id) navigate({ name: 'mixer', id });
  };

  const openSample = sampleOpen ? all[sampleOpen] : undefined;
  const openTemplate = sampleOpen ? templateForSample(sampleOpen) : undefined;
  const samplePlaying = sampleOpen !== null && activeId === sampleOpen && playing;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="h-12 w-12 rounded-xl" />
          <div>
          <h1 className="text-3xl font-bold tracking-tight">OurSound</h1>
          <p className="text-sm text-muted">Generated sound for sleep, rest and focus</p>
          </div>
        </div>
        <div className="flex items-center">
          <FeedbackButton />
          <IconButton label="Settings" onClick={() => navigate({ name: 'settings' })}>
            <SettingsIcon size={20} />
          </IconButton>
        </div>
      </header>

      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" onClick={() => setNewOpen(true)}>
          <Plus size={20} /> New timeline
        </Button>
        <Button onClick={() => (Capacitor.isNativePlatform() ? void scanShared() : setNewOpen(true))}>
          <ScanLine size={20} /> Import
        </Button>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your timelines</h2>
        {order.length === 0 && (
          <p className="rounded-2xl border border-dashed border-line p-5 text-center text-sm text-muted">
            Nothing here yet. Pick a sample below and tap <b className="text-ink">Make my copy</b>, or start a new
            timeline.
          </p>
        )}
        {savedNote && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{savedNote}</p>}
        <ul className="flex flex-col gap-3">
          {order.map((id) => {
            const tl = timelines[id];
            if (!tl) return null;
            return (
              <TimelineRow
                key={id}
                tl={tl}
                onOpen={() => navigate({ name: 'mixer', id })}
                onMore={() => setMenuFor(id)}
              />
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">Samples</h2>
          <p className="text-sm text-muted">Play them as they are, or make your own copy to change anything.</p>
        </div>
        {TEMPLATE_CATEGORIES.map((cat) => (
          <div key={cat} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-muted">{cat}</h3>
            <ul className="flex flex-col gap-2">
              {TEMPLATES.filter((t) => t.category === cat).map((t) => {
                const tl = all['sample:' + t.id];
                return (
                  <TimelineRow key={t.id} tl={tl} subtitle={t.description} onOpen={() => setSampleOpen(tl.id)} />
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      {/* sample preview */}
      <Sheet open={!!openSample && !!openTemplate} onClose={() => setSampleOpen(null)} title={openSample?.name ?? ''}>
        {openSample && openTemplate && (
          <>
            <p>{openTemplate.description}</p>
            <p className="rounded-xl bg-card-2 p-3 text-sm text-muted">
              <b className="text-ink">Shows: </b>
              {openTemplate.shows}
            </p>
            <ul className="flex flex-col gap-1">
              {openSample.soundtracks.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                  <span className="font-medium">{t.name}</span>
                  <span className="truncate text-muted">
                    · {t.segments.map((s) => GENERATORS[s.generator]?.label ?? s.generator).join(', ')}
                    {t.segments.some((s) => s.automation.length) ? ' · automated' : ''}
                    {t.segments.some((s) => s.repeat.mode !== 'none') ? ' · repeats' : ''}
                  </span>
                </li>
              ))}
            </ul>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => void togglePlay(openSample.id)}>
                {samplePlaying ? <Pause size={18} /> : <Play size={18} />}
                {samplePlaying ? 'Pause' : 'Play'}
              </Button>
              <Button variant="primary" onClick={() => copy(openSample.id)}>
                <CopyPlus size={18} /> Make my copy
              </Button>
            </div>
          </>
        )}
      </Sheet>

      {/* new timeline */}
      <Sheet open={newOpen} onClose={() => setNewOpen(false)} title="New timeline">
        <Button onClick={() => create()} className="justify-start">
          <Plus size={18} /> Blank timeline (8 h)
        </Button>
        <ReceiveButtons onDone={() => setNewOpen(false)} />
        {userTemplates.length > 0 && (
          <>
            <p className="mt-2 text-sm font-semibold text-muted">Your templates</p>
            {userTemplates.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-xl bg-card-2 p-1 pl-3">
                <button type="button" onClick={() => create(t)} className="min-w-0 flex-1 py-2 text-left">
                  <div className="truncate font-semibold">{t.name}</div>
                  <div className="text-sm text-muted">{summary(t)}</div>
                </button>
                <IconButton label={`Delete template ${t.name}`} onClick={() => deleteUserTemplate(t.id)} className="h-9 w-9 bg-transparent text-muted">
                  <X size={16} />
                </IconButton>
              </div>
            ))}
          </>
        )}
        {TEMPLATE_CATEGORIES.map((cat) => (
          <div key={cat} className="flex flex-col gap-2">
            <p className="mt-2 text-sm font-semibold text-muted">{cat}</p>
            {TEMPLATES.filter((t) => t.category === cat).map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => create(t.build())}
                className="rounded-xl bg-card-2 p-3 text-left active:scale-[0.99]"
              >
                <div className="font-semibold">{t.name}</div>
                <div className="text-sm text-muted">{t.description}</div>
              </button>
            ))}
          </div>
        ))}
      </Sheet>

      {/* your timeline's menu */}
      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} title={menuFor ? timelines[menuFor]?.name ?? '' : ''}>
        <Button
          className="justify-start"
          onClick={() => {
            if (menuFor) duplicateTimeline(menuFor);
            setMenuFor(null);
          }}
        >
          <Copy size={18} /> Duplicate
        </Button>
        <Button
          className="justify-start"
          onClick={() => {
            setShareId(menuFor);
            setMenuFor(null);
          }}
        >
          <QrCode size={18} /> Share as QR code
        </Button>
        <Button
          className="justify-start"
          onClick={() => {
            if (menuFor) {
              saveAsTemplate(menuFor);
              setSavedNote(`Saved "${timelines[menuFor]?.name}" as a template. Find it under New timeline.`);
              setTimeout(() => setSavedNote(null), 4000);
            }
            setMenuFor(null);
          }}
        >
          <BookmarkPlus size={18} /> Save as template
        </Button>
        <Button
          variant="danger"
          className="justify-start"
          onClick={() => {
            setConfirmDelete(menuFor);
            setMenuFor(null);
          }}
        >
          <Trash2 size={18} /> Delete
        </Button>
      </Sheet>

      <ShareSheet timeline={shareId ? (timelines[shareId] ?? null) : null} onClose={() => setShareId(null)} />

      <Confirm
        open={confirmDelete !== null}
        title="Delete timeline?"
        message={`"${confirmDelete ? timelines[confirmDelete]?.name : ''}" will be removed from this phone. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => confirmDelete && deleteTimeline(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
