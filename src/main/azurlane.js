'use strict';
// Azur Lane live wallpapers, set up on the user's request like NIKKE's: nothing of the game ships
// with TyranWeb. A ship is downloaded whole (every Live2D skin of hers) into
// userData/live/azur-<ship>/ and shown by TyranWeb's own player page (src/live/azurlane):
//  - her Live2D models from MilkyLan/AzurLane-Live2d (extracted from the game; the originals, not
//    the censored "_hx" copies), each skin with its motions and textures (WebP when there are);
//  - her lobby background, voice lines and card picture from Fernando2603/AzurLane (EN data);
//  - the Live2D runtime for the web: Live2D's own Cubism Core (cubism.live2d.com, its redistributable
//    code), PixiJS 6.5.10 and pixi-live2d-display 0.4.0 (both MIT, from npm, SHA-256 checked).
// The roster (src/main/azur-roster.json) was made from those lists and the game's EN skin table
// (AzurLaneTools/AzurLaneData): ships with their skins, each skin's model folder, lines, background.
const fs = require('fs');
const path = require('path');
const { LIVE_WALLPAPERS, ROOT, USER_WALLPAPERS } = require('./protocol');
const { fetchOk, readBody, saver, folderBytes } = require('./nikke').helpers;
const { t } = require('./i18n');

const MODELS = 'https://raw.githubusercontent.com/MilkyLan/AzurLane-Live2d/main/live2d';
const VOICES = 'https://raw.githubusercontent.com/Fernando2603/AzurLane/main/audio/voiceline';
const RUNTIME = [
  { file: 'live2dcubismcore.min.js', url: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js' },
  { file: 'pixi.min.js', url: 'https://unpkg.com/pixi.js@6.5.10/dist/browser/pixi.min.js', sha256: '403f2f2ee8145fa17f60c5c89403056efe2680e5096ec2762036486914ed19c5' },
  { file: 'cubism4.min.js', url: 'https://unpkg.com/pixi-live2d-display@0.4.0/dist/cubism4.min.js', sha256: 'af1267e6d52759b245766c578d905bfa025b532d5c3cc727c370957c4409e21b' },
];
const RUNTIME_BYTES = 800_000;
const PAGE = path.join(ROOT, 'src', 'live', 'azurlane');
const PAGE_FILES = ['index.html', 'player.js'];
// { ship: { name, looks: [{ id, name, dir, webp, bytes, bg, card, voice: { line: skin it is from }, calib }] } }
const SHIPS = require('./azur-roster.json');
// what the game itself has for each skin (made from AzurLaneTools/AzurLaneData's EN tables):
// { skin: { offset: [x, y], range: { param: [min, max] }, cues: 1, drags: [its ship_l2d entries] } }
const GAME = require('./azur-game.json');

const dirOf = (id) => path.join(LIVE_WALLPAPERS, 'azur-' + id);
const known = (id) => Object.hasOwn(SHIPS, id);
const lookOf = (id, skin) => SHIPS[id]?.looks.find((l) => l.id === skin) || null;
const manifestOf = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
};
const installed = (id) => known(id) && !!manifestOf(id) && RUNTIME.every((r) => fs.existsSync(path.join(dirOf(id), r.file)));
const lookInstalled = (id, skin) => installed(id) && !!manifestOf(id)?.looks?.[skin] && fs.existsSync(path.join(dirOf(id), 'look', skin));
const previewFile = (key) => path.join(USER_WALLPAPERS, 'ba-previews', `azur_${key}.jpg`);
const previewUrl = (key) => {
  const pic = previewFile(key);
  return fs.existsSync(pic) ? `tyran://userdata/ba-previews/azur_${key}.jpg?${Math.round(fs.statSync(pic).mtimeMs)}` : '';
};

// ---------------------------------------------------------------- cards
// Each skin's card: drawn by TyranWeb from her model once downloaded (azur-cards/<skin>.png), else
// her painting from Fernando2603's data (loaded by the card as it comes into view).
const CARDS = path.join(USER_WALLPAPERS, 'azur-cards');
const cardUrl = (name) => {
  const file = path.join(CARDS, name);
  return fs.existsSync(file) ? `tyran://userdata/azur-cards/${name}?${Math.round(fs.statSync(file).mtimeMs)}` : '';
};
const cardOf = (look) => cardUrl(look.id + '.png') || look.card || '';

async function drawCard(id, skin) {
  const url = pageUrl(id, skin);
  if (!url) return false;
  const { BrowserWindow } = require('electron');
  // (the card's own shape: a skin drawn with its scene fills it)
  const win = new BrowserWindow({ show: false, width: 360, height: 400, webPreferences: { offscreen: true, partition: 'persist:tyran-wallpaper', sandbox: true, backgroundThrottling: false } });
  try {
    win.webContents.setAudioMuted(true);
    await win.loadURL(url + '&card=1');
    const js = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 120 && !(await js('!!(window.__tyran && (__tyran.ready || __tyran.failed))').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));
    const data = await js('window.__tyran && __tyran.ready ? __tyran.portrait(360, 400) : ""').catch(() => '');
    if (!/^data:image\/png;base64,/.test(data || '')) return false;
    fs.mkdirSync(CARDS, { recursive: true });
    fs.writeFileSync(path.join(CARDS, skin + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    return true;
  } finally {
    win.destroy();
  }
}

let carding = null;
function makeCards(onDone = () => {}) {
  carding ||= (async () => {
    for (const [id, s] of Object.entries(SHIPS)) {
      if (!installed(id)) continue;
      for (const look of s.looks) {
        if (!lookInstalled(id, look.id) || fs.existsSync(path.join(CARDS, look.id + '.png'))) continue;
        if (await drawCard(id, look.id).catch(() => false)) onDone();
      }
    }
  })().finally(() => (carding = null));
  return carding;
}

// ---------------------------------------------------------------- the list
const missingBytes = (id) => (installed(id) ? 0 : RUNTIME_BYTES) + SHIPS[id].looks.reduce((n, l) => n + (lookInstalled(id, l.id) ? 0 : l.bytes), 0);
function list() {
  return Object.entries(SHIPS)
    .map(([id, s]) => {
      const on = installed(id);
      const [first, ...rest] = s.looks;
      const all = RUNTIME_BYTES + s.looks.reduce((n, l) => n + l.bytes, 0);
      return {
        id,
        name: s.name,
        // (her first skin is the card's own look; the others are her outfits)
        look: first.name,
        lookId: first.id,
        download: all,
        bytes: on ? folderBytes(dirOf(id)) : all,
        missing: missingBytes(id),
        installed: on && lookInstalled(id, first.id),
        complete: on && s.looks.every((l) => lookInstalled(id, l.id)),
        installing: job?.id === id ? job.progress : null,
        thumb: first.card,
        card: cardOf(first),
        preview: on ? previewUrl(first.id) : '',
        outfits: rest.map((l) => ({ id: l.id, name: l.name, installed: lookInstalled(id, l.id), thumb: l.card, card: cardOf(l), preview: lookInstalled(id, l.id) ? previewUrl(l.id) : '' })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- downloading
let job = null;
function startJob(id, total, onProgress, work) {
  if (job) return job.id === id ? job.promise : Promise.reject(new Error(t('Đang tải một phần khác, hãy chờ nó xong')));
  const ctl = new AbortController();
  const progress = { done: 0, total };
  let last = 0;
  const tick = (n) => {
    progress.done += n;
    const t = Date.now();
    if (t - last > 150) (last = t), onProgress({ ...progress });
  };
  job = { id, progress, abort: () => ctl.abort() };
  job.promise = (async () => {
    await work(tick, ctl.signal);
    progress.done = progress.total;
    onProgress({ ...progress, finished: true });
  })().finally(() => (job = null));
  return job.promise.then(() => list().find((c) => c.id === id));
}

const MOTION_LINE = { login: 'login', home: 'home', main_1: 'main1', main_2: 'main2', main_3: 'main3', touch_body: 'touch', touch_special: 'touch2', touch_head: 'headtouch', mission: 'mission', mission_complete: 'mission_complete', mail: 'mail', complete: 'expedition', wedding: 'propose' };

// A skin's entry in her manifest: its files, and what TyranWeb and the game know of it (refreshed
// whenever she is shown, so what a newer TyranWeb knows reaches skins downloaded before).
const lookEntry = (look, files) => ({ ...files, name: look.name, lines: MOTION_LINE, calib: look.calib || {}, game: GAME[look.id] || {} });
function refresh(id) {
  const m = manifestOf(id);
  if (!m?.looks) return;
  let changed = false;
  for (const [skin, l] of Object.entries(m.looks)) {
    const look = lookOf(id, skin);
    if (!look) continue;
    const next = lookEntry(look, { model: l.model, bg: l.bg, voices: l.voices });
    if (JSON.stringify(next) !== JSON.stringify(l)) (m.looks[skin] = next), (changed = true);
  }
  if (changed) fs.writeFileSync(path.join(dirOf(id), 'manifest.json'), JSON.stringify(m));
}

// One skin: its model (the textures as WebP when there are; the rig's own touch areas named for the
// runtime), its background and its lines, into look/<skin>/.
async function lookInto(id, look, tick, signal) {
  const dir = dirOf(id);
  const final = path.join(dir, 'look', look.id);
  const tmp = final + '-part';
  fs.rmSync(tmp, { recursive: true, force: true });
  const save = saver(tmp);
  const get = async (url) => readBody(await fetchOk(url, { signal }), tick, signal);
  try {
    const base = `${MODELS}/${look.dir}/`;
    const json = JSON.parse((await get(`${base}${look.dir}.model3.json`)).toString('utf8').replace(/^﻿/, ''));
    const refs = json.FileReferences || {};
    const safe = (p) => typeof p === 'string' && !p.includes('..') && !/^[a-z]+:/i.test(p) && !p.startsWith('/');
    const files = [refs.Moc, refs.Physics, refs.Pose, ...(refs.Textures || []), ...Object.values(refs.Motions || {}).flatMap((g) => g.map((m) => m.File))].filter(safe);
    if (look.webp) refs.Textures = (refs.Textures || []).map((t) => t.replace(/\.png$/i, '.webp'));
    for (const f of new Set(files.map((f) => (look.webp && /^textures\/.+\.png$/i.test(f) ? f.replace(/\.png$/i, '.webp') : f)))) save('model/' + f, await get(base + encodeURI(f)));
    // (the rig's own touch areas: its TouchHead / TouchBody / TouchSpecial pictures)
    json.HitAreas = [
      { Id: 'TouchSpecial', Name: 'special' },
      { Id: 'TouchHead', Name: 'head' },
      { Id: 'TouchBody', Name: 'body' },
    ];
    save('model/model.model3.json', Buffer.from(JSON.stringify(json)));
    let bg = '';
    if (look.bg) {
      save('bg.png', await get(look.bg));
      bg = `look/${look.id}/bg.png`;
    }
    const voices = {};
    for (const [line, from] of Object.entries(look.voice || {})) {
      try {
        save(`voice/${line}.ogg`, await get(`${VOICES}/${from}/${line}.ogg`));
        voices[line] = `look/${look.id}/voice/${line}.ogg`;
      } catch {
        /* a line missing there: she says nothing then */
      }
    }
    if (GAME[look.id]?.bgm) await music(GAME[look.id].bgm); // (a skin with its own song)
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    const m = manifestOf(id);
    m.looks = { ...(m.looks || {}), [look.id]: lookEntry(look, { model: `look/${look.id}/model/model.model3.json`, bg, voices }) };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Her whole: the runtime and the page (once), then every skin still missing.
function install(id, onProgress = () => {}) {
  if (!known(id)) return Promise.reject(new Error(t('Không có tàu này')));
  return startJob(id, missingBytes(id), onProgress, async (tick, signal) => {
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const r of RUNTIME) {
      if (fs.existsSync(path.join(dir, r.file))) continue;
      const buf = await readBody(await fetchOk(r.url, { signal }), tick, signal);
      if (r.sha256 && require('crypto').createHash('sha256').update(buf).digest('hex') !== r.sha256) throw new Error(t('Bộ chạy Live2D tải về không khớp bản đã kiểm tra'));
      if (!r.sha256 && !/Live2D Cubism Core/.test(buf.subarray(0, 400).toString('utf8'))) throw new Error(t('Không tải được Live2D Cubism Core'));
      fs.writeFileSync(path.join(dir, r.file), buf);
    }
    if (!manifestOf(id)) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: SHIPS[id].name, looks: {} }, null, 1));
    copyPage(dir);
    for (const look of SHIPS[id].looks) if (!lookInstalled(id, look.id)) await lookInto(id, look, tick, signal);
    await music(DEFAULT_MUSIC);
  });
}

function cancel() {
  job?.abort();
  return true;
}

function remove(id) {
  if (!known(id) || job?.id === id) return false;
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  for (const l of SHIPS[id].looks) {
    fs.rmSync(previewFile(l.id), { force: true });
    fs.rmSync(path.join(CARDS, l.id + '.png'), { force: true });
  }
  return true;
}

function copyPage(dir) {
  for (const f of PAGE_FILES) fs.copyFileSync(path.join(PAGE, f), path.join(dir, f));
}

// The page an Azur Lane wallpaper shows: her skin (her first when none is given, or it is missing).
function pageUrl(id, skin = '') {
  if (!installed(id)) return null;
  try {
    copyPage(dirOf(id));
    refresh(id);
  } catch {
    /* the copy there still works */
  }
  music(DEFAULT_MUSIC); // (the lobby's own song, for the ships downloaded before it was)
  const s = lookInstalled(id, skin) ? skin : SHIPS[id].looks.find((l) => lookInstalled(id, l.id))?.id;
  return s ? `livewp://azur-${id}/index.html?s=${s}` : null;
}

// ---------------------------------------------------------------- lobby music
// The game's songs (Fernando2603's copies of its BGM, listed in azur-music.json as name: [title,
// seconds, KB]), each downloaded once when first wanted into live/azur-music/<name>.ogg, which the
// pages play as livewp://azur-music/<name>.ogg. The lobby's own is "main"; a skin may have its own.
const TRACKS = require('./azur-music.json');
const MUSIC = 'https://raw.githubusercontent.com/Fernando2603/AzurLane/main/audio/bgm/';
const MUSIC_DIR = path.join(LIVE_WALLPAPERS, 'azur-music');
const DEFAULT_MUSIC = 'main';
const fetching = new Map();
function music(name) {
  if (!Object.hasOwn(TRACKS, name)) return Promise.resolve(false);
  const file = path.join(MUSIC_DIR, name + '.ogg');
  if (fs.existsSync(file)) return Promise.resolve(true);
  if (!fetching.has(name)) {
    fetching.set(
      name,
      (async () => {
        const buf = await readBody(await fetchOk(MUSIC + encodeURIComponent(name) + '.ogg'), () => {});
        if (buf.subarray(0, 4).toString('latin1') !== 'OggS') throw new Error('not a song');
        fs.mkdirSync(MUSIC_DIR, { recursive: true });
        fs.writeFileSync(file + '.part', buf);
        fs.renameSync(file + '.part', file);
        return true;
      })()
        .catch(() => false)
        .finally(() => fetching.delete(name))
    );
  }
  return fetching.get(name);
}
const tracks = () => Object.entries(TRACKS).map(([name, [title, seconds, kb]]) => ({ name, title, seconds, kb, have: fs.existsSync(path.join(MUSIC_DIR, name + '.ogg')) }));

module.exports = { list, install, cancel, remove, pageUrl, installed, makeCards, drawCard, music, tracks, SHIPS, RUNTIME, RUNTIME_BYTES };
