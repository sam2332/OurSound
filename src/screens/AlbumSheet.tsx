import { ArrowDown, ArrowUp, Disc3, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { albumLength, albumSoundtrack, type AlbumTrack } from '../album.ts';
import type { Timeline } from '../engine/model.ts';
import { Button, IconButton, Sheet, fmtDuration } from '../ui/controls.tsx';

/** Put imported tracks in order, then add them back to back as one soundtrack. */
export function AlbumSheet({
  tracks,
  timeline,
  onClose,
  onAdd,
}: {
  tracks: AlbumTrack[] | null;
  timeline: Timeline;
  onClose: () => void;
  onAdd: (recipe: (d: Timeline) => void) => void;
}) {
  const [order, setOrder] = useState<AlbumTrack[]>([]);
  const [name, setName] = useState('Album');
  const [stretch, setStretch] = useState(true);
  useEffect(() => {
    if (tracks) setOrder(tracks);
  }, [tracks]);

  const total = albumLength(order);
  const longer = total > timeline.duration;
  const move = (i: number, d: number) =>
    setOrder((o) => {
      const j = i + d;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <Sheet open={tracks !== null} onClose={onClose} title="Album order">
      <input
        className="rounded-xl bg-card-2 px-3 py-2 font-semibold outline-none focus:ring-1 focus:ring-accent"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Album name"
      />
      <p className="text-sm text-muted">
        {order.length} tracks · {fmtDuration(Math.round(total))}. They play back to back in this order, each starting
        where the previous one ends.
      </p>
      <ol className="flex flex-col gap-2">
        {order.map((t, i) => (
          <li key={t.id} className="flex items-center gap-2 rounded-xl bg-card-2 p-2 pl-3">
            <span className="w-6 text-sm text-muted tabular-nums">{i + 1}.</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t.name}</span>
              <span className="text-xs text-muted">{fmtDuration(Math.round(t.duration))}</span>
            </span>
            <IconButton label={`Move ${t.name} up`} onClick={() => move(i, -1)} disabled={i === 0} className="h-9 w-9">
              <ArrowUp size={16} />
            </IconButton>
            <IconButton label={`Move ${t.name} down`} onClick={() => move(i, 1)} disabled={i === order.length - 1} className="h-9 w-9">
              <ArrowDown size={16} />
            </IconButton>
            <IconButton
              label={`Remove ${t.name}`}
              onClick={() => setOrder((o) => o.filter((x) => x.id !== t.id))}
              className="h-9 w-9 bg-transparent text-muted"
            >
              <X size={16} />
            </IconButton>
          </li>
        ))}
      </ol>
      {longer && (
        <label className="flex items-center gap-3 rounded-xl bg-card-2 p-3 text-sm">
          <input type="checkbox" checked={stretch} onChange={(e) => setStretch(e.target.checked)} className="h-5 w-5 accent-[var(--color-accent)]" />
          <span>
            Make the timeline {fmtDuration(Math.ceil(total))} so the whole album fits
            <span className="block text-xs text-muted">It's {fmtDuration(timeline.duration)} now.</span>
          </span>
        </label>
      )}
      <Button
        variant="primary"
        disabled={order.length === 0}
        onClick={() => {
          const tracksNow = order;
          onAdd((d) => {
            d.soundtracks.push(albumSoundtrack(tracksNow, name.trim() || 'Album', d.soundtracks.length));
            if (stretch && albumLength(tracksNow) > d.duration) d.duration = Math.ceil(albumLength(tracksNow));
          });
          onClose();
        }}
      >
        <Disc3 size={18} /> Add album to the timeline
      </Button>
    </Sheet>
  );
}
