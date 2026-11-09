import { Clipboard } from '@capacitor/clipboard';
import { Capacitor } from '@capacitor/core';
import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, QrCode, ScanLine } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { listAssets, type StoredAsset } from '../audio/assets.ts';
import type { Timeline } from '../engine/model.ts';
import { encodeTimeline, filesNeeded, qrParts } from '../share.ts';
import { Button, IconButton, Sheet } from '../ui/controls.tsx';
import { receiveShared, scanShared, useIncoming } from './SharedImport.tsx';

async function copyText(text: string) {
  if (Capacitor.isNativePlatform()) await Clipboard.write({ string: text });
  else await navigator.clipboard.writeText(text);
}

/** Shows a timeline as a QR code (several, for a big one), plus a code to copy. */
export function ShareSheet({ timeline, onClose }: { timeline: Timeline | null; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [qrs, setQrs] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  /** Several codes take turns on screen, so the other phone can just keep scanning. */
  const [auto, setAuto] = useState(true);
  const [copied, setCopied] = useState(false);
  const [library, setLibrary] = useState<StoredAsset[]>([]);

  useEffect(() => {
    setCode(null);
    setQrs([]);
    setPage(0);
    setAuto(true);
    setCopied(false);
    if (!timeline) return;
    let alive = true;
    void (async () => {
      const lib = await listAssets();
      if (!alive) return;
      setLibrary(lib);
      const c = await encodeTimeline(timeline, lib);
      if (!alive) return;
      setCode(c);
      const images = await Promise.all(
        qrParts(c).map((p) => QRCode.toDataURL(p, { errorCorrectionLevel: 'L', margin: 4, width: 1000 })),
      );
      if (alive) setQrs(images);
    })();
    return () => {
      alive = false;
    };
  }, [timeline]);

  const files = timeline ? filesNeeded(timeline, library) : [];
  const many = qrs.length > 1;

  useEffect(() => {
    if (!many || !auto) return;
    const t = setInterval(() => setPage((p) => (p + 1) % qrs.length), 1200);
    return () => clearInterval(t);
  }, [many, auto, qrs.length]);

  return (
    <Sheet open={timeline !== null} onClose={onClose} title={`Share "${timeline?.name ?? ''}"`}>
      <p className="text-sm text-muted">
        On the other phone: OurSound → <b className="text-ink">Import</b>, then point it at this code.
        {many && ` It takes ${qrs.length} codes; they change by themselves, so just keep the camera on them.`}
      </p>
      {qrs.length > 0 ? (
        <div className="flex flex-col items-center gap-2">
          <img src={qrs[page]} alt={`QR code ${page + 1} of ${qrs.length}`} className="w-full max-w-sm rounded-xl bg-white" />
          {many && (
            <div className="flex items-center gap-4">
              <IconButton
                label="Previous code"
                onClick={() => {
                  setAuto(false);
                  setPage((p) => (p - 1 + qrs.length) % qrs.length);
                }}
              >
                <ChevronLeft size={22} />
              </IconButton>
              <button className="min-w-20 font-semibold tabular-nums" onClick={() => setAuto((a) => !a)}>
                {page + 1} of {qrs.length}
                <span className="block text-xs font-normal text-muted">{auto ? 'tap to pause' : 'paused · tap to play'}</span>
              </button>
              <IconButton
                label="Next code"
                onClick={() => {
                  setAuto(false);
                  setPage((p) => (p + 1) % qrs.length);
                }}
              >
                <ChevronRight size={22} />
              </IconButton>
            </div>
          )}
        </div>
      ) : (
        <p className="text-muted">Preparing…</p>
      )}
      {files.length > 0 && (
        <p className="text-sm text-muted">
          Your audio files stay on your phone. The other phone finds its own copies of{' '}
          {files.length <= 3 ? (
            files.map((f, i) => (
              <span key={f.id}>
                {i > 0 && (i === files.length - 1 ? ' and ' : ', ')}
                <span className="text-ink">{f.name}</span>
              </span>
            ))
          ) : (
            <span className="text-ink">{files.length} tracks</span>
          )}
          .
        </p>
      )}
      {code && (
        <Button
          onClick={async () => {
            await copyText(code);
            setCopied(true);
          }}
        >
          <Copy size={18} /> {copied ? 'Copied: paste it in a message' : 'Copy as a code instead'}
        </Button>
      )}
    </Sheet>
  );
}

/** "Scan a QR code" and "Paste a code" buttons, for the New timeline sheet. */
export function ReceiveButtons({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState('');

  const receive = async (raw: string) => {
    setError(null);
    if (await receiveShared(raw)) {
      setPasteOpen(false);
      setText('');
      onDone();
    } else {
      setError(useIncoming.getState().error);
      useIncoming.setState({ error: null });
    }
  };

  return (
    <>
      {Capacitor.isNativePlatform() && (
        <Button
          className="justify-start"
          onClick={() => {
            onDone();
            void scanShared();
          }}
        >
          <ScanLine size={18} /> Import from a QR code
        </Button>
      )}
      <Button className="justify-start" onClick={() => setPasteOpen(true)}>
        <ClipboardPaste size={18} /> Paste a shared code
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}

      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="Paste a shared code">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="OURSOUND1:…"
          className="h-32 w-full rounded-xl bg-card-2 p-3 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        <Button variant="primary" onClick={() => void receive(text)} disabled={!text.trim()}>
          <QrCode size={18} /> Open it
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </Sheet>
    </>
  );
}
