'use strict';
// Truy tìm video: what a tab really plays, caught from its own network traffic on any site (its
// frames and embedded players too): video files (mp4, webm, mov, mkv, flv) and HLS streams (.m3u8,
// or a playlist under another name). Listed per tab for the toolbar's video button; on the user's
// press a file is downloaded by the browser's own download (in Tải xuống) with the referrer its
// player used, a stream piece by piece into an .mp4 (main/hls.js), in Tải xuống as well. Pieces of
// a stream, a site's own adaptive pieces (YouTube's), a variant listed under its master and tiny
// files (previews, ads) are not listed. Each one's picture and facts come from main/mediaprobe.js
// when the list is opened.
const fs = require('fs');
const path = require('path');
const { webContents, session } = require('electron');
const hls = require('./hls');
const dljobs = require('./dljobs');
const mediaprobe = require('./mediaprobe');
const { step } = require('./webrequest');

const found = new Map(); // tab's webContents id → Map(url → item)
const HLS_TYPE = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(x-)?mpegurl)$/i;
const VIDEO_EXT = /\.(mp4|webm|m4v|mov|mkv|flv)$/i;
const PIECE = /\.(ts|m4s|m4a|aac|vtt|webvtt|key|jpe?g|png|gif|webp)$/i;
const MIN_FILE = 512 * 1024;
let seq = 0;

const header = (h, name) => {
  for (const k in h || {}) if (k.toLowerCase() === name) return String(Array.isArray(h[k]) ? h[k][0] : h[k]);
  return '';
};

// ---- seeing it: every response of the browsing sessions, looked at as it starts
function seen(d) {
  if (d.method !== 'GET' || !d.webContentsId || d.statusCode >= 400 || !/^https?:/i.test(d.url)) return;
  let u;
  try {
    u = new URL(d.url);
  } catch {
    return;
  }
  const type = header(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const p = u.pathname.toLowerCase();
  if (type === 'video/mp2t' || type === 'video/iso.segment' || /^(image|text\/(css|html|javascript))/.test(type)) return;
  if (/\/videoplayback$/.test(p) || /[?&](range|bytestart|byterange)=/i.test(u.search)) return; // (adaptive pieces)
  let kind = '';
  if (HLS_TYPE.test(type) || p.endsWith('.m3u8')) kind = 'hls';
  else if (PIECE.test(p)) return;
  else if (/^video\//.test(type) || (VIDEO_EXT.test(p) && /^(|application\/octet-stream|binary\/octet-stream)$/.test(type))) kind = 'file';
  // (a playlist under another name: read to be sure)
  else if (/m3u8|playlist|master/i.test(d.url) && /^(|text\/plain|application\/octet-stream|binary\/octet-stream)$/.test(type)) kind = 'hls?';
  if (!kind) return;
  const range = /\/(\d+)\s*$/.exec(header(d.responseHeaders, 'content-range'))?.[1];
  const size = Number(range || 0) || (d.statusCode === 200 ? Number(header(d.responseHeaders, 'content-length')) || 0 : 0);
  if (kind === 'file' && size && size < MIN_FILE) return;
  add(d.webContentsId, { url: d.url, kind, type, size, referrer: d.referrer || '' });
}

function add(wcId, x) {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed() || !wc.hostWebContents) return; // (tabs only)
  let list = found.get(wcId);
  if (!list) found.set(wcId, (list = new Map()));
  const key = x.url.split('#')[0];
  const had = list.get(key);
  if (had) {
    if (x.size && !had.size) had.size = x.size;
    return;
  }
  if (list.size >= 80) return;
  const item = { id: 'm' + ++seq, key, url: x.url, kind: x.kind === 'hls?' ? 'hls' : x.kind, type: x.type, size: x.size, referrer: x.referrer || wc.getURL(), title: wc.getTitle(), at: Date.now(), hidden: x.kind !== 'file' };
  list.set(key, item);
  if (item.kind === 'hls') read(wc, item);
  else tell(wc);
}

// a playlist read: its variants, length, DRM; a variant (or audio) of a master already listed is not
// a video of its own
async function read(wc, item) {
  try {
    const pl = hls.parse(await get(wc.session, item.url, item.referrer), item.url);
    const list = found.get(wc.id);
    item.variants = pl.variants.map((v) => ({ width: v.width, height: v.height, bandwidth: v.bandwidth, fps: v.fps, audioApart: v.audioApart }));
    item.duration = pl.duration;
    item.drm = pl.drm;
    item.live = pl.live;
    if (pl.variants.length) {
      item.children = new Set([...pl.variants, ...pl.audios].map((v) => v.url.split('#')[0]));
      for (const k of item.children) if (list?.get(k)) list.get(k).child = true;
      // (its length, keys and whether it is live are in a variant's playlist, not the master's)
      const v = pl.variants[hls.best(pl.variants)];
      try {
        const sub = hls.parse(await get(wc.session, v.url, item.referrer), v.url);
        Object.assign(item, { duration: sub.duration, drm: sub.drm, live: sub.live });
      } catch {
        /* (the master alone, then) */
      }
    } else if ([...(list?.values() || [])].some((o) => o.children?.has(item.key))) item.child = true;
    item.hidden = false;
  } catch {
    item.hidden = true; // (not a playlist after all, or not readable)
  }
  if (!wc.isDestroyed()) tell(wc);
}

const shown = (wcId) => [...(found.get(wcId)?.values() || [])].filter((i) => !i.hidden && !i.child);
function tell(wc) {
  const host = wc.hostWebContents;
  if (host && !host.isDestroyed()) host.send('media:found', { wcId: wc.id, count: shown(wc.id).length });
}

function get(ses, url, referrer, { binary = false, range = null, signal } = {}) {
  const end = range && Number.isFinite(range.length) ? range.offset + range.length - 1 : '';
  return mediaprobe
    .fetchFrom(ses, url, referrer, { signal, headers: range ? { range: `bytes=${range.offset}-${end}` } : undefined })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
    });
}

// ---- the sessions and tabs it watches
function watch(ses) {
  mediaprobe.referers(ses);
  step(ses, 'onHeadersReceived', 'media', (d, cb) => {
    try {
      seen(d);
    } catch {
      /* (never in the way of a page) */
    }
    cb({});
  });
}
function guest(wc) {
  const id = wc.id;
  wc.on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isSameDocument || !found.has(id)) return;
    found.delete(id);
    tell(wc);
  });
  wc.once('destroyed', () => found.delete(id));
}

// what the video button lists
function list(wcId) {
  return shown(wcId)
    .map((i) => ({ id: i.id, kind: i.kind, url: i.url, size: i.size, duration: i.duration || 0, variants: i.variants || [], drm: !!i.drm, live: !!i.live, title: i.title, at: i.at, meta: i.meta || null }))
    .sort((a, b) => b.at - a.at);
}

// ---- its picture and facts (size in pixels, frame rate, length), once
function probe(wc, id) {
  const item = shown(wc.id).find((i) => i.id === id);
  if (!item) return Promise.reject(new Error('gone'));
  item.probing ||= (async () => {
    const fetcher = (u, o) => get(wc.session, u, item.referrer, o);
    let meta = {};
    if (!item.drm) meta = await mediaprobe.probe(wc.session, item, fetcher).catch(() => ({}));
    if (!meta.thumb && !wc.isDestroyed()) meta.thumb = await mediaprobe.fromPage(wc, item).catch(() => '');
    if (item.kind === 'hls') {
      // (each variant's frame rate: the one it states, else read from its first piece)
      const rates = await hls.frameRates({ get: fetcher, url: item.url }).catch(() => []);
      if (item.variants?.length) item.variants.forEach((v, i) => (v.fps = mediaprobe.snap(rates[i] || v.fps || 0)));
      else if (rates[0]) meta.fps = mediaprobe.snap(rates[0]);
      const top = item.variants?.length ? item.variants[hls.best(item.variants)] : null;
      if (top?.height) Object.assign(meta, { width: top.width, height: top.height, fps: top.fps || meta.fps });
      meta.duration = item.duration || meta.duration;
    }
    item.meta = meta;
    return { meta, variants: item.variants || [] };
  })();
  return item.probing;
}

// ---- downloading it
const isPrivate = (wc) => wc.session === session.fromPartition(require('./sessions').PRIVATE_PARTITION);

async function download(wc, id, variant) {
  const item = shown(wc.id).find((i) => i.id === id);
  if (!item) throw new Error('gone');
  if (item.kind === 'file') {
    wc.downloadURL(item.url, { headers: item.referrer ? { Referer: item.referrer } : {} }); // (a tab's own download takes a Referer as it is)
    return { kind: 'file' };
  }
  if (item.drm) throw new Error('drm');
  if (item.live) throw new Error('live');
  const v = item.variants?.[variant];
  const host = (() => {
    try {
      return new URL(item.referrer || item.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const file = dljobs.unique(path.join(dljobs.dir(), `${dljobs.safe(item.title || host)}${v?.height ? ` ${v.height}p` : ''}.mp4`));
  const ctrl = new AbortController();
  const job = dljobs.start({ url: item.url, path: file, mime: 'video/mp4', private: isPrivate(wc), cancel: () => ctrl.abort() });
  run(wc.session, item, variant, job, ctrl.signal);
  return { kind: 'hls', id: job.rec.id };
}

async function run(ses, item, variant, job, signal) {
  const fetcher = (u, o = {}) => get(ses, u, item.referrer, { ...o, signal });
  const into = async (url, file, v) => {
    const out = fs.createWriteStream(file + '.part');
    try {
      const r = await hls.download({
        get: fetcher,
        url,
        variant: v,
        out,
        signal,
        // (its size: an estimate from the pieces so far)
        progress: (p) => job.update({ receivedBytes: p.bytes, totalBytes: Math.round((p.bytes / p.done) * p.total) }),
      });
      await new Promise((ok, fail) => out.end((err) => (err ? fail(err) : ok())));
      fs.renameSync(file + '.part', file);
      return r;
    } catch (err) {
      out.destroy();
      fs.rmSync(file + '.part', { force: true });
      throw err;
    }
  };
  try {
    const r = await into(item.url, job.rec.path, Number.isInteger(variant) ? variant : undefined);
    // (its sound in a playlist of its own: beside it, as an .m4a)
    if (r.audioUrl) await into(r.audioUrl, dljobs.unique(job.rec.path.replace(/\.mp4$/i, ' (audio).m4a')), undefined).catch(() => {});
    job.finish('completed', { receivedBytes: r.bytes, totalBytes: r.bytes });
  } catch (err) {
    job.finish(signal.aborted ? 'cancelled' : 'interrupted', { error: String(err?.message || err) });
  }
}

module.exports = { watch, guest, list, probe, download };
