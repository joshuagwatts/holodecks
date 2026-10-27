# HoloDecks — NOTES

## Architecture

Single static app, no build step:

- `index.html` — all UI structure. Decks top (~60%), instruments in one tidy
  panel below, sync + lighting as a slim strip at the bottom.
- `css/style.css` — neutral dark greys (`#1a1a1c` deck panels), white text,
  one accent per deck (A cyan `#22d3ee`, B magenta `#f471e8`). No frameworks.
- `js/app.js` — everything, in sections:
  - **Audio core** — `AudioContext` created on the POWER ON gesture. Master
    chain: `masterGain → compressor → analyser → destination`. Sampler and
    synth have their own gains into master (post-crossfader, so they always
    sound at full level regardless of deck fader position).
  - **Offline synth** — demo tracks and sampler one-shots are rendered with
    `OfflineAudioContext` from small synth primitives (kick/hat/snare/clap/
    bass/stab). No sample files ship with the app.
  - **Deck** — one class, two instances (deviceIds 11/12 per ECOSYSTEM §5.4).
    Chain per deck: `source → EQ low shelf → EQ peaking → EQ high shelf →
    channel gain → crossfader gain → master`. Playback is a loop-less
    `AudioBufferSourceNode`; position is tracked as
    `offset + (ctx.currentTime − startedAt) × rate` and re-based on every
    pitch/bend/seek change. Loops and track-end are handled in the rAF ticker
    (loop wrap is also computed inside `position()` so beat math never jumps).
  - **Master clock** — master deck rule mirrors HoloSYNC (flagged > on-air
    playing > Deck A). When the master deck plays, the beat *is* the deck's
    beat (`position × trackBpm / 60`). When nothing plays, a free clock runs
    at the last/default BPM (124) so the instruments still work standalone.
  - **Scheduler** — standard Chris Wilson lookahead pattern (`setInterval`
    25 ms, schedule ahead 0.1 s) on 16th notes of the master BPM. It
    soft-aligns to a playing master deck (re-bases only on >2-step drift, e.g.
    a deck swap) so instruments stay glued to the record without jitter.
  - **Sync bus** — `buildSyncState()` produces the exact `types.ts` shape and
    `publishSync()` fans it out to BroadcastChannel + `window.__HOLODECKS_SYNC__`
    / CustomEvent + the HoloSYNC WebSocket. 10 Hz while anything plays, plus
    immediate publishes on any state change (`publishSoon`). `trackChangeSeq`
    increments only when the *master* deck's track identity changes.
  - **Lighting** — pure function of the master beat float: bar flash, 8-fixture
    chase, phrase (16-bar) palette rotation. Preview only in v1.

## Engine interface note (ECOSYSTEM §5.5 hybrid)

v1 is Web Audio behind a small interface on purpose: `Deck` exposes
play/pause/seek/setPitch/setBend/setLoop, the instruments expose
`triggerPad` / the step scheduler, and the sync bus only reads deck state via
`Deck.toState()`. A native engine (the future .exe / ASIO path) can replace the
internals of those classes without touching the UI, the instruments' clock, or
the published `SyncState` shape. The UI never reaches into audio nodes directly
except the mixer gains/EQ, which are also the native engine's mixer surface.

## What's NOT in v1

- Native .exe / ASIO engine (see above — decided by Joshua's feel verdict)
- Edit / Catalog / Arrange modes (v1 is Perform only)
- Real BPM detection for arbitrary files — BPM is a manual per-deck field
  (demo tracks are exact); tap-tempo can come later
- rekordbox import, TCNet / Art-Net wire output (the lighting strip is the
  preview; HoloSYNC Phase 4 owns the wire)
- Recording, effects per deck beyond 3-band EQ, key detection/shifting

## Test handle

`window.__HOLODECKS__` exposes deck objects, `getSyncState()`, `masterLevel()`
(analyser RMS), sequencer state + note log, and sampler trigger counts — that's
what `tests/prove.mjs` asserts against while driving the real UI.

## v1.1 (2026-10-27) — BPM detection, RMS sections, mobile sync
- js/tempo.js: real BPM + first-beat detection on file load (kick-weighted onset envelope, autocorrelation 60-180, octave walk-up rule, integer snap). v1 shipped with NO detection (loaded files inherited the BPM box value) — Joshua caught it on mobile. Correction row per deck: -/+ 0.1, 1/2, x2, TAP.
- js/rms.js: per-bar RMS sections (rolling median, >4dB sustained change = boundary, true lengths reported). DeckState gains rmsNow/energy/section fields + track.sections; SyncState gains rmsTransitionSeq for HoloMapper's future "RMS Transitions" setting (fires clip on drastic RMS change; keyed off seq, never raw RMS).
- js/sync.js: HoloMapper-style phone link — MQTT/WSS (emqx>hivemq>mosquitto, sequential), pair QR/code (?sync=CODE), phone = FULL app as guest control surface, desktop host owns audio. Presence heartbeat 4s + FNV state hash; SYNCED only when peer fresh <8s AND hashes match; auto-heal.
- Prove-out: 73/73 (tests/prove.mjs), incl. detected-vs-true exact on 100/122/128/138/145/160, RMS sections exact 16/32/16, two-page MQTT sync test on a local aedes relay.
