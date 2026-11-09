import { Moon, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { useLibrary } from '../store/library.ts';
import { player, togglePlay, usePlayback } from '../store/playback.ts';
import { isSample, samples } from '../store/samples.ts';
import { Button, IconButton, Sheet, fmtClock } from '../ui/controls.tsx';
import { SLEEP_CHOICES, sleepLabel } from './Settings.tsx';

/** Bottom bar: what's playing, play/pause, scrub, sleep timer. */
export function NowPlayingBar() {
  const activeId = usePlayback((s) => s.activeId);
  const playing = usePlayback((s) => s.playing);
  const status = usePlayback((s) => s.status);
  const error = usePlayback((s) => s.error);
  const tl = useLibrary((s) =>
    activeId ? (s.timelines[activeId] ?? (isSample(activeId) ? samples()[activeId] : undefined)) : undefined,
  );
  const navigate = useLibrary((s) => s.navigate);
  const screen = useLibrary((s) => s.stack[s.stack.length - 1]);
  const [scrub, setScrub] = useState<number | null>(null);
  const [sleepOpen, setSleepOpen] = useState(false);

  if (!tl) return null;
  const pos = scrub ?? status.positionSec;
  const fill = tl.duration > 0 ? (pos / tl.duration) * 100 : 0;
  const sleep = status.sleepRemainingSec;
  const commit = () => {
    if (scrub !== null) player.seek(scrub);
    setScrub(null);
  };

  return (
    <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 px-4 pt-2 backdrop-blur">
      {error && <p className="mb-1 text-sm text-danger">{error}</p>}
      <input
        className="slider"
        type="range"
        min={0}
        max={tl.duration}
        step={1}
        value={pos}
        aria-label="Position"
        onChange={(e) => setScrub(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        style={{ ['--fill' as string]: `${fill}%` }}
      />
      <div className="flex items-center gap-3">
        <IconButton label={playing ? 'Pause' : 'Play'} active onClick={() => void togglePlay()} className="h-12 w-12">
          {playing ? <Pause size={22} /> : <Play size={22} className="ml-0.5" />}
        </IconButton>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            // samples are read-only, so they have no mixer to open
            if (!isSample(tl.id) && !(screen.name === 'mixer' && screen.id === tl.id)) navigate({ name: 'mixer', id: tl.id });
          }}
        >
          <div className="truncate font-semibold">{tl.name}</div>
          <div className="text-sm tabular-nums text-muted">
            {fmtClock(pos)} / {fmtClock(tl.duration)}
            {status.stoppedBy === 'sleep' && !playing && ' · stopped by sleep timer'}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setSleepOpen(true)}
          aria-label="Sleep timer"
          className={`flex h-11 items-center gap-1 rounded-full px-3 text-sm ${sleep !== null ? 'bg-accent text-bg font-semibold' : 'bg-accent-soft'}`}
        >
          <Moon size={16} />
          {sleep !== null ? fmtClock(sleep).replace(/^0:/, '') : ''}
        </button>
      </div>

      <Sheet open={sleepOpen} onClose={() => setSleepOpen(false)} title="Sleep timer">
        <p className="text-sm text-muted">Stop playing after a while, fading out over the last minute.</p>
        <div className="grid grid-cols-4 gap-2">
          {SLEEP_CHOICES.map((m) => (
            <Button
              key={String(m)}
              variant={m === null && sleep === null ? 'primary' : 'soft'}
              onClick={() => {
                player.setSleepTimer(m);
                setSleepOpen(false);
              }}
            >
              {sleepLabel(m)}
            </Button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
