'use strict';
/* HoloDecks v1 — clean DJ controller up front, sampler / synth sequencer / arp inside.
 * Ecosystem rule 1: THE DECKS ARE TEMPO. HoloDecks publishes SyncState in the exact
 * HoloSYNC shape (holosync/src/core/types.ts). HoloSYNC relays it; HoloMapper and
 * lighting are followers only. Nothing sends tempo back upstream.
 *
 * Engine note (ECOSYSTEM §5.5 hybrid): all playback goes through the small Deck /
 * instrument interfaces below on Web Audio for v1, so a native engine can replace
 * the internals later without touching the UI or the sync bus. */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtTime = (s) => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); const r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10] };

/* ============================== AUDIO CORE ============================== */
let ctx = null;
let masterGain, analyser, compNode;
let samplerGain, seqGain;
const analyserData = new Uint8Array(2048);

function initAudio() {
  if (ctx) { ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain(); masterGain.gain.value = parseFloat($('master-vol').value);
  compNode = ctx.createDynamicsCompressor();
  analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
  masterGain.connect(compNode); compNode.connect(analyser); analyser.connect(ctx.destination);
  samplerGain = ctx.createGain(); samplerGain.gain.value = 0.9; samplerGain.connect(masterGain);
  seqGain = ctx.createGain(); seqGain.gain.value = parseFloat($('synth-vol').value); seqGain.connect(masterGain);
  decks.forEach((d) => d.buildChain());
  buildSamplerBuffers();
}

/* ==================== OFFLINE SYNTH (demos + one-shots) ==================== */
function noiseBuffer(c, seconds) {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
function sKick(c, dest, t, vol = 0.95) {
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.3);
}
function sHat(c, noise, dest, t, open, vol = 0.3) {
  const s = c.createBufferSource(); s.buffer = noise;
  const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
  const g = c.createGain(); const dur = open ? 0.32 : 0.05;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest); s.start(t); s.stop(t + dur + 0.05);
}
function sSnare(c, noise, dest, t, vol = 0.55) {
  const s = c.createBufferSource(); s.buffer = noise;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  s.connect(f); f.connect(g); g.connect(dest); s.start(t); s.stop(t + 0.2);
  const o = c.createOscillator(), og = c.createGain(); o.frequency.value = 190;
  og.gain.setValueAtTime(vol * 0.6, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(og); og.connect(dest); o.start(t); o.stop(t + 0.1);
}
function sClap(c, noise, dest, t, vol = 0.5) {
  for (let i = 0; i < 3; i++) {
    const s = c.createBufferSource(); s.buffer = noise;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 1.4;
    const g = c.createGain(); const tt = t + i * 0.018;
    g.gain.setValueAtTime(vol * (i === 2 ? 1 : 0.6), tt);
    g.gain.exponentialRampToValueAtTime(0.001, tt + (i === 2 ? 0.28 : 0.05));
    s.connect(f); f.connect(g); g.connect(dest); s.start(tt); s.stop(tt + 0.34);
  }
}
function sBass(c, dest, t, hz, dur, vol = 0.5) {
  const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
  f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(160, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(f); f.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
}
function sStab(c, dest, t, midis, dur, vol = 0.3, type = 'sawtooth') {
  midis.forEach((m) => {
    const o = c.createOscillator(); o.type = type; o.frequency.value = midiHz(m);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2600;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol / midis.length, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
  });
}

/* Demo tracks: full loops rendered offline so the app works with zero files. */
async function renderDemo(which) {
  const bpm = which === 'a' ? 124 : 126;
  const bars = 16, beats = bars * 4, spb = 60 / bpm, dur = beats * spb + 0.1;
  const oc = new OfflineAudioContext(2, Math.ceil(44100 * dur), 44100);
  const out = oc.createGain(); out.gain.value = 0.9; out.connect(oc.destination);
  const noise = noiseBuffer(oc, 1.2);
  // A: A minor prog-house. B: F minor, busier hats, different bass walk.
  const rootMidi = which === 'a' ? 33 : 29; // A1 / F1
  const bassLine = which === 'a'
    ? [0, 0, 12, 0, 3, 0, 10, 0, 0, 0, 12, 0, 5, 3, 10, 7]
    : [0, 0, 0, 12, 0, 3, 0, 0, 8, 0, 0, 12, 0, 5, 7, 10];
  const chordRoots = which === 'a' ? [57, 53, 48, 55] : [53, 49, 56, 51]; // Am F C G / Fm Db Ab Eb-ish
  for (let b = 0; b < beats; b++) {
    const t = b * spb;
    sKick(oc, out, t);
    if (b % 4 === 2) (which === 'a' ? sSnare : sClap)(oc, noise, out, t, 0.42);
    for (let e = 0; e < 2; e++) {
      const tt = t + e * spb / 2;
      sHat(oc, noise, out, tt, e === 1 && b % 4 === 3, e === 1 ? 0.34 : 0.16);
    }
    if (which === 'b') sHat(oc, noise, out, t + spb * 0.75, false, 0.12);
    const stepIdx = b % 16;
    if (b % 2 === 0) sBass(oc, out, t + spb * 0.5, midiHz(rootMidi + bassLine[stepIdx] + 12), spb * 0.45, 0.42);
    if (b % 16 === 0) {
      const cr = chordRoots[Math.floor(b / 16) % 4];
      sStab(oc, out, t, [cr, cr + 3, cr + 7, cr + 12], spb * 3.2, 0.34, 'triangle');
    }
    if (b % 16 === 14) sStab(oc, out, t, [chordRoots[0] + 12, chordRoots[0] + 15, chordRoots[0] + 19], spb * 0.9, 0.2);
  }
  const buf = await oc.startRendering();
  return {
    buffer: buf, bpm,
    title: which === 'a' ? 'Demo A — Midnight Circuit' : 'Demo B — Second Sky',
    artist: 'HoloDecks Built-in',
  };
}

/* Sampler one-shots, also synthesized offline. */
const samplerBuffers = new Array(8).fill(null);
const samplerNames = ['KICK', 'SNARE', 'CLAP', 'CLOSED HAT', 'OPEN HAT', 'PERC', 'BASS STAB', 'CHORD STAB'];
async function renderOneShot(i) {
  const dur = [0.35, 0.3, 0.45, 0.12, 0.5, 0.2, 0.4, 0.55][i];
  const oc = new OfflineAudioContext(2, Math.ceil(44100 * dur), 44100);
  const out = oc.createGain(); out.gain.value = 0.95; out.connect(oc.destination);
  const noise = noiseBuffer(oc, 0.6); const t = 0.01;
  if (i === 0) sKick(oc, out, t, 1);
  else if (i === 1) sSnare(oc, noise, out, t, 0.8);
  else if (i === 2) sClap(oc, noise, out, t, 0.75);
  else if (i === 3) sHat(oc, noise, out, t, false, 0.55);
  else if (i === 4) sHat(oc, noise, out, t, true, 0.55);
  else if (i === 5) { // perc: short filtered blip + shaker tick
    const o = oc.createOscillator(), g = oc.createGain(); o.type = 'square'; o.frequency.value = 1240;
    g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.09);
    sHat(oc, noise, out, t + 0.02, false, 0.22);
  }
  else if (i === 6) sBass(oc, out, t, midiHz(45), 0.36, 0.8); // A1 stab
  else if (i === 7) sStab(oc, out, t, [57, 60, 64], 0.5, 0.55); // Am stab
  return oc.startRendering();
}
async function buildSamplerBuffers() {
  for (let i = 0; i < 8; i++) { if (!samplerBuffers[i]) samplerBuffers[i] = await renderOneShot(i); }
}

/* ============================== DECK ============================== */
class Deck {
  constructor(key, deviceId) {
    this.key = key; this.deviceId = deviceId;
    this.buffer = null; this.title = ''; this.artist = ''; this.trackBpm = key === 'a' ? 124 : 126;
    this.peaks = [];
    this.source = null; this.playing = false;
    this.startedAt = 0; this.offset = 0; // seconds into track when (re)started
    this.pitch = 0; this.bend = 0; this.isSync = false; this.masterFlag = false;
    this.cuePoint = 0; this.hotCues = [null, null, null, null];
    this.loop = null; // {start, end, beats}
    this.chanGainVal = 0.9;
    this.beatOffsetSec = 0; // first-beat position from TempoDetect (0 for demos)
    this.bpmSource = 'manual'; // manual | demo | auto | auto-low | analyzing
    this.detectConfidence = 0; this.rawDetectedBpm = 0;
    this.sections = []; this.barRms = []; this.barDb = [];
    this.tapTimes = [];
    this.el = {};
    ['title', 'artist', 'bpm', 'effbpm', 'elapsed', 'remain', 'wf', 'dots', 'play', 'pitch', 'pitchval', 'loopstate', 'bpmbadge', 'secinfo']
      .forEach((n) => { this.el[n] = $(n + '-' + key); });
    this.wfCtx = this.el.wf.getContext('2d');
  }
  buildChain() {
    this.eqLow = ctx.createBiquadFilter(); this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 120;
    this.eqMid = ctx.createBiquadFilter(); this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 0.7;
    this.eqHigh = ctx.createBiquadFilter(); this.eqHigh.type = 'highshelf'; this.eqHigh.frequency.value = 8000;
    this.chanGain = ctx.createGain(); this.chanGain.gain.value = this.chanGainVal;
    this.crossGain = ctx.createGain();
    this.eqLow.connect(this.eqMid); this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.chanGain); this.chanGain.connect(this.crossGain); this.crossGain.connect(masterGain);
    const x = parseFloat($('xfader').value);
    this.crossGain.gain.value = this.key === 'a' ? Math.cos(x * Math.PI / 2) : Math.cos((1 - x) * Math.PI / 2);
  }
  get rate() { return 1 + (this.pitch + this.bend) / 100; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get effBpm() { return this.buffer ? this.trackBpm * this.rate : null; }
  position() {
    if (!this.buffer) return 0;
    if (!this.playing) return clamp(this.offset, 0, this.duration);
    let p = this.offset + (ctx.currentTime - this.startedAt) * this.rate;
    if (this.loop && p >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.start) % len);
    }
    return p;
  }
  beatFloat() { return this.buffer ? (this.position() - this.beatOffsetSec) * this.trackBpm / 60 : null; }
  beatInMeasure() { const b = this.beatFloat(); return b == null ? 0 : (((Math.floor(b) % 4) + 4) % 4) + 1; }
  /* RMS section containing the current playhead (bar = 4 beats from beatOffsetSec). */
  sectionInfo() {
    if (!this.buffer || !this.sections.length) return null;
    const beat = this.beatFloat() || 0;
    const totalBars = this.sections.reduce((a, s) => a + s.lengthBars, 0);
    let bar = clamp(Math.floor(beat / 4), 0, Math.max(0, totalBars - 1));
    if (beat < 0) bar = 0;
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i];
      if (bar >= s.startBar && bar < s.startBar + s.lengthBars) {
        return {
          sectionIndex: i, section: s, barIndex: bar,
          barInSection: bar - s.startBar + 1,
          barsToNext: s.startBar + s.lengthBars - bar,
        };
      }
    }
    const last = this.sections[this.sections.length - 1];
    return { sectionIndex: this.sections.length - 1, section: last, barIndex: bar, barInSection: last.lengthBars, barsToNext: 0 };
  }
  rmsNow() {
    if (!this.buffer || !this.barRms.length) return 0;
    const bar = clamp(Math.floor((this.beatFloat() || 0) / 4), 0, this.barRms.length - 1);
    return this.barRms[bar] || 0;
  }
  updateBpmBadge() {
    const b = this.el.bpmbadge; if (!b) return;
    let txt = 'MANUAL', cls = 'manual';
    if (this.bpmSource === 'auto') { txt = 'AUTO ' + this.trackBpm.toFixed(1); cls = 'auto'; }
    else if (this.bpmSource === 'auto-low') { txt = 'AUTO? ' + this.trackBpm.toFixed(1); cls = 'auto-low'; }
    else if (this.bpmSource === 'demo') { txt = 'DEMO'; cls = 'demo'; }
    else if (this.bpmSource === 'analyzing') { txt = 'ANALYZING BPM…'; cls = 'analyzing'; }
    b.textContent = txt; b.className = 'bpm-badge ' + cls;
    b.title = this.rawDetectedBpm ? 'detected raw ' + this.rawDetectedBpm.toFixed(2) + ' BPM, confidence ' + this.detectConfidence.toFixed(2) : '';
  }
  refreshSections() {
    if (!this.buffer || !window.RmsAnalyze) { this.sections = []; this.barRms = []; this.barDb = []; return; }
    const data = window.RmsAnalyze.analyzeSections(this.buffer, this.trackBpm, this.beatOffsetSec);
    this.sections = data.sections; this.barRms = data.barRms; this.barDb = data.barDb;
  }
  setBpmManual(bpm) {
    this.trackBpm = clamp(Math.round(bpm * 100) / 100, 30, 300);
    this.el.bpm.value = this.trackBpm;
    this.bpmSource = 'manual'; this.updateBpmBadge();
    this.refreshSections();
    this.updateEff(); publishSoon();
  }
  _startSource(atPos) {
    this._stopSource();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.playbackRate.value = this.rate;
    src.connect(this.eqLow);
    src.start(0, clamp(atPos, 0, Math.max(0, this.duration - 0.02)));
    this.source = src; this.startedAt = ctx.currentTime; this.offset = atPos;
  }
  _stopSource() { if (this.source) { try { this.source.onended = null; this.source.stop(); } catch (e) {} try { this.source.disconnect(); } catch (e) {} this.source = null; } }
  play(fromPos) {
    if (!this.buffer || !ctx) return;
    const pos = fromPos != null ? fromPos : (this.offset >= this.duration - 0.05 ? 0 : this.offset);
    this._startSource(pos); this.playing = true;
    this.el.play.textContent = '❚❚'; this.el.play.classList.add('playing');
    publishSoon();
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this._stopSource(); this.playing = false;
    this.el.play.textContent = '▶'; this.el.play.classList.remove('playing');
    publishSoon();
  }
  togglePlay() { this.playing ? this.pause() : this.play(); }
  seek(pos) {
    if (!this.buffer) return;
    pos = clamp(pos, 0, this.duration);
    if (this.playing) this._startSource(pos); else this.offset = pos;
    publishSoon();
  }
  setPitch(p, fromSync) {
    const wasPlaying = this.playing;
    const pos = this.position();
    this.pitch = clamp(p, -8, 8);
    this.el.pitch.value = this.pitch;
    this.el.pitchval.textContent = (this.pitch >= 0 ? '+' : '') + this.pitch.toFixed(2) + '%';
    if (wasPlaying) this._startSource(pos); else this.offset = pos;
    if (!fromSync) { this.isSync = false; $('sync-' + this.key).classList.remove('on'); }
    this.updateEff();
  }
  setBend(b) {
    if (!this.playing) { this.bend = b; return; }
    const pos = this.position(); this.bend = b; this._startSource(pos);
  }
  updateEff() { this.el.effbpm.textContent = this.effBpm ? this.effBpm.toFixed(2) : '—'; }
  setLoop(beats) {
    if (!this.buffer) return;
    const spb = 60 / this.trackBpm;
    const startBeat = Math.floor(this.beatFloat() || 0);
    const start = this.beatOffsetSec + startBeat * spb;
    this.loop = { start, end: Math.min(this.duration, start + beats * spb), beats };
    if (this.playing && this.position() >= this.loop.end) this.seek(this.loop.start);
    this.el.loopstate.textContent = 'LOOP ' + beats;
    $('loop4-' + this.key).classList.toggle('on', beats === 4);
    $('loop8-' + this.key).classList.toggle('on', beats === 8);
    publishSoon();
  }
  clearLoop() {
    this.loop = null; this.el.loopstate.textContent = '';
    $('loop4-' + this.key).classList.remove('on'); $('loop8-' + this.key).classList.remove('on');
    publishSoon();
  }
  onAir() {
    // fader up (channel gain) and crossfader side audible
    return this.chanGainVal > 0.01 && this.crossGain && this.crossGain.gain.value > 0.01;
  }
  playState() {
    if (!this.buffer) return 'Empty';
    if (this.playing) return this.loop ? 'Looping' : 'Playing';
    return this.offset > 0.05 ? 'Paused' : 'Cued';
  }
  async loadBuffer(buffer, title, artist, bpm, opts = {}) {
    this.pause(); this._stopSource();
    this.buffer = buffer; this.title = title; this.artist = artist; this.trackBpm = bpm;
    this.beatOffsetSec = opts.beatOffsetSec || 0;
    this.bpmSource = opts.source || 'manual';
    this.detectConfidence = opts.confidence || 0;
    this.rawDetectedBpm = opts.rawBpm || 0;
    if (opts.sectionsData) {
      this.sections = opts.sectionsData.sections; this.barRms = opts.sectionsData.barRms; this.barDb = opts.sectionsData.barDb;
    } else this.refreshSections();
    this.updateBpmBadge();
    this.offset = 0; this.cuePoint = 0; this.hotCues = [null, null, null, null]; this.clearLoop();
    this.el.title.textContent = title; this.el.artist.textContent = artist;
    this.el.bpm.value = bpm;
    // overview peaks, ~120 values 0..1
    const ch = buffer.getChannelData(0); const N = 120; const step = Math.floor(ch.length / N);
    this.peaks = [];
    for (let i = 0; i < N; i++) { let m = 0; for (let j = 0; j < step; j += 97) m = Math.max(m, Math.abs(ch[i * step + j] || 0)); this.peaks.push(+m.toFixed(3)); }
    document.querySelectorAll('#hotcues-' + this.key + ' button').forEach((b) => b.classList.remove('set'));
    this.updateEff(); trackChanged(this); publishSoon();
  }
  toState(masterId) {
    const beat = this.beatFloat();
    const info = this.sectionInfo();
    return {
      deviceId: this.deviceId,
      loaded: !!this.buffer,
      track: this.buffer ? {
        title: this.title, artist: this.artist, trackId: 0, bpm: this.trackBpm, durationSec: +this.duration.toFixed(2),
        sections: this.sections.map((s) => ({ ...s })),
      } : null,
      playState: this.playState(),
      isPlaying: this.playing,
      isMaster: this.deviceId === masterId,
      isOnAir: this.onAir(),
      isSync: this.isSync,
      sliderPitch: +this.pitch.toFixed(3),
      effectivePitch: +(this.pitch + this.bend).toFixed(3),
      effectiveBpm: this.effBpm ? +this.effBpm.toFixed(3) : null,
      beat: beat == null ? null : +beat.toFixed(3),
      beatInMeasure: this.buffer ? this.beatInMeasure() : 0,
      beatsUntilCue: this.buffer ? +(((this.cuePoint - this.position()) * this.trackBpm) / 60).toFixed(2) : null,
      positionSec: +this.position().toFixed(3),
      waveform: this.peaks.slice(),
      /* additive extensions (ECOSYSTEM backwards-compat: new fields allowed) */
      beatOffsetSec: +this.beatOffsetSec.toFixed(3),
      bpmConfidence: +this.detectConfidence.toFixed(3),
      rmsNow: +this.rmsNow().toFixed(4),
      energy: info ? info.section.energy : 0,
      sectionIndex: info ? info.sectionIndex : -1,
      barInSection: info ? info.barInSection : 0,
      sectionLengthBars: info ? info.section.lengthBars : 0,
      barsToNextSection: info ? info.barsToNext : 0,
    };
  }
  tickEnded() {
    // called by the rAF ticker: non-loop end of track
    if (this.playing && !this.loop && this.position() >= this.duration - 0.03) {
      this.pause(); this.offset = 0;
    }
  }
  drawWaveform() {
    const c = this.wfCtx, W = this.el.wf.width, H = this.el.wf.height;
    const acc = this.key === 'a' ? '#22d3ee' : '#f471e8';
    c.clearRect(0, 0, W, H); c.fillStyle = '#101012'; c.fillRect(0, 0, W, H);
    if (!this.buffer || !this.peaks.length) {
      c.fillStyle = '#3c3c44'; c.font = '13px system-ui'; c.textAlign = 'center';
      c.fillText('NO TRACK', W / 2, H / 2 + 4); return;
    }
    const pos = this.position(), frac = this.duration ? pos / this.duration : 0;
    if (this.sections.length && this.duration) {
      this.sections.forEach((s, i) => {
        const x0 = (s.startSec / this.duration) * W;
        const wdt = (((s.lengthBars * 4 * 60) / this.trackBpm) / this.duration) * W;
        if (s.energy >= 0.75) c.fillStyle = 'rgba(232,201,122,0.12)';
        else if (i % 2 === 0) c.fillStyle = 'rgba(255,255,255,0.05)';
        else return;
        c.fillRect(x0, 0, wdt, H);
      });
      c.fillStyle = 'rgba(255,255,255,0.35)';
      this.sections.forEach((s) => { const x = (s.startSec / this.duration) * W; c.fillRect(x, 0, 1, 8); });
    }
    if (this.loop) {
      c.fillStyle = 'rgba(255,255,255,0.13)';
      c.fillRect((this.loop.start / this.duration) * W, 0, ((this.loop.end - this.loop.start) / this.duration) * W, H);
    }
    const bw = W / this.peaks.length;
    this.peaks.forEach((p, i) => {
      c.fillStyle = (i / this.peaks.length) <= frac ? acc : '#48484f';
      const h = Math.max(2, p * (H - 10));
      c.fillRect(i * bw + 0.5, (H - h) / 2, Math.max(1, bw - 1.5), h);
    });
    this.hotCues.forEach((hc) => {
      if (hc == null) return;
      c.fillStyle = '#ffffff'; const x = (hc / this.duration) * W;
      c.fillRect(x - 1, 0, 2, 10);
    });
    if (this.cuePoint != null) { c.fillStyle = '#e8c97a'; c.fillRect((this.cuePoint / this.duration) * W - 1, H - 10, 2, 10); }
    c.fillStyle = '#ffffff'; c.fillRect(frac * W - 1, 0, 2, H);
  }
}

const decks = [new Deck('a', 11), new Deck('b', 12)];
const deckByKey = { a: decks[0], b: decks[1] };

/* ================= MASTER SELECTION (HoloSYNC rule) =================
 * master-flagged deck > first on-air playing deck > deck A (if loaded).
 * The step clock and every follower derive from the master's EFFECTIVE bpm. */
function masterDeck() {
  const flagged = decks.find((d) => d.masterFlag && d.buffer);
  if (flagged) return flagged;
  const onAir = decks.find((d) => d.playing && d.onAir());
  if (onAir) return onAir;
  return decks[0].buffer ? decks[0] : (decks[1].buffer ? decks[1] : decks[0]);
}
let lastMasterBpm = 124;
function currentMasterBpm() {
  const m = masterDeck();
  if (m.buffer && m.effBpm) { lastMasterBpm = m.effBpm; return m.effBpm; }
  return lastMasterBpm;
}
/* Master beat: from the master deck when it is playing, else the free clock. */
let freeBeat = 0, lastTickCtx = 0;
function masterBeatFloat() {
  const m = masterDeck();
  if (m.buffer && m.playing) return Math.max(0, m.beatFloat() || 0);
  return freeBeat;
}

/* ================= LOOKAHEAD SCHEDULER (Chris Wilson pattern) ================= */
const sched = {
  playing: false, timer: null, nextStep: 0, nextTime: 0,
  ahead: 0.1, interval: 25, absStep: 0,
};
const notesLog = []; // {time, freq, midi, step, source}
let notesScheduled = 0;

function scaleDegreeMidi(degree) {
  const scale = SCALES[$('synth-scale').value] || SCALES.minor;
  const root = parseInt($('synth-root').value, 10);
  const octShift = parseInt($('oct-val').textContent, 10) || 0;
  const base = 48 + root + octShift * 12; // C3-based
  const oct = Math.floor(degree / 7);
  return base + scale[degree % 7] + oct * 12;
}
/* step state -> scale degree: 1=root(0) 2=3rd(2) 3=5th(4) 4=octave(7) */
const STATE_DEGREE = { 1: 0, 2: 2, 3: 4, 4: 7 };
const stepStates = [1, 0, 2, 0, 3, 0, 2, 0, 1, 0, 4, 0, 3, 0, 2, 0];

const arp = { on: false, idx: 0, dir: 1 };
function arpChordMidis() {
  // chord tones: scale degrees 0,2,4 across the selected octave range
  const octaves = parseInt($('arp-octaves').value, 10);
  const tones = [];
  for (let o = 0; o < octaves; o++) [0, 2, 4].forEach((d) => tones.push(scaleDegreeMidi(d + o * 7)));
  tones.push(scaleDegreeMidi(octaves * 7));
  return tones;
}
function arpNextMidi() {
  const tones = arpChordMidis();
  const pattern = $('arp-pattern').value;
  let midi;
  if (pattern === 'random') midi = tones[Math.floor(Math.random() * tones.length)];
  else {
    if (pattern === 'down') { arp.idx = (arp.idx - 1 + tones.length) % tones.length; }
    else if (pattern === 'updown') {
      arp.idx += arp.dir;
      if (arp.idx >= tones.length - 1) { arp.idx = tones.length - 1; arp.dir = -1; }
      if (arp.idx <= 0) { arp.idx = 0; arp.dir = 1; }
    } else { arp.idx = (arp.idx + 1) % tones.length; } // up
    midi = tones[clamp(arp.idx, 0, tones.length - 1)];
  }
  return midi;
}

function synthNote(midi, time, durSec, source) {
  const wave = $('synth-wave').value;
  const cutoff = parseFloat($('synth-cutoff').value);
  const reso = parseFloat($('synth-reso').value);
  const o = ctx.createOscillator(); o.type = wave; o.frequency.value = midiHz(midi);
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = reso;
  const g = ctx.createGain();
  const peak = 0.32;
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(peak, time + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, time + Math.max(0.05, durSec));
  o.connect(f); f.connect(g); g.connect(seqGain);
  o.start(time); o.stop(time + durSec + 0.05);
  notesLog.push({ time, freq: +midiHz(midi).toFixed(2), midi, source });
  if (notesLog.length > 400) notesLog.splice(0, notesLog.length - 400);
  notesScheduled++;
}

function scheduleStep(absStep, time) {
  const step16 = absStep % 16;
  const state = stepStates[step16];
  const bpm = currentMasterBpm();
  const stepDur = 60 / bpm / 4;
  if (state === 0) return;
  if (arp.on) {
    const rateSteps = parseInt($('arp-rate').value, 10); // 1 = every 16th, 2 = every 8th
    if (absStep % rateSteps !== 0) return;
    const gate = parseFloat($('arp-gate').value);
    synthNote(arpNextMidi(), time, stepDur * rateSteps * gate * 2.2, 'arp');
  } else {
    synthNote(scaleDegreeMidi(STATE_DEGREE[state]), time, stepDur * 1.8, 'seq');
  }
}
function schedulerTick() {
  if (!sched.playing || !ctx) return;
  const bpm = currentMasterBpm();
  const stepDur = 60 / bpm / 4;
  // Soft-align the free-running step grid to a playing master deck (phase lock).
  const m = masterDeck();
  if (m.buffer && m.playing) {
    const deckStep = Math.floor((m.beatFloat() || 0) * 4);
    const drift = sched.absStep - deckStep;
    if (Math.abs(drift) > 2) { // hard re-align only on big drift / deck swap
      sched.absStep = deckStep;
      sched.nextTime = ctx.currentTime + 0.03;
    }
  }
  while (sched.nextTime < ctx.currentTime + sched.ahead) {
    scheduleStep(sched.absStep, sched.nextTime);
    sched.nextStep = sched.absStep % 16;
    sched.nextTime += stepDur;
    sched.absStep++;
  }
}
function seqStart() {
  if (!ctx) return;
  sched.playing = true;
  sched.nextTime = ctx.currentTime + 0.05;
  const m = masterDeck();
  sched.absStep = (m.buffer && m.playing) ? Math.ceil((m.beatFloat() || 0) * 4) : Math.ceil(freeBeat * 4);
  sched.timer = setInterval(schedulerTick, sched.interval);
  $('seq-play').classList.add('on'); $('seq-play').textContent = 'SEQ STOP';
}
function seqStop() {
  sched.playing = false;
  if (sched.timer) clearInterval(sched.timer); sched.timer = null;
  $('seq-play').classList.remove('on'); $('seq-play').textContent = 'SEQ PLAY';
  document.querySelectorAll('.step.now').forEach((s) => s.classList.remove('now'));
}

/* ============================== SAMPLER ============================== */
let quantize = true;
let samplerTriggers = 0;
const pendingPads = new Set();
function playPadNow(i, when) {
  if (!ctx || !samplerBuffers[i]) return;
  const src = ctx.createBufferSource(); src.buffer = samplerBuffers[i];
  src.connect(samplerGain); src.start(when || ctx.currentTime);
  samplerTriggers++;
  const el = document.querySelector('.pad[data-pad="' + i + '"]');
  if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 160); }
}
function nextBeatTime() {
  const m = masterDeck();
  if (m.buffer && m.playing) {
    const beat = m.beatFloat() || 0;
    const nextBeat = Math.floor(beat) + 1;
    const posSec = m.beatOffsetSec + nextBeat * 60 / m.trackBpm;
    return ctx.currentTime + (posSec - m.position()) / m.rate;
  }
  const bpm = currentMasterBpm();
  const nextBeat = Math.floor(freeBeat) + 1;
  return ctx.currentTime + (nextBeat - freeBeat) * (60 / bpm);
}
function triggerPad(i) {
  if (!ctx) return;
  if (quantize) playPadScheduled(i, nextBeatTime()); // waits for the next master beat
  else playPadNow(i);
}
function playPadScheduled(i, when) {
  if (!ctx || !samplerBuffers[i]) return;
  const src = ctx.createBufferSource(); src.buffer = samplerBuffers[i];
  src.connect(samplerGain); src.start(when);
  samplerTriggers++;
  const delay = Math.max(0, (when - ctx.currentTime) * 1000);
  const el = document.querySelector('.pad[data-pad="' + i + '"]');
  if (el) setTimeout(() => { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 160); }, delay);
}

/* ============================== SYNC BUS ==============================
 * Publishes SyncState EXACTLY in the holosync types.ts shape.
 * mode 'live', devices ['HoloDeck 1','HoloDeck 2'], deck deviceIds 11/12. */
let trackChangeSeq = 0;
let lastMasterTrackKey = '';
/* rmsTransitionSeq: increments ONLY when the PLAYING master deck crosses an
 * RMS section boundary live on the same track. HoloMapper's "RMS Transitions"
 * keys clip triggers off this seq (never raw RMS) so a re-snapshot can't
 * double-fire — same convention as trackChangeSeq. Seeks/pauses update the
 * baseline silently and never fire it. */
let rmsTransitionSeq = 0;
let lastMasterSectionKey = '';
let lastMasterSectionIdx = -1;
let lastMasterSectionTrackKey = '';
function trackChanged(deck) { /* seq increments centrally in buildSyncState (master track identity) */ }
let bc = null;
try { bc = new BroadcastChannel('holodecks-sync'); } catch (e) { bc = null; }

function buildSyncState() {
  const m = masterDeck();
  const masterId = m.buffer ? m.deviceId : null;
  const decksState = decks.map((d) => d.toState(masterId));
  // trackChangeSeq tracks the MASTER deck's track identity
  const mKey = m.buffer ? m.deviceId + ':' + m.title + ':' + m.buffer.duration : 'none';
  if (mKey !== lastMasterTrackKey) {
    if (lastMasterTrackKey !== '') trackChangeSeq++;
    lastMasterTrackKey = mKey;
  }
  // RMS transition crossing: same playing master track, section changed
  const mState = decksState.find((d) => d.deviceId === masterId);
  const secIdx = mState ? mState.sectionIndex : -1;
  const secKey = mKey + '|sec:' + secIdx;
  if (mState && m.playing && secIdx >= 0 && lastMasterSectionTrackKey === mKey
      && lastMasterSectionIdx >= 0 && secIdx !== lastMasterSectionIdx) {
    rmsTransitionSeq++;
  }
  lastMasterSectionKey = secKey;
  lastMasterSectionIdx = secIdx;
  lastMasterSectionTrackKey = mKey;
  return {
    mode: 'live',
    networkStatus: wsOpen ? 'HOLODECKS + HOLOSYNC LINK' : 'HOLODECKS LOCAL',
    devices: ['HoloDeck 1', 'HoloDeck 2'],
    decks: decksState,
    masterDeviceId: masterId,
    masterBpm: m.buffer ? +currentMasterBpm().toFixed(3) : null,
    trackChangeSeq,
    rmsTransitionSeq,
    timestamp: Date.now(),
  };
}
let latestSync = null;
function publishSync() {
  latestSync = buildSyncState();
  window.__HOLODECKS_SYNC__ = latestSync;
  try { bc && bc.postMessage(latestSync); } catch (e) {}
  window.dispatchEvent(new CustomEvent('holodecks-sync', { detail: latestSync }));
  if (wsOpen && ws) { try { ws.send(JSON.stringify({ type: 'state', state: latestSync })); } catch (e) {} }
  updateSyncPanel(latestSync);
}
let publishQueued = false;
function publishSoon() {
  if (publishQueued) return;
  publishQueued = true;
  setTimeout(() => { publishQueued = false; publishSync(); }, 30);
}

/* WebSocket to HoloSYNC — best effort, silent if absent, retry at most every 15s. */
let ws = null, wsOpen = false, wsTimer = null;
function wsConnect() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  let sock;
  try { sock = new WebSocket('ws://127.0.0.1:52711'); } catch (e) { wsTimer = setTimeout(wsConnect, 15000); return; }
  ws = sock;
  sock.onopen = () => {
    wsOpen = true;
    try { sock.send(JSON.stringify({ type: 'hello', sourceId: 'holodecks-1', sourceKind: 'holodeck', name: 'HoloDecks', protocolVersion: 1, deckCount: 2 })); } catch (e) {}
    $('sync-pill').textContent = 'SYNC · LIVE'; $('sync-pill').classList.add('live'); $('sync-pill').classList.remove('local');
    const st = $('sync-status'); st.textContent = 'LIVE — HOLOSYNC LINKED'; st.classList.add('live'); st.classList.remove('local');
    publishSoon();
  };
  const down = () => {
    if (wsOpen) {
      $('sync-pill').textContent = 'SYNC · LOCAL'; $('sync-pill').classList.remove('live'); $('sync-pill').classList.add('local');
      const st = $('sync-status'); st.textContent = 'LOCAL'; st.classList.remove('live'); st.classList.add('local');
    }
    wsOpen = false; ws = null;
    wsTimer = setTimeout(wsConnect, 15000);
  };
  sock.onclose = down; sock.onerror = () => { try { sock.close(); } catch (e) {} };
}
wsConnect();
setInterval(() => { if (decks.some((d) => d.playing) || sched.playing) publishSync(); }, 100); // 10Hz while playing

function updateSyncPanel(s) {
  $('so-bpm').textContent = s.masterBpm ? s.masterBpm.toFixed(2) : '—';
  const md = s.decks.find((d) => d.deviceId === s.masterDeviceId);
  $('so-beat').textContent = md && md.beat != null ? Math.floor(md.beat) + 1 + ' / bar ' + (Math.floor(md.beat / 4) + 1) : '—';
  $('so-deck').textContent = s.masterDeviceId === 11 ? 'A' : s.masterDeviceId === 12 ? 'B' : '—';
  $('so-seq').textContent = s.trackChangeSeq;
  const rmsEl = $('so-rms');
  if (rmsEl) {
    if (md && md.sectionIndex >= 0 && md.track && md.track.sections && md.track.sections.length) {
      const eLabel = md.energy >= 0.75 ? 'HIGH' : md.energy >= 0.45 ? 'MID' : 'LOW';
      rmsEl.textContent = 'RMS SECTION ' + (md.sectionIndex + 1) + '/' + md.track.sections.length +
        ' · bar ' + md.barInSection + ' of ' + md.sectionLengthBars +
        ' · energy ' + eLabel + ' · next in ' + md.barsToNextSection + ' bars' +
        ' · transitions ' + s.rmsTransitionSeq;
    } else rmsEl.textContent = 'RMS SECTION —';
  }
  $('follow-readout').textContent = 'HoloMapper would follow: BPM ' + (s.masterBpm ? s.masterBpm.toFixed(2) : '—') +
    ', beat ' + (md && md.beatInMeasure ? md.beatInMeasure : '—') + ' of bar ' + (md && md.beat != null ? Math.floor(md.beat / 4) + 1 : '—') +
    (md && md.track ? ' — ' + md.track.title : '');
  $('sync-peek').textContent = JSON.stringify(s).slice(0, 600) + '…';
}

/* ============================== LIGHTING ==============================
 * Preview only — driven by the same master beat data HoloMapper receives. */
const PALETTE = ['#22d3ee', '#f471e8', '#4ade80', '#e8c97a', '#7aa2ff', '#ff7a59', '#b48cff', '#5ff2c8'];
let lightsOn = true;
function drawLighting() {
  const fixtures = document.querySelectorAll('#fixtures .fixture');
  const beat = masterBeatFloat();
  const beatInBar = Math.floor(beat) % 4;
  const bar = Math.floor(beat / 4);
  const frac = beat - Math.floor(beat);
  const pattern = $('light-pattern').value;
  const phrase = Math.floor(bar / 16) + bar; // color shifts each 16-bar phrase + per bar in wash
  fixtures.forEach((fx, i) => {
    let bg = '#232327', lit = false, op = 1;
    if (lightsOn) {
      if (pattern === 'chase') {
        const active = Math.floor(beat) % 8;
        if (i === active) { bg = PALETTE[bar % PALETTE.length]; lit = true; op = 1 - frac * 0.55; }
      } else if (pattern === 'strobe') {
        if (beatInBar === 0 && frac < 0.4) { bg = '#ffffff'; lit = true; op = 1 - frac; }
      } else if (pattern === 'wash') {
        bg = PALETTE[Math.abs(phrase) % PALETTE.length]; lit = true; op = 0.45 + 0.4 * (1 - frac);
      } else if (pattern === 'pulse') {
        bg = PALETTE[bar % PALETTE.length]; lit = frac < 0.6; op = 1 - frac * 0.8;
      }
    }
    fx.style.background = bg; fx.style.opacity = op;
    fx.classList.toggle('lit', lit && lightsOn);
  });
}

/* ============================== TICKER ============================== */
function drawVU() {
  if (!analyser) return;
  analyser.getByteTimeDomainData(analyserData);
  let peak = 0;
  for (let i = 0; i < analyserData.length; i++) peak = Math.max(peak, Math.abs(analyserData[i] - 128) / 128);
  const c = $('vu').getContext('2d'); const W = 72, H = 150;
  c.fillStyle = '#101012'; c.fillRect(0, 0, W, H);
  const h = peak * (H - 8);
  c.fillStyle = peak > 0.85 ? '#ff5f57' : peak > 0.6 ? '#e8c97a' : '#4ade80';
  c.fillRect(10, H - 4 - h, W - 20, h);
}
function ticker() {
  requestAnimationFrame(ticker);
  if (!ctx) return;
  const now = ctx.currentTime;
  const dt = lastTickCtx ? now - lastTickCtx : 0;
  lastTickCtx = now;
  const m = masterDeck();
  if (!(m.buffer && m.playing)) freeBeat += dt * currentMasterBpm() / 60;
  decks.forEach((d) => {
    d.tickEnded();
    d.drawWaveform();
    if (d.buffer) {
      const pos = d.position();
      d.el.elapsed.textContent = fmtTime(pos);
      d.el.remain.textContent = '-' + fmtTime(Math.max(0, d.duration - pos));
      const bim = d.beatInMeasure();
      d.el.dots.querySelectorAll('span').forEach((s, i) => {
        s.classList.toggle('on', d.playing && i === bim - 1);
        s.classList.toggle('bar', i === 0);
      });
      if (d.el.secinfo) {
        const info = d.sectionInfo();
        d.el.secinfo.textContent = info
          ? 'SEC ' + (info.sectionIndex + 1) + ' · ' + info.barInSection + '/' + info.section.lengthBars + ' · ' +
            (info.section.energy >= 0.75 ? 'HIGH' : info.section.energy >= 0.45 ? 'MID' : 'LOW')
          : 'SEC —';
      }
    }
  });
  // header readouts
  const bpm = currentMasterBpm();
  $('master-bpm').textContent = bpm.toFixed(2);
  $('master-deck-label').textContent = 'DECK ' + m.key.toUpperCase() + (m.buffer ? ' — ' + m.title : '');
  const beat = masterBeatFloat();
  $('clock-readout').textContent = 'BAR ' + (Math.floor(beat / 4) + 1) + ' · BEAT ' + ((Math.floor(beat) % 4) + 1);
  // sequencer playhead highlight
  if (sched.playing) {
    const cur = Math.floor(masterBeatFloat() * 4) % 16;
    document.querySelectorAll('.step').forEach((s, i) => s.classList.toggle('now', i === ((cur % 16) + 16) % 16));
  }
  drawVU();
  drawLighting();
}
requestAnimationFrame(ticker);

/* ============================== UI WIRING ============================== */
$('power-btn').addEventListener('click', () => {
  initAudio();
  $('power-overlay').classList.add('off');
  publishSync();
});

function applyCrossfader() {
  const x = parseFloat($('xfader').value);
  // equal-power
  if (decks[0].crossGain) decks[0].crossGain.gain.value = Math.cos(x * Math.PI / 2);
  if (decks[1].crossGain) decks[1].crossGain.gain.value = Math.cos((1 - x) * Math.PI / 2);
}
$('xfader').addEventListener('input', applyCrossfader);
$('master-vol').addEventListener('input', (e) => { if (masterGain) masterGain.gain.value = parseFloat(e.target.value); });

/* File-load analysis flow (also the test entry point): paint ANALYZING first,
 * yield so the label renders, detect BPM + first beat, analyse RMS sections,
 * then load with the detected grid. Any detection failure falls back to the
 * BPM input value with a MANUAL badge. */
const yieldFrame = () => new Promise((r) => setTimeout(r, 30));
async function analyzeAndLoad(key, buffer, title, artist = 'Local file') {
  const deck = deckByKey[key];
  if (!deck || !buffer) return null;
  deck.bpmSource = 'analyzing'; deck.updateBpmBadge();
  await yieldFrame(); // let ANALYZING BPM… paint before the heavy loop
  let det = null;
  try { det = window.TempoDetect ? window.TempoDetect.detect(buffer) : null; } catch (e) { det = null; }
  let bpm, opts;
  if (det && det.bpm > 0) {
    bpm = det.bpm;
    opts = {
      beatOffsetSec: det.beatOffsetSec || 0,
      confidence: det.confidence || 0,
      rawBpm: det.rawBpm || det.bpm,
      source: det.confidence < 0.35 ? 'auto-low' : 'auto',
    };
  } else {
    bpm = clamp(parseFloat(deck.el.bpm.value) || 120, 40, 240);
    opts = { source: 'manual' };
  }
  await yieldFrame();
  try {
    if (window.RmsAnalyze) opts.sectionsData = window.RmsAnalyze.analyzeSections(buffer, bpm, opts.beatOffsetSec || 0);
  } catch (e) { /* sections are additive — load proceeds without them */ }
  await deck.loadBuffer(buffer, title, artist, bpm, opts);
  return det;
}

decks.forEach((deck) => {
  const k = deck.key;
  $('file-' + k).addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file || !ctx) return;
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      await analyzeAndLoad(k, buf, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) { console.warn('decode failed', err); }
  });
  $('demo-' + k).addEventListener('click', async () => {
    if (!ctx) return;
    $('demo-' + k).textContent = 'RENDERING…';
    const d = await renderDemo(k);
    await deck.loadBuffer(d.buffer, d.title, d.artist, d.bpm, { source: 'demo', beatOffsetSec: 0 });
    $('demo-' + k).textContent = 'LOAD DEMO';
  });
  $('bpm-' + k).addEventListener('change', (e) => {
    deck.setBpmManual(parseFloat(e.target.value) || deck.trackBpm);
  });
  /* manual BPM correction row: fine adjust / half / double / tap tempo */
  $('bpmminus-' + k).addEventListener('click', () => deck.setBpmManual(Math.round((deck.trackBpm - 0.1) * 10) / 10));
  $('bpmplus-' + k).addEventListener('click', () => deck.setBpmManual(Math.round((deck.trackBpm + 0.1) * 10) / 10));
  $('bpmhalf-' + k).addEventListener('click', () => deck.setBpmManual(deck.trackBpm / 2));
  $('bpmdouble-' + k).addEventListener('click', () => deck.setBpmManual(deck.trackBpm * 2));
  $('tap-' + k).addEventListener('click', (e) => {
    /* event.timeStamp is stamped when the tap/click actually happened, not
     * when this (possibly delayed) handler runs on a busy main thread. */
    const now = (e && e.timeStamp) ? e.timeStamp : performance.now();
    if (deck.tapTimes.length && now - deck.tapTimes[deck.tapTimes.length - 1] > 2000) deck.tapTimes = [];
    deck.tapTimes.push(now);
    if (deck.tapTimes.length > 7) deck.tapTimes.shift();
    if (deck.tapTimes.length >= 4) {
      // median interval: one sloppy tap shouldn't drag the tempo
      const ivs = [];
      for (let i = 1; i < deck.tapTimes.length; i++) ivs.push(deck.tapTimes[i] - deck.tapTimes[i - 1]);
      ivs.sort((a, b) => a - b);
      const medMs = ivs[Math.floor(ivs.length / 2)];
      if (medMs > 150) deck.setBpmManual(Math.round((60000 / medMs) * 10) / 10);
    }
  });
  $('play-' + k).addEventListener('click', () => deck.togglePlay());
  $('cue-' + k).addEventListener('click', () => {
    if (!deck.buffer) return;
    if (deck.playing) { deck.pause(); deck.seek(deck.cuePoint); }
    else { deck.cuePoint = deck.position(); publishSoon(); }
  });
  // jog nudge: temporary pitch bend while pressed
  const bendAmt = 2.5;
  const dn = $('nudge-dn-' + k), up = $('nudge-up-' + k);
  const onDn = (e) => { e.preventDefault(); deck.setBend(-bendAmt); };
  const onUp = (e) => { e.preventDefault(); deck.setBend(bendAmt); };
  const off = () => deck.setBend(0);
  dn.addEventListener('pointerdown', onDn); up.addEventListener('pointerdown', onUp);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => { dn.addEventListener(ev, off); up.addEventListener(ev, off); });
  $('pitch-' + k).addEventListener('input', (e) => { deck.setPitch(parseFloat(e.target.value)); });
  $('pitchzero-' + k).addEventListener('click', () => deck.setPitch(0));
  $('master-' + k).addEventListener('click', () => {
    deck.masterFlag = !deck.masterFlag;
    if (deck.masterFlag) decks.forEach((d) => { if (d !== deck) d.masterFlag = false; });
    decks.forEach((d) => $('master-' + d.key).classList.toggle('on', d.masterFlag));
    publishSoon();
  });
  $('sync-' + k).addEventListener('click', () => {
    const other = decks.find((d) => d !== deck);
    const target = (other.buffer && other.effBpm) ? other.effBpm : currentMasterBpm();
    if (!deck.buffer || !target) return;
    const needed = (target / deck.trackBpm - 1) * 100;
    deck.setPitch(clamp(needed, -8, 8), true);
    deck.isSync = Math.abs(needed) <= 8;
    $('sync-' + k).classList.toggle('on', deck.isSync);
    publishSoon();
  });
  $('loop4-' + k).addEventListener('click', () => deck.setLoop(4));
  $('loop8-' + k).addEventListener('click', () => deck.setLoop(8));
  $('loopoff-' + k).addEventListener('click', () => deck.clearLoop());
  // hot cues
  document.querySelectorAll('#hotcues-' + k + ' button').forEach((btn) => {
    const idx = parseInt(btn.dataset.cue, 10);
    btn.addEventListener('click', () => {
      if (!deck.buffer) return;
      if (deck.hotCues[idx] == null) {
        deck.hotCues[idx] = deck.position();
        btn.classList.add('set');
      } else {
        deck.seek(deck.hotCues[idx]);
        btn.classList.add('fired'); setTimeout(() => btn.classList.remove('fired'), 200);
      }
      publishSoon();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault(); deck.hotCues[idx] = null; btn.classList.remove('set');
    });
  });
  // waveform seek
  deck.el.wf.addEventListener('click', (e) => {
    if (!deck.buffer) return;
    const r = deck.el.wf.getBoundingClientRect();
    deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
  });
  // mixer: EQ + channel gain
  $('eqhi-' + k).addEventListener('input', (e) => { if (deck.eqHigh) deck.eqHigh.gain.value = parseFloat(e.target.value); });
  $('eqmid-' + k).addEventListener('input', (e) => { if (deck.eqMid) deck.eqMid.gain.value = parseFloat(e.target.value); });
  $('eqlow-' + k).addEventListener('input', (e) => { if (deck.eqLow) deck.eqLow.gain.value = parseFloat(e.target.value); });
  $('gain-' + k).addEventListener('input', (e) => {
    deck.chanGainVal = parseFloat(e.target.value);
    if (deck.chanGain) deck.chanGain.gain.value = deck.chanGainVal;
    publishSoon();
  });
});

/* sampler UI */
document.querySelectorAll('.pad').forEach((pad) => {
  const i = parseInt(pad.dataset.pad, 10);
  pad.addEventListener('click', () => triggerPad(i));
  pad.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    $('pad-file').dataset.pad = i;
    $('pad-file').click();
  });
  pad.addEventListener('dragover', (e) => { e.preventDefault(); pad.classList.add('drop'); });
  pad.addEventListener('dragleave', () => pad.classList.remove('drop'));
  pad.addEventListener('drop', async (e) => {
    e.preventDefault(); pad.classList.remove('drop');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && ctx) await loadPadFile(i, file);
  });
});
async function loadPadFile(i, file) {
  try {
    samplerBuffers[i] = await ctx.decodeAudioData(await file.arrayBuffer());
    const el = document.querySelector('.pad[data-pad="' + i + '"]');
    el.textContent = file.name.replace(/\.[^.]+$/, '').slice(0, 18).toUpperCase();
    el.classList.add('custom');
  } catch (err) { console.warn('pad decode failed', err); }
}
$('pad-file').addEventListener('change', async (e) => {
  const i = parseInt(e.target.dataset.pad, 10);
  if (e.target.files[0]) await loadPadFile(i, e.target.files[0]);
  e.target.value = '';
});
$('quantize-btn').addEventListener('click', () => {
  quantize = !quantize;
  $('quantize-btn').textContent = quantize ? 'QUANTIZE ON' : 'QUANTIZE OFF';
  $('quantize-btn').classList.toggle('on', quantize);
});

/* sequencer UI */
const stepsEl = $('steps');
const STATE_LABEL = ['—', 'R', '3', '5', '8'];
stepStates.forEach((st, i) => {
  const b = document.createElement('button');
  b.className = 'step' + (i % 4 === 0 ? ' group-start' : '');
  b.dataset.state = st; b.textContent = STATE_LABEL[st];
  b.addEventListener('click', () => {
    stepStates[i] = (stepStates[i] + 1) % 5;
    b.dataset.state = stepStates[i]; b.textContent = STATE_LABEL[stepStates[i]];
  });
  stepsEl.appendChild(b);
});
$('seq-play').addEventListener('click', () => { sched.playing ? seqStop() : seqStart(); });
$('arp-btn').addEventListener('click', () => {
  arp.on = !arp.on; arp.idx = 0; arp.dir = 1;
  $('arp-btn').textContent = arp.on ? 'ARP ON' : 'ARP OFF';
  $('arp-btn').classList.toggle('on', arp.on);
});
$('oct-dn').addEventListener('click', () => { $('oct-val').textContent = clamp(parseInt($('oct-val').textContent, 10) - 1, -2, 2); });
$('oct-up').addEventListener('click', () => { $('oct-val').textContent = clamp(parseInt($('oct-val').textContent, 10) + 1, -2, 2); });
$('synth-vol').addEventListener('input', (e) => { if (seqGain) seqGain.gain.value = parseFloat(e.target.value); });

/* sync + lighting UI */
$('copy-sync').addEventListener('click', async () => {
  publishSync();
  try { await navigator.clipboard.writeText(JSON.stringify(latestSync, null, 2)); $('copy-sync').textContent = 'COPIED'; }
  catch (e) { $('copy-sync').textContent = 'COPY FAILED'; }
  setTimeout(() => { $('copy-sync').textContent = 'COPY SYNC STATE'; }, 1200);
});
$('light-btn').addEventListener('click', () => {
  lightsOn = !lightsOn;
  $('light-btn').textContent = lightsOn ? 'LIGHTS ON' : 'LIGHTS OFF';
  $('light-btn').classList.toggle('on', lightsOn);
});

/* keyboard: space is NOT hijacked (buttons need it); Q/W = cue, A/B handled by buttons. */

/* ================= DEBUG / TEST HANDLE ================= */
function masterLevel() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(analyserData);
  let sum = 0;
  for (let i = 0; i < analyserData.length; i++) { const v = (analyserData[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / analyserData.length);
}
window.__HOLODECKS__ = {
  version: 1,
  get ctxState() { return ctx ? ctx.state : 'none'; },
  decks,
  getSyncState: () => buildSyncState(),
  latestSync: () => latestSync,
  masterLevel,
  seq: {
    get playing() { return sched.playing; },
    get step() { return Math.floor(masterBeatFloat() * 4) % 16; },
    get absStep() { return sched.absStep; },
    get notesScheduled() { return notesScheduled; },
    notesLog,
  },
  sampler: {
    get triggers() { return samplerTriggers; },
    get quantize() { return quantize; },
    triggerPad,
    buffersReady: () => samplerBuffers.every(Boolean),
  },
  masterDeckKey: () => masterDeck().key,
  masterBpm: () => currentMasterBpm(),
  masterBeat: () => masterBeatFloat(),
  detectBPM: (buffer) => window.TempoDetect.detect(buffer),
  analyzeSections: (buffer, bpm, off) => window.RmsAnalyze.analyzeSections(buffer, bpm, off),
  analyzeAndLoad,
};
publishSync();
