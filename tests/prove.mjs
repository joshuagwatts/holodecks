/* HoloDecks v1 prove-out: drives every control through the UI path in headless
 * Chromium (same pattern as limbo-test/cue-room suites) and asserts on the
 * window.__HOLODECKS__ handle + the BroadcastChannel sync bus.
 * Serves the app itself on :8931 and boots via a file:// bootstrap page
 * (Chromium 152 local-network rule — see AGENTS.md). */
import { createRequire } from 'module';
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../../limbo-test/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}/`;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.md': 'text/plain', '.png': 'image/png' };

const server = createServer((req, res) => {
  const clean = req.url.split('?')[0];
  const p = join(ROOT, clean === '/' ? 'index.html' : clean);
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
writeFileSync('/tmp/holodecks-bootstrap.html', `<script>location.replace(${JSON.stringify(BASE)})</script>`);

/* local MQTT-over-WS relay (aedes from limbo-test node_modules) for the
 * mobile-sync two-page test — same broker pattern HoloMapper tests use. */
const RELAY_PORT = 8932;
const aedes = require('aedes')();
const wsStream = require('websocket-stream');
const relayServer = createServer();
wsStream.createServer({ server: relayServer }, aedes.handle);
await new Promise((r) => relayServer.listen(RELAY_PORT, '127.0.0.1', r));
const RELAY_Q = 'relay=' + encodeURIComponent(`ws://127.0.0.1:${RELAY_PORT}/`);
const bootTo = async (pg, url) => {
  writeFileSync('/tmp/holodecks-bootstrap2.html', `<script>location.replace(${JSON.stringify(url)})</script>`);
  await pg.goto('file:///tmp/holodecks-bootstrap2.html');
  await pg.waitForURL((u) => u.href.startsWith(BASE), { timeout: 20000 });
};

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) fails++;
};

const browser = await chromium.launch({
  executablePath: '/opt/meta-chromium/chrome',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-certificate-errors', '--mute-audio', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 220)); });
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket/i.test(m.text())) console.log('[console]', m.text().slice(0, 180)); });

const H = (fn) => page.evaluate(fn);

console.log('== boot + power on');
await page.goto('file:///tmp/holodecks-bootstrap.html');
await page.waitForURL((u) => u.href.startsWith(BASE), { timeout: 20000 });
await page.waitForFunction(() => !!window.__HOLODECKS__, { timeout: 20000 });
check('debug handle present', true);
await page.evaluate(() => {
  window.__bcStates = [];
  new BroadcastChannel('holodecks-sync').onmessage = (e) => window.__bcStates.push(e.data);
});
await page.click('#power-btn');
await page.waitForFunction(() => window.__HOLODECKS__.ctxState === 'running', { timeout: 10000 });
check('audio context running after power-on', true);
await page.waitForFunction(() => window.__HOLODECKS__.sampler.buffersReady(), { timeout: 20000 });
check('sampler one-shots rendered', true);

console.log('== load demos + play deck A');
await page.click('#demo-a');
await page.waitForFunction(() => window.__HOLODECKS__.decks[0].buffer, { timeout: 30000 });
await page.click('#demo-b');
await page.waitForFunction(() => window.__HOLODECKS__.decks[1].buffer, { timeout: 30000 });
const titles = await H(() => window.__HOLODECKS__.decks.map((d) => d.title + ' @' + d.trackBpm));
check('demo tracks loaded', titles[0].includes('Demo A') && titles[1].includes('Demo B'), titles.join(' | '));
await page.click('#play-a');
await page.waitForTimeout(700);
const pos1 = await H(() => window.__HOLODECKS__.decks[0].position());
await page.waitForTimeout(600);
const pos2 = await H(() => window.__HOLODECKS__.decks[0].position());
check('deck A position advances', pos2 > pos1 + 0.3, pos1.toFixed(2) + ' -> ' + pos2.toFixed(2));
const lvl = await H(() => window.__HOLODECKS__.masterLevel());
check('master analyser level > 0 while playing', lvl > 0.005, 'rms=' + lvl.toFixed(4));

console.log('== pitch + sync');
await page.evaluate(() => {
  const el = document.getElementById('pitch-a');
  el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
const effA = await H(() => window.__HOLODECKS__.decks[0].effBpm);
check('pitch +2% -> effective BPM ~126.48', Math.abs(effA - 126.48) < 0.1, 'effA=' + effA.toFixed(2));
await page.click('#sync-b');
await page.waitForTimeout(200);
const syncInfo = await H(() => ({
  pitchB: window.__HOLODECKS__.decks[1].pitch,
  effB: window.__HOLODECKS__.decks[1].effBpm,
  isSync: window.__HOLODECKS__.decks[1].isSync,
}));
check('SYNC B matches A effective BPM', Math.abs(syncInfo.effB - effA) < 0.15, 'effB=' + syncInfo.effB.toFixed(2) + ' pitchB=' + syncInfo.pitchB.toFixed(2));
check('deck B isSync flag set', syncInfo.isSync === true);

console.log('== play B + crossfade + EQ');
await page.click('#play-b');
await page.waitForTimeout(400);
const bothPlaying = await H(() => window.__HOLODECKS__.decks.every((d) => d.playing));
check('both decks playing', bothPlaying);
await page.evaluate(() => {
  const el = document.getElementById('xfader');
  el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
const xf = await H(() => ({
  a: window.__HOLODECKS__.decks[0].crossGain.gain.value,
  b: window.__HOLODECKS__.decks[1].crossGain.gain.value,
  onAirB: window.__HOLODECKS__.decks[1].onAir(),
}));
check('crossfader full-A: A gain ~1, B gain ~0, B off-air', xf.a > 0.99 && xf.b < 0.01 && xf.onAirB === false, JSON.stringify(xf));
await page.evaluate(() => {
  const el = document.getElementById('xfader');
  el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true }));
  const eq = document.getElementById('eqhi-a');
  eq.value = '9'; eq.dispatchEvent(new Event('input', { bubbles: true }));
});
const eqVal = await H(() => window.__HOLODECKS__.decks[0].eqHigh.gain.value);
check('EQ HI on A applies (+9 dB)', eqVal === 9, 'gain=' + eqVal);

console.log('== hot cue + loop');
await page.evaluate(() => document.querySelector('#hotcues-a button[data-cue="0"]').click());
await page.waitForTimeout(120);
await page.evaluate(() => window.__HOLODECKS__.decks[0].seek(10));
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('#hotcues-a button[data-cue="0"]').click());
await page.waitForTimeout(150);
const cuePos = await H(() => window.__HOLODECKS__.decks[0].position());
const cuePoint = await H(() => window.__HOLODECKS__.decks[0].cuePoint);
const hot0 = await H(() => window.__HOLODECKS__.decks[0].hotCues[0]);
check('hot cue 1 set then jump returns near it', hot0 != null && Math.abs(cuePos - hot0) < 1.2, 'hot=' + hot0.toFixed(2) + ' pos=' + cuePos.toFixed(2));
await page.click('#loop4-a');
await page.waitForTimeout(200);
const loopState = await H(() => ({
  loop: window.__HOLODECKS__.decks[0].loop,
  playState: window.__HOLODECKS__.getSyncState().decks[0].playState,
}));
check('LOOP 4 active and SyncState says Looping', !!loopState.loop && loopState.loop.beats === 4 && loopState.playState === 'Looping', JSON.stringify(loopState.playState));
await page.click('#loopoff-a');

console.log('== sampler: quantize off + on');
await page.click('#quantize-btn'); // -> OFF
const t0 = await H(() => window.__HOLODECKS__.sampler.triggers);
await page.click('.pad[data-pad="0"]');
await page.waitForTimeout(120);
const t1 = await H(() => window.__HOLODECKS__.sampler.triggers);
check('pad fires immediately with quantize OFF', t1 === t0 + 1, t0 + ' -> ' + t1);
await page.click('#quantize-btn'); // -> ON
await page.click('.pad[data-pad="3"]');
await page.waitForFunction((prev) => window.__HOLODECKS__.sampler.triggers > prev, t1, { timeout: 2500 });
const t2 = await H(() => window.__HOLODECKS__.sampler.triggers);
check('pad fires on next beat with quantize ON', t2 === t1 + 1, t1 + ' -> ' + t2);

console.log('== sequencer');
const notes0 = await H(() => window.__HOLODECKS__.seq.notesScheduled);
await page.click('#seq-play');
await page.waitForTimeout(1600);
const seqInfo = await H(() => ({
  playing: window.__HOLODECKS__.seq.playing,
  step: window.__HOLODECKS__.seq.step,
  notes: window.__HOLODECKS__.seq.notesScheduled,
}));
check('sequencer running', seqInfo.playing === true);
check('sequencer notes being scheduled', seqInfo.notes > notes0 + 3, 'notes ' + notes0 + ' -> ' + seqInfo.notes);
const stepA = await H(() => window.__HOLODECKS__.seq.absStep);
await page.waitForTimeout(700);
const stepB = await H(() => window.__HOLODECKS__.seq.absStep);
check('sequencer step advances', stepB > stepA, stepA + ' -> ' + stepB);

console.log('== arpeggiator');
await page.evaluate(() => { window.__HOLODECKS__.seq.notesLog.length = 0; });
await page.click('#arp-btn');
await page.waitForTimeout(2200);
const arpNotes = await H(() => window.__HOLODECKS__.seq.notesLog.filter((n) => n.source === 'arp').map((n) => n.midi));
check('arp produces notes', arpNotes.length >= 6, 'count=' + arpNotes.length);
const distinct = [...new Set(arpNotes)];
check('arp notes vary across chord tones', distinct.length >= 3, 'distinct=' + distinct.join(','));
let ascRun = 0, bestRun = 0;
for (let i = 1; i < arpNotes.length; i++) { ascRun = arpNotes[i] > arpNotes[i - 1] ? ascRun + 1 : 0; bestRun = Math.max(bestRun, ascRun); }
check('arp UP pattern has ascending runs', bestRun >= 2, 'bestRun=' + bestRun + ' seq=' + arpNotes.slice(0, 14).join(','));
await page.click('#arp-btn');
await page.click('#seq-play'); // stop seq

console.log('== sync bus');
await page.waitForTimeout(400);
const bcInfo = await H(() => ({
  count: window.__bcStates.length,
  last: window.__bcStates[window.__bcStates.length - 1],
  win: window.__HOLODECKS_SYNC__,
}));
check('BroadcastChannel received SyncState frames', bcInfo.count > 2, 'frames=' + bcInfo.count);
const s = bcInfo.last;
check('SyncState shape: mode live + devices', s && s.mode === 'live' && JSON.stringify(s.devices) === JSON.stringify(['HoloDeck 1', 'HoloDeck 2']));
check('SyncState decks are deviceId 11/12', s && s.decks[0].deviceId === 11 && s.decks[1].deviceId === 12);
check('SyncState masterBpm follows playing decks', s && s.masterBpm > 120 && s.masterBpm < 130, 'masterBpm=' + (s && s.masterBpm));
check('SyncState master deck flagged + waveform present', s && s.decks.some((d) => d.isMaster) && s.decks[0].waveform.length === 120);
check('window.__HOLODECKS_SYNC__ matches', !!bcInfo.win && bcInfo.win.timestamp >= s.timestamp - 1000);
const seq1 = await H(() => window.__HOLODECKS__.getSyncState().trackChangeSeq);
check('trackChangeSeq counted the master load', seq1 >= 1, 'seq=' + seq1);

console.log('== synthetic track builder (in-page)');
await page.evaluate(() => {
  const actx = new AudioContext();
  window.__testCtx = actx;
  const seeded = () => { let s = 22222; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; }; };
  // 4-on-the-floor pattern at a known BPM: kick chirp, backbeat noise, offbeat hats, offbeat bass.
  window.__synthTrack = (bpm, seconds, opts = {}) => {
    const sr = actx.sampleRate;
    const lead = opts.lead || 0;
    const buf = actx.createBuffer(2, Math.ceil(sr * seconds), sr);
    const chans = [buf.getChannelData(0), buf.getChannelData(1)];
    const rand = seeded();
    const spb = 60 / bpm;
    const put = (t0, dur, fn, amp) => {
      const s0 = Math.floor(t0 * sr);
      for (let i = 0; i < Math.floor(sr * dur); i++) {
        const idx = s0 + i; if (idx >= chans[0].length) break;
        const v = fn(i / sr, i) * amp;
        chans[0][idx] += v; chans[1][idx] += v * 0.97;
      }
    };
    const L = Math.log(160 / 42);
    const kickFn = (t) => Math.sin(2 * Math.PI * (42 * t + (160 - 42) * (0.11 / L) * (1 - Math.exp(-t * L / 0.11)))) * Math.pow(0.001, t / 0.26);
    for (let beat = 0; lead + beat * spb < seconds; beat++) {
      const t = lead + beat * spb;
      put(t, 0.28, kickFn, 0.95);
      if (beat % 4 === 1 || beat % 4 === 3) put(t, 0.15, (tt) => rand() * Math.exp(-tt * 30), 0.35);
      for (let e = 0; e < 2; e++) put(t + e * spb / 2, 0.06, (tt) => rand() * Math.exp(-tt * 55), e === 1 ? 0.20 : 0.11);
      if (beat % 2 === 0) put(t + spb * 0.5, spb * 0.4, (tt) => Math.sin(2 * Math.PI * 55 * tt) * Math.exp(-tt * 4), 0.30);
    }
    return buf;
  };
  // One bar of dense pattern, tiled at exact per-bar target RMS levels.
  window.__synthSections = (bpm, plan) => { // plan: [[bars, rms], ...]
    const sr = actx.sampleRate;
    const spb = 60 / bpm, barSec = 4 * spb;
    const totalBars = plan.reduce((a, p) => a + p[0], 0);
    const buf = actx.createBuffer(2, Math.ceil(sr * barSec * totalBars), sr);
    const chans = [buf.getChannelData(0), buf.getChannelData(1)];
    const rand = seeded();
    const barLen = Math.floor(sr * barSec);
    const one = new Float32Array(barLen);
    const L = Math.log(160 / 42);
    const kickFn = (t) => Math.sin(2 * Math.PI * (42 * t + (160 - 42) * (0.11 / L) * (1 - Math.exp(-t * L / 0.11)))) * Math.pow(0.001, t / 0.26);
    for (let beat = 0; beat < 4; beat++) {
      const s0 = Math.floor(beat * spb * sr);
      for (let i = 0; i < sr * 0.28 && s0 + i < barLen; i++) one[s0 + i] += kickFn(i / sr) * 0.9;
      for (let e = 0; e < 2; e++) {
        const hs = Math.floor((beat * spb + e * spb / 2) * sr);
        for (let i = 0; i < sr * 0.05 && hs + i < barLen; i++) one[hs + i] += rand() * 0.25 * Math.exp(-(i / sr) * 50);
      }
      const bs = Math.floor((beat * spb + spb * 0.5) * sr);
      for (let i = 0; i < sr * spb * 0.4 && bs + i < barLen; i++) one[bs + i] += Math.sin(2 * Math.PI * 55 * (i / sr)) * 0.35;
      for (let i = 0; i < barLen; i++) { /* sustained bed keeps RMS dense */ }
    }
    for (let i = 0; i < barLen; i++) one[i] += Math.sin(2 * Math.PI * 110 * (i / sr)) * 0.22;
    let sq = 0; for (let i = 0; i < barLen; i++) sq += one[i] * one[i];
    const baseRms = Math.sqrt(sq / barLen);
    let bar = 0;
    for (const [bars, rms] of plan) {
      const g = rms / baseRms;
      for (let b = 0; b < bars; b++, bar++) {
        const off = bar * barLen;
        for (let i = 0; i < barLen && off + i < chans[0].length; i++) {
          chans[0][off + i] = one[i] * g; chans[1][off + i] = one[i] * g * 0.97;
        }
      }
    }
    return buf;
  };
});
check('synth builders ready', await H(() => typeof window.__synthTrack === 'function' && typeof window.__synthSections === 'function'));

console.log('== BPM detector: synthetic known tempos');
const bpmTable = await page.evaluate(async () => {
  const out = [];
  for (const bpm of [100, 122, 128, 138, 145, 160]) {
    const buf = window.__synthTrack(bpm, 32);
    const t0 = performance.now();
    const det = window.__HOLODECKS__.detectBPM(buf);
    out.push({ true: bpm, det: det.bpm, raw: det.rawBpm, conf: det.confidence, ms: Math.round(performance.now() - t0) });
  }
  return out;
});
for (const r of bpmTable) {
  console.log('  BPM true ' + r.true + ' -> detected ' + r.det + ' (raw ' + r.raw + ', conf ' + r.conf + ', ' + r.ms + 'ms)');
  const tol = (r.true === 122 || r.true === 128 || r.true === 138) ? 0.5 : 1.0;
  check('detect ' + r.true + ' BPM within ±' + tol, Math.abs(r.det - r.true) <= tol, 'det=' + r.det);
}
check('half/double trap: 140 stays 140 (not 70/280)', await page.evaluate(() => {
  const det = window.__HOLODECKS__.detectBPM(window.__synthTrack(140, 32));
  return Math.abs(det.bpm - 140) <= 1;
}));
check('half/double trap: 100 stays 100 (not 200)', await page.evaluate(() => {
  const det = window.__HOLODECKS__.detectBPM(window.__synthTrack(100, 32));
  return Math.abs(det.bpm - 100) <= 1 && det.bpm < 150;
}));

console.log('== BPM detector: first-beat offset');
const offRes = await page.evaluate(() => {
  const det = window.__HOLODECKS__.detectBPM(window.__synthTrack(128, 32, { lead: 0.40 }));
  return det;
});
check('offset 0.40s @128 detected within ±0.06', Math.abs(offRes.beatOffsetSec - 0.40) <= 0.06,
  'bpm=' + offRes.bpm + ' offset=' + offRes.beatOffsetSec);

console.log('== UI integration: analyzeAndLoad');
const uiRes = await page.evaluate(async () => {
  const buf = window.__synthTrack(128, 32, { lead: 0.40 });
  const det = await window.__HOLODECKS__.analyzeAndLoad('a', buf, 'Synth 128 Offset');
  const deck = window.__HOLODECKS__.decks[0];
  deck.seek(deck.beatOffsetSec + 2 * (60 / deck.trackBpm)); // exactly 2 beats in
  const st = window.__HOLODECKS__.getSyncState().decks[0];
  return {
    detBpm: det && det.bpm, trackBpm: deck.trackBpm,
    inputVal: parseFloat(document.getElementById('bpm-a').value),
    badge: document.getElementById('bpmbadge-a').textContent,
    badgeClass: document.getElementById('bpmbadge-a').className,
    offset: deck.beatOffsetSec, stateBeat: st.beat, stateOffset: st.beatOffsetSec,
  };
});
check('analyzeAndLoad detects 128 (±1)', Math.abs(uiRes.trackBpm - 128) <= 1, 'trackBpm=' + uiRes.trackBpm + ' det=' + uiRes.detBpm);
check('bpm input shows detected value', Math.abs(uiRes.inputVal - uiRes.trackBpm) < 0.011, 'input=' + uiRes.inputVal);
check('AUTO badge visible', /^AUTO/.test(uiRes.badge) && /auto/.test(uiRes.badgeClass), uiRes.badge + ' / ' + uiRes.badgeClass);
check('SyncState beat aligned to offset (beat≈2)', Math.abs(uiRes.stateBeat - 2) <= 0.06 && Math.abs(uiRes.stateOffset - 0.40) <= 0.06,
  'beat=' + uiRes.stateBeat + ' off=' + uiRes.stateOffset);

console.log('== manual BPM fixes');
await page.click('#bpmdouble-a');
let bpmNow = await H(() => window.__HOLODECKS__.decks[0].trackBpm);
check('×2 doubles BPM', Math.abs(bpmNow - uiRes.trackBpm * 2) < 0.05, 'bpm=' + bpmNow);
await page.click('#bpmhalf-a');
bpmNow = await H(() => window.__HOLODECKS__.decks[0].trackBpm);
check('½ halves BPM back', Math.abs(bpmNow - uiRes.trackBpm) < 0.05, 'bpm=' + bpmNow);
const badgeAfterManual = await H(() => document.getElementById('bpmbadge-a').textContent);
check('manual change clears AUTO badge to MANUAL', badgeAfterManual === 'MANUAL', badgeAfterManual);
await page.click('#bpmplus-a');
bpmNow = await H(() => window.__HOLODECKS__.decks[0].trackBpm);
check('+ fine adjust adds 0.1', Math.abs(bpmNow - (uiRes.trackBpm + 0.1)) < 0.011, 'bpm=' + bpmNow);
await page.click('#bpmminus-a');
// TAP at 120 cadence on deck B (500ms intervals). Driven via CDP raw input:
// Playwright's page.click adds ~270ms of actionability overhead per click in
// this sandbox, which would corrupt the cadence — CDP mouse events are real
// trusted input with no such lag (and the handler uses e.timeStamp).
{
  const box = await page.locator('#tap-b').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (let i = 0; i < 5; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    if (i < 4) await page.waitForTimeout(480); // 480 + ~15-20ms observed CDP/node overhead ≈ true 500ms cadence
  }
  await cdp.detach();
}
const tapBpm = await H(() => window.__HOLODECKS__.decks[1].trackBpm);
check('TAP x5 at 120 cadence sets ~120 (±3)', Math.abs(tapBpm - 120) <= 3, 'tapBpm=' + tapBpm);

console.log('== detector perf: 5-min stereo buffer');
const perf = await page.evaluate(() => {
  const buf = window.__synthTrack(128, 300);
  const t0 = performance.now();
  const det = window.__HOLODECKS__.detectBPM(buf);
  const detectMs = performance.now() - t0;
  const t1 = performance.now();
  const rms = window.__HOLODECKS__.analyzeSections(buf, 128, 0);
  const rmsMs = performance.now() - t1;
  window.__bigBuffer = buf;
  return { det, detectMs: Math.round(detectMs), rmsMs: Math.round(rmsMs), rmsSections: rms.sections.length, bars: rms.barRms.length };
});
console.log('  detect 5-min: ' + perf.detectMs + 'ms -> ' + perf.det.bpm + ' BPM | analyzeSections: ' + perf.rmsMs + 'ms, ' + perf.bars + ' bars');
check('detect 5-min < 4000ms', perf.detectMs < 4000, perf.detectMs + 'ms');
check('detect 5-min still finds 128', Math.abs(perf.det.bpm - 128) <= 1, 'bpm=' + perf.det.bpm);

console.log('== RMS sections: synthetic 16/32/16');
const rmsRes = await page.evaluate(() => {
  const buf = window.__synthSections(128, [[16, 0.25], [32, 0.80], [16, 0.25]]);
  const t0 = performance.now();
  const r = window.__HOLODECKS__.analyzeSections(buf, 128, 0);
  return { sections: r.sections, ms: Math.round(performance.now() - t0), bars: r.barRms.length };
});
console.log('  sections: ' + rmsRes.sections.map((s) => s.startBar + '+' + s.lengthBars + 'bars rms=' + s.meanRms + ' energy=' + s.energy).join(' | ') + ' (' + rmsRes.ms + 'ms)');
check('RMS finds 3 sections (±1)', rmsRes.sections.length >= 2 && rmsRes.sections.length <= 4, 'count=' + rmsRes.sections.length);
if (rmsRes.sections.length === 3) {
  const lens = rmsRes.sections.map((s) => s.lengthBars);
  check('RMS section lengths ≈16/32/16 (±2)', Math.abs(lens[0] - 16) <= 2 && Math.abs(lens[1] - 32) <= 2 && Math.abs(lens[2] - 16) <= 2, lens.join('/'));
  check('RMS energy ordering quiet<loud', rmsRes.sections[0].energy < rmsRes.sections[1].energy && rmsRes.sections[2].energy < rmsRes.sections[1].energy,
    rmsRes.sections.map((s) => s.energy).join(' < '));
} else {
  check('RMS section lengths ≈16/32/16 (±2)', false, 'sections=' + rmsRes.sections.length);
  check('RMS energy ordering quiet<loud', false, 'n/a');
}
const rmsUniform = await page.evaluate(() => {
  const buf = window.__synthTrack(128, 48);
  return window.__HOLODECKS__.analyzeSections(buf, 128, 0).sections;
});
check('RMS uniform track = 1 section (no false boundaries)', rmsUniform.length === 1, 'count=' + rmsUniform.length + ' len=' + (rmsUniform[0] && rmsUniform[0].lengthBars));

console.log('== RMS live crossing -> rmsTransitionSeq');
const crossSetup = await page.evaluate(async () => {
  const buf = window.__synthSections(128, [[16, 0.25], [32, 0.80], [16, 0.25]]);
  await window.__HOLODECKS__.analyzeAndLoad('a', buf, 'Section Track');
  const st = window.__HOLODECKS__.getSyncState();
  const d = st.decks[0];
  return {
    bpm: d.track ? d.track.bpm : null,
    sections: d.track ? d.track.sections : [],
    seq0: window.__HOLODECKS__.latestSync() ? window.__HOLODECKS__.latestSync().rmsTransitionSeq : st.rmsTransitionSeq,
  };
});
console.log('  deck sections: ' + (crossSetup.sections || []).map((s) => s.lengthBars + ' bars @' + s.meanRms).join(' | ') + ' bpm=' + crossSetup.bpm);
check('deck carries RMS sections in SyncState track', !!crossSetup.sections && crossSetup.sections.length >= 2 && crossSetup.sections.length <= 4,
  'count=' + (crossSetup.sections || []).length);
if (crossSetup.sections && crossSetup.sections.length >= 2) {
  const boundarySec = crossSetup.sections[1].startSec;
  const barDur = 240 / crossSetup.bpm;
  await page.evaluate((pos) => window.__HOLODECKS__.decks[0].seek(pos), Math.max(0, boundarySec - barDur));
  await page.waitForTimeout(150);
  const seqBefore = await H(() => window.__HOLODECKS__.getSyncState().rmsTransitionSeq);
  await page.click('#play-a');
  let crossed = true;
  try {
    await page.waitForFunction((s0) => {
      const s = window.__HOLODECKS_SYNC__;
      return s && s.decks[0].sectionIndex === 1 && s.rmsTransitionSeq > s0;
    }, seqBefore, { timeout: Math.ceil(barDur * 1000) + 6000 });
  } catch (e) { crossed = false; }
  const crossState = await H(() => ({
    seq: window.__HOLODECKS_SYNC__.rmsTransitionSeq,
    secIdx: window.__HOLODECKS_SYNC__.decks[0].sectionIndex,
    barIn: window.__HOLODECKS_SYNC__.decks[0].barInSection,
    barsToNext: window.__HOLODECKS_SYNC__.decks[0].barsToNextSection,
    panel: document.getElementById('so-rms').textContent,
  }));
  check('live crossing increments rmsTransitionSeq + sectionIndex advances', crossed,
    'seq ' + seqBefore + ' -> ' + crossState.seq + ', secIdx=' + crossState.secIdx);
  check('SYNC OUT panel shows RMS section line', /RMS SECTION 2\//.test(crossState.panel), crossState.panel);
  await page.click('#play-a'); // pause A
} else {
  check('live crossing increments rmsTransitionSeq + sectionIndex advances', false, 'no sections on deck');
  check('SYNC OUT panel shows RMS section line', false, 'no sections on deck');
}

console.log('== lighting follows the beat');
const bg1 = await page.evaluate(() => [...document.querySelectorAll('#fixtures .fixture')].map((f) => f.style.background + '|' + f.style.opacity).join(';'));
await page.waitForTimeout(650);
const bg2 = await page.evaluate(() => [...document.querySelectorAll('#fixtures .fixture')].map((f) => f.style.background + '|' + f.style.opacity).join(';'));
check('lighting fixtures change over a beat', bg1 !== bg2);

console.log('== mobile sync: host + guest over local MQTT relay');
const syncErrors = [];
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const hostPage = await hostCtx.newPage();
hostPage.on('pageerror', (e) => { syncErrors.push('host: ' + String(e)); console.log('[host pageerror]', String(e).slice(0, 200)); });
const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const guestPage = await guestCtx.newPage();
guestPage.on('pageerror', (e) => { syncErrors.push('guest: ' + String(e)); console.log('[guest pageerror]', String(e).slice(0, 200)); });

await bootTo(hostPage, BASE + '?' + RELAY_Q);
await hostPage.waitForFunction(() => !!window.__HD_SYNC__, { timeout: 20000 });
await hostPage.click('#power-btn');
await hostPage.waitForFunction(() => window.__HD_SYNC__.connected, { timeout: 25000 });
const pairCode = await hostPage.evaluate(() => window.__HD_SYNC__.pairCode);
check('host connected to local relay + has pair code', /^[A-Z0-9]{6}$/.test(pairCode), 'code=' + pairCode + ' broker=' + (await hostPage.evaluate(() => window.__HD_SYNC__.broker)));

await bootTo(guestPage, BASE + '?sync=' + pairCode + '&' + RELAY_Q);
await guestPage.waitForFunction(() => !!window.__HD_SYNC__ && window.__HD_SYNC__.IS_GUEST, { timeout: 20000 });
await guestPage.click('#power-btn');
let guestGotSnap = true;
try {
  await guestPage.waitForFunction(() => window.__HD_SYNC__.gotSnapshot, { timeout: 30000 });
} catch (e) { guestGotSnap = false; }
check('guest received host snapshot', guestGotSnap);

await hostPage.click('#demo-a');
await hostPage.waitForFunction(() => window.__HOLODECKS__.decks[0].buffer, { timeout: 30000 });
const hostTitle = await hostPage.evaluate(() => window.__HOLODECKS__.decks[0].title);
let guestTitle = '';
try {
  await guestPage.waitForFunction((t) => window.__HOLODECKS__.decks[0].title === t, hostTitle, { timeout: 30000 });
  guestTitle = hostTitle;
} catch (e) {
  guestTitle = await guestPage.evaluate(() => window.__HOLODECKS__.decks[0].title);
}
check('guest sees host track title after demo load', guestTitle === hostTitle, 'guest="' + guestTitle + '" host="' + hostTitle + '"');
const guestRole = await guestPage.evaluate(() => document.getElementById('link-role').textContent);
check('guest header labels it as linked control surface', /LINKED/.test(guestRole), guestRole);

console.log('== mobile sync: guest PLAY drives host');
await guestPage.click('#play-a');
let hostPlaying = true;
try {
  await hostPage.waitForFunction(() => window.__HOLODECKS__.decks[0].playing, { timeout: 15000 });
} catch (e) { hostPlaying = false; }
check('guest PLAY starts host deck', hostPlaying);
const hPos1 = await hostPage.evaluate(() => window.__HOLODECKS__.decks[0].position());
await hostPage.waitForTimeout(700);
const hPos2 = await hostPage.evaluate(() => window.__HOLODECKS__.decks[0].position());
check('host position advances after guest PLAY', hPos2 > hPos1 + 0.3, hPos1.toFixed(2) + ' -> ' + hPos2.toFixed(2));
const hostLvl = await hostPage.evaluate(() => window.__HOLODECKS__.masterLevel());
check('host analyser > 0 (real audio on host)', hostLvl > 0.003, 'rms=' + hostLvl.toFixed(4));

console.log('== mobile sync: host crossfader reflects on guest');
await hostPage.evaluate(() => {
  const el = document.getElementById('xfader');
  el.value = '0.15'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
let xfGuest = null;
try {
  await guestPage.waitForFunction(() => Math.abs(parseFloat(document.getElementById('xfader').value) - 0.15) < 0.001, { timeout: 20000 });
  xfGuest = 0.15;
} catch (e) {
  xfGuest = await guestPage.evaluate(() => parseFloat(document.getElementById('xfader').value));
}
check('guest crossfader follows host', xfGuest === 0.15, 'guest xf=' + xfGuest);

console.log('== mobile sync: honesty (hash parity -> SYNCED)');
let syncedBoth = true;
try {
  await hostPage.waitForFunction(() => window.__HD_SYNC__.inSync, { timeout: 30000 });
  await guestPage.waitForFunction(() => window.__HD_SYNC__.inSync, { timeout: 30000 });
  // pill text refreshes on a 1s tick — wait for the text itself, not the flag
  await hostPage.waitForFunction(() => document.getElementById('link-pill').textContent === 'SYNCED', { timeout: 15000 });
  await guestPage.waitForFunction(() => document.getElementById('link-pill').textContent === 'SYNCED', { timeout: 15000 });
} catch (e) { syncedBoth = false; }
const pillInfo = {
  host: await hostPage.evaluate(() => document.getElementById('link-pill').textContent + '|' + window.__HD_SYNC__.ownHash()),
  guest: await guestPage.evaluate(() => document.getElementById('link-pill').textContent + '|' + window.__HD_SYNC__.ownHash()),
};
check('both pills reach SYNCED with matching hash', syncedBoth && /SYNCED/.test(pillInfo.host) && /SYNCED/.test(pillInfo.guest) && pillInfo.host.split('|')[1] === pillInfo.guest.split('|')[1],
  'host=' + pillInfo.host + ' guest=' + pillInfo.guest);

await guestPage.screenshot({ path: join(ROOT, 'tests', 'prove-mobile.png'), fullPage: false });

console.log('== mobile sync: unit checks (hash / dedupe / LWW)');
const unit = await guestPage.evaluate(() => {
  const S = window.__HD_SYNC__;
  const h1 = S.fnv1a('holodecks'), h2 = S.fnv1a('holodecks'), h3 = S.fnv1a('holodecks!');
  const d1 = S.dedupe('unit-mid-1'), d2 = S.dedupe('unit-mid-1');
  return { hashStable: h1 === h2, hashDiffers: h1 !== h3, dedupeFirst: d1 === false, dedupeSecond: d2 === true };
});
check('FNV-1a hash stable + input-sensitive', unit.hashStable && unit.hashDiffers);
check('command mid dedupe works', unit.dedupeFirst && unit.dedupeSecond);
const lww = await guestPage.evaluate(() => {
  const S = window.__HD_SYNC__;
  const snap = (seq, title) => ({
    kind: 'ui-state', from: 'test-host', seq, ts: Date.now(),
    canonical: S.buildSnapshot().canonical,
    decks: [{ key: 'a', title, artist: 'T', hasTrack: false, durationSec: 0, trackBpm: 128, beatOffsetSec: 0, bpmSource: 'manual', playing: false, positionSec: 0, pitch: 0, isSync: false, masterFlag: false, cuePoint: 0, hotCues: [null, null, null, null], loop: null, peaks: [], sections: [], barRms: [] }],
  });
  S.applySnapshotForTest(snap(900001, 'LWW NEWER'));
  const afterNew = window.__HOLODECKS__.decks[0].title;
  S.applySnapshotForTest(snap(900000, 'LWW STALE'));
  const afterStale = window.__HOLODECKS__.decks[0].title;
  return { afterNew, afterStale };
});
check('snapshot LWW: stale seq dropped', lww.afterNew === 'LWW NEWER' && lww.afterStale === 'LWW NEWER', JSON.stringify(lww));

check('no page errors on host/guest pages', syncErrors.length === 0, syncErrors.slice(0, 2).join(' | '));

console.log('== mobile sync: host dies -> guest pill drops SYNCED');
await hostPage.close();
await hostCtx.close();
let droppedSync = true;
try {
  await guestPage.waitForFunction(() => !window.__HD_SYNC__.inSync && !window.__HD_SYNC__.peerLive, { timeout: 15000 });
  await guestPage.waitForFunction(() => document.getElementById('link-pill').textContent !== 'SYNCED', { timeout: 12000 });
} catch (e) { droppedSync = false; }
const guestPillAfter = await guestPage.evaluate(() => document.getElementById('link-pill').textContent);
check('guest pill drops SYNCED within ~10s of host death', droppedSync, 'pill="' + guestPillAfter + '"');
await guestPage.close();
await guestCtx.close();

await page.screenshot({ path: join(ROOT, 'tests', 'prove.png'), fullPage: false });
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL PASS'));
await browser.close();
server.close();
relayServer.close();
try { aedes.close(() => {}); } catch (e) {}
process.exit(fails ? 1 : 0);
