'use strict';
// Project SEKAI live wallpapers, downloaded on the user's request like Azur Lane's: nothing of the
// game ships with TyranWeb. Its Live2D models come from sekai.best (the open-source sekai-viewer's
// asset storage), read the way sekai-viewer's own loader reads them, with TyranWeb's own code. A
// character is downloaded one outfit at a time (her card's own look comes with the first) into
// userData/live/sekai-<id>/, and shown by TyranWeb's own player page (src/live/sekai):
//  - each outfit's model (moc3, textures, physics) under look/<outfit>/model/;
//  - the motion library her outfit moves by (the game keeps a character's body gestures and faces
//    apart from her outfits), only the gestures and faces the page plays, under motion/<library>/;
//  - the Live2D runtime: Live2D's Cubism Core, PixiJS and pixi-live2d-display (as for Azur Lane).
// The roster (src/main/sekai-roster.json) was made from sekai.best's model list and the game's
// character names (sekai-master-db-en): the 26 characters' own and collab outfits, their sizes, the
// motion library of each.
const fs = require('fs');
const path = require('path');
const { LIVE_WALLPAPERS, ROOT, USER_WALLPAPERS } = require('./protocol');
const { fetchOk, readBody, saver, folderBytes, syncBackdrop } = require('./nikke').helpers;
const { RUNTIME, RUNTIME_BYTES } = require('./azurlane');
const { t } = require('./i18n');

const ASSETS = 'https://storage.sekai.best/sekai-live2d-assets/live2d';
const PORTRAIT = (id) => `https://storage.sekai.best/sekai-jp-assets/character/character_select/chr_tl_${id}.webp`;
const PAGE = path.join(ROOT, 'src', 'live', 'sekai');
const PAGE_FILES = ['index.html', 'player.js'];
// { chars: { id: { name, looks: [{ id, name, path, file, bytes, motion }] } }, motions: { library: { gestures, faces, bytes } } }
const { chars: CHARS, motions: LIBRARIES } = require('./sekai-roster.json');
// what the page plays: her gestures (body motions) and her happier faces (keep in step with the roster's maker)
const GESTURE = /-(pose|glad|nod|tilthead|nodtilthead|tiltheadnod|lookuptilthead|blushed|shy|piece|guts|wink|thumb|relief|greeting|lookleft|lookright|lookaround|musical|musicall|musicalr|cheek|smug|fidget|forward|delicious|think|shakehand|yurayura|wandahoi)\d*[a-c]?$/i;
const FACE = /^face_(normal|smile|ncsmile|ossmile|shy|sparkling|ncsparkling|surprise|ossurprise|play)_\d+/i;

const dirOf = (id) => path.join(LIVE_WALLPAPERS, 'sekai-' + id);
const known = (id) => Object.hasOwn(CHARS, id);
const lookOf = (id, look) => CHARS[id]?.looks.find((l) => l.id === look) || null;
const libKey = (motion) => motion.replace(/^motion\//, '').replace(/[^a-z0-9_]+/gi, '_');
const manifestOf = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
};
const base = (id) => known(id) && !!manifestOf(id) && RUNTIME.every((r) => fs.existsSync(path.join(dirOf(id), r.file)));
const libInstalled = (id, motion) => !!manifestOf(id)?.libs?.[libKey(motion)];
const lookInstalled = (id, look) => base(id) && !!manifestOf(id)?.looks?.[look] && fs.existsSync(path.join(dirOf(id), 'look', look));
// "downloaded" is her card's own look (her first), as for Azur Lane: her other outfits come one by one
const installed = (id) => base(id) && lookInstalled(id, CHARS[id].looks[0].id);
const previewFile = (key) => path.join(USER_WALLPAPERS, 'ba-previews', `sekai_${key}.jpg`);
const previewUrl = (key) => {
  const pic = previewFile(key);
  return fs.existsSync(pic) ? `tyran://userdata/ba-previews/sekai_${key}.jpg?${Math.round(fs.statSync(pic).mtimeMs)}` : '';
};

// ---------------------------------------------------------------- cards
// Each outfit's card: drawn by TyranWeb from her model once downloaded (sekai-cards/<outfit>.png),
// else her portrait from the game's character select.
const CARDS = path.join(USER_WALLPAPERS, 'sekai-cards');
const cardUrl = (name) => {
  const file = path.join(CARDS, name);
  return fs.existsSync(file) ? `tyran://userdata/sekai-cards/${name}?${Math.round(fs.statSync(file).mtimeMs)}` : '';
};

async function drawCard(id, look) {
  const url = pageUrl(id, look);
  if (!url) return false;
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 360, height: 400, webPreferences: { offscreen: true, partition: 'persist:tyran-wallpaper', sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadURL(url + '&card=1');
    const js = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 120 && !(await js('!!(window.__tyran && (__tyran.ready || __tyran.failed))').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 150));
    const data = await js('window.__tyran && __tyran.ready ? __tyran.portrait(360, 400) : ""').catch(() => '');
    if (!/^data:image\/png;base64,/.test(data || '')) return false;
    fs.mkdirSync(CARDS, { recursive: true });
    fs.writeFileSync(path.join(CARDS, look + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    return true;
  } finally {
    win.destroy();
  }
}

let carding = null;
function makeCards(onDone = () => {}) {
  carding ||= (async () => {
    for (const [id, c] of Object.entries(CHARS)) {
      if (!base(id)) continue;
      for (const look of c.looks) {
        if (!lookInstalled(id, look.id) || fs.existsSync(path.join(CARDS, look.id + '.png'))) continue;
        if (await drawCard(id, look.id).catch(() => false)) onDone();
      }
    }
  })().finally(() => (carding = null));
  return carding;
}

// ---------------------------------------------------------------- the list
// What one more outfit takes (its model, and its motion library unless she has it already or the
// first download brings it), and what her first download takes (the runtime, her card's look).
const libBytes = (motion) => LIBRARIES[motion]?.bytes || 0;
const firstBytes = (id) => {
  const first = CHARS[id].looks[0];
  return (base(id) ? 0 : RUNTIME_BYTES) + (lookInstalled(id, first.id) ? 0 : first.bytes) + (libInstalled(id, first.motion) ? 0 : libBytes(first.motion));
};
const outfitBytes = (id, look) => {
  if (lookInstalled(id, look.id)) return 0;
  const lib = libInstalled(id, look.motion) || (!installed(id) && look.motion === CHARS[id].looks[0].motion);
  return look.bytes + (lib ? 0 : libBytes(look.motion));
};
function list() {
  return Object.entries(CHARS)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, c]) => {
      const on = installed(id);
      const [first, ...rest] = c.looks;
      const download = RUNTIME_BYTES + first.bytes + libBytes(first.motion);
      return {
        id,
        name: c.name,
        look: first.name,
        lookId: first.id,
        each: true, // (her outfits come one at a time)
        download,
        bytes: base(id) ? folderBytes(dirOf(id)) : download,
        missing: firstBytes(id),
        installed: on,
        complete: on && c.looks.every((l) => lookInstalled(id, l.id)),
        installing: job?.id === id ? job.progress : null,
        thumb: PORTRAIT(id),
        card: cardUrl(first.id + '.png') || PORTRAIT(id),
        preview: on ? previewUrl(first.id) : '',
        outfits: rest.map((l) => ({ id: l.id, name: l.name, installed: lookInstalled(id, l.id), need: outfitBytes(id, l), thumb: PORTRAIT(id), card: cardUrl(l.id + '.png') || PORTRAIT(id), preview: lookInstalled(id, l.id) ? previewUrl(l.id) : '' })),
      };
    });
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
    const now = Date.now();
    if (now - last > 150) (last = now), onProgress({ ...progress });
  };
  job = { id, progress, abort: () => ctl.abort() };
  job.promise = (async () => {
    await work(tick, ctl.signal);
    progress.done = progress.total;
    onProgress({ ...progress, finished: true });
  })().finally(() => (job = null));
  return job.promise.then(() => list().find((c) => c.id === id));
}

// a file of sekai.best's (some paths there are only in lower case)
async function getAsset(rel, tick, signal) {
  try {
    return await readBody(await fetchOk(`${ASSETS}/${rel}`, { signal }), tick, signal);
  } catch (err) {
    if (signal.aborted || rel.toLowerCase() === rel) throw err;
    return readBody(await fetchOk(`${ASSETS}/${rel.toLowerCase()}`, { signal }), tick, signal);
  }
}
const safe = (p) => typeof p === 'string' && !p.includes('..') && !/^[a-z]+:/i.test(p) && !p.startsWith('/');
const writeManifest = (id, m) => fs.writeFileSync(path.join(dirOf(id), 'manifest.json'), JSON.stringify(m));

// A motion library: the gestures and faces the page plays, into motion/<library>/.
async function libraryInto(id, motion, tick, signal) {
  const key = libKey(motion);
  const final = path.join(dirOf(id), 'motion', key);
  const tmp = final + '-part';
  fs.rmSync(tmp, { recursive: true, force: true });
  const save = saver(tmp);
  try {
    const md = JSON.parse((await getAsset(`${motion}/BuildMotionData.json`, () => {}, signal)).toString('utf8').replace(/^﻿/, ''));
    const gestures = (md.motions || []).filter((n) => GESTURE.test(n) && safe(n));
    const faces = (md.expressions || []).filter((n) => FACE.test(n) && safe(n));
    // (a few hundred small files: six at a time)
    const files = [...gestures.map((n) => `motion/${n}.motion3.json`), ...faces.map((n) => `facial/${n}.motion3.json`)];
    let next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < files.length) {
          const f = files[next++];
          save(f, await getAsset(`${motion}/${f}`, tick, signal));
        }
      })
    );
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    const m = manifestOf(id);
    m.libs = { ...(m.libs || {}), [key]: { gestures, faces } };
    writeManifest(id, m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// One outfit: its model, into look/<outfit>/model/ (and the motion library it moves by).
async function lookInto(id, look, tick, signal) {
  if (!libInstalled(id, look.motion)) await libraryInto(id, look.motion, tick, signal);
  const final = path.join(dirOf(id), 'look', look.id);
  const tmp = final + '-part';
  fs.rmSync(tmp, { recursive: true, force: true });
  const save = saver(tmp);
  try {
    const dir = `model/${look.path}/`;
    const json = JSON.parse((await getAsset(dir + look.file, tick, signal)).toString('utf8').replace(/^﻿/, ''));
    const refs = json.FileReferences || {};
    for (const f of [refs.Moc, refs.Physics, ...(refs.Textures || [])].filter(safe)) save('model/' + f, await getAsset(dir + f, tick, signal));
    // (her motions are the library's: the page names them for the runtime itself)
    json.FileReferences = { Moc: refs.Moc, Textures: refs.Textures || [], ...(refs.Physics ? { Physics: refs.Physics } : {}) };
    save('model/model.model3.json', Buffer.from(JSON.stringify(json)));
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    const m = manifestOf(id);
    m.looks = { ...(m.looks || {}), [look.id]: { name: look.name, model: `look/${look.id}/model/model.model3.json`, lib: `motion/${libKey(look.motion)}/` } };
    writeManifest(id, m);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Her: the runtime and the page (once), her card's own look (once), then the outfit asked for.
function install(id, outfit = '', onProgress = () => {}) {
  if (!known(id)) return Promise.reject(new Error(t('Không có nhân vật này')));
  const want = [CHARS[id].looks[0], lookOf(id, outfit)].filter((l, i, all) => l && all.indexOf(l) === i && !lookInstalled(id, l.id));
  const total = (base(id) ? 0 : RUNTIME_BYTES) + want.reduce((n, l) => n + l.bytes, 0) + [...new Set(want.map((l) => l.motion))].filter((m) => !libInstalled(id, m)).reduce((n, m) => n + libBytes(m), 0);
  return startJob(id, total, onProgress, async (tick, signal) => {
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const r of RUNTIME) {
      if (fs.existsSync(path.join(dir, r.file))) continue;
      const buf = await readBody(await fetchOk(r.url, { signal }), tick, signal);
      if (r.sha256 && require('crypto').createHash('sha256').update(buf).digest('hex') !== r.sha256) throw new Error(t('Bộ chạy Live2D tải về không khớp bản đã kiểm tra'));
      if (!r.sha256 && !/Live2D Cubism Core/.test(buf.subarray(0, 400).toString('utf8'))) throw new Error(t('Không tải được Live2D Cubism Core'));
      fs.writeFileSync(path.join(dir, r.file), buf);
    }
    if (!manifestOf(id)) writeManifest(id, { id, name: CHARS[id].name, looks: {}, libs: {} });
    copyPage(dir);
    for (const l of want) await lookInto(id, l, tick, signal);
  });
}

function cancel() {
  job?.abort();
  return true;
}

function remove(id) {
  if (!known(id) || job?.id === id) return false;
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  for (const l of CHARS[id].looks) {
    fs.rmSync(previewFile(l.id), { force: true });
    fs.rmSync(path.join(CARDS, l.id + '.png'), { force: true });
  }
  return true;
}

function copyPage(dir) {
  for (const f of PAGE_FILES) fs.copyFileSync(path.join(PAGE, f), path.join(dir, f));
}

// The page a Project SEKAI wallpaper shows: her outfit (her first downloaded when none is given, or
// it is missing), over the backdrop chosen for downloaded characters.
function pageUrl(id, outfit = '') {
  if (!installed(id)) return null;
  try {
    copyPage(dirOf(id));
    syncBackdrop(dirOf(id));
  } catch {
    /* the copy there still works */
  }
  const l = lookInstalled(id, outfit) ? outfit : CHARS[id].looks.find((x) => lookInstalled(id, x.id))?.id;
  return l ? `livewp://sekai-${id}/index.html?s=${l}` : null;
}

module.exports = { list, install, cancel, remove, pageUrl, installed, makeCards, drawCard, CHARS };
