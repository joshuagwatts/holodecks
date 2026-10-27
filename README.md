# HoloDecks

Joshua's own DJ controller — a clean, awesome deck front with a sampler, synth
sequencer and arpeggiator inside, built to plug straight into his ecosystem:
HoloSYNC relays its state, HoloMapper and lighting follow it.

Think deadmau5's AUTO/PILOT / syndicate direction — a performance instrument,
not just two decks and a crossfader — but it's his own thing.

## Run it

```bash
cd ~/workspace/holodecks
python3 -m http.server 8931
# open http://127.0.0.1:8931/ and tap POWER ON
```

No build step, no frameworks — vanilla HTML/CSS/JS + Web Audio.

## What's in v1 (Perform mode)

**Front — the DJ controller (the hero)**
- 2 decks (A = cyan, B = magenta) on neutral dark-grey panels
- Load your own audio files, or hit **LOAD DEMO** — each deck has a built-in
  synthesized loop track (124 BPM / 126 BPM, rendered in-code with
  OfflineAudioContext), so it works with zero files
- Big play/pause, CUE (set while paused / return while playing), jog nudge −/+,
  pitch fader ±8% with effective-BPM readout, SYNC to the other/master deck,
  MASTER flag, hot cues 1–4 (click empty = set, click set = jump,
  right-click = clear), LOOP 4 / LOOP 8 from the playhead (beat-quantized),
  overview waveform with playhead + cue markers (click to seek), beat dots,
  elapsed / remaining time
- Mixer: equal-power crossfader, per-channel gain + HI/MID/LOW EQ,
  master volume, VU meter

**Inside — instruments, all locked to the master BPM**
- **Sampler:** 8 pads with synthesized one-shots (kick, snare, clap, closed/open
  hat, perc, bass stab, chord stab). QUANTIZE on = pads fire on the next master
  beat. Load your own sample onto any pad by dragging a file onto it or
  right-clicking the pad.
- **Synth sequencer:** 16 steps, each click cycles off → root → 3rd → 5th →
  octave. Saw/square/tri, filter cutoff + resonance, root note, minor/major/
  dorian scale, octave shift, volume. Lookahead scheduler (25 ms / 0.1 s),
  phase-aligned to the master deck.
- **Arpeggiator:** takes over the sequencer's gates and cycles the chord tones —
  Up / Down / Up-Down / Random, 1/8 or 1/16 rate, 1–3 octaves, gate control.

**Ecosystem out**
- **Sync Bus** — publishes `SyncState` in the exact HoloSYNC shape
  (`holosync/src/core/types.ts`, deck deviceIds 11/12) at 10 Hz while playing:
  1. `BroadcastChannel('holodecks-sync')` — same-device tabs (a HoloMapper tab
     follows instantly)
  2. `window.__HOLODECKS_SYNC__` + a `holodecks-sync` CustomEvent on `window`
  3. Best-effort WebSocket to `ws://127.0.0.1:52711` when HoloSYNC is running
     (hello: `sourceKind: 'holodeck'`). Silent when HoloSYNC isn't there.
- **SYNC OUT panel** — live/local status, master BPM, beat/bar, master deck,
  track-change counter, COPY SYNC STATE button, JSON peek, and a plain-text
  "HoloMapper would follow: …" readout.
- **Lighting preview** — 8 fixtures (Chase / Strobe / Wash / Pulse) driven by the
  master beat/bar/phrase. This is the preview of the lighting consumer HoloMapper
  will run — from the exact same beat data.

## Rule 1

**The decks are tempo.** Master deck = the MASTER-flagged deck, else the first
on-air playing deck, else Deck A. The sequencer clock, the sampler quantize, the
lighting and every follower derive from the master deck's *effective* BPM.
HoloDecks only ever publishes tempo — nothing flows back upstream.

## Prove it

```bash
node tests/prove.mjs   # headless Chromium drives every control through the UI
```

## v1.1 additions
- **Auto BPM**: loading a file detects its BPM and first beat automatically (watch for the AUTO badge); fix it with the -/+ , 1/2, x2, TAP row if needed.
- **RMS sections**: every loaded track is split into energy sections (shown shaded on the waveform, e.g. SEC 2 · 9/32 · HIGH). Section data rides the sync feed for HoloMapper's RMS Transitions.
- **Pair phone**: PAIR PHONE in the header shows a QR — scan it and your phone opens the full HoloDecks as a synced control surface for the desktop (same link style as HoloMapper).
