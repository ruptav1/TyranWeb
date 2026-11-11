'use strict';
// Truy tìm video: each listed video's picture and facts (its size in pixels, frame rate, length). It
// is played for a moment, muted, in a hidden offscreen page of the tab's own session with the
// referrer its page used, its frame rate read from the frames it shows and one frame captured; a
// stream through a short piece of it (hls.js sample). When that cannot be done (DRM, a link that
// only plays inside its page), the picture comes from the page: the video where it plays, its
// poster, or the page's preview image. One video at a time; the page goes after a minute unused.
const { BrowserWindow, nativeImage } = require('electron');
const hls = require('./hls');
const { step } = require('./webrequest');

const RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 72, 90, 100, 119.88, 120, 144, 240];
// (the usual rate nearest to what was read, when it is near one)
const snap = (f) => {
  if (!(f > 0)) return 0;
  const near = RATES.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
  if (Math.abs(near - f) / near < 0.025) return near;
  return Math.abs(f - Math.round(f)) < 0.06 ? Math.round(f) : Math.round(f * 10) / 10;
};

let win = null;
let winSes = null;
let referrer = '';
let idle = null;
let chain = Promise.resolve();
const hooked = new WeakSet();
const MARK = 'x-tyran-referer';

// The referrer of what TyranWeb fetches for a page (a stream's pieces, a poster, a site's pictures):
// Electron's fetch sends none of its own, so a request carries it in a header of TyranWeb's and this
// step makes it the Referer; the probe page's requests get the one of the video it plays. Set on each
// browsing session (sniffer.js watch).
function referers(ses) {
  if (hooked.has(ses)) return;
  hooked.add(ses);
  step(ses, 'onBeforeSendHeaders', 'referer', (d, cb) => {
    const key = Object.keys(d.requestHeaders).find((k) => k.toLowerCase() === MARK);
    const ref = key ? d.requestHeaders[key] : referrer && win && !win.isDestroyed() && d.webContentsId === win.webContents.id ? referrer : '';
    if (!ref && !key) return cb({});
    const headers = {};
    for (const [k, v] of Object.entries(d.requestHeaders)) if (k.toLowerCase() !== MARK && k.toLowerCase() !== 'referer') headers[k] = v;
    if (ref) headers.Referer = ref;
    cb({ requestHeaders: headers });
  });
}

// ses.fetch with that referrer
function fetchFrom(ses, url, ref, opts = {}) {
  return ses.fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(ref ? { [MARK]: ref } : {}) } });
}

function close() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

function page(ses) {
  clearTimeout(idle);
  if (win && !win.isDestroyed() && winSes === ses) return win;
  close();
  winSes = ses;
  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 180,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false },
  });
  win.webContents.setFrameRate(120);
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  referers(ses);
  return win;
}

// runs in the probe page: the video's size and length, its frame rate from the media times of the
// frames shown while it plays, then a frame a tenth of the way in (the middle of a stream's piece)
async function inPage(src, piece) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;background:#000';
  document.body.style.cssText = 'margin:0;background:#000';
  document.body.replaceChildren(v);
  const wait = (ev, ms) =>
    new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error('timeout ' + ev)), ms);
      v.addEventListener(ev, () => (clearTimeout(t), ok()), { once: true });
      v.addEventListener('error', () => (clearTimeout(t), no(new Error('media ' + (v.error && v.error.code)))), { once: true });
    });
  // (every wait has its end: a paused video shows no new frame after a seek, and play() may never settle)
  const until = (p, ms) => Promise.race([p, new Promise((ok) => setTimeout(ok, ms))]);
  v.src = src;
  await wait('loadedmetadata', 15000);
  const out = { width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0, fps: 0 };
  if (v.requestVideoFrameCallback) {
    const times = [];
    await until(v.play().catch(() => {}), 3000);
    await new Promise((ok) => {
      const stop = setTimeout(ok, 1800);
      const cb = (now, m) => {
        times.push(m.mediaTime);
        if (times.length >= 30) {
          clearTimeout(stop);
          ok();
        } else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    });
    v.pause();
    const gaps = times
      .slice(1)
      .map((x, i) => x - times[i])
      .filter((g) => g > 0.003 && g < 0.25)
      .sort((a, b) => a - b);
    if (gaps.length >= 6) out.fps = 1 / gaps[Math.floor(gaps.length / 3)];
  }
  const at = out.duration ? Math.min(out.duration * (piece ? 0.5 : 0.1), out.duration - 0.1) : 0;
  if (at > 0.3) {
    v.currentTime = at;
    await wait('seeked', 8000).catch(() => {});
  }
  await until(new Promise((ok) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => ok()) : ok())), 500);
  await new Promise((ok) => setTimeout(ok, 150));
  return out;
}

const jpeg = (img, width = 320) => (img.isEmpty() ? '' : 'data:image/jpeg;base64,' + img.resize({ width: Math.min(width, img.getSize().width) }).toJPEG(80).toString('base64'));

async function once(ses, item, get) {
  const w = page(ses);
  referrer = item.referrer || '';
  let timer;
  try {
    let src = item.url;
    let piece = false;
    if (item.kind === 'hls') {
      src = 'data:video/mp4;base64,' + (await hls.sample({ get, url: item.url })).toString('base64');
      piece = true;
    }
    if (w.webContents.getURL() !== 'about:blank') await w.loadURL('about:blank');
    const facts = await Promise.race([
      w.webContents.executeJavaScript(`(${inPage})(${JSON.stringify(src)}, ${piece})`, true),
      new Promise((ok, no) => (timer = setTimeout(() => no(new Error('timeout')), 30000))),
    ]);
    const thumb = jpeg(await w.webContents.capturePage());
    return { width: facts.width, height: facts.height, duration: facts.duration, fps: snap(facts.fps), thumb };
  } catch (err) {
    close(); // (a page stuck loading is not reused)
    throw err;
  } finally {
    clearTimeout(timer);
    referrer = '';
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript('document.body.replaceChildren()', true).catch(() => {});
    clearTimeout(idle);
    idle = setTimeout(close, 60000);
  }
}

// probe(session, item, get) → { width, height, duration, fps, thumb }; get(url, opts) as main/hls.js
function probe(ses, item, get) {
  const run = chain.then(() => once(ses, item, get));
  chain = run.catch(() => {});
  return run;
}

// an image (a poster, a preview) as a data URL no wider than `width`, fetched in the tab's session
async function imageData(ses, url, ref, width = 480) {
  const res = await fetchFrom(ses, url, ref);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 6e6) throw new Error('big');
  const img = nativeImage.createFromBuffer(buf);
  if (!img.isEmpty()) return jpeg(img, width);
  if (!/^image\/(webp|gif|avif|png|jpeg)$/.test(type)) throw new Error('not an image');
  return `data:${type};base64,${buf.toString('base64')}`;
}

// the picture from the page itself: the video where it plays (captured as it is now), its poster,
// else the page's preview image
async function fromPage(wc, item) {
  const r = await wc.executeJavaScriptInIsolatedWorld(1079, [
    {
      code: `(() => {
        const vids = [...document.querySelectorAll('video')].map((v) => {
          const b = v.getBoundingClientRect();
          return { src: v.currentSrc || v.src || '', poster: v.poster || '', x: b.x, y: b.y, w: b.width, h: b.height, on: b.width > 80 && b.height > 45 && b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth };
        });
        const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:url"]');
        return { vids, og: og ? og.content : '' };
      })()`,
    },
  ]);
  const base = item.url.split('#')[0];
  const shown = r.vids.filter((v) => v.on);
  const v = r.vids.find((x) => x.src.split('#')[0] === base) || (shown.length === 1 && (item.kind === 'hls' || /^blob:/.test(shown[0].src)) ? shown[0] : null);
  if (v?.on) {
    const z = wc.getZoomFactor();
    const img = await wc.capturePage({ x: Math.max(0, Math.round(v.x * z)), y: Math.max(0, Math.round(v.y * z)), width: Math.round(v.w * z), height: Math.round(v.h * z) });
    if (!img.isEmpty()) return jpeg(img);
  }
  const pic = v?.poster || r.og;
  return pic ? imageData(wc.session, new URL(pic, wc.getURL()).href, wc.getURL(), 320) : '';
}

module.exports = { probe, fromPage, imageData, snap, referers, fetchFrom };
