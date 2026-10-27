'use strict';
/* HoloDecks mobile sync — mirrors HoloMapper's proven phone link:
 * MQTT over WSS via vendored Paho, brokers tried IN ORDER (sequential
 * rendezvous — racing brokers strand peers on different brokers), topics
 * holodecks/v1/<CODE>/{sync,presence/<id>,cmd}.
 *
 * Roles: HOST = opened without ?sync (owns audio + files). GUEST = arrived
 * via ?sync=CODE — the FULL app as a control surface: its deck audio never
 * runs (no buffers cross the link; transport/mixer/sampler/seq/arp actions
 * are sent as commands and the host applies them through the same UI paths).
 *
 * Honesty (HoloMapper v1.9.53 rules): the link pill may say SYNCED only
 * when peer presence is <8s fresh AND the FNV-1a hash of the canonical UI
 * state matches the peer's. Divergence auto-heals: guest re-sends hello,
 * host re-broadcasts a full snapshot. Guest never sends deck state; it
 * sends commands + presence only, and only after connecting. */
(function () {
  if (typeof Paho !== 'undefined' && !Paho.MQTT) Paho.MQTT = { Client: Paho.Client, Message: Paho.Message };

  const $id = (id) => document.getElementById(id);
  const LS_KEY = 'holodecks.paircode';
  const params = new URLSearchParams(location.search);
  const syncParam = params.get('sync');
  const IS_GUEST = !!(syncParam && syncParam.length >= 4);

  function genCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }
  function loadCode() { try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } }
  function saveCode(c) { try { localStorage.setItem(LS_KEY, c); } catch (e) {} }

  let pairCode;
  if (IS_GUEST) { pairCode = syncParam.toUpperCase(); saveCode(pairCode); }
  else { pairCode = loadCode() || genCode(); saveCode(pairCode); }

  const linkId = 'hd-' + Math.random().toString(36).slice(2, 10);
  const ROLE = IS_GUEST ? 'guest' : 'host';

  /* ---------------- FNV-1a hash of canonical UI state ---------------- */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function canonicalUI() {
    const num = (v) => Math.round((+v || 0) * 1000) / 1000;
    return {
      decks: decks.map((d) => ({
        title: d.title, artist: d.artist, bpm: num(d.trackBpm), off: num(d.beatOffsetSec),
        playing: !!d.playing, pitch: num(d.pitch), sync: !!d.isSync, master: !!d.masterFlag,
        cue: num(d.cuePoint), hot: d.hotCues.map((h) => (h == null ? null : num(h))),
        loop: d.loop ? { start: num(d.loop.start), end: num(d.loop.end), beats: d.loop.beats } : null,
        src: d.bpmSource, gain: num(d.chanGainVal),
        eq: ['eqhi', 'eqmid', 'eqlow'].map((n) => num(parseFloat($id(n + '-' + d.key).value))),
        sections: d.sections.map((s) => [s.startBar, s.lengthBars]),
      })),
      xf: num(parseFloat($id('xfader').value)), masterVol: num(parseFloat($id('master-vol').value)),
      quantize: !!window.__HOLODECKS__.sampler.quantize,
      pads: [...document.querySelectorAll('.pad')].map((p) => p.textContent),
      seq: {
        playing: seqPlayingCanonical(), steps: stepStates.slice(),
        wave: $id('synth-wave').value, root: $id('synth-root').value, scale: $id('synth-scale').value,
        oct: $id('oct-val').textContent, cutoff: $id('synth-cutoff').value, reso: $id('synth-reso').value,
        vol: $id('synth-vol').value, arpOn: !!arp.on,
        arpPattern: $id('arp-pattern').value, arpRate: $id('arp-rate').value,
        arpOctaves: $id('arp-octaves').value, arpGate: $id('arp-gate').value,
      },
    };
  }
  function ownHash() { try { return fnv1a(JSON.stringify(canonicalUI())); } catch (e) { return 'x'; } }

  /* ---------------- MQTT transport (sequential rendezvous) ---------------- */
  const CLOUD_BROKERS = [
    ['broker.emqx.io', 8084, '/mqtt'],
    ['broker.hivemq.com', 8884, '/mqtt'],
    ['test.mosquitto.org', 8081, '/'],
  ];
  function brokerList() {
    try {
      const r = params.get('relay');
      if (r) { const u = new URL(r); return [[u.hostname, +(u.port || (u.protocol === 'wss:' ? 443 : 80)), u.pathname || '/', u.protocol === 'wss:']]; }
    } catch (e) {}
    return CLOUD_BROKERS.map((b) => [b[0], b[1], b[2], true]);
  }
  const topic = (suffix) => 'holodecks/v1/' + pairCode + '/' + suffix;

  let client = null, connecting = false, brokerName = '', connectedAt = 0;
  let startIdx = 0, curIdx = 0, hopping = false, shakeAt = 0;
  let peerAt = 0, peerHash = '', peerRole = '', peerSeenAt = 0;
  let presTimer = null, helloTimer = null, healAt = 0;
  let gotSnapshot = false, lastAppliedSeq = -1; // guest side, per host stream
  let hostSeq = 0;
  const seenMids = new Set();

  function send(topicSuffix, obj, retained) {
    if (!client) return;
    try {
      const m = new Paho.MQTT.Message(JSON.stringify(obj));
      m.destinationName = topic(topicSuffix);
      if (retained) m.retained = true;
      client.send(m);
    } catch (e) {}
  }
  function sendPresence() {
    send('presence/' + linkId, { app: 1, id: linkId, role: ROLE, online: true, ts: Date.now(), h: ownHash() }, true);
  }
  const peerLive = () => !!(peerSeenAt && Date.now() - peerSeenAt < 8000);
  const inSync = () => peerLive() && !!peerHash && peerHash === ownHash();
  /* On a guest the sequencer never runs locally (it is a control surface);
   * the canonical hash therefore uses this shadow of the host's seq state. */
  let guestSeqPlaying = false;
  const seqPlayingCanonical = () => (IS_GUEST ? guestSeqPlaying : !!window.__HOLODECKS__.seq.playing);

  /* ---------------- UI state snapshot ---------------- */
  function buildSnapshot() {
    return {
      kind: 'ui-state', from: linkId, role: ROLE, seq: ++hostSeq, ts: Date.now(),
      canonical: canonicalUI(),
      decks: decks.map((d) => ({
        key: d.key, title: d.title, artist: d.artist, hasTrack: !!d.buffer,
        durationSec: d.buffer ? +d.duration.toFixed(2) : 0,
        trackBpm: d.trackBpm, beatOffsetSec: d.beatOffsetSec, bpmSource: d.bpmSource,
        confidence: d.detectConfidence, rawBpm: d.rawDetectedBpm,
        playing: d.playing, positionSec: +d.position().toFixed(3), pitch: d.pitch,
        isSync: d.isSync, masterFlag: d.masterFlag, cuePoint: d.cuePoint,
        hotCues: d.hotCues.slice(), loop: d.loop ? { ...d.loop } : null,
        peaks: d.peaks.slice(), sections: d.sections, barRms: d.barRms,
      })),
    };
  }
  let snapQueued = false;
  function broadcastSnapshot() {
    if (IS_GUEST || !client) return;
    send('sync', buildSnapshot());
  }
  function broadcastSnapshotSoon() {
    if (snapQueued) return;
    snapQueued = true;
    setTimeout(() => { snapQueued = false; broadcastSnapshot(); }, 60);
  }
  function broadcastPos() {
    if (IS_GUEST || !client || !decks.some((d) => d.playing)) return;
    send('sync', {
      kind: 'pos', from: linkId, role: ROLE, ts: Date.now(),
      decks: decks.map((d) => ({ key: d.key, playing: d.playing, positionSec: +d.position().toFixed(3) })),
    });
  }
  setInterval(broadcastPos, 200); // ~5Hz playhead anchors while playing
  /* Host: any canonical change (a local knob/track move) pushes a fresh
   * snapshot + presence hash promptly — no waiting for the heal cycle. */
  let lastHashSent = '';
  setInterval(() => {
    if (IS_GUEST || !client) return;
    const h = ownHash();
    if (h !== lastHashSent) { lastHashSent = h; broadcastSnapshotSoon(); sendPresence(); }
  }, 1000);

  /* ---------------- guest: apply host snapshot ---------------- */
  function setInput(id, v, evType) {
    const el = $id(id); if (!el) return;
    el.value = v;
    if (evType) el.dispatchEvent(new Event(evType, { bubbles: true }));
  }
  function applyDeckSnapshot(d, s) {
    d.title = s.title; d.artist = s.artist;
    d.trackBpm = s.trackBpm; d.beatOffsetSec = s.beatOffsetSec || 0;
    d.bpmSource = s.bpmSource || 'manual'; d.detectConfidence = s.confidence || 0; d.rawDetectedBpm = s.rawBpm || 0;
    d.peaks = s.peaks || []; d.sections = s.sections || []; d.barRms = s.barRms || []; d.barDb = [];
    d.cuePoint = s.cuePoint || 0; d.hotCues = (s.hotCues || [null, null, null, null]).slice();
    d.loop = s.loop ? { ...s.loop } : null;
    d.pitch = s.pitch || 0; d.isSync = !!s.isSync; d.masterFlag = !!s.masterFlag;
    if (s.hasTrack) {
      // Phantom buffer: carries duration for position/waveform math only.
      // Guest transport is intercepted, so it is never actually played.
      d.buffer = {
        duration: s.durationSec, sampleRate: 44100, numberOfChannels: 2, length: 0,
        getChannelData: () => new Float32Array(0),
      };
    } else d.buffer = null;
    d.offset = s.positionSec || 0;
    d.playing = !!s.playing && !!ctx;
    if (ctx) d.startedAt = ctx.currentTime;
    // DOM
    d.el.title.textContent = s.title || 'No track loaded';
    d.el.artist.textContent = s.artist || '';
    d.el.bpm.value = s.trackBpm;
    d.el.pitch.value = d.pitch;
    d.el.pitchval.textContent = (d.pitch >= 0 ? '+' : '') + d.pitch.toFixed(2) + '%';
    d.el.play.textContent = s.playing ? '❚❚' : '▶';
    d.el.play.classList.toggle('playing', !!s.playing);
    d.el.loopstate.textContent = d.loop ? 'LOOP ' + d.loop.beats : '';
    $id('loop4-' + d.key).classList.toggle('on', !!d.loop && d.loop.beats === 4);
    $id('loop8-' + d.key).classList.toggle('on', !!d.loop && d.loop.beats === 8);
    $id('sync-' + d.key).classList.toggle('on', !!s.isSync);
    $id('master-' + d.key).classList.toggle('on', !!s.masterFlag);
    document.querySelectorAll('#hotcues-' + d.key + ' button').forEach((b, i) => b.classList.toggle('set', d.hotCues[i] != null));
    d.updateBpmBadge(); d.updateEff();
    d.drawWaveform();
  }
  function applySnapshot(msg) {
    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastAppliedSeq) return; // LWW per sender stream
      lastAppliedSeq = msg.seq;
    }
    gotSnapshot = true; shakeAt = Date.now();
    const c = msg.canonical;
    (msg.decks || []).forEach((s) => { const d = deckByKey[s.key]; if (d) applyDeckSnapshot(d, s); });
    if (c) {
      // mixer
      setInput('xfader', c.xf, 'input');
      setInput('master-vol', c.masterVol, 'input');
      c.decks.forEach((cd, i) => {
        const k = decks[i].key;
        setInput('gain-' + k, cd.gain, 'input');
        setInput('eqhi-' + k, cd.eq[0], 'input');
        setInput('eqmid-' + k, cd.eq[1], 'input');
        setInput('eqlow-' + k, cd.eq[2], 'input');
      });
      // sampler
      const pads = document.querySelectorAll('.pad');
      c.pads.forEach((t, i) => { if (pads[i] && pads[i].textContent !== t) pads[i].textContent = t; });
      if (!!window.__HOLODECKS__.sampler.quantize !== c.quantize) $id('quantize-btn').click();
      // sequencer + arp — values straight in (app reads them live), steps via state + DOM
      const sq = c.seq;
      const stepBtns = document.querySelectorAll('#steps .step');
      sq.steps.forEach((st, i) => {
        stepStates[i] = st;
        if (stepBtns[i]) { stepBtns[i].dataset.state = st; stepBtns[i].textContent = STATE_LABEL[st]; }
      });
      setInput('synth-wave', sq.wave); setInput('synth-root', sq.root); setInput('synth-scale', sq.scale);
      $id('oct-val').textContent = sq.oct;
      setInput('synth-cutoff', sq.cutoff); setInput('synth-reso', sq.reso);
      setInput('synth-vol', sq.vol, 'input');
      setInput('arp-pattern', sq.arpPattern); setInput('arp-rate', sq.arpRate);
      setInput('arp-octaves', sq.arpOctaves); setInput('arp-gate', sq.arpGate);
      if (!!arp.on !== !!sq.arpOn) $id('arp-btn').click();
      // seq: shadow the state + button face only — the guest's own
      // sequencer/synth never runs (control surface, no local audio).
      guestSeqPlaying = !!sq.playing;
      $id('seq-play').classList.toggle('on', guestSeqPlaying);
      $id('seq-play').textContent = guestSeqPlaying ? 'SEQ STOP' : 'SEQ PLAY';
    }
    sendPresence();
  }
  function applyPos(msg) {
    (msg.decks || []).forEach((s) => {
      const d = deckByKey[s.key]; if (!d || !d.buffer) return;
      const drift = Math.abs(d.position() - s.positionSec);
      const wantPlay = !!s.playing;
      if (d.playing !== wantPlay && ctx) {
        d.playing = wantPlay; d.offset = s.positionSec; d.startedAt = ctx.currentTime;
        d.el.play.textContent = wantPlay ? '❚❚' : '▶';
        d.el.play.classList.toggle('playing', wantPlay);
      } else if (wantPlay && drift > 0.3 && ctx) {
        d.offset = s.positionSec; d.startedAt = ctx.currentTime; // re-anchor only on real drift
      } else if (!wantPlay) {
        d.offset = s.positionSec;
      }
    });
  }

  /* ---------------- commands ---------------- */
  let cmdSeq = 0;
  function sendCmd(name, args) {
    if (!IS_GUEST) return;
    send('cmd', { type: 'cmd', name, args: args || {}, mid: linkId + '-' + (++cmdSeq), from: linkId });
  }
  function hostClick(id) { const el = $id(id); if (el) el.click(); }
  function applyCommand(d) {
    if (!d || d.from === linkId) return;
    if (d.mid) {
      if (seenMids.has(d.mid)) return;
      seenMids.add(d.mid);
      if (seenMids.size > 500) seenMids.delete(seenMids.values().next().value);
    }
    const a = d.args || {}, k = a.deck;
    switch (d.name) {
      case 'playToggle': hostClick('play-' + k); break;
      case 'cue': hostClick('cue-' + k); break;
      case 'syncBtn': hostClick('sync-' + k); break;
      case 'masterBtn': hostClick('master-' + k); break;
      case 'loadDemo': hostClick('demo-' + k); break;
      case 'pitchZero': hostClick('pitchzero-' + k); break;
      case 'loop': hostClick((a.beats ? 'loop' + a.beats + '-' : 'loopoff-') + k); break;
      case 'hotcue': {
        const btn = document.querySelector('#hotcues-' + k + ' button[data-cue="' + a.idx + '"]');
        if (btn) btn.click();
        break;
      }
      case 'seekFrac': { const dk = deckByKey[k]; if (dk && dk.buffer) dk.seek(a.frac * dk.duration); break; }
      case 'seekSec': { const dk = deckByKey[k]; if (dk) dk.seek(a.sec); break; }
      case 'pitch': setInput('pitch-' + k, a.value, 'input'); break;
      case 'bpmInput': setInput('bpm-' + k, a.value, 'change'); break;
      case 'bpmBtn': hostClick(a.id); break;
      case 'bend': { const dk = deckByKey[k]; if (dk) dk.setBend(a.amount); break; }
      case 'mixer': setInput(a.id, a.value, 'input'); break;
      case 'setting': setInput(a.id, a.value, 'input'); break; // input event: synth-vol drives seqGain via the app listener; selects just take the value
      case 'pad': triggerPad(a.idx); break;
      case 'quantize': hostClick('quantize-btn'); break;
      case 'seqPlay': hostClick('seq-play'); break;
      case 'arpBtn': hostClick('arp-btn'); break;
      case 'stepCycle': { const btn = document.querySelectorAll('#steps .step')[a.idx]; if (btn) btn.click(); break; }
      case 'oct': hostClick(a.id); break;
      default: return;
    }
    broadcastSnapshotSoon();
  }

  /* ---------------- guest: intercept the UI (trusted events only) ------------- */
  if (IS_GUEST) {
    const clickMap = (el) => {
      const id = el.id || '';
      let m;
      if ((m = id.match(/^(play|cue|sync|demo|master|pitchzero)-(a|b)$/))) {
        const name = { play: 'playToggle', cue: 'cue', sync: 'syncBtn', demo: 'loadDemo', master: 'masterBtn', pitchzero: 'pitchZero' }[m[1]];
        return { name, args: { deck: m[2] } };
      }
      if ((m = id.match(/^loop(4|8)-(a|b)$/))) return { name: 'loop', args: { deck: m[2], beats: +m[1] } };
      if ((m = id.match(/^loopoff-(a|b)$/))) return { name: 'loop', args: { deck: m[1], beats: 0 } };
      if ((m = id.match(/^bpm(minus|plus|half|double)-(a|b)$/))) return { name: 'bpmBtn', args: { id, deck: m[2] } };
      if ((m = id.match(/^tap-(a|b)$/))) return { name: 'bpmBtn', args: { id, deck: m[1] } };
      if (id === 'quantize-btn') return { name: 'quantize', args: {} };
      if (id === 'seq-play') return { name: 'seqPlay', args: {} };
      if (id === 'arp-btn') return { name: 'arpBtn', args: {} };
      if (id === 'oct-dn' || id === 'oct-up') return { name: 'oct', args: { id } };
      if (el.classList.contains('pad')) return { name: 'pad', args: { idx: +el.dataset.pad } };
      if (el.classList.contains('step')) {
        const idx = [...document.querySelectorAll('#steps .step')].indexOf(el);
        return { name: 'stepCycle', args: { idx } };
      }
      const hc = el.closest && el.closest('.hotcues');
      if (hc && el.dataset.cue != null) return { name: 'hotcue', args: { deck: hc.id.split('-')[1], idx: +el.dataset.cue } };
      return null;
    };
    document.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      const el = e.target.closest('button, .pad, .step, canvas.waveform, label.load-btn');
      if (!el) return;
      if (el.id === 'power-btn' || el.id === 'pair-btn' || el.id === 'pair-close' || el.id === 'pair-copy') return;
      if (el.tagName === 'LABEL') { e.preventDefault(); e.stopPropagation(); flashLinkNote('files live on the host'); return; }
      if (el.classList.contains('waveform')) {
        const deckKey = el.id.split('-')[1];
        const r = el.getBoundingClientRect();
        sendCmd('seekFrac', { deck: deckKey, frac: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) });
        e.preventDefault(); e.stopPropagation(); return;
      }
      const cmd = clickMap(el);
      if (cmd) { sendCmd(cmd.name, cmd.args); e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener('input', (e) => {
      if (!e.isTrusted) return;
      const el = e.target, id = el.id || '';
      let m;
      if ((m = id.match(/^pitch-(a|b)$/))) { sendCmd('pitch', { deck: m[1], value: el.value }); }
      else if (/^(xfader|master-vol|eqhi-a|eqmid-a|eqlow-a|gain-a|eqhi-b|eqmid-b|eqlow-b|gain-b)$/.test(id)) { sendCmd('mixer', { id, value: el.value }); }
      else if (/^(synth-cutoff|synth-reso|synth-vol|arp-gate)$/.test(id)) { sendCmd('setting', { id, value: el.value }); }
      else return;
      e.stopPropagation();
    }, true);
    document.addEventListener('change', (e) => {
      if (!e.isTrusted) return;
      const el = e.target, id = el.id || '';
      let m;
      if ((m = id.match(/^bpm-(a|b)$/))) { sendCmd('bpmInput', { deck: m[1], value: el.value }); e.stopPropagation(); return; }
      if (/^(synth-wave|synth-root|synth-scale|arp-pattern|arp-rate|arp-octaves|light-pattern)$/.test(id)) {
        if (id !== 'light-pattern') sendCmd('setting', { id, value: el.value });
        e.stopPropagation(); return;
      }
      if (id === 'file-a' || id === 'file-b' || id === 'pad-file') { e.stopPropagation(); flashLinkNote('files live on the host'); }
    }, true);
    // jog nudge: pointer hold -> bend commands
    document.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted) return;
      const m = (e.target.id || '').match(/^nudge-(dn|up)-(a|b)$/);
      if (m) { sendCmd('bend', { deck: m[2], amount: m[1] === 'dn' ? -2.5 : 2.5 }); e.preventDefault(); e.stopPropagation(); }
    }, true);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => document.addEventListener(ev, (e) => {
      if (!e.isTrusted) return;
      const m = (e.target.id || '').match(/^nudge-(dn|up)-(a|b)$/);
      if (m) { sendCmd('bend', { deck: m[2], amount: 0 }); e.stopPropagation(); }
    }, true));
  }
  function flashLinkNote(txt) {
    const el = $id('link-role'); if (!el) return;
    const old = el.textContent; el.textContent = txt;
    setTimeout(() => { el.textContent = old; }, 1800);
  }

  /* ---------------- connection ---------------- */
  function connect() {
    if (typeof Paho === 'undefined') { setTimeout(connect, 1200); return; }
    if (client || connecting) return;
    connecting = true;
    const brokers = brokerList();
    let idx = startIdx; startIdx = 0;
    const tryNext = () => {
      if (client) { connecting = false; return; }
      if (idx >= brokers.length) {
        connecting = false;
        setTimeout(() => { if (!client) connect(); }, 8000);
        return;
      }
      const [host, port, path, ssl] = brokers[idx++];
      curIdx = idx - 1;
      let c;
      try { c = new Paho.MQTT.Client(host, port, path, 'hd-' + ROLE + '-' + pairCode + '-' + linkId); }
      catch (e) { tryNext(); return; }
      let settled = false;
      c.onConnectionLost = () => {
        if (client === c) {
          client = null; connecting = false; peerSeenAt = 0;
          if (presTimer) { clearInterval(presTimer); presTimer = null; }
          setTimeout(() => { if (!client) connect(); }, 2500);
        }
      };
      c.onMessageArrived = (m) => {
        let d; try { d = JSON.parse(m.payloadString); } catch (e) { return; }
        const dest = m.destinationName;
        if (dest.endsWith('/presence/' + linkId)) return;
        if (dest.indexOf('/presence/') >= 0) {
          if (d && d.app && d.id !== linkId) {
            if (d.online && (!d.ts || Date.now() - d.ts < 9000)) {
              peerSeenAt = Date.now(); peerAt = peerSeenAt; peerRole = d.role || '';
              if (d.h) peerHash = d.h;
              shakeCheck();
            } else if (!d.online) { peerSeenAt = 0; peerHash = ''; }
          }
          return;
        }
        if (dest.endsWith('/cmd')) { if (!IS_GUEST) applyCommand(d); return; }
        if (dest.endsWith('/sync')) {
          if (!d || d.from === linkId) return;
          if (d.kind === 'hello') {
            peerSeenAt = Date.now();
            if (!IS_GUEST) { shakeAt = Date.now(); broadcastSnapshot(); }
            else if (gotSnapshot) { shakeAt = Date.now(); }
            return;
          }
          if (IS_GUEST && d.kind === 'ui-state') { applySnapshot(d); return; }
          if (IS_GUEST && d.kind === 'pos') { applyPos(d); return; }
        }
      };
      const will = new Paho.MQTT.Message(JSON.stringify({ app: 1, id: linkId, role: ROLE, online: false }));
      will.destinationName = topic('presence/' + linkId); will.retained = true;
      c.connect({
        useSSL: ssl, timeout: 6, keepAliveInterval: 30, willMessage: will,
        onSuccess: () => {
          settled = true; connecting = false; client = c; brokerName = host; connectedAt = Date.now();
          c.subscribe(topic('sync'));
          c.subscribe(topic('cmd'));
          c.subscribe(topic('presence/+'));
          sendPresence();
          if (presTimer) clearInterval(presTimer);
          presTimer = setInterval(sendPresence, 4000);
          if (IS_GUEST) {
            // keep asking until a snapshot lands — a single QoS-0 hello can vanish
            if (helloTimer) clearInterval(helloTimer);
            helloTimer = setInterval(() => {
              if (gotSnapshot) { clearInterval(helloTimer); helloTimer = null; return; }
              send('sync', { kind: 'hello', from: linkId, role: ROLE });
            }, 3000);
            send('sync', { kind: 'hello', from: linkId, role: ROLE });
          } else {
            broadcastSnapshot();
          }
          renderPairPanel();
        },
        onFailure: () => { if (!settled) tryNext(); },
      });
    };
    tryNext();
  }
  /* rendezvous watcher: if no handshake on this broker, hop to the next
   * (presence alone does NOT pin — retained presence can be a ghost). */
  setInterval(() => {
    if (!client || hopping) return;
    if (shakeAt >= connectedAt && shakeAt > 0) return;
    const fuse = IS_GUEST ? 10000 : 25000;
    if (Date.now() - connectedAt < fuse) return;
    if (!IS_GUEST && shakeAt > 0) return;
    const brokers = brokerList(); if (brokers.length < 2) return;
    startIdx = (curIdx + 1) % brokers.length;
    hopping = true;
    const old = client; client = null; connecting = false;
    if (presTimer) { clearInterval(presTimer); presTimer = null; }
    try { old.disconnect(); } catch (e) {}
    setTimeout(() => { hopping = false; if (!client) connect(); }, 700);
  }, 2500);

  /* ---------------- honesty: pill + parity heal ---------------- */
  function shakeCheck() {
    // peer is live: if our hashes disagree, heal (guest asks, host pushes)
    if (!peerLive()) return;
    if (peerHash && peerHash !== ownHash()) {
      const now = Date.now();
      if (now - healAt > 5000) {
        healAt = now;
        if (IS_GUEST) send('sync', { kind: 'hello', from: linkId, role: ROLE });
        else broadcastSnapshot();
      }
    }
  }
  function pillTick() {
    const pill = $id('link-pill'); if (!pill) return;
    let txt, cls;
    if (!client) { txt = 'LINK…'; cls = 'local'; }
    else if (inSync()) { txt = 'SYNCED'; cls = 'live'; }
    else if (peerLive()) { txt = 'peer live — catching up…'; cls = 'local'; }
    else { txt = IS_GUEST ? 'waiting for desktop…' : 'LOCAL'; cls = 'local'; }
    pill.textContent = txt; pill.className = 'pill ' + cls;
    const role = $id('link-role');
    if (role && IS_GUEST) {
      role.textContent = peerLive() ? 'LINKED — controlling host · ' + pairCode : 'LINKED — waiting for desktop…';
    } else if (role) {
      role.textContent = peerLive() && peerRole === 'guest' ? 'PHONE LINKED · ' + pairCode : 'HOST · ' + pairCode;
    }
    shakeCheck();
    renderPairPanel();
  }
  setInterval(pillTick, 1000);

  /* ---------------- pair panel ---------------- */
  function pairUrl() {
    try {
      const u = new URL(location.href);
      u.search = '?sync=' + pairCode;
      if (params.get('relay')) u.search += '&relay=' + encodeURIComponent(params.get('relay'));
      u.hash = '';
      return u.toString();
    } catch (e) {
      return 'https://joshuagwatts.github.io/holodecks/?sync=' + pairCode;
    }
  }
  let qrDone = false;
  function renderPairPanel() {
    const panel = $id('pair-panel'); if (!panel || panel.classList.contains('off')) return;
    $id('pair-code').textContent = pairCode;
    const url = pairUrl();
    $id('pair-url').textContent = url;
    if (!qrDone && typeof QRCode !== 'undefined') {
      try { new QRCode($id('pair-qr'), { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M }); qrDone = true; } catch (e) {}
    }
    const list = $id('pair-peers');
    if (list) {
      const broker = client ? 'relay: ' + brokerName : 'relay: connecting…';
      const peer = peerLive()
        ? (peerRole || 'peer') + ' — ' + (inSync() ? 'SYNCED' : 'live, catching up…') + ' (seen ' + Math.max(0, Math.round((Date.now() - peerSeenAt) / 1000)) + 's ago)'
        : (IS_GUEST ? 'no host seen yet' : 'no phone yet — open the link or scan the QR');
      list.innerHTML = '';
      [broker, 'this screen: ' + ROLE + ' · ' + linkId, 'peer: ' + peer].forEach((t) => {
        const li = document.createElement('li'); li.textContent = t; list.appendChild(li);
      });
    }
  }
  const pairBtn = $id('pair-btn');
  if (pairBtn) pairBtn.addEventListener('click', () => { $id('pair-panel').classList.remove('off'); qrDone = false; $id('pair-qr').innerHTML = ''; renderPairPanel(); });
  const pairClose = $id('pair-close');
  if (pairClose) pairClose.addEventListener('click', () => $id('pair-panel').classList.add('off'));
  const pairPanel = $id('pair-panel');
  if (pairPanel) pairPanel.addEventListener('click', (e) => { if (e.target === pairPanel) pairPanel.classList.add('off'); });
  const pairCopy = $id('pair-copy');
  if (pairCopy) pairCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pairUrl()); pairCopy.textContent = 'COPIED'; }
    catch (e) { pairCopy.textContent = 'COPY FAILED'; }
    setTimeout(() => { pairCopy.textContent = 'COPY LINK'; }, 1200);
  });

  if (IS_GUEST) document.body.classList.add('guest');

  /* ---------------- unit-testable core (prove.mjs, node) ---------------- */
  window.__HD_SYNC__ = {
    fnv1a, canonicalUI, ownHash,
    dedupe: (mid) => {
      if (seenMids.has(mid)) return true;
      seenMids.add(mid);
      if (seenMids.size > 500) seenMids.delete(seenMids.values().next().value);
      return false;
    },
    IS_GUEST, pairCode, linkId,
    get connected() { return !!client; },
    get broker() { return brokerName; },
    get peerLive() { return peerLive(); },
    get inSync() { return inSync(); },
    get gotSnapshot() { return gotSnapshot; },
    setPeerForTest: (h, agoMs) => { peerHash = h; peerSeenAt = Date.now() - (agoMs || 0); },
    applySnapshotForTest: (m) => applySnapshot(m),
    buildSnapshot,
  };

  connect();
  pillTick();
})();
