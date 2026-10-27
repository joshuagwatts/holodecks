'use strict';
/* HoloDecks RMS section analysis — for HoloMapper "RMS Transitions".
 * Given a decoded buffer + known BPM + first-beat offset, computes the RMS of
 * every bar (4 beats, starting at beatOffsetSec), then finds the track's real
 * sections: sustained level changes, snapped to bar lines. Section lengths are
 * whatever the track actually does (16/24/32/48/64…) — never forced to a
 * power of two.
 *
 * Method: per-bar RMS from one downmix pass (per-bar sum of squares — cheap).
 * Bar RMS is smoothed with a rolling median (5 bars), then candidate
 * boundaries are bars where |mean dB of previous ~8 bars − next ~8 bars|
 * exceeds 4 dB; candidates must be a local maximum of that delta (±5 bars)
 * and are accepted strongest-first with ≥8 bars between boundaries. Sections
 * shorter than 4 bars are merged into a neighbour, and adjacent sections
 * whose means differ by <4 dB are merged. Energy is each section's mean RMS
 * normalised to the loudest section (0..1). */
window.RmsAnalyze = (() => {
  const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-5));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  function analyzeSections(buffer, bpm, beatOffsetSec) {
    if (!buffer || !bpm || bpm <= 0) return { barRms: [], barDb: [], sections: [] };
    const sr = buffer.sampleRate;
    const nCh = Math.max(1, buffer.numberOfChannels || 1);
    const channels = [];
    for (let c = 0; c < nCh; c++) channels.push(buffer.getChannelData(c));

    const barDurSec = (4 * 60) / bpm;
    const offset = Math.max(0, beatOffsetSec || 0);
    const startSample = Math.floor(offset * sr);
    const barSamples = barDurSec * sr;
    const nBars = Math.max(0, Math.floor((buffer.length - startSample) / barSamples));
    if (nBars < 1) {
      // shorter than one bar: still report one section over what exists
      let sum = 0, cnt = 0;
      for (let i = startSample; i < buffer.length; i += 7) {
        let x = 0; for (let c = 0; c < nCh; c++) x += channels[c][i];
        x /= nCh; sum += x * x; cnt++;
      }
      const rms = Math.sqrt(cnt ? sum / cnt : 0);
      return {
        barRms: [rms], barDb: [toDb(rms)],
        sections: [{ startBar: 0, lengthBars: 1, meanRms: +rms.toFixed(4), meanDb: +toDb(rms).toFixed(1), energy: 1, startSec: +offset.toFixed(3) }],
      };
    }

    /* ---- per-bar sum of squares in one pass ---- */
    const sums = new Float64Array(nBars);
    const counts = new Float64Array(nBars);
    const invCh = 1 / nCh;
    for (let bar = 0; bar < nBars; bar++) {
      const s0 = Math.floor(startSample + bar * barSamples);
      const s1 = Math.min(buffer.length, Math.floor(startSample + (bar + 1) * barSamples));
      let sum = 0;
      if (nCh === 2) {
        const a = channels[0], b = channels[1];
        for (let i = s0; i < s1; i++) { const x = (a[i] + b[i]) * 0.5; sum += x * x; }
      } else if (nCh === 1) {
        const a = channels[0];
        for (let i = s0; i < s1; i++) sum += a[i] * a[i];
      } else {
        for (let i = s0; i < s1; i++) {
          let x = 0; for (let c = 0; c < nCh; c++) x += channels[c][i];
          x *= invCh; sum += x * x;
        }
      }
      sums[bar] = sum; counts[bar] = Math.max(1, s1 - s0);
    }
    const barRms = Array.from(sums, (s, i) => Math.sqrt(s / counts[i]));
    const barDb = barRms.map(toDb);

    /* ---- rolling median (5 bars) for boundary detection ---- */
    const smDb = barRms.map((_, i) => {
      const w = [];
      for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < nBars) w.push(barRms[j]);
      w.sort((a, b) => a - b);
      return toDb(w[Math.floor(w.length / 2)]);
    });

    /* ---- candidate boundaries: sustained delta > 4 dB, local max ±5 bars ---- */
    const deltas = new Map();
    for (let b = 4; b <= nBars - 4; b++) {
      const prev = smDb.slice(Math.max(0, b - 8), b);
      const next = smDb.slice(b, Math.min(nBars, b + 8));
      if (prev.length < 2 || next.length < 2) continue;
      const d = Math.abs(mean(next) - mean(prev));
      if (d > 4) deltas.set(b, d);
    }
    const cands = [...deltas.entries()]
      .filter(([b, d]) => {
        for (let j = b - 5; j <= b + 5; j++) {
          if (j !== b && deltas.has(j) && deltas.get(j) > d) return false;
        }
        return true;
      })
      .map(([b, d]) => ({ b, d }))
      .sort((a, b) => b.d - a.d);
    const bounds = [];
    for (const c of cands) {
      if (bounds.every((x) => Math.abs(x - c.b) >= 8)) bounds.push(c.b);
    }
    bounds.sort((a, b) => a - b);

    /* ---- build sections, merge short (<4) then weak (<4 dB) neighbours ---- */
    const edges = [0, ...bounds, nBars];
    let sections = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const startBar = edges[i], lengthBars = edges[i + 1] - edges[i];
      const m = mean(barRms.slice(startBar, startBar + lengthBars));
      sections.push({ startBar, lengthBars, meanRms: m });
    }
    if (sections.length > 1 && sections[sections.length - 1].lengthBars < 4) {
      const last = sections.pop(), prev = sections[sections.length - 1];
      prev.meanRms = (prev.meanRms * prev.lengthBars + last.meanRms * last.lengthBars) / (prev.lengthBars + last.lengthBars);
      prev.lengthBars += last.lengthBars;
    }
    if (sections.length > 1 && sections[0].lengthBars < 4 && bounds.length && bounds[0] < 4) {
      const first = sections.shift(), nxt = sections[0];
      nxt.meanRms = (nxt.meanRms * nxt.lengthBars + first.meanRms * first.lengthBars) / (nxt.lengthBars + first.lengthBars);
      nxt.lengthBars += first.lengthBars; nxt.startBar = 0;
    }
    let changed = true;
    while (changed && sections.length > 1) {
      changed = false;
      for (let i = 0; i < sections.length - 1; i++) {
        if (Math.abs(toDb(sections[i + 1].meanRms) - toDb(sections[i].meanRms)) < 4) {
          const a = sections[i], b = sections[i + 1], tot = a.lengthBars + b.lengthBars;
          a.meanRms = (a.meanRms * a.lengthBars + b.meanRms * b.lengthBars) / tot;
          a.lengthBars = tot;
          sections.splice(i + 1, 1);
          changed = true; break;
        }
      }
    }

    const maxR = Math.max(...sections.map((s) => s.meanRms), 1e-6);
    sections = sections.map((s) => ({
      startBar: s.startBar,
      lengthBars: s.lengthBars,
      meanRms: +s.meanRms.toFixed(4),
      meanDb: +toDb(s.meanRms).toFixed(1),
      energy: +Math.min(1, s.meanRms / maxR).toFixed(3),
      startSec: +(offset + s.startBar * barDurSec).toFixed(3),
    }));
    return {
      barRms: barRms.map((v) => +v.toFixed(4)),
      barDb: barDb.map((v) => +v.toFixed(1)),
      sections,
    };
  }

  return { analyzeSections };
})();
