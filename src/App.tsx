import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Headphones } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { LibraryScreen } from './screens/Library.tsx';
import { MixerScreen } from './screens/Mixer.tsx';
import { NowPlayingBar } from './screens/NowPlaying.tsx';
import { SettingsScreen } from './screens/Settings.tsx';
import { SharedImportSheet } from './screens/SharedImport.tsx';
import { currentScreen, startAutosave, useLibrary } from './store/library.ts';
import { activate, startPlaybackSync, usePlayback } from './store/playback.ts';
import { Button, Sheet } from './ui/controls.tsx';

const EditorScreen = lazy(() => import('./screens/Editor.tsx'));

export default function App() {
  const ready = useLibrary((s) => s.ready);
  const screen = useLibrary(currentScreen);
  const seenTips = useLibrary((s) => s.settings.seenTips);
  const setSettings = useLibrary((s) => s.setSettings);
  const hasActive = usePlayback((s) => s.activeId !== null);

  useEffect(() => {
    const stopSave = startAutosave();
    let stopSync = () => {};
    void useLibrary
      .getState()
      .init()
      .then(() => {
        stopSync = startPlaybackSync();
        // Preload the first timeline so the Now Playing bar is ready.
        const first = useLibrary.getState().order[0];
        if (first) void activate(first);
      });
    return () => {
      stopSave();
      stopSync();
    };
  }, []);

  // Android back button: go back a screen, or leave the app (playback continues).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handle = CapApp.addListener('backButton', () => {
      if (!useLibrary.getState().back()) void CapApp.minimizeApp();
    });
    return () => void handle.then((h) => h.remove());
  }, []);

  // Each screen starts at the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  if (!ready) return <div className="pt-safe p-6 text-muted">Loading…</div>;

  const isEditor = screen.name === 'editor';

  return (
    <>
      <main className={`pt-safe mx-auto max-w-xl px-4 ${hasActive && !isEditor ? 'pb-40' : 'pb-safe'}`}>
        {screen.name === 'library' && <LibraryScreen />}
        {screen.name === 'mixer' && <MixerScreen id={screen.id} />}
        {screen.name === 'settings' && <SettingsScreen />}
        {isEditor && (
          <Suspense fallback={<p className="text-muted">Loading editor…</p>}>
            <EditorScreen id={screen.id} focus={screen.focus} />
          </Suspense>
        )}
      </main>
      {!isEditor && <NowPlayingBar />}
      <SharedImportSheet />

      <Sheet open={!seenTips} onClose={() => setSettings({ seenTips: true })} title="Welcome to OurSound">
        <div className="flex items-center gap-3 text-accent">
          <Headphones size={28} />
          <p className="text-ink">Binaural beats need headphones, with each ear hearing only its own tone.</p>
        </div>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>Turn off spatial audio / Dolby Atmos for your headphones.</li>
          <li>Set a comfortable maximum volume in Settings. Nothing will ever play louder.</li>
          <li>Press Play, lock your phone, and sleep. Playback keeps going with the screen off.</li>
        </ul>
        <Button variant="primary" onClick={() => setSettings({ seenTips: true })}>
          Got it
        </Button>
      </Sheet>
    </>
  );
}
