/* HoloDecks v1 prove-out: drives every control through the UI path in headless
 * Chromium (same pattern as limbo-test/cue-room suites) and asserts on the
 * window.__HOLODECKS__ handle + the BroadcastChannel sync bus.
 * Serves the app itself on :8931 and boots via a file:// bootstrap page
 * (Chromium 152 local-network rule — see AGENTS.md). */
import { createRequire } from 'module';
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../../limbo-test/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}/`;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.md': 'text/plain', '.png': 'image/png' };

const server = createServer((req, res) => {
  const p = join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
writeFileSync('/tmp/holodecks-bootstrap.html', `<script>location.replace(${JSON.stringify(BASE)})</script>`);

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

console.log('== lighting follows the beat');
const bg1 = await page.evaluate(() => [...document.querySelectorAll('#fixtures .fixture')].map((f) => f.style.background + '|' + f.style.opacity).join(';'));
await page.waitForTimeout(650);
const bg2 = await page.evaluate(() => [...document.querySelectorAll('#fixtures .fixture')].map((f) => f.style.background + '|' + f.style.opacity).join(';'));
check('lighting fixtures change over a beat', bg1 !== bg2);

await page.screenshot({ path: join(ROOT, 'tests', 'prove.png'), fullPage: false });
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL PASS'));
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
