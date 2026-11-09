import { ArrowLeft, BatteryCharging, FileAudio, Headphones, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { deleteAsset, type StoredAsset } from '../audio/assets.ts';
import { useAssets } from '../audio/useAssets.ts';
import { ABSOLUTE_MAX_CAP_DB } from '../engine/core.ts';
import { Playback } from '../native/playback.ts';
import { useLibrary } from '../store/library.ts';
import { usePlayback } from '../store/playback.ts';
import { Button, Card, Confirm, IconButton, Segmented, Slider, fmtDuration } from '../ui/controls.tsx';

export const SLEEP_CHOICES: (number | null)[] = [null, 15, 30, 45, 60, 90, 120, 240];

export function sleepLabel(m: number | null) {
  if (m === null) return 'Off';
  return m < 60 ? `${m}m` : `${m / 60}h`;
}

export function SettingsScreen() {
  const settings = useLibrary((s) => s.settings);
  const setSettings = useLibrary((s) => s.setSettings);
  const back = useLibrary((s) => s.back);
  const limiterDb = usePlayback((s) => s.status.limiterDb);
  const playing = usePlayback((s) => s.playing);
  const [batteryOk, setBatteryOk] = useState(true);
  const assets = useAssets();
  const timelines = useLibrary((s) => s.timelines);
  const [toDelete, setToDelete] = useState<StoredAsset | null>(null);
  const usedIn = (assetId: string) =>
    Object.values(timelines).filter((t) => t.soundtracks.some((tr) => tr.segments.some((sg) => sg.assetId === assetId)));

  const refreshBattery = () => Playback.isIgnoringBatteryOptimizations().then((r) => setBatteryOk(r.value));
  useEffect(() => {
    void refreshBattery();
    const onVis = () => !document.hidden && void refreshBattery();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-2">
        <IconButton label="Back" onClick={back}>
          <ArrowLeft size={20} />
        </IconButton>
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      <Card>
        <h2 className="flex items-center gap-2 font-semibold">
          <ShieldCheck size={18} className="text-ok" /> Volume safety
        </h2>
        <Slider
          label="Maximum output"
          value={settings.capDb}
          min={-40}
          max={ABSOLUTE_MAX_CAP_DB}
          step={1}
          unit="dB"
          onChange={(v) => setSettings({ capDb: v })}
          hint={
            playing && limiterDb < -0.5 ? (
              <span className="text-xs text-warn">limiting {limiterDb.toFixed(1)} dB</span>
            ) : undefined
          }
        />
        <p className="text-sm text-muted">
          Nothing can ever play louder than this, whatever the timeline's volumes are. Lower it if you sleep with
          the phone volume high.
        </p>
        <Slider
          label="Fade in when pressing Play"
          value={settings.playFadeSeconds}
          min={0}
          max={30}
          step={1}
          unit="s"
          onChange={(v) => setSettings({ playFadeSeconds: v })}
        />
      </Card>

      <Card>
        <h2 className="font-semibold">Sleep timer</h2>
        <p className="text-sm text-muted">Start every playback with this timer. It fades out over the last minute.</p>
        <Segmented
          value={settings.defaultSleepMinutes ?? -1}
          onChange={(v) => setSettings({ defaultSleepMinutes: v === -1 ? null : v })}
          options={SLEEP_CHOICES.slice(0, 6).map((m) => ({ value: m ?? -1, label: sleepLabel(m) }))}
        />
      </Card>

      <Card>
        <h2 className="flex items-center gap-2 font-semibold">
          <BatteryCharging size={18} className={batteryOk ? 'text-ok' : 'text-warn'} /> Overnight playback
        </h2>
        {batteryOk ? (
          <p className="text-sm text-muted">Battery optimization is off for OurSound, so Android won't stop it overnight.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Battery optimization is on. Android may stop playback in the middle of the night.
            </p>
            <Button
              variant="primary"
              onClick={async () => {
                await Playback.requestIgnoreBatteryOptimizations();
              }}
            >
              Allow background playback
            </Button>
          </>
        )}
      </Card>

      <Card>
        <h2 className="flex items-center gap-2 font-semibold">
          <FileAudio size={18} className="text-accent" /> Imported audio
        </h2>
        {assets.length === 0 ? (
          <p className="text-sm text-muted">
            None yet. Add one from a timeline: Add soundtrack → Import an audio file.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-xl bg-card-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{a.name}</div>
                  <div className="text-xs text-muted">
                    {fmtDuration(Math.round(a.duration))} · {(a.size / 1e6).toFixed(1)} MB ·{' '}
                    {usedIn(a.id).length ? `used in ${usedIn(a.id).length} timeline(s)` : 'not used'}
                  </div>
                </div>
                <IconButton label={`Delete ${a.name}`} onClick={() => setToDelete(a)} className="h-9 w-9 bg-transparent text-danger">
                  <Trash2 size={16} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Confirm
        open={toDelete !== null}
        title="Delete imported audio?"
        message={
          toDelete
            ? `"${toDelete.name}" will be removed from this phone.${usedIn(toDelete.id).length ? ' Timelines that use it will play silence in its place.' : ''}`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => toDelete && void deleteAsset(toDelete.id)}
        onClose={() => setToDelete(null)}
      />

      <Card>
        <h2 className="flex items-center gap-2 font-semibold">
          <Headphones size={18} className="text-accent" /> For binaural beats to work
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>Use headphones. Each ear must hear only its own tone.</li>
          <li>
            Turn off <b className="text-ink">spatial audio</b>, <b className="text-ink">Dolby Atmos</b> or "3D sound"
            in your phone and headphone apps. They mix the ears together and cancel the beat.
          </li>
          <li>Wired headphones are best. Bluetooth works; avoid "mono audio" in Accessibility settings.</li>
          <li>If headphones disconnect, OurSound pauses instead of playing through the speaker.</li>
        </ul>
      </Card>

      <Card>
        <h2 className="font-semibold">About</h2>
        <p className="text-sm text-muted">
          OurSound generates every sound live on your phone. Nothing is recorded or stored, so timelines can be
          as long as you like. It is not a medical device; binaural beats are for relaxation only. Don't use while
          driving. If you have epilepsy or a seizure disorder, avoid pulsing (isochronic) tones.
        </p>
      </Card>
    </div>
  );
}
