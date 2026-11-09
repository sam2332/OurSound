// Receiving a shared timeline, and linking the audio files it uses.
//
// A shared timeline lists its imported files (name, length, size) but doesn't
// contain them. Here the receiver's own copies are found — first in OurSound,
// then by scanning the phone's music (or a folder they pick) — and copied in.

import { Capacitor } from '@capacitor/core';
import { CheckCircle2, CircleHelp, CircleX, FolderSearch, Link2, Music, ScanLine, Search, Unlink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { addNativeAssets, importAudioFile, importAudioNative, listAssets, type StoredAsset } from '../audio/assets.ts';
import type { SharedFile, Timeline } from '../engine/model.ts';
import { NativeEngine, type FoundAudio } from '../native/engine-plugin.ts';
import { applyLinks, matchFiles, type Candidate, type Confidence } from '../relink.ts';
import { PartCollector, readShared } from '../share.ts';
import { useLibrary } from '../store/library.ts';
import { Button, Card, Sheet, cx, fmtClock, fmtDuration } from '../ui/controls.tsx';

const isNative = Capacitor.isNativePlatform();

// ------------------------------------------------------------ incoming timelines

type Incoming = {
  timeline: Timeline | null;
  error: string | null;
  /** Scanning a big timeline's QR codes: how far along. */
  parts: { have: number; total: number; next: number } | null;
};
export const useIncoming = create<Incoming>(() => ({ timeline: null, error: null, parts: null }));

const collector = new PartCollector();

/**
 * Opens the QR scanner. A whole code opens the import sheet; for a timeline in
 * several codes it keeps scanning (in any order) until it has them all.
 */
export async function scanShared(): Promise<void> {
  try {
    for (;;) {
      const r = await NativeEngine.scanQr();
      if (!r.text) return; // cancelled: the "Keep scanning" sheet stays if parts are in
      const part = collector.add(r.text);
      if (!part) {
        await receiveShared(r.text);
        return;
      }
      if (part.done) {
        useIncoming.setState({ parts: null });
        await receiveShared(part.code);
        return;
      }
      useIncoming.setState({ parts: { have: part.have, total: part.total, next: part.next } });
    }
  } catch (err) {
    useIncoming.setState({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Opens the "Shared timeline" sheet for a code (throws nothing). */
export async function receiveShared(text: string): Promise<boolean> {
  try {
    useIncoming.setState({ timeline: await readShared(text), error: null });
    return true;
  } catch (err) {
    useIncoming.setState({ timeline: null, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

const libCandidate = (a: StoredAsset): Candidate => ({
  libraryId: a.id,
  name: a.name + (a.ext ?? ''),
  duration: a.duration,
  size: a.size,
  folder: 'Already in OurSound',
});

const foundCandidate = (f: FoundAudio): Candidate => ({
  uri: f.uri,
  name: f.name,
  duration: f.duration || undefined,
  size: f.size || undefined,
  folder: f.folder,
});

// ------------------------------------------------------------ linking files

type Pick = { candidate: Candidate; confidence: Confidence | 'chosen' };

/**
 * The list of files a timeline needs, each with the copy found for it.
 * `onDone` gets old asset id → this phone's asset id for every file linked.
 */
export function LinkFiles({
  files,
  doneLabel,
  onDone,
}: {
  files: SharedFile[];
  doneLabel: (linked: number) => string;
  onDone: (links: Map<string, string>) => void;
}) {
  const [picks, setPicks] = useState<Map<string, Pick>>(new Map());
  const [found, setFound] = useState<Candidate[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const choosingFor = useRef<string | null>(null);

  /** Re-matches files the user hasn't chosen by hand against everything known. */
  const rematch = (cands: Candidate[], current: Map<string, Pick>) => {
    const chosen = [...current.values()].filter((p) => p.confidence === 'chosen');
    const open = files.filter((f) => current.get(f.id)?.confidence !== 'chosen');
    const taken = new Set(chosen.map((p) => p.candidate));
    const m = matchFiles(open, cands.filter((c) => !taken.has(c)));
    const next = new Map<string, Pick>();
    for (const f of files) {
      const c = current.get(f.id);
      if (c?.confidence === 'chosen') next.set(f.id, c);
      else {
        const hit = m.get(f.id);
        if (hit) next.set(f.id, { candidate: hit.candidate, confidence: hit.confidence });
      }
    }
    return next;
  };

  const scanPhone = async (lib: Candidate[], current: Map<string, Pick>) => {
    setStatus('Looking through the music on this phone…');
    try {
      const r = await NativeEngine.scanAudio();
      if (r.denied) setDenied(true);
      const all = [...lib, ...r.files.map(foundCandidate)];
      setFound(all);
      const next = rematch(all, current);
      setPicks(next);
      setStatus(
        r.denied
          ? null
          : `Looked through ${r.files.length.toLocaleString()} audio file${r.files.length === 1 ? '' : 's'} on this phone.`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  // First: files already in OurSound, then the phone's music.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const lib = (await listAssets()).map(libCandidate);
      if (!alive) return;
      setFound(lib);
      const first = rematch(lib, new Map());
      setPicks(first);
      if (isNative && files.some((f) => !first.has(f.id))) await scanPhone(lib, first);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scanAFolder = async () => {
    setStatus('Pick the folder your music is in…');
    try {
      const r = await NativeEngine.scanFolder();
      if (r.cancelled || !r.files) {
        setStatus(null);
        return;
      }
      const all = [...found, ...r.files.map(foundCandidate)];
      setFound(all);
      setPicks((p) => rematch(all, p));
      setStatus(`Looked through ${r.files.length.toLocaleString()} audio files in that folder.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const choose = async (fileId: string) => {
    if (!isNative) {
      choosingFor.current = fileId;
      fileInput.current?.click();
      return;
    }
    try {
      const a = await importAudioNative();
      if (a) setPicks((p) => new Map(p).set(fileId, { candidate: libCandidate(a), confidence: 'chosen' }));
    } catch (err) {
      setProblems((x) => [...x, err instanceof Error ? err.message : String(err)]);
    }
  };

  const unlink = (fileId: string) =>
    setPicks((p) => {
      const n = new Map(p);
      n.delete(fileId);
      return n;
    });

  const finish = async () => {
    setBusy(true);
    const links = new Map<string, string>();
    const failed: string[] = [];
    const todo = files.filter((f) => picks.has(f.id));
    let n = 0;
    for (const f of todo) {
      const c = picks.get(f.id)!.candidate;
      n++;
      if (c.libraryId) {
        links.set(f.id, c.libraryId);
        continue;
      }
      setStatus(`Copying ${n} of ${todo.length}: ${c.name}`);
      try {
        const meta = await NativeEngine.importAudioUri({ uri: c.uri! });
        await addNativeAssets([meta]);
        links.set(f.id, meta.id);
      } catch (err) {
        failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    setStatus(null);
    if (failed.length) setProblems(failed);
    onDone(links);
  };

  const linked = files.filter((f) => picks.has(f.id)).length;
  const missing = files.length - linked;

  return (
    <>
      <ul className="flex flex-col gap-2">
        {files.map((f) => {
          const p = picks.get(f.id);
          const c = p?.candidate;
          const icon = !p ? (
            <CircleX size={18} className="shrink-0 text-danger" />
          ) : p.confidence === 'guess' ? (
            <CircleHelp size={18} className="shrink-0 text-warn" />
          ) : (
            <CheckCircle2 size={18} className="shrink-0 text-accent" />
          );
          return (
            <li key={f.id} className="flex flex-col gap-1 rounded-xl bg-card-2 p-3">
              <div className="flex items-center gap-2">
                {icon}
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <span className="text-xs tabular-nums text-muted">{fmtClock(f.duration).replace(/^0:/, '')}</span>
              </div>
              <p className={cx('pl-7 text-xs', !p ? 'text-danger' : p.confidence === 'guess' ? 'text-warn' : 'text-muted')}>
                {!p && 'Not found yet'}
                {p && c?.libraryId && p.confidence !== 'chosen' && 'Already in OurSound'}
                {p && !c?.libraryId && p.confidence !== 'chosen' && (
                  <>
                    {p.confidence === 'guess' ? 'Best guess, check it: ' : 'Found: '}
                    <span className="text-ink">{c?.name}</span>
                    {c?.folder ? ` in ${c.folder}` : ''}
                  </>
                )}
                {p && p.confidence === 'chosen' && (
                  <>
                    You chose <span className="text-ink">{c?.name}</span>
                  </>
                )}
              </p>
              <div className="flex gap-2 pl-7">
                <button className="text-xs font-semibold text-accent" onClick={() => void choose(f.id)} disabled={busy}>
                  {p ? 'Choose a different file' : 'Choose the file…'}
                </button>
                {p && (
                  <button className="flex items-center gap-1 text-xs text-muted" onClick={() => unlink(f.id)} disabled={busy}>
                    <Unlink size={12} /> Leave unlinked
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {status && <p className="text-sm text-muted">{status}</p>}
      {denied && (
        <p className="text-sm text-warn">
          OurSound wasn't allowed to look at your music. Pick the folder it's in instead, or choose each file.
        </p>
      )}
      {isNative && missing > 0 && !busy && (
        <div className="flex flex-wrap gap-2">
          {denied && (
            <Button onClick={() => void scanPhone(found.filter((c) => c.libraryId), picks)}>
              <Search size={16} /> Search the phone again
            </Button>
          )}
          <Button onClick={() => void scanAFolder()}>
            <FolderSearch size={16} /> Search a folder…
          </Button>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="text-sm text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {missing > 0 && !busy && (
        <p className="text-sm text-muted">
          Files you don't link stay silent. You can link them later from the timeline.
        </p>
      )}
      <Button variant="primary" onClick={() => void finish()} disabled={busy}>
        <Link2 size={18} /> {busy ? 'Copying…' : doneLabel(linked)}
      </Button>

      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          const id = choosingFor.current;
          if (!file || !id) return;
          try {
            const a = await importAudioFile(file);
            setPicks((p) => new Map(p).set(id, { candidate: libCandidate(a), confidence: 'chosen' }));
          } catch (err) {
            setProblems((x) => [...x, err instanceof Error ? err.message : String(err)]);
          }
        }}
      />
    </>
  );
}

// ------------------------------------------------------------ the sheets

function summary(tl: Timeline) {
  const n = tl.soundtracks.length;
  return `${n} soundtrack${n === 1 ? '' : 's'} · ${fmtDuration(tl.duration)}`;
}

/** Shown (from App) whenever a shared timeline arrives. */
export function SharedImportSheet() {
  const { timeline, error, parts } = useIncoming();
  const importTimeline = useLibrary((s) => s.importTimeline);
  const navigate = useLibrary((s) => s.navigate);
  const close = () => useIncoming.setState({ timeline: null, error: null });

  const add = (links: Map<string, string>) => {
    if (!timeline) return;
    const tl = structuredClone(timeline);
    applyLinks(tl, links);
    const id = importTimeline(tl);
    close();
    navigate({ name: 'mixer', id });
  };

  const files = timeline?.missingFiles ?? [];
  return (
    <>
      <Sheet open={!!parts} onClose={() => useIncoming.setState({ parts: null })} title="Keep scanning">
        {parts && (
          <>
            <div className="flex gap-1.5">
              {Array.from({ length: parts.total }, (_, i) => (
                <span key={i} className={cx('h-2 flex-1 rounded-full', i < parts.have ? 'bg-accent' : 'bg-card-2')} />
              ))}
            </div>
            <p className="text-sm">
              Got {parts.have} of {parts.total} codes. Keep the camera on the other phone; the codes change by
              themselves.
            </p>
            <Button variant="primary" onClick={() => void scanShared()}>
              <ScanLine size={18} /> Keep scanning
            </Button>
          </>
        )}
      </Sheet>
      <Sheet open={!!error} onClose={close} title="Couldn't open this">
        <p className="text-sm">{error}</p>
        <Button onClick={close}>OK</Button>
      </Sheet>
      <Sheet open={!!timeline} onClose={close} title="Shared timeline">
        {timeline && (
          <>
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                <Music size={22} />
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold">{timeline.name}</p>
                <p className="text-sm text-muted">{summary(timeline)}</p>
              </div>
            </div>
            {files.length === 0 ? (
              <Button variant="primary" onClick={() => add(new Map())}>
                Add to my timelines
              </Button>
            ) : (
              <>
                <p className="text-sm text-muted">
                  It plays {files.length === 1 ? "an audio file that wasn't" : `${files.length} audio files that weren't`} sent along.
                  Link your own {files.length === 1 ? 'copy' : 'copies'}:
                </p>
                <LinkFiles
                  key={timeline.name + files.length}
                  files={files}
                  doneLabel={(n) => (n === files.length ? 'Add to my timelines' : `Add with ${n} of ${files.length} linked`)}
                  onDone={add}
                />
              </>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}

/** "N audio files aren't linked" card for a timeline's mixer. */
export function MissingFilesCard({ timeline }: { timeline: Timeline }) {
  const updateTimeline = useLibrary((s) => s.updateTimeline);
  const [open, setOpen] = useState(false);
  const files = timeline.missingFiles ?? [];
  if (!files.length) return null;
  return (
    <Card className="border-warn/40">
      <div className="flex items-center gap-3">
        <CircleHelp size={22} className="shrink-0 text-warn" />
        <p className="flex-1 text-sm">
          {files.length === 1 ? '1 audio file isn’t' : `${files.length} audio files aren’t`} linked yet, so{' '}
          {files.length === 1 ? 'it plays' : 'they play'} as silence.
        </p>
      </div>
      <Button onClick={() => setOpen(true)}>
        <Search size={16} /> Find {files.length === 1 ? 'it' : 'them'}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Link audio files">
        {open && (
          <LinkFiles
            files={files}
            doneLabel={(n) => (n ? `Link ${n} file${n === 1 ? '' : 's'}` : 'Done')}
            onDone={(links) => {
              if (links.size) updateTimeline(timeline.id, (d) => applyLinks(d, links));
              setOpen(false);
            }}
          />
        )}
      </Sheet>
    </Card>
  );
}
