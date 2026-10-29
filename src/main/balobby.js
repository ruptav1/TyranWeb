'use strict';
// Blue Archive's normal lobby (the game's main lobby, not a memorial one): a student's standing
// sprite in Schale's office, saying the game's lobby lines with their faces, effects, voices and
// speech bubbles; the same student or outfit as the memorial lobby chosen, switched to and from by
// the lobby button (web.baMode), as in the game. Nothing of the game ships with TyranWeb. TyranWeb's own page (src/live/ba-lobby)
// is copied into userData/live/ba-lobby/ with what it runs on, and reads straight from:
//  - asdfdsa12/BA-Spine-Viewer's assets on GitHub: the student's standing sprite (Spine 4.2);
//  - ba-archive's asset store (yuuka.cdn.diyigemt.com): Schale's office, the game's BG_MainOffice;
//  - SchaleDB (r2.schaledb.com): the voice lines.
// What she says is put together here, per student and language, into s-<id>-<lang>.json beside the
// page: the game's lobby lines (CharacterDialogExcel, electricgoat/ba-data's copy) with each
// line's face, effect (greeting, hophop, jump, shake, stiff), bubble (said or thought) and timing,
// joined to SchaleDB's voice clips and translations (English, Japanese, Korean, Chinese; the
// interface's other languages have no community translation and get English). A student the table
// lacks (one newer than its copy) gets SchaleDB's lines alone (one bubble a line, her usual face).
// The page runs on the official Spine runtime for the web (spine-webgl 4.2, Esoteric Software, from
// npm, checked against its SHA-256) and gsap (npm package, copied from TyranWeb's own).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');
const { LIVE_WALLPAPERS, ROOT } = require('./protocol');

const HOME = path.join(LIVE_WALLPAPERS, 'ba-lobby');
const PAGE = path.join(ROOT, 'src', 'live', 'ba-lobby');
const PAGE_FILES = ['index.html', 'player.js', 'ba-effects.js'];
const GSAP = path.join(ROOT, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
const RUNTIME = {
  file: 'spine-webgl-4.2.min.js',
  url: 'https://unpkg.com/@esotericsoftware/spine-webgl@4.2.120/dist/iife/spine-webgl.min.js',
  sha256: '9e495034588d2195c379422df37151a0750f79e2f4211434ca482520da3df6e0',
};
// the game's dialogue table: electricgoat/ba-data's copy of the Japanese game's (its DB tables, kept
// up to date: every student), else respectZ's (older: the newest students missing)
const DIALOG_TABLES = ['https://raw.githubusercontent.com/electricgoat/ba-data/jp/DB/CharacterDialogExcelTable.json', 'https://ba.svdex.moe/data/jp/TableBundles/Excel/CharacterDialogExcelTable.json'];
const SCHALE = 'https://schaledb.com';
const VOICE = 'https://r2.schaledb.com/voice/';
const SPRITES = 'https://raw.githubusercontent.com/asdfdsa12/BA-Spine-Viewer';
const SPRITE_ASSETS = 'https://raw.githubusercontent.com/asdfdsa12/BA-Spine-Viewer-Asset/main';
const OFFICE = 'https://yuuka.cdn.diyigemt.com/image/ba-all-data/UIs/03_Scenario/01_Background/BG_MainOffice.jpg';
const UA = { 'User-Agent': 'TyranWeb/1.0 (+desktop browser)' };
const WEEK = 7 * 86400000;

// the interface's language -> SchaleDB's ('' : the game table's own text per line)
const VOICE_LANG = { en: 'en', ja: 'jp', ko: 'kr', 'zh-CN': 'cn' };
const langOf = (lang) => VOICE_LANG[lang] || 'en';

async function getJson(url) {
  const res = await net.fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// a table fetched at most once a week (made smaller by `map` first; `url` may list mirrors, tried in
// turn); the old copy when offline
const memo = new Map();
async function cached(name, url, map) {
  if (memo.has(name)) return memo.get(name);
  const file = path.join(HOME, name);
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - fs.statSync(file).mtimeMs < WEEK) {
      memo.set(name, old);
      return old;
    }
  } catch {
    /* none yet */
  }
  try {
    let json = null;
    let last = null;
    for (const u of [url].flat()) {
      json = await getJson(u).catch((err) => ((last = err), null));
      if (json) break;
    }
    if (!json) throw last;
    const v = map(json);
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v));
    memo.set(name, v);
    return v;
  } catch (err) {
    if (old) return old;
    throw err;
  }
}

// The game's lobby lines, by student: each line in the table's order with its condition (Enter: when
// the lobby opens, Idle: when she is touched), anniversary, dates, group (the lines said one after
// another), bubble, effect, face, time on screen (ms, 0: as long as its voice) and whether a voice
// clip starts with it.
// (the table's few slips: a face "3" or "03.", an effect "sitff")
const faceName = (s) => String(s || '').trim().replace(/\.+$/, '').replace(/^(\d)$/, '0$1');
const effectName = (s) => ({ sitff: 'stiff' })[String(s || '').trim()] || String(s || '').trim();
const dialogs = () =>
  cached('dialog-2.json', DIALOG_TABLES, (json) => {
    const out = {};
    for (const r of Array.isArray(json) ? json : json.DataList || []) {
      if (r.DialogCategory !== 'UILobby') continue;
      (out[r.CharacterId] ||= []).push({
        k: r.DialogCondition === 'Enter' ? 'E' : 'I',
        a: r.Anniversary || 'None',
        s: r.StartDate || '',
        e: r.EndDate || '',
        g: r.GroupId,
        th: r.DialogType === 'Think',
        act: effectName(r.ActionName),
        face: faceName(r.AnimationName),
        ms: Number(r.Duration) || 0,
        jp: String(r.LocalizeJP || ''),
        kr: String(r.LocalizeKR || ''),
        v: Array.isArray(r.VoiceId) && r.VoiceId.length > 0,
      });
    }
    return out;
  });

// SchaleDB's lobby voice clips and their text in one language, by student, in the game's order
const voices = (lang) =>
  cached(`voice-${lang}.json`, `${SCHALE}/data/${lang}/voice.min.json`, (json) => {
    const out = {};
    for (const [id, v] of Object.entries(json)) if (v?.Lobby?.length) out[id] = v.Lobby.map((x) => ({ g: String(x.Group), clip: String(x.AudioClip || ''), text: String(x.Transcription || '') }));
    return out;
  });

// The standing sprites the viewer's assets have (its "new" folder, then its older one), by name
const sprites = async () => {
  const lists = await Promise.all(
    ['new', 'old'].map((dir) =>
      cached(`sprites-${dir}.json`, `${SPRITES}/main/${dir}/Characters.json`, (json) => (json.characters || []).filter((c) => /_spr$/i.test(c.id)).map((c) => c.id))
        .then((ids) => ids.map((id) => [id.toLowerCase(), { dir, id }]))
        .catch(() => [])
    )
  );
  const map = new Map();
  for (const list of lists) for (const [k, v] of list) if (!map.has(k)) map.set(k, v);
  return map;
};
// a student's sprite: her DevName's (outfits share one: CH0258_01 / _02), her path name's, or a name
// the viewer gives her differently
const SPRITE_ALIASES = { ch0065: 'shiroko_ridingsuit', ch0134: 'reizyo' };
function spriteOf(map, st) {
  const dev = String(st.dev || '').toLowerCase();
  for (const n of [dev, dev.replace(/_0\d$/, ''), SPRITE_ALIASES[dev], String(st.path || '').toLowerCase()]) {
    const s = n && map.get(n + '_spr');
    if (s) return s;
  }
  return null;
}

// SchaleDB's group of a line of the table (its number: Enter / Idle 1..n, then the special ones)
const SPECIAL = { 100: 'UILobbyUserBDay', 200: 'UILobbyStudentBDay', 300: 'UILobbyNewYear', 400: 'UILobbyXmas', 500: 'UILobbyHalloween' };
const groupName = (k, g) => SPECIAL[g] || (k === 'E' ? 'UILobbyEnter' : 'UILobbyIdle') + g;
// dates of SchaleDB's special groups, for students the table lacks
const DATES = { UILobbyNewYear: ['01/01', '01/03'], UILobbyXmas: ['12/24', '12/25'], UILobbyHalloween: ['10/30', '10/31'] };

// The lines of a student, as the page says them: { enter, idle, userBday, studentBday: [group],
// dated: [{ from, to, lines: group }] }, a group being the lines said one after another, each
// { text, think, face, act, ms, voice }.
function linesOf(rows, said, lang) {
  const out = { enter: [], idle: [], userBday: [], studentBday: [], dated: [] };
  const place = (lines, k, a, from, to) => {
    if (a === 'UserBDay') out.userBday.push(lines);
    else if (a === 'StudentBDay') out.studentBday.push(lines);
    else if (from) out.dated.push({ from, to, lines });
    else (k === 'E' ? out.enter : out.idle).push(lines);
  };
  const clips = new Map(); // SchaleDB's group -> its clips, in order
  for (const x of said || []) {
    if (!clips.has(x.g)) clips.set(x.g, []);
    clips.get(x.g).push(x);
  }
  if (!rows?.length) {
    // (a student the table lacks: SchaleDB's lines, one bubble each)
    for (const [g, list] of clips) {
      const lines = list.map((x) => ({ text: x.text, think: /^[(（]/.test(x.text), face: '', act: '', ms: 0, voice: x.clip ? VOICE + x.clip : '' }));
      const k = /Enter|BDay|NewYear|Xmas|Halloween/.test(g) && g !== 'UILobbyStudentBDay' ? 'E' : 'I';
      const a = g === 'UILobbyUserBDay' ? 'UserBDay' : g === 'UILobbyStudentBDay' ? 'StudentBDay' : 'None';
      place(lines, k, a, DATES[g]?.[0] || '', DATES[g]?.[1] || '');
    }
    return out;
  }
  // the table's groups, in its order
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.k}|${r.g}|${r.a}|${r.s}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) {
    const r0 = list[0];
    const own = clips.get(groupName(r0.k, r0.g)) || [];
    // each clip starts on a line marked with a voice and runs on over the unmarked lines after it;
    // its text (SchaleDB's: one per clip) is shared out over those lines when it has as many parts
    let c = -1;
    const spans = [];
    for (const r of list) {
      if (r.v) c++;
      spans.push(c);
    }
    const lines = list.map((r, i) => {
      const clip = r.v ? own[spans[i]] : null;
      let text = lang === 'jp' ? r.jp : lang === 'kr' ? r.kr : '';
      if (!text) {
        const x = own[spans[i]];
        const part = list.filter((q, j) => spans[j] === spans[i]);
        const pieces = String(x?.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const at = part.indexOf(r);
        if (!x?.text) text = r.jp;
        else if (pieces.length === part.length) text = pieces[at];
        else text = at === 0 ? pieces.join(' ') : '';
      }
      return { text, think: r.th, face: r.face, act: r.act, ms: r.ms, voice: clip?.clip ? VOICE + clip.clip : '' };
    });
    place(lines, r0.k, r0.a, r0.s, r0.e);
  }
  return out;
}

// The students that have a normal lobby (a standing sprite), of SchaleDB's: their ids. Each memorial
// lobby's student or outfit gets hers (services.blueArchiveModels), switched to as the game's
// lobby button does.
async function withSprites(list) {
  const map = await sprites();
  return new Set(list.filter((st) => spriteOf(map, st)).map((st) => st.id));
}

// ---- the page
function copyPage() {
  fs.mkdirSync(HOME, { recursive: true });
  for (const f of PAGE_FILES) {
    const from = path.join(PAGE, f);
    const to = path.join(HOME, f);
    try {
      if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
    } catch {
      /* copy it */
    }
    fs.copyFileSync(from, to);
  }
  const g = path.join(HOME, 'gsap.min.js');
  if (!fs.existsSync(g)) fs.writeFileSync(g, fs.readFileSync(GSAP));
}
async function runtime() {
  const file = path.join(HOME, RUNTIME.file);
  if (fs.existsSync(file)) return;
  const res = await net.fetch(RUNTIME.url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== RUNTIME.sha256) throw new Error('Spine runtime checksum');
  fs.writeFileSync(file, buf);
}

// The page for a student (SchaleDB id), with her lines in the interface's language: its address
async function pageUrl(id, uiLang) {
  const services = require('./services');
  const lang = langOf(uiLang);
  const sid = Number(id);
  copyPage();
  const [list, map, rows, said] = await Promise.all([services.schaleStudentList(), sprites(), dialogs().catch(() => ({})), voices(lang).catch(() => ({}))]);
  const st = list.find((x) => x.id === sid);
  if (!st) throw new Error('no student');
  const spr = spriteOf(map, st);
  if (!spr) throw new Error('no sprite');
  // (JP / KR text is the table's own, one per line)
  const lines = linesOf(rows[st.id], said[st.id], lang);
  // (the viewer's list writes a few names other than its files do: "tsubaki_spr" for Tsubaki_spr)
  let base = `${SPRITE_ASSETS}/${spr.dir}/assets/${spr.id}`;
  const up = `${SPRITE_ASSETS}/${spr.dir}/assets/${spr.id.charAt(0).toUpperCase()}${spr.id.slice(1)}`;
  if (up !== base && !(await net.fetch(base + '.skel', { method: 'HEAD', headers: UA }).then((r) => r.ok, () => true))) base = up;
  const file = `s-${st.id}-${lang}.json`;
  fs.writeFileSync(path.join(HOME, file), JSON.stringify({ id: st.id, name: st.name, birthday: st.birthday || '', spr: { skel: base + '.skel', atlas: base + '.atlas' }, bg: OFFICE, ...lines }));
  await runtime();
  return `livewp://ba-lobby/index.html?d=${encodeURIComponent(file)}&v=${Date.now().toString(36)}`;
}

// The lobby's song, the same for every student: the game's lobby theme, Step by Step (BGM 14: the
// game's BGMUIExcel gives it to UILobby; the community's soundtrack lists agree)
const LOBBY_BGM = 14;
function song() {
  let track = null;
  try {
    track = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'ba-ost.json'), 'utf8')).tracks?.[LOBBY_BGM];
  } catch {
    /* none */
  }
  return { key: 'normal', name: 'Lobby', ost: track ? { n: LOBBY_BGM, video: track.id, title: track.title || `OST ${LOBBY_BGM}` } : { n: LOBBY_BGM, video: '', title: '' } };
}

// (the store page's Sora shop draws with the same runtime: main/sorashop.js)
const runtimeFile = () => path.join(HOME, RUNTIME.file);

module.exports = { withSprites, pageUrl, song, linesOf, HOME, runtime, runtimeFile };
