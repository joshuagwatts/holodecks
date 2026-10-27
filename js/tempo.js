'use strict';
/* HoloDecks TempoDetect — automatic BPM + first-beat detection on a decoded
 * AudioBuffer. Plain JS on the raw channel data (no OfflineAudioContext):
 *   mixdown -> one-pole lowpass (kick/bass weight) -> per-hop energy onset
 *   envelope (hop 256, ~172 fps at 44.1k) -> normalised autocorrelation over
 *   60..180 BPM lags -> octave correction -> parabolic peak interpolation ->
 *   integer snap -> beat-phase search for the first-beat offset.
 * Analyses at most the first 120 s, so it stays fast on a phone.
 *
 * Octave rule (test-driven, see tests/prove.mjs): autocorrelation of real
 * tracks peaks at multiples of the beat (the 2-beat / 4-beat pattern period
 * often scores HIGHER than 1 beat). So: take the strongest peak, then walk
 * UP in octaves — if the half-lag (double-BPM) candidate scores at least
 * 58% of the current candidate, prefer the double. True half-tempo tracks
 * fail this test by a wide margin (their double-time candidate scores
 * ~20-30%), so 100 BPM never comes back 200 and 140 never stays 70.
 * Finally the result is folded into 85..180 BPM. */
window.TempoDetect = (() => {
  const HOP = 256;
  const MAX_SECONDS = 120;
  const MIN_BPM = 60, MAX_BPM = 180;

  function detect(buffer) {
    if (!buffer || !buffer.length || !buffer.sampleRate) {
      return { bpm: 0, rawBpm: 0, confidence: 0, beatOffsetSec: 0 };
    }
    const sr = buffer.sampleRate;
    const nCh = Math.max(1, buffer.numberOfChannels || 1);
    const total = Math.min(buffer.length, Math.floor(sr * MAX_SECONDS));
    if (total < sr * 4) return { bpm: 0, rawBpm: 0, confidence: 0, beatOffsetSec: 0 };

    /* ---- mixdown to mono ---- */
    const mono = new Float32Array(total);
    for (let c = 0; c < nCh; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < total; i++) mono[i] += d[i];
    }
    if (nCh > 1) { const inv = 1 / nCh; for (let i = 0; i < total; i++) mono[i] *= inv; }

    /* ---- onset envelope: lowpassed energy, positive change, sqrt-compressed ---- */
    const nFrames = Math.floor(total / HOP);
    const env = new Float32Array(nFrames);
    const alpha = 0.12;
    let lp = 0, prevE = 0, idx = 0;
    for (let f = 0; f < nFrames; f++) {
      let e = 0;
      for (let i = 0; i < HOP; i++) {
        const x = mono[idx++];
        lp += alpha * (x - lp);
        e += lp * lp;
      }
      env[f] = e > prevE ? Math.sqrt(e - prevE) : 0;
      prevE = e;
    }
    const fps = sr / HOP;

    /* ---- normalised autocorrelation over 60..180 BPM lags ---- */
    let mean = 0;
    for (let i = 0; i < nFrames; i++) mean += env[i];
    mean /= nFrames;
    const e2 = new Float32Array(nFrames);
    let varSum = 0;
    for (let i = 0; i < nFrames; i++) { e2[i] = env[i] - mean; varSum += e2[i] * e2[i]; }
    const varMean = varSum / nFrames;
    if (varMean <= 1e-12) return { bpm: 0, rawBpm: 0, confidence: 0, beatOffsetSec: 0 };

    const minLag = Math.max(2, Math.floor((60 / MAX_BPM) * fps));
    const maxLag = Math.min(nFrames - 2, Math.ceil((60 / MIN_BPM) * fps));
    const scores = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0, lim = nFrames - lag; i < lim; i++) s += e2[i] * e2[i + lag];
      scores[lag] = s / (nFrames - lag) / varMean;
    }

    /* ---- peaks ---- */
    const peaks = [];
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
        peaks.push({ lag, score: scores[lag] });
      }
    }
    if (!peaks.length) return { bpm: 0, rawBpm: 0, confidence: 0, beatOffsetSec: 0 };
    peaks.sort((a, b) => b.score - a.score);
    let cur = peaks[0];
    if (cur.score <= 0.02) return { bpm: 0, rawBpm: 0, confidence: 0, beatOffsetSec: 0 };

    const scoreNear = (lagF) => {
      let bestS = -Infinity, bestL = Math.round(lagF);
      const lo = Math.max(minLag, Math.round(lagF) - 2), hi = Math.min(maxLag, Math.round(lagF) + 2);
      for (let l = lo; l <= hi; l++) if (scores[l] > bestS) { bestS = scores[l]; bestL = l; }
      return { lag: bestL, score: bestS };
    };

    /* ---- octave correction: walk up while the double-time candidate holds up ---- */
    for (let iter = 0; iter < 3; iter++) {
      const halfLag = cur.lag / 2;
      if (halfLag < minLag) break;
      const cand = scoreNear(halfLag);
      if ((60 * fps) / cand.lag > 182) break;
      if (cand.score >= 0.58 * cur.score) cur = cand; else break;
    }

    /* ---- parabolic interpolation for fractional BPM ---- */
    const l = cur.lag;
    const s0 = scores[l], sm = scores[l - 1] || s0, sp = scores[l + 1] || s0;
    const denom = sm - 2 * s0 + sp;
    let delta = denom !== 0 ? (0.5 * (sm - sp)) / denom : 0;
    delta = Math.max(-1, Math.min(1, delta));
    let bpm = (60 * fps) / (l + delta);

    /* ---- fold into 85..180 ---- */
    while (bpm < 85 && bpm > 0) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const rawBpm = bpm;

    /* ---- integer snap (most produced tracks are integer BPM) ---- */
    const nearest = Math.round(bpm);
    if (Math.abs(bpm - nearest) <= 0.2) bpm = nearest;

    /* ---- confidence: winning score vs strongest non-harmonic peak + mean ---- */
    let second = 0;
    for (const p of peaks) {
      if (Math.abs(p.lag - cur.lag) <= 3) continue;
      if (Math.abs(p.lag - cur.lag * 2) <= 3 || Math.abs(p.lag * 2 - cur.lag) <= 3) continue;
      second = Math.max(second, p.score);
    }
    let confidence = second > 0
      ? Math.max(0, Math.min(1, ((cur.score - second) / cur.score) * 1.4))
      : 0.9;
    if (cur.score < 0.1) confidence = Math.min(confidence, 0.25);

    /* ---- first-beat phase: maximise summed onset energy on the beat grid ---- */
    const periodF = (60 * fps) / bpm; // frames per beat at the final BPM
    let bestPhase = 0, bestSum = -1;
    const phaseScore = (ph) => {
      let s = 0;
      for (let pos = ph; pos < nFrames - 1; pos += periodF) {
        const i0 = Math.floor(pos), fr = pos - i0;
        s += env[i0] * (1 - fr) + env[i0 + 1] * fr;
      }
      return s;
    };
    for (let ph = 0; ph < periodF; ph += 0.25) {
      const s = phaseScore(ph);
      if (s > bestSum) { bestSum = s; bestPhase = ph; }
    }
    for (let ph = Math.max(0, bestPhase - 0.25); ph <= Math.min(periodF, bestPhase + 0.25); ph += 0.05) {
      const s = phaseScore(ph);
      if (s > bestSum) { bestSum = s; bestPhase = ph; }
    }
    const beatOffsetSec = bestPhase / fps;

    return {
      bpm: +bpm.toFixed(2),
      rawBpm: +rawBpm.toFixed(2),
      confidence: +confidence.toFixed(3),
      beatOffsetSec: +beatOffsetSec.toFixed(3),
    };
  }

  return { detect };
})();
