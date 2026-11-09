# OurSound — Project Plan

A generative, multi-layer audio DAW for **Android phones**, built for long-form
**binaural sleep audio** listened to on **headphones**. Everything is synthesized
live in the app — nothing is pre-recorded, pre-rendered, cached, or exported.

The core use case: before bed, you press play on a timeline you built (your
"master playlist"). If it's 8 hours long, you wake up to it.

---

## 1. Decisions (locked)

| Topic | Decision |
|---|---|
| Platform | Android only |
| Shell | Vite + React 19 + TypeScript, wrapped with **Capacitor** |
| Output | Live in-app playback only — **no export** |
| Listening | Headphones (binaural requires them) |
| Length | Effectively unlimited (thousands of hours) |
| Playback | **One timeline plays at a time** |
| Library | Unlimited saved timelines |
| Imports | Local audio files (MP3/M4A/WAV). **No YouTube** (ToS forbids audio extraction; embeds can't be mixed or play in background) |
| Safety | User-set maximum output cap enforced by a master brickwall limiter |

---

## 2. Vocabulary

```
Timeline     a whole project; unlimited per library; one plays at a time
 └─ Soundtrack   one lane/layer (own volume, pan, mute, solo)
     └─ Segment      a block on the lane: binaural, noise, box fan, thunder, MP3...
         └─ Automation   curves over segment params or the soundtrack's volume
```

All soundtracks in a timeline play together.

---

## 3. Core engine principle: compute, never store

Every audio block (128 samples, ~2.7 ms) is computed fresh from
`(time, timeline settings, seed)`. Consequences:

- **Constant memory & CPU** regardless of length or position. Hour 1 costs the
  same as hour 2,999.
- **Time = sample counter** (a JS double). 3,000 h @ 48 kHz ≈ 5.2×10¹¹ samples —
  exact in a double (< 2⁵³). No drift.
- **Oscillator phase** in double precision, wrapped each sample; on seek it is
  derived analytically from the integral of the frequency automation
  (closed-form per segment), so seeking is instant and click-free.
- **Automation** = small list of breakpoints; evaluated by binary search +
  curve formula. No baked buffers.
- **Random events** (thunder, droplets, random-interval repeats) come from
  `hash(seed, timeSlot)` — re-derived on demand, never stored as event lists.
  Seeking to any time reproduces the same result.
- **Timeline file is just settings** (JSON, a few KB). Only imported audio
  files are large, and those are streamed from storage, never fully decoded.

---

## 4. Repetition

Per segment repeat modes — all resolved by arithmetic
(`k = floor((t − start) / interval)`, local time = remainder), never copies:

| Mode | Behavior |
|---|---|
| Once | Plays start → end |
| Loop | Content loops seamlessly to fill the segment |
| Every interval | Replays every N (start-to-start), silence between |
| Random interval | Replays at a seeded random gap within [min, max] |

Options: repeat count (N / until timeline end / forever), active window
(e.g. hours 1–5), per-repeat variation (new seed per repeat, optional small
volume/pitch drift).

Automation scope per lane: **per repeat** (curve restarts each repetition) or
**across span** (one curve over all repeats). Both can be combined.

Timeline level: loop whole timeline forever, or loop an A–B region.

Timeline **end behavior**: stop, fade out, loop, or gentle wake-up rise.

---

## 5. Sound generators (all procedural)

**Tones**
- Binaural beat — L = carrier, R = carrier + beat; both automatable
  (e.g. 10 Hz alpha → 6 Hz theta → 2 Hz delta)
- Monaural beat, isochronic tones
- Pure tones / drones / stacked pads with slow detune

**Noise** — white, pink, brown, grey; filter controls

**Ambient**
- Box fan — brown/pink noise + motor hum harmonics + blade-pass modulation;
  `speed` drives pitch & blade rate; `wobble`
- Rain — filtered bed + seeded droplet transients; intensity, surface
- Thunder — seeded rumble events; frequency, distance (LPF + delay), intensity
- Wind — band-passed noise with drifting center; gustiness
- Ocean — noise with slow swells; wave period
- Later: fire crackle, creek, crickets, heartbeat, train

**Imported audio** — streamed MP3/M4A/WAV as a segment; loop, trim, fades,
speed, volume automation.

---

## 6. Audio quality (binaural integrity)

- 48 kHz, 32-bit float processing, double-precision phase
- Pure sine synthesis; no compression/effects on binaural layers
- L/R strictly independent through the whole chain (no mono-summing stages)
- Smoothed parameter changes (no zipper noise / clicks)
- In-app tips: disable Dolby Atmos / spatial audio / "3D sound"; prefer wired or
  LDAC/aptX over low-bitrate SBC; exclude app from battery optimization

## 7. Safety

- **Max output cap** (dB) in Settings, enforced by a master brickwall limiter
- Always fade in from silence on play
- Sleep timer / fade-out; optional overall night-long volume curve
- Warning when automation would exceed the cap
- Non-medical disclaimer

---

## 8. Stack

| Area | Choice |
|---|---|
| App | Vite + React 19 + TypeScript (strict) |
| Native | Capacitor (Android) |
| Audio | Custom AudioWorklet DSP engine (TypeScript); fallback: native Kotlin/Oboe engine via Capacitor plugin |
| Background | Android foreground service (`mediaPlayback`), media notification, wake lock |
| State | Zustand + Immer + zundo (undo/redo) |
| Schema | Zod (validated, versioned timeline files) |
| UI | Tailwind v4 + shadcn/ui (touch-friendly), Canvas 2D timeline |
| Storage | Capacitor SQLite / Filesystem (library + imported audio) |
| Tests | Vitest (DSP sample-level tests), on-device testing via wireless adb |

## 9. UI

- **Library** — list of timelines; create, duplicate, rename, delete; templates
- **Layers / Mixer (portrait)** — soundtracks with volume, mute, key params
- **Timeline (landscape)** — pinch zoom (thousands of hours → seconds), drag/resize
  segments, finger-drawn automation, repeats shown as ghosted copies
- **Settings** — max output cap, fade-in, sleep timer, headphone tips
- **Lock screen / notification** — play/pause, time remaining, sleep timer

---

## 10. Phases

0. **Background playback spike** — Capacitor app plays a binaural tone via
   AudioWorklet with a foreground service + wake lock. Verify hours of clean
   playback with the screen locked on a real device. **Go/no-go**: if the
   WebView suspends audio, move the engine to native (Kotlin/Oboe).
1. **Engine core** — sample-counter clock, phase math, automation evaluator,
   repeat resolver, tone + noise generators, master limiter & cap,
   play/pause/seek.
2. **Library + Layers view + Settings**
3. **Ambient generators** — fan, rain, thunder, wind, ocean
4. **Timeline view** — segments, repeats, automation editing, undo/redo
5. **Audio import** — streamed file segments
6. **Polish** — templates, lock-screen controls, end behaviors, battery tuning

---

## 11. Progress log

**2026-11-08 — Phase 0 (passed short tests on Pixel 10a, Android 17)**
- AudioWorklet + foreground service (`mediaPlayback`) + partial wake lock keeps
  audio running with the screen off and in forced Doze. Overnight run pending.
- Found: after a Bluetooth (JBL buds) stream restart, the WebView's audio
  sometimes renders at 2x real time and drops half → audible clicking.
  Mitigated in Phase 1 by the watchdog (see below).

**2026-11-08 — Phase 1 (engine core) done**
- `src/engine/` — time-pure engine: automation with exact integrals
  (hold/linear/smooth/exp), O(1) repeat resolver (none/interval/random),
  generators (binaural, monaural, isochronic, tone, white/pink/brown noise),
  soundtrack gain/pan/mute/solo, 5 ms look-ahead stereo-linked limiter at the
  user's cap, play fade-in / pause fade-out / seek dip, stop/loop at end.
- `src/audio/player.ts` — watchdog rebuilds the audio pipeline at the same
  position on clock drift > 3 s, stalls, context interruptions, or device
  changes; pauses when headphones disconnect (native BECOMING_NOISY).
- 25 Vitest tests (`npm test`): binaural accuracy, exact seek, accuracy at
  hour 2,999, repeats, noise levels, cap never exceeded, limiter click-free.
- Perf: ~94x real time on desktop; ~12–17% of one phone core with the screen
  off. Battery tuning (cheaper noise PRNG, sine) is a Phase 6 item.

**2026-11-08 — Phases 2–6 done (all installed and checked on the Pixel 10a)**
- Phase 2: timeline library (IndexedDB, Zod-validated), templates, mixer view
  (soundtracks, segments, params, fades, repeats), settings (volume cap,
  play fade-in, default sleep timer, battery, headphone tips), now-playing bar
  with sleep timer (exact, runs in the audio thread), undo/redo (zundo).
- Phase 3: procedural box fan, rain, thunder, wind, ocean (seeded, seekable,
  level-calibrated) + Box Fan Night / Thunderstorm / Ocean Sleep templates.
- Phase 4: canvas timeline editor — pinch zoom (thousands of hours ↔ seconds),
  pan, move/resize segments, ghosted repeats, automation lanes with
  tap-to-add / drag / long-press-to-edit points, ruler seek.
- Phase 5: audio file import (MP3/M4A/WAV/OGG/FLAC via mediabunny + WebCodecs).
  Files stay compressed in IndexedDB; 5 s chunks are decoded on demand and
  streamed to the worklet (Catmull-Rom resampling, speed, trim, seamless
  crossfaded loops). Verified on the phone with a real MP3.
- Phase 6: lock-screen / notification / headphone-button controls
  (MediaSession), paused notification keeps Play available, 'Gentle wake'
  end behaviour, slower status updates while hidden, cheaper noise hashing and
  thunder rendering (Thunderstorm screen-off CPU ~31% → ~15% of one core).
- 51 Vitest tests. `sh scripts/install.sh` builds + installs on the phone.
- On-device test hooks: `window.__os` (reachable only via WebView devtools).

**Still to verify:** a real overnight run; how realistic the ambiences sound
(needs ears); whether the watchdog catches the Bluetooth 2x-rate fault in the wild.

**2026-11-08 — Sample library**
- 15 built-in samples in `src/templates.ts` (Sleep / Naps & focus / Ambience),
  each with a "shows" note on which editor feature it demonstrates.
- Library shows them under Samples: playable read-only (`src/store/samples.ts`),
  "Make my copy" creates an editable timeline.
- "Save as template" (Library ⋮ menu or the bookmark button in the mixer)
  stores your own templates, listed under New timeline → Your templates.
- New installs start with an empty "Your timelines" (no demo seeded).

**2026-11-08 — Native audio engine (fixes stutter/restarts)**
- Root causes found in logcat: (1) a pause/play race demoted the foreground
  service → app + WebView renderer in the background cpuset → audio starved
  (Chromium PushPullFIFO underflows); (2) even at foreground priority, the
  WebView's audio sink still underflowed and ran ~2x real time with Bluetooth.
- Fix: the engine is ported to Java (`android/.../engine/`) and plays from a
  THREAD_PRIORITY_URGENT_AUDIO thread into an AudioTrack (float, 48 kHz,
  ~370 ms buffer, power-saving/deep-buffer path) — `NativeAudio.java`.
  The WebView only sends the timeline + commands (`NativePlayer` in
  `src/audio/native-player.ts`); the browser keeps the WebView engine.
- Bit-exact with TypeScript: `GoldenTest.java` compares 17 reference renders
  from `src/engine/golden.test.ts` (max diff 1.5e-8). Regenerate with
  `GOLDEN_DIR=android/app/src/test/resources/golden npx vitest run src/engine/golden.test.ts`.
- Native side owns the service state, media buttons, audio focus (calls
  pause and resume), headphone disconnect — nothing overnight depends on JS.
- Imported audio is now stored in app files and decoded with MediaCodec.
- Builds are release-optimized (debug-key signed): Rainy Window uses ~7% of
  one core screen-on, ~11% screen-off. Verified: 4 min screen-off, position
  exactly 60 s/min, 0 underruns. `OSNative` logs position + underruns every minute.
