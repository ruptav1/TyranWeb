'use strict';
// Kho nền video (tyran://store): live video wallpapers from several sites, searched together. The
// sites' pages are read here, in a session of their own (the store page picks them apart:
// pages/store/sources.js), and a video picked there is downloaded into the user's video wallpapers
// with what is known of it: its size, resolution, date, tags, the site and its page.
//
// A page that first runs a script to let a browser in (a "Just a moment..." or "You are being
// redirected..." page) is read through a hidden window of that session instead, which then keeps
// its cookie for the next reads. A page that asks for a CAPTCHA is not read.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const data = require('./data');
const { USER_WALLPAPERS } = require('./protocol');

const PARTITION = 'persist:tyran-store';
// each site: the pages that may be read, the addresses its videos come from
const SITES = {
  moewalls: { name: 'MoeWalls', pages: ['moewalls.com'], files: ['go.moewalls.com'] },
  motionbgs: { name: 'MotionBGs', pages: ['motionbgs.com'], files: ['motionbgs.com'] },
  wallpaperwaifu: { name: 'WallpaperWaifu', pages: ['wallpaperwaifu.com'], files: ['go.wallpaperwaifu.com'] },
};
const VIDEO_MAX = 4 * 1024 ** 3;
const GATE = /You are being redirected|cf_chl_opt|<title>Just a moment/i;

const hostIn = (url, hosts) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.some((h) => u.hostname === h || u.hostname === 'www.' + h);
  } catch {
    return false;
  }
};
const siteOf = (url) => Object.keys(SITES).find((k) => hostIn(url, SITES[k].pages)) || '';

let ses = null;
function store() {
  if (ses) return ses;
  ses = session.fromPartition(PARTITION);
  ses.setUserAgent(require('./sessions').cleanUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

// ---- reading a page
let reader = null; // { win, timer }
let queue = Promise.resolve();
function viaWindow(url) {
  const job = queue.then(async () => {
    if (!reader || reader.win.isDestroyed()) {
      const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, images: false, backgroundThrottling: false, autoplayPolicy: 'user-gesture-required' } });
      win.webContents.setAudioMuted(true);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      reader = { win, timer: 0 };
    }
    clearTimeout(reader.timer);
    const wc = reader.win.webContents;
    await wc.loadURL(url).catch(() => {});
    // (its gate script reloads the page once it has set its cookie)
    let html = '';
    for (let i = 0; i < 30; i++) {
      html = await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
      if (html && !GATE.test(html.slice(0, 6000))) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    const r = reader;
    r.timer = setTimeout(() => !r.win.isDestroyed() && r.win.destroy(), 60000);
    return { url: wc.getURL() || url, html: GATE.test(html.slice(0, 6000)) ? '' : html };
  });
  queue = job.catch(() => {});
  return job;
}

async function page(url) {
  url = String(url || '');
  if (!siteOf(url)) throw new Error('not a store site');
  const res = await store().fetch(url, { headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en' } });
  const html = await res.text();
  if (res.ok && !GATE.test(html.slice(0, 6000))) return { url: res.url || url, html };
  const r = await viaWindow(url);
  if (!r.html) throw new Error(`HTTP ${res.status}`);
  return r;
}

// ---- downloading a video: progress to the page that asked, the file into the video wallpapers
const jobs = new Map(); // id → AbortController
const isVideo = (b) => b.length >= 12 && (b.toString('latin1', 4, 8) === 'ftyp' || b.readUInt32BE(0) === 0x1a45dfa3);

async function download(sender, item) {
  const site = SITES[item?.site];
  const id = String(item?.id || '');
  if (!site || !id || !hostIn(item.file, site.files) || !hostIn(item.page, site.pages)) throw new Error('not a store video');
  const ctrl = new AbortController();
  jobs.set(id, ctrl);
  const name = `video-${data.uid()}`;
  const part = path.join(USER_WALLPAPERS, name + '.part');
  try {
    // (the page it is on as its referrer: Electron's fetch refuses a Referer header set by hand)
    const res = await store().fetch(item.file, { referrer: item.page, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    // (a page instead of the file: the site no longer has it, as WallpaperWaifu says of some)
    if (/text\/html/i.test(res.headers.get('content-type') || '') || /\/error-file\//.test(res.url)) throw new Error('gone');
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > VIDEO_MAX) throw new Error('too big');
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get('content-disposition') || '')?.[1] || '';
    const ext = /\.webm$/i.test(named) || /webm/i.test(res.headers.get('content-type') || '') ? '.webm' : '.mp4';
    fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
    const out = fs.createWriteStream(part);
    let got = 0;
    let head = Buffer.alloc(0);
    let told = 0;
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      if (head.length < 12) head = Buffer.concat([head, b]).subarray(0, 12);
      got += b.length;
      if (got > VIDEO_MAX) throw new Error('too big');
      if (!out.write(b)) await new Promise((ok) => out.once('drain', ok));
      if (Date.now() - told > 200 && !sender.isDestroyed()) {
        told = Date.now();
        sender.send('livewalls:progress', { id, got, total });
      }
    }
    await new Promise((ok, fail) => out.end((err) => (err ? fail(err) : ok())));
    if (!isVideo(head)) throw new Error('not a video');
    const file = name + ext;
    fs.renameSync(part, path.join(USER_WALLPAPERS, file));
    if (!sender.isDestroyed()) sender.send('livewalls:progress', { id, got, total: got });
    const services = require('./services');
    if (!(await poster(file, item.thumb))) await services.makePoster(file);
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
    return services.addUserWallpaper(file, {
      type: 'video',
      title: String(item.title || site.name).slice(0, 200),
      source: site.name,
      site: item.site,
      page: item.page,
      bytes: got,
      width: num(item.width),
      height: num(item.height),
      date: String(item.date || '').slice(0, 10),
      tags: (Array.isArray(item.tags) ? item.tags : []).map(String).slice(0, 30),
      origin: String(item.origin || '').slice(0, 100),
    });
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  } finally {
    jobs.delete(id);
  }
}

// the site's own picture of it as its poster (the Windows thumbnailer has no codec for some videos)
async function poster(file, thumb) {
  if (!/^https:\/\//i.test(thumb || '') || !siteOf(thumb)) return false;
  try {
    const res = await store().fetch(thumb);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\//.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return false;
    fs.writeFileSync(path.join(USER_WALLPAPERS, file + '.thumb.jpg'), buf);
    return true;
  } catch {
    return false;
  }
}

function cancel(id) {
  jobs.get(String(id))?.abort();
}

module.exports = { SITES, page, download, cancel };
