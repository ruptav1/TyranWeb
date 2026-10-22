'use strict';
// NIKKE live wallpapers, set up on the user's request: nothing of the game ships with TyranWeb.
// A character is downloaded once into userData/live/nikke-<id>/ and shown by TyranWeb's own player
// page (src/live/nikke), copied in beside her:
//  - her Spine models (standing in the lobby, and behind cover / aiming in battle) from Nikke-db,
//    a fan database of the game (nikke-db.github.io, github.com/Nikke-db/Nikke-db.github.io);
//  - her Japanese voice lines from the voice packs of I6RaVeN9I/nikke-wallpaper-packs: only her
//    files are read out of the zip, by range requests. A character with no Japanese voice there
//    stays silent but for a few short hurt sounds (no words) from the English pack;
//  - the official Spine runtime for the web (spine-webgl, Esoteric Software) from npm, checked
//    against its known SHA-256: 4.0.31, and 4.1.56 for models made with Spine 4.1.
// Her other outfits come the same way, one at a time, into outfit/<outfit-id>/ beside her (they
// share her voice).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { LIVE_WALLPAPERS, ROOT, USER_WALLPAPERS } = require('./protocol');

const NIKKE_DB = 'https://nikke-db.github.io/l2d';
const NIKKE_IMAGES = 'https://nikke-db.github.io/images';
const VOICE_ZIPS = {
  jp: 'https://github.com/I6RaVeN9I/nikke-wallpaper-packs/releases/download/Audio/jp.zip',
  en: 'https://github.com/I6RaVeN9I/nikke-wallpaper-packs/releases/download/Audio/en.zip',
};
const RUNTIMES = {
  '4.0': {
    file: 'spine-webgl.min.js',
    url: 'https://unpkg.com/@esotericsoftware/spine-webgl@4.0.31/dist/iife/spine-webgl.min.js',
    sha256: 'db31d4ff4d604ca9971f817427277607185b233158cbb4744409288c004a6d2b',
  },
  '4.1': {
    file: 'spine-webgl-4.1.min.js',
    url: 'https://unpkg.com/@esotericsoftware/spine-webgl@4.1.56/dist/iife/spine-webgl.min.js',
    sha256: '305b5f54f4f1ac238d3d59a0c2591416ac2dd95cb21e2b9f65b27066c607320f',
  },
};
const LICENSE = 'https://unpkg.com/@esotericsoftware/spine-webgl@4.0.31/LICENSE';
const PAGE = path.join(ROOT, 'src', 'live', 'nikke');
const PAGE_FILES = ['index.html', 'player.js'];
// The characters TyranWeb offers (src/main/nikke-roster.json, made from Nikke-db's tables and file
// lists, the packs' file lists and the voice zips; Rapi, Marciana and Elegg checked by hand), each:
//  name; bytes / download: what she takes on disk / to download (models + runtime + voice);
//  voice: the pack her lines come from ('jp'), or with `files` only those (short hurt sounds, no
//    words: one burst up to 1.5 s or two under 1 s, from the English pack), or 'none';
//  weapon: her gun in the game (kind, magazine, reload in seconds; Nikke-db, Prydwen / nikke.gg);
//  fb: Nikke-db has a full-length picture of her (images/FB), shown on her card until TyranWeb has
//    drawn its own; art: the NIKKE wiki's pictures of her looks ('' her own), for the others;
//  outfits: { id: { name (Nikke-db's, else numbered), bytes } }. The game's separate units of her
//    ("Rapi: Red Hood") are among them, with `from` (the unit), their own `weapon` and `voice`,
//    and their own outfits after them.
const CHARACTERS = require('./nikke-roster.json');
const { t } = require('./i18n');

const dirOf = (id) => path.join(LIVE_WALLPAPERS, 'nikke-' + id);
const known = (id) => Object.hasOwn(CHARACTERS, id);
const outfitOf = (id, o) => (known(id) && Object.hasOwn(CHARACTERS[id].outfits || {}, o) ? CHARACTERS[id].outfits[o] : null);
const manifestOf = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
};
// (downloaded: her manifest and the runtime her models need)
const installed = (id) => {
  const m = known(id) && manifestOf(id);
  return !!m && fs.existsSync(path.join(dirOf(id), (RUNTIMES[m.spine || '4.0'] || RUNTIMES['4.0']).file));
};
const outfitInstalled = (id, o) => !!outfitOf(id, o) && installed(id) && !!manifestOf(id)?.outfits?.[o] && fs.existsSync(path.join(dirOf(id), 'outfit', o));
// pictures of her for Settings, taken by the wallpaper (nikke_<id or outfit>.jpg)
const previewFile = (key) => path.join(USER_WALLPAPERS, 'ba-previews', `nikke_${key}.jpg`);
const previewUrl = (key) => {
  const pic = previewFile(key);
  return fs.existsSync(pic) ? `tyran://userdata/ba-previews/nikke_${key}.jpg?${Math.round(fs.statSync(pic).mtimeMs)}` : '';
};

// ---------------------------------------------------------------- cards
// Each look's card in Settings: her picture as TyranWeb draws it from her model once downloaded
// (nikke-cards/<id>.png, made in a hidden window), else Nikke-db's full-length picture of her (kept
// small, fb-<id>.png), else the NIKKE wiki's (its smaller copy, fetched as shown), else her small
// portrait from Nikke-db.
const CARDS = path.join(USER_WALLPAPERS, 'nikke-cards');
const cardUrl = (name) => {
  const file = path.join(CARDS, name);
  return fs.existsSync(file) ? `tyran://userdata/nikke-cards/${name}?${Math.round(fs.statSync(file).mtimeMs)}` : '';
};
const hasFb = (id, look) => (look === id ? CHARACTERS[id].fb : CHARACTERS[id].outfits?.[look]?.fb);
function cardOf(id, look = id) {
  return cardUrl(look + '.png') || cardUrl(`fb-${look}.png`) || (hasFb(id, look) ? `${NIKKE_IMAGES}/FB/${look}_00.png` : '') || CHARACTERS[id].art?.[look === id ? '' : look] || `${NIKKE_IMAGES}/sprite/si_${look}_00_s.png`;
}

// Her look drawn by the player page in a hidden window: the whole of her, standing, on nothing.
async function drawCard(id, outfit = '') {
  const url = await pageUrl(id, outfit);
  if (!url) return false;
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 360, height: 600, webPreferences: { offscreen: true, partition: 'persist:tyran-wallpaper', sandbox: true, backgroundThrottling: false } });
  try {
    win.webContents.setAudioMuted(true);
    await win.loadURL(url + (url.includes('?') ? '&' : '?') + 'card=1');
    const js = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js('!!(window.__tyran && (__tyran.ready || __tyran.failed))').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));
    const data = await js('window.__tyran && __tyran.ready ? __tyran.portrait(360, 600) : ""').catch(() => '');
    if (!/^data:image\/png;base64,/.test(data || '')) return false;
    fs.mkdirSync(CARDS, { recursive: true });
    fs.writeFileSync(path.join(CARDS, (outfit || id) + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    return true;
  } finally {
    win.destroy();
  }
}

// Cards still missing: Nikke-db's pictures fetched once (made small), and the downloaded looks drawn.
// `onDone` after each one that was made.
let carding = null;
function makeCards(onDone = () => {}) {
  carding ||= (async () => {
    const { nativeImage } = require('electron');
    fs.mkdirSync(CARDS, { recursive: true });
    const fbs = Object.entries(CHARACTERS).flatMap(([id, c]) => [id, ...Object.keys(c.outfits || {})].filter((look) => hasFb(id, look)));
    for (const look of fbs) {
      if (fs.existsSync(path.join(CARDS, `fb-${look}.png`))) continue;
      try {
        const res = await fetch(`${NIKKE_IMAGES}/FB/${look}_00.png`);
        if (!res.ok) continue;
        let img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
        if (img.isEmpty()) continue;
        if (img.getSize().height > 600) img = img.resize({ height: 600, quality: 'best' });
        fs.writeFileSync(path.join(CARDS, `fb-${look}.png`), img.toPNG());
        onDone();
      } catch {
        /* the next time */
      }
    }
    for (const id of Object.keys(CHARACTERS)) {
      if (!installed(id)) continue;
      for (const o of ['', ...Object.keys(CHARACTERS[id].outfits || {})]) {
        if (o && !outfitInstalled(id, o)) continue;
        if (fs.existsSync(path.join(CARDS, (o || id) + '.png'))) continue;
        if (await drawCard(id, o).catch(() => false)) onDone();
      }
    }
  })().finally(() => (carding = null));
  return carding;
}

function folderBytes(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? folderBytes(p) : fs.statSync(p).size;
  }
  return n;
}

// what downloading her takes now: her own (unless she is downloaded) and each outfit missing
function missingBytes(id) {
  const c = CHARACTERS[id];
  return (installed(id) ? 0 : c.download) + Object.entries(c.outfits || {}).reduce((n, [o, x]) => n + (outfitInstalled(id, o) ? 0 : x.bytes), 0);
}
function list() {
  return Object.entries(CHARACTERS).map(([id, c]) => {
    const on = installed(id);
    const outfits = Object.entries(c.outfits || {}).map(([o, x]) => ({
      id: o,
      name: x.name,
      installed: outfitInstalled(id, o),
      thumb: `${NIKKE_IMAGES}/sprite/si_${o}_00_s.png`,
      card: cardOf(id, o),
      preview: outfitInstalled(id, o) ? previewUrl(o) : '',
    }));
    const all = c.download + Object.values(c.outfits || {}).reduce((n, x) => n + x.bytes, 0);
    return {
      id,
      name: c.name,
      // (everything: her and all her outfits)
      download: all,
      bytes: on ? folderBytes(dirOf(id)) : all + (c.bytes - c.download),
      missing: missingBytes(id),
      installed: on,
      complete: on && outfits.every((o) => o.installed),
      installing: job?.id === id ? job.progress : null,
      thumb: `${NIKKE_IMAGES}/sprite/si_${id}_00_s.png`,
      card: cardOf(id),
      preview: on ? previewUrl(id) : '',
      weapon: c.weapon,
      voice: c.voice?.pack || 'none',
      outfits,
    };
  });
}

// ---------------------------------------------------------------- downloading
async function fetchOk(url, opts = {}) {
  const res = await fetch(url, { redirect: 'follow', ...opts });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}: ${url}`);
  return res;
}

async function readBody(res, onBytes, signal) {
  const chunks = [];
  for await (const c of res.body) {
    if (signal?.aborted) throw new Error(t('Đã hủy'));
    chunks.push(Buffer.from(c));
    onBytes(c.length);
  }
  return Buffer.concat(chunks);
}

// The entries of a zip on the web, from its central directory (read by range, ~200 KB).
async function remoteZip(url) {
  const head = await fetchOk(url, { method: 'HEAD' });
  const size = Number(head.headers.get('content-length'));
  const final = head.url || url;
  const range = async (a, b) => Buffer.from(await (await fetchOk(final, { headers: { Range: `bytes=${a}-${b}` } })).arrayBuffer());
  const tail = await range(Math.max(0, size - 65558), size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(t('Gói giọng nói không đọc được'));
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff) {
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    const z = await range(Number(tail.readBigUInt64LE(loc + 8)), Number(tail.readBigUInt64LE(loc + 8)) + 55);
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOff = Number(z.readBigUInt64LE(48));
  }
  const cd = await range(cdOff, cdOff + cdSize - 1);
  const entries = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.length; i++) {
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    let off = cd.readUInt32LE(p + 42);
    for (let x = p + 46 + nlen; x < p + 46 + nlen + xlen; ) {
      const id = cd.readUInt16LE(x);
      const sz = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) (usize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (off === 0xffffffff) off = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + sz;
    }
    entries.push({ name: cd.toString('utf8', p + 46, p + 46 + nlen), method: cd.readUInt16LE(p + 10), csize, usize, off });
    p += 46 + nlen + xlen + clen;
  }
  return { url: final, size, entries };
}

// The models: lobby (<id>/<id>_00), cover and aim, each a skeleton, an atlas and its pictures.
const RIGS = { lobby: '', cover: 'cover/', aim: 'aim/' };
// models worn with a named skin, as Nikke-db shows them (Snow White's gun in battle)
const SKINS = { c220: { cover: ['default', 'weapon_1'], aim: ['default', 'weapon_1'] } };
const rigName = (id, rig) => (rig === 'lobby' ? `${id}_00` : `${id}_${rig}_00`);
// the Spine version a skeleton file was made with (its header names it)
const spineOf = (skel) => (/\b4\.1\./.test(skel.subarray(0, 80).toString('latin1')) ? '4.1' : '4.0');

function saver(dir) {
  return (rel, buf) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), buf);
  };
}

// The three models of `id` (her own, or an outfit's) from Nikke-db into `dir`.
async function modelsInto(dir, id, tick, signal) {
  const save = saver(dir);
  const rigs = {};
  let spine = '4.0';
  for (const [rig, sub] of Object.entries(RIGS)) {
    const name = rigName(id, rig);
    const base = `${NIKKE_DB}/${id}/${sub}${name}`;
    const atlas = (await readBody(await fetchOk(base + '.atlas', { signal }), tick, signal)).toString('utf8').replace(/^﻿/, '');
    const pages = [...new Set(atlas.split(/\r?\n/).filter((l) => /^[^\s:]+\.(png|webp|jpg)$/i.test(l.trim()) && !/^\s/.test(l)).map((l) => l.trim()))];
    if (!pages.length || pages.some((p) => p.includes('/') || p.includes('\\'))) throw new Error(t('Mô hình không đọc được: ') + name);
    const skel = await readBody(await fetchOk(base + '.skel', { signal }), tick, signal);
    if (rig === 'lobby') spine = spineOf(skel);
    save(`${sub}${name}.atlas`, Buffer.from(atlas));
    save(`${sub}${name}.skel`, skel);
    for (const p of pages) save(sub + p, await readBody(await fetchOk(`${NIKKE_DB}/${id}/${sub}${p}`, { signal }), tick, signal));
    rigs[rig] = { skel: `${sub}${name}.skel`, atlas: `${sub}${name}.atlas`, ...(SKINS[id]?.[rig] ? { skins: SKINS[id][rig] } : {}) };
  }
  return { rigs, spine };
}

// A runtime into `dir`, exactly the release it was checked as (once).
async function runtimeInto(dir, ver, tick, signal) {
  const rt = RUNTIMES[ver];
  if (!rt) throw new Error(t('Mô hình dùng bản Spine chưa hỗ trợ: ') + ver);
  if (fs.existsSync(path.join(dir, rt.file))) return;
  const buf = await readBody(await fetchOk(rt.url, { signal }), tick, signal);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== rt.sha256) throw new Error(t('Bộ chạy Spine tải về không khớp bản đã kiểm tra'));
  fs.writeFileSync(path.join(dir, rt.file), buf);
}

// Her voice lines (or only the files named), read out of the pack by range: in one when they sit
// together in it, else one by one.
async function voicesInto(dir, id, voice, tick, signal, sub = 'voice/') {
  const save = saver(dir);
  const pack = voice?.pack || 'jp';
  if (!VOICE_ZIPS[pack]) return []; // (none: she stays silent)
  const zip = await remoteZip(VOICE_ZIPS[pack]);
  const mine = zip.entries.filter((e) => e.name.startsWith(`${pack}/${id}/`) && /\.(wav|ogg|mp3)$/i.test(e.name) && (!voice?.files || voice.files.includes(path.basename(e.name))));
  const voices = [];
  if (!mine.length) return voices;
  const take = (buf, a, e) => {
    const p = e.off - a;
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(t('Gói giọng nói không đọc được'));
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const raw = buf.subarray(start, start + e.csize);
    const file = path.basename(e.name);
    if (!/^[\w.-]+$/.test(file)) return;
    save(sub + file, e.method === 8 ? zlib.inflateRawSync(raw) : raw);
    voices.push(file);
  };
  const span = (list) => [Math.min(...list.map((e) => e.off)), Math.min(zip.size - 1, Math.max(...list.map((e) => e.off + e.csize)) + 1024)];
  const [a, b] = span(mine);
  const groups = b - a > 3 * mine.reduce((n, e) => n + e.csize, 0) + 65536 ? mine.map((e) => [e]) : [mine];
  for (const g of groups) {
    const [x, y] = span(g);
    const buf = await readBody(await fetchOk(zip.url, { headers: { Range: `bytes=${x}-${y}` }, signal }), tick, signal);
    for (const e of g) take(buf, x, e);
  }
  return voices.sort();
}

let job = null; // the one download running: { id, outfit, progress: { done, total }, abort, promise }

function startJob(id, outfit, total, onProgress, work) {
  if (job) return job.id === id && job.outfit === outfit ? job.promise : Promise.reject(new Error(t('Đang tải một phần khác, hãy chờ nó xong')));
  const ctl = new AbortController();
  const progress = { done: 0, total };
  let last = 0;
  const tick = (n) => {
    progress.done += n;
    const t = Date.now();
    if (t - last > 150) (last = t), onProgress({ ...progress });
  };
  job = { id, outfit, progress, abort: () => ctl.abort() };
  job.promise = (async () => {
    await work(tick, ctl.signal);
    progress.done = progress.total;
    onProgress({ ...progress, finished: true });
  })().finally(() => (job = null));
  return job.promise.then(() => list().find((c) => c.id === id));
}

// Downloading her downloads all of her: her own models, voices, runtime and the page (beside the old
// copy, then put in place), then every outfit still missing. A character downloaded before keeps what
// she has and gets the rest.
function install(id, onProgress = () => {}) {
  if (!known(id)) return Promise.reject(new Error(t('Không có nhân vật này')));
  return startJob(id, '', missingBytes(id), onProgress, async (tick, signal) => {
    if (!installed(id)) await installBase(id, tick, signal);
    for (const o of Object.keys(CHARACTERS[id].outfits || {})) if (!outfitInstalled(id, o)) await outfitInto(id, o, tick, signal);
  });
}

async function installBase(id, tick, signal) {
  const dir = dirOf(id);
  const tmp = dir + '-part';
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const { rigs, spine } = await modelsInto(tmp, id, tick, signal);
    await runtimeInto(tmp, spine, tick, signal);
    saver(tmp)('spine-LICENSE.txt', Buffer.from(await (await fetchOk(LICENSE, { signal })).arrayBuffer()));
    const voices = await voicesInto(tmp, id, CHARACTERS[id].voice, tick, signal);
    const old = manifestOf(id);
    // (her outfits, their voices and the runtimes they needed stay)
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (f === 'outfit' || f.startsWith('voice-') || Object.values(RUNTIMES).some((rt) => rt.file === f && !fs.existsSync(path.join(tmp, f)))) fs.renameSync(path.join(dir, f), path.join(tmp, f));
    }
    const m = { id, name: CHARACTERS[id].name, weapon: CHARACTERS[id].weapon, rigs, spine, voices, outfits: old?.outfits || {}, installed: Date.now() };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(m, null, 1));
    copyPage(tmp);
    syncBackdrop(tmp);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Whose voice an outfit speaks with: a unit of her own (`from`) with its own Japanese lines, or its
// hurt sounds when she has no Japanese lines either, speaks with them (voice-<unit>/); else hers.
function outfitVoice(id, x) {
  if (!x.from || !x.voice) return null;
  if (x.voice.pack === 'jp' || (x.voice.files?.length && CHARACTERS[id].voice?.pack !== 'jp')) return x.voice;
  return null;
}

// One outfit: its models into outfit/<outfit>/, the runtime they need, a unit's own voice.
async function outfitInto(id, outfit, tick, signal) {
  const o = outfitOf(id, outfit);
  const dir = dirOf(id);
  const final = path.join(dir, 'outfit', outfit);
  const tmp = final + '-part';
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const { rigs, spine } = await modelsInto(tmp, outfit, tick, signal);
    await runtimeInto(dir, spine, tick, signal);
    for (const r of Object.values(rigs)) for (const k of ['skel', 'atlas']) r[k] = `outfit/${outfit}/${r[k]}`;
    const v = outfitVoice(id, o);
    const extra = { weapon: o.weapon || CHARACTERS[id].weapon };
    if (v) {
      extra.voiceDir = `voice-${o.from}/`;
      // (once for a unit: its outfits speak with the same lines)
      const had = Object.values(manifestOf(id).outfits || {}).find((x) => x.voiceDir === extra.voiceDir)?.voices;
      extra.voices = had || (await voicesInto(dir, o.from, v, tick, signal, extra.voiceDir));
    }
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    const m = manifestOf(id);
    m.outfits = { ...(m.outfits || {}), [outfit]: { name: o.name, rigs, spine, ...extra } };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// One outfit alone (the developer's tests; Settings downloads her whole).
async function installOutfit(id, outfit, onProgress = () => {}) {
  const o = outfitOf(id, outfit);
  if (!o) throw new Error(t('Không có trang phục này'));
  if (!installed(id)) await startJob(id, '', CHARACTERS[id].download, onProgress, (tick, signal) => installBase(id, tick, signal));
  return startJob(id, outfit, o.bytes, onProgress, (tick, signal) => outfitInto(id, outfit, tick, signal));
}

function cancel() {
  job?.abort();
  return true;
}

function remove(id) {
  if (!known(id) || job?.id === id) return false;
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  for (const k of [id, ...Object.keys(CHARACTERS[id].outfits || {})]) {
    fs.rmSync(previewFile(k), { force: true });
    fs.rmSync(path.join(CARDS, k + '.png'), { force: true });
  }
  return true;
}

function removeOutfit(id, outfit) {
  if (!outfitOf(id, outfit) || job?.id === id) return false;
  const m = manifestOf(id);
  if (m?.outfits?.[outfit]) {
    delete m.outfits[outfit];
    fs.writeFileSync(path.join(dirOf(id), 'manifest.json'), JSON.stringify(m, null, 1));
  }
  fs.rmSync(path.join(dirOf(id), 'outfit', outfit), { recursive: true, force: true });
  fs.rmSync(previewFile(outfit), { force: true });
  fs.rmSync(path.join(CARDS, outfit + '.png'), { force: true });
  return true;
}

// TyranWeb's player page, refreshed beside every downloaded character (it comes with the app)
function copyPage(dir) {
  for (const f of PAGE_FILES) fs.copyFileSync(path.join(PAGE, f), path.join(dir, f));
}

// The page a NIKKE wallpaper shows (null until the character is downloaded), in one of her
// outfits when that one is downloaded. (The logo behind her is made first, the first time: a few
// seconds at most, without it when the sites are out of reach.)
async function pageUrl(id, outfit = '') {
  if (!installed(id)) return null;
  await Promise.race([ensureLogo(), new Promise((r) => setTimeout(r, 12000))]);
  try {
    copyPage(dirOf(id));
    syncBackdrop(dirOf(id));
    syncLogo(dirOf(id));
    // (what TyranWeb knows of her now: her gun, for a character downloaded before it did)
    const m = manifestOf(id);
    const before = JSON.stringify(m);
    m.weapon = CHARACTERS[id].weapon;
    for (const [o, x] of Object.entries(m.outfits || {})) x.weapon = CHARACTERS[id].outfits?.[o]?.weapon || m.weapon;
    if (JSON.stringify(m) !== before) fs.writeFileSync(path.join(dirOf(id), 'manifest.json'), JSON.stringify(m, null, 1));
  } catch {
    /* the copy there still works */
  }
  return `livewp://nikke-${id}/index.html${outfitInstalled(id, outfit) ? '?o=' + outfit : ''}`;
}

// The user's own picture behind her, kept in userData/live/nikke-backdrop and copied beside each
// downloaded character (the page can only read its own folder), under a new name each time so the
// page never shows an old one.
const IMAGE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const BACKDROP = path.join(LIVE_WALLPAPERS, 'nikke-backdrop');
function syncBackdrop(dir) {
  const want = fs.existsSync(BACKDROP) ? fs.readdirSync(BACKDROP).filter((f) => f.startsWith('backdrop-')) : [];
  for (const f of fs.readdirSync(dir)) if (f.startsWith('backdrop-') && !want.includes(f)) fs.rmSync(path.join(dir, f), { force: true });
  for (const f of want) if (!fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(BACKDROP, f), path.join(dir, f));
}
function setBackdrop(file) {
  if (file && (!IMAGE.test(file) || !fs.statSync(file).isFile())) throw new Error(t('Hãy chọn một file ảnh'));
  const name = file ? `backdrop-${Date.now().toString(36)}${path.extname(file).toLowerCase()}` : '';
  fs.rmSync(BACKDROP, { recursive: true, force: true });
  if (name) {
    fs.mkdirSync(BACKDROP, { recursive: true });
    fs.copyFileSync(file, path.join(BACKDROP, name));
  }
  for (const id of Object.keys(CHARACTERS)) if (fs.existsSync(dirOf(id))) syncBackdrop(dirOf(id));
  // (Project SEKAI's characters stand on the same backdrop)
  for (const d of fs.existsSync(LIVE_WALLPAPERS) ? fs.readdirSync(LIVE_WALLPAPERS) : []) if (/^sekai-\d+$/.test(d)) syncBackdrop(path.join(LIVE_WALLPAPERS, d));
  return name;
}

// The game's logo behind her (NIKKE · GODDESS OF VICTORY), white, cut out of the official site's
// loading picture (nikke-en.com), where it is drawn dark on light; else Wikimedia Commons' copy of
// it (PD-textlogo, from the same site, smaller). Its shape is traced into an SVG (outline.js) so
// that it stays sharp however big it is drawn: made once into userData/live/nikke-logo/logo.svg,
// then copied beside each character as nikke-logo.svg.
const LOGO = path.join(LIVE_WALLPAPERS, 'nikke-logo', 'logo.svg');
const LOGO_SITE = 'https://nikke-en.com/';
const LOGO_PICTURE = 'https://nikke-en.com/assets/loading_bg-839b2d01.jpg';
const LOGO_COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/archive/2/24/20241104160848%21Nikke_%E2%80%93_Goddess_of_Victory_logo.png';
// the site's loading picture under its current name (it changes with the site's builds)
async function loadingPicture() {
  try {
    return Buffer.from(await (await fetchOk(LOGO_PICTURE, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
  } catch {
    const html = await (await fetchOk(LOGO_SITE, { signal: AbortSignal.timeout(15000) })).text();
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/g)].map((m) => new URL(m[1], LOGO_SITE).href);
    for (const s of scripts) {
      const name = /loading_bg-[\w-]+\.jpg/.exec(await (await fetchOk(s, { signal: AbortSignal.timeout(15000) })).text())?.[0];
      if (name) return Buffer.from(await (await fetchOk(new URL('/assets/' + name, LOGO_SITE).href, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
    }
    throw new Error('no loading picture');
  }
}
// The logo's shape out of a picture of it: dark ink (on light, or on nothing) in the middle of a
// big picture, or anywhere in a small one; as opaque as the ink is dark (the background's light
// texture left out), then traced.
function cutLogo(buf) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(buf);
  const { width: w, height: h } = img.getSize();
  if (!w || !h) return null;
  const px = img.toBitmap(); // (BGRA)
  const ink = (i) => (px[i + 3] / 255) * (1 - (px[i] + px[i + 1] + px[i + 2]) / 765);
  const [ax, ay, bx, by] = w >= 1200 ? [0.3, 0.2, 0.7, 0.52].map((f, k) => Math.round(f * (k % 2 ? h : w))) : [0, 0, w, h];
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      if (ink((y * w + x) * 4) < 0.6) continue;
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
  }
  const [cw, ch] = [x1 - x0 + 7, y1 - y0 + 7];
  if (x1 < 0 || cw < 150 || cw / ch < 1.5 || cw / ch > 2.5) return null;
  const a = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const [sx, sy] = [x0 - 3 + x, y0 - 3 + y];
      a[y * cw + x] = sx < 0 || sy < 0 || sx >= w || sy >= h ? 0 : Math.min(1, Math.max(0, (ink((sy * w + sx) * 4) - 0.2) / 0.62));
    }
  }
  const d = require('./outline').trace(a, cw, ch);
  return d ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cw} ${ch}" width="${cw * 8}" height="${ch * 8}"><path fill="#fff" fill-rule="evenodd" d="${d}"/></svg>` : null;
}
let logoJob = null;
function ensureLogo() {
  if (fs.existsSync(LOGO)) return Promise.resolve(true);
  logoJob ||= (async () => {
    let svg = null;
    try {
      svg = cutLogo(await loadingPicture());
    } catch {
      /* the site is out of reach: Commons' copy */
    }
    if (!svg) svg = cutLogo(Buffer.from(await (await fetchOk(LOGO_COMMONS, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'TyranWeb' } })).arrayBuffer()));
    if (!svg) return false;
    fs.mkdirSync(path.dirname(LOGO), { recursive: true });
    fs.rmSync(path.join(path.dirname(LOGO), 'logo.png'), { force: true }); // (an enlarged picture, before)
    fs.writeFileSync(LOGO, svg);
    return true;
  })()
    .catch(() => false)
    .finally(() => (logoJob = null));
  return logoJob;
}
function syncLogo(dir) {
  const there = path.join(dir, 'nikke-logo.svg');
  fs.rmSync(path.join(dir, 'nikke-logo.png'), { force: true });
  if (fs.existsSync(LOGO) && fs.statSync(LOGO).size !== (fs.existsSync(there) ? fs.statSync(there).size : -1)) fs.copyFileSync(LOGO, there);
}

module.exports = { list, install, installOutfit, cancel, remove, removeOutfit, pageUrl, setBackdrop, installed, makeCards, drawCard, CHARACTERS, helpers: { fetchOk, readBody, saver, folderBytes, syncBackdrop } };
