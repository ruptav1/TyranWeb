// The music's spectrum along the foot of the wallpaper (the new tab page's button beside Tùy biến,
// setting newtab.visualizer), drawn as in Blue Archive's OST videos (see the bar below): over the
// wallpaper and under the pages, seen wherever the wallpaper is (the new tab page, Lobby mode).
//
// Only the wallpaper's music is heard: the lobby's song or the wallpaper's own music, measured where
// it plays (YouTube's page in the sidebar, a SoundCloud / Spotify player, the user's files, the
// Azur Lane lobby page), never the characters' voices. Each place gives its levels through a source
// added here (addSpectrumSource); a page measures its own media with spectrumHook.
// Turned on, the bar still keeps out of sight: it listens, comes out (its start) once the music is
// heard, and goes away (its end) a little after the music stops or the wallpaper has none.
import { on } from './util.js';
import { S } from './state.js';
import { active } from './tabs.js';

// Measures a playing media element (its own captured stream, so how it plays is untouched) as n
// levels 0-255, low to high on a log scale from 45 Hz to 11 kHz. Given no element finder it is for
// a page of its own (run there as text): window.__tyranSpectrum(n), for its playing <video> /
// <audio>. Its source is copied into pages as it stands, so it uses nothing from outside itself.
export function spectrumHook(find) {
  if (!find && window.__tyranSpectrum) return window.__tyranSpectrum;
  const pick = find || (() => [...document.querySelectorAll('video, audio')].find((m) => !m.paused && !m.ended) || null);
  let ctx = null;
  let an = null;
  let bins = null;
  let track = null;
  let src = null;
  const edgesFor = new Map();
  const read = (n = 48) => {
    const m = pick();
    if (!m || m.paused || m.ended) return null;
    try {
      m.__tyranStream ||= m.captureStream();
      const t = m.__tyranStream.getAudioTracks()[0];
      if (!t) return null;
      if (t !== track) {
        ctx ||= new AudioContext();
        if (!an) {
          an = ctx.createAnalyser();
          an.fftSize = 8192;
          an.smoothingTimeConstant = 0.45;
          an.minDecibels = -88;
          an.maxDecibels = -22;
          bins = new Uint8Array(an.frequencyBinCount);
        }
        if (src) src.disconnect();
        src = ctx.createMediaStreamSource(new MediaStream([t]));
        src.connect(an);
        track = t;
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (!edgesFor.has(n)) {
        const hz = ctx.sampleRate / an.fftSize;
        edgesFor.set(n, Array.from({ length: n + 1 }, (_, i) => Math.max(1, Math.round((45 * Math.pow(11000 / 45, i / n)) / hz))));
      }
      const edges = edgesFor.get(n);
      an.getByteFrequencyData(bins);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let top = 0;
        for (let k = edges[i]; k < Math.max(edges[i] + 1, edges[i + 1]) && k < bins.length; k++) top = Math.max(top, bins[k]);
        out[i] = top;
      }
      return out;
    } catch {
      return null; // (a sound it may not read: a protected stream, another site's file)
    }
  };
  if (!find) window.__tyranSpectrum = read;
  return read;
}

// where the music is measured: each source gives n levels, null (its music is silent now) or
// undefined (it has no music now: ask the next); the lower the rank, the sooner it is asked
const sources = [];
export function addSpectrumSource(fn, rank = 5) {
  sources.push({ fn, rank });
  sources.sort((a, b) => a.rank - b.rank);
}
async function levelsNow(n) {
  for (const s of sources) {
    let v = null;
    try {
      v = await s.fn(n);
    } catch {
      v = null; // (a page not ready to be asked)
    }
    if (v !== undefined) return Array.isArray(v) ? v : null;
  }
  return null;
}

// ---------------------------------------------------------------- the bar
// As in Blue Archive's OST videos (MO2's): 63 plain white bars with square corners and a soft
// shadow to the lower right, across the middle 82% of the width, a bar 2/3 of its step, the lowest
// a flat dash; neighbours smoothed into one another. Its start as there: two thin lines grow in
// from the two ends and meet, the line fades, and the bars come out from the middle to the ends;
// its end the same backwards.
const BARS = 63;
const SPAN = 0.82; // of the window's width
const FILL = 0.66; // a bar's share of its step
const TALL = 0.086; // the tallest bar, of the span (90 px on a 1044 px span)
let canvas = null;
let state = 'off'; // off | in | live | out
let since = 0;
let raf = 0;
let poll = 0;
let pollEvery = 0; // ms (0: not listening)
let busy = false;
let lastHeard = 0; // when the music was last heard (s)
const QUIET = 3; // seconds without music before the bar goes away (songs have short gaps)
const level = new Float32Array(BARS); // what is drawn, eased
let want = new Float32Array(BARS);
let lastFrame = 0;

const visible = () => !!S.lobby || /^tyran:\/\/newtab\/?$/i.test(active()?.url || '');
const shown = () => !!S.settings?.newtab?.visualizer;
const animated = () => S.settings?.appearance?.animations !== false;
const INTRO = 1.3; // seconds: the lines (0-0.5), the line fading (0.5-1.0), the bars coming out (1.0-1.3)
const OUTRO = 1.0;

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.id = 'spectrum';
  canvas.style.cssText = 'position:absolute;left:0;bottom:0;width:100%;pointer-events:none;z-index:3';
  document.getElementById('wallpaper').append(canvas);
  return canvas;
}

// its start (the music came) or its end (the music went, or the bar was turned off)
function come(on) {
  if (on && (state === 'off' || state === 'out')) state = animated() ? 'in' : 'live';
  else if (!on && (state === 'in' || state === 'live')) state = animated() ? 'out' : 'off';
  else return;
  since = performance.now() / 1000;
  run();
}

function apply() {
  if (!shown()) come(false);
  run();
}

// drawing while it is there and can be seen; listening while it is turned on and can be seen (often
// while the bars show, now and then while it waits for music)
function run() {
  const go = state !== 'off' && visible();
  if (go && !raf) {
    ensureCanvas();
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  }
  if (!go && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
  const every = !shown() || !visible() ? 0 : state === 'in' || state === 'live' ? 40 : 150;
  if (every === pollEvery) return;
  clearInterval(poll);
  poll = every ? setInterval(listenNow, every) : 0;
  pollEvery = every;
  if (!every) want.fill(0);
}

async function listenNow() {
  if (busy) return;
  busy = true;
  try {
    const v = await levelsNow(BARS);
    // (music is heard when it gives levels above silence)
    const t = performance.now() / 1000;
    if (v && v.some((x) => x > 30)) lastHeard = t;
    if (!shown()) return;
    if (t - lastHeard < 0.2) come(true);
    else if (t - lastHeard > QUIET) come(false);
    // (the louder parts stand out: a curve on the levels, the highs lifted a little as they are quieter)
    const raw = Float32Array.from({ length: BARS }, (_, i) => (v ? Math.min(1, (Math.max(0, (v[i] || 0) - 28) / 227) ** 1.35 * (0.9 + (0.4 * i) / BARS)) : 0));
    // neighbours smoothed into one another, as such visualizers do: none lower than a taller one
    // near it, less a share for each bar between
    for (let i = 0; i < BARS; i++) for (let j = 0; j < BARS; j++) if (i !== j) raw[j] = Math.max(raw[j], raw[i] / 1.6 ** Math.abs(i - j));
    want = raw;
  } finally {
    busy = false;
  }
}

const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

function frame(nowMs) {
  raf = requestAnimationFrame(frame);
  const t = nowMs / 1000;
  const dt = Math.min(0.1, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const dpr = devicePixelRatio || 1;
  const W = innerWidth;
  const span = W * SPAN;
  const step = span / BARS;
  const barW = step * FILL;
  const tall = span * TALL;
  const low = Math.max(2, barW * 0.42); // (the flat dash a silent bar is)
  const bottom = Math.max(18, innerHeight * 0.05);
  const boxH = tall + bottom + 12;
  const cw = Math.round(W * dpr);
  const ch = Math.round(boxH * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.height = boxH + 'px';
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, boxH);
  const x0 = (W - span) / 2;
  const base = boxH - bottom;

  // where its start (or its end, the same backwards) is: the lines, how strong the line is, how
  // far from the middle the bars have come out
  let lines = 0; // how far each line has grown (1: they have met)
  let lineAlpha = 0;
  let out = 1; // the bars, from the middle (0) to the ends (1)
  const k = t - since;
  if (state === 'in') {
    lines = ease(k / 0.5);
    lineAlpha = k < 0.7 ? 1 : 1 - Math.min(1, (k - 0.7) / 0.3);
    out = ease((k - 1.0) / 0.3);
    if (k >= INTRO) {
      state = 'live';
      run();
    }
  } else if (state === 'out') {
    const r = OUTRO - k; // (the start, run backwards and quicker)
    const s = r * (INTRO / OUTRO);
    lines = ease(s / 0.5);
    lineAlpha = s < 0.7 ? 1 : 1 - Math.min(1, (s - 0.7) / 0.3);
    out = ease((s - 1.0) / 0.3);
    if (k >= OUTRO) {
      state = 'off';
      return void run();
    }
  }

  // the bars: eased toward the music (up fast, down slower)
  for (let i = 0; i < BARS; i++) {
    const target = state === 'live' ? want[i] : 0;
    level[i] += (target - level[i]) * (target > level[i] ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 8));
  }
  g.shadowColor = 'rgba(0, 0, 0, 0.35)';
  g.shadowBlur = Math.max(2, barW * 0.3);
  g.shadowOffsetX = g.shadowOffsetY = Math.max(1, barW * 0.15);
  g.fillStyle = '#fff';
  if (out > 0) {
    g.beginPath();
    for (let i = 0; i < BARS; i++) {
      // (coming out from the middle: a bar is there once the front has passed it)
      const from = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
      if (from > out) continue;
      const h = low + level[i] * (tall - low);
      g.rect(x0 + i * step + (step - barW) / 2, base - h, barW, h);
    }
    g.fill();
  }
  // the two thin lines from the ends, meeting in the middle
  if (lines > 0 && lineAlpha > 0) {
    g.globalAlpha = lineAlpha;
    const lh = Math.max(1.5, barW * 0.18);
    const half = (span / 2) * lines;
    g.fillRect(x0, base - lh, half, lh);
    g.fillRect(x0 + span - half, base - lh, half, lh);
    g.globalAlpha = 1;
  }
}

export function initVisualizer() {
  on('settings', apply);
  for (const ev of ['active', 'tabs:changed', 'lobby-mode']) on(ev, run);
  apply();
}
