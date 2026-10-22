'use strict';
// Network-backed helpers: search suggestions, AniList "anime of the day", Wallhaven gallery,
// and wallpaper files (bundled, user images / videos, live web wallpaper packages).
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { net, dialog, nativeImage } = require('electron');
const data = require('./data');
const { SEARCH_ENGINES } = require('./defaults');
const { ROOT, USER_WALLPAPERS, LIVE_WALLPAPERS, WALLPAPER_FOLDER_FILE, LINKED_FILE } = require('./protocol');
const { execFile } = require('child_process');
const { t } = require('./i18n');

const UA = { 'User-Agent': 'TyranWeb/1.0 (+desktop browser)' };
// Images uploaded before public AI image generators (Stable Diffusion: Aug 2022) cannot be AI-made.
const AI_CUTOFF = '2022-08-01';

async function getJson(url, init = {}) {
  const res = await net.fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- search suggestions ----------
async function suggest(text) {
  const g = data.settings.data.general;
  const engine = SEARCH_ENGINES[g.searchEngine];
  if (!g.searchSuggestions || !engine?.suggest || !text.trim()) return [];
  try {
    const json = await getJson(engine.suggest.replace('%s', encodeURIComponent(text)));
    const list = Array.isArray(json) ? json[1] : [];
    return (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string').slice(0, 6);
  } catch {
    return [];
  }
}

// ---------- AniList: one 2000–2010 anime per day ----------
const animeCache = new Map();
async function animeOfTheDay(genre = 'Slice of Life') {
  const day = new Date().toISOString().slice(0, 10);
  const key = day + '|' + genre;
  if (animeCache.has(key)) return animeCache.get(key);
  const query = `query ($page: Int, $genre: String) {
    Page(page: $page, perPage: 50) {
      media(type: ANIME, format_in: [TV, MOVIE, OVA, ONA], startDate_greater: 20000000, startDate_lesser: 20101231,
            sort: POPULARITY_DESC, isAdult: false, genre: $genre) {
        id siteUrl title { romaji english native } startDate { year } seasonYear episodes format
        coverImage { extraLarge color } bannerImage genres averageScore
        studios(isMain: true) { nodes { name } }
        description(asHtml: false)
      }
    }
  }`;
  const seed = [...day].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const page = 1 + (seed % 2);
  const json = await getJson('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { page, genre: genre === 'all' ? undefined : genre } }),
  });
  const list = json?.data?.Page?.media || [];
  if (!list.length) throw new Error('empty');
  const m = list[seed % list.length];
  const result = {
    id: m.id,
    url: m.siteUrl,
    title: m.title.english || m.title.romaji,
    romaji: m.title.romaji,
    native: m.title.native,
    year: m.startDate?.year || m.seasonYear,
    episodes: m.episodes,
    format: m.format,
    cover: m.coverImage?.extraLarge,
    color: m.coverImage?.color,
    banner: m.bannerImage,
    genres: m.genres || [],
    score: m.averageScore,
    studio: m.studios?.nodes?.[0]?.name || '',
    description: String(m.description || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 320),
  };
  animeCache.set(key, result);
  return result;
}

// ---------- wallpapers ----------
function bundledWallpapers() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'wallpapers', 'wallpapers.json'), 'utf8'));
    return list.map((w) => ({
      ...w,
      kind: 'bundled',
      url: `tyran://assets/wallpapers/${w.file}`,
      thumb: `tyran://assets/wallpapers/thumbs/${w.file}`,
    }));
  } catch {
    return [];
  }
}

const userIndexFile = path.join(USER_WALLPAPERS, 'index.json');
function readUserIndex() {
  try {
    return JSON.parse(fs.readFileSync(userIndexFile, 'utf8'));
  } catch {
    return [];
  }
}
function writeUserIndex(list) {
  fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
  fs.writeFileSync(userIndexFile, JSON.stringify(list, null, 2));
}

// Videos get a poster frame from the Windows shell thumbnailer (none when no codec is installed).
function userEntry(w) {
  const url = `tyran://userdata/${w.file}`;
  if (w.type !== 'video') return { ...w, type: 'image', kind: 'user', url, thumb: url };
  const poster = w.file + '.thumb.jpg';
  return { ...w, kind: 'user', url, thumb: fs.existsSync(path.join(USER_WALLPAPERS, poster)) ? `tyran://userdata/${poster}` : '' };
}

function userWallpapers() {
  return readUserIndex()
    .filter((w) => fs.existsSync(path.join(USER_WALLPAPERS, w.file)))
    .map(userEntry);
}

function listWallpapers() {
  const user = userWallpapers();
  const linked = linkedWallpapers();
  return {
    bundled: bundledWallpapers(),
    user: [...user.filter((w) => w.type === 'image'), ...linked.images],
    videos: [...user.filter((w) => w.type === 'video'), ...linked.videos],
    folders: linked.folders,
    folder: USER_WALLPAPERS,
    live: liveWallpapers(),
  };
}

function addUserWallpaper(file, meta) {
  const list = readUserIndex().filter((w) => w.file !== file);
  list.unshift({ file, added: Date.now(), ...meta });
  writeUserIndex(list);
  return userEntry(list[0]);
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|m4v|mov|mkv|ogv)$/i;
const VIDEO_MAX = 4 * 1024 ** 3;

async function makePoster(file) {
  try {
    const img = await nativeImage.createThumbnailFromPath(path.join(USER_WALLPAPERS, file), { width: 480, height: 270 });
    if (!img.isEmpty()) fs.writeFileSync(path.join(USER_WALLPAPERS, file + '.thumb.jpg'), img.toJPEG(82));
  } catch {
    /* no thumbnail handler for this format */
  }
}

async function importLocalVideo(win) {
  const r = await dialog.showOpenDialog(win, {
    title: t('Chọn video làm hình nền'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'm4v', 'mov', 'mkv', 'ogv'] }],
  });
  if (r.canceled) return [];
  fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
  const added = [];
  for (const src of r.filePaths) {
    if (!VIDEO_EXT.test(src) || fs.statSync(src).size > VIDEO_MAX) continue;
    const file = `video-${data.uid()}${path.extname(src).toLowerCase()}`;
    await fs.promises.copyFile(src, path.join(USER_WALLPAPERS, file));
    await makePoster(file);
    added.push(addUserWallpaper(file, { type: 'video', title: path.basename(src), source: t('Máy tính') }));
  }
  return added;
}

// Downloads a video (https, video/* or a known extension) so it can loop offline.
async function downloadVideo(url) {
  if (!/^https:\/\//i.test(url)) throw new Error(t('Chỉ hỗ trợ link https'));
  const res = await net.fetch(url, { headers: UA });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const pathname = new URL(res.url || url).pathname;
  const extOf = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/ogg': '.ogv' };
  const ext = extOf[type] || (VIDEO_EXT.exec(pathname)?.[0] || '').toLowerCase();
  if (!ext || (type && !type.startsWith('video/') && type !== 'application/octet-stream')) throw new Error(t('Link này không phải file video'));
  if (Number(res.headers.get('content-length') || 0) > VIDEO_MAX) throw new Error(t('Video quá lớn'));
  fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
  const file = `video-${data.uid()}${ext}`;
  const dest = path.join(USER_WALLPAPERS, file);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      cb(bytes > VIDEO_MAX ? new Error(t('Video quá lớn')) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(dest));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  await makePoster(file);
  let title = path.basename(pathname);
  try {
    title = decodeURIComponent(title);
  } catch {
    /* keep encoded name */
  }
  return addUserWallpaper(file, { type: 'video', title: title || 'Video', source: url });
}

// ---------- live (web page) wallpapers ----------
// Blue Archive memorial lobbies through respectZ's fan-made viewer (github.com/respectZ/blue-archive-viewer).
// Nothing from the game is bundled; the viewer loads it when this wallpaper is on.
const BLUE_ARCHIVE_VIEWER = 'https://ba.svdex.moe/jp/live2d';
const BLUE_ARCHIVE_MODELS = 'https://ba.svdex.moe/data/jp/Android/info.json';
const liveIndexFile = path.join(LIVE_WALLPAPERS, 'index.json');

function readLiveIndex() {
  try {
    return JSON.parse(fs.readFileSync(liveIndexFile, 'utf8'));
  } catch {
    return [];
  }
}

function writeLiveIndex(list) {
  fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
  fs.writeFileSync(liveIndexFile, JSON.stringify(list, null, 2));
}

function liveWallpapers() {
  return readLiveIndex()
    .filter((w) => fs.existsSync(path.join(LIVE_WALLPAPERS, w.id)))
    .map((w) => ({ ...w, thumb: w.preview ? `tyran://userdata/${w.preview}` : '' }));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function checkFolderSize(dir, max) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
      if (bytes > max) throw new Error(t('Thư mục quá lớn (tối đa 1 GB)'));
    }
  };
  walk(dir);
}

// A folder with an HTML page: plain, Wallpaper Engine "web" (project.json) or Lively (LivelyInfo.json).
async function importLiveWallpaper(win) {
  const r = await dialog.showOpenDialog(win, { title: t('Chọn thư mục hình nền web (có file index.html)'), properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = path.resolve(r.filePaths[0]);
  let entry = 'index.html';
  let title = path.basename(src);
  let preview = '';
  const we = readJson(path.join(src, 'project.json'));
  if (we) {
    if (we.type && String(we.type).toLowerCase() !== 'web') throw new Error(t('Wallpaper Engine: chỉ hỗ trợ hình nền loại Web'));
    entry = we.file || entry;
    title = we.title || title;
    preview = we.preview || '';
  }
  const lively = readJson(path.join(src, 'LivelyInfo.json'));
  if (lively) {
    if (![1, 2].includes(lively.Type)) throw new Error(t('Lively: chỉ hỗ trợ hình nền loại Web'));
    entry = lively.FileName || entry;
    title = lively.Title || title;
    preview = lively.Thumbnail || lively.Preview || '';
  }
  entry = String(entry).replace(/\\/g, '/').replace(/^\/+/, '');
  const inside = (p) => p.startsWith(src + path.sep);
  const entryPath = path.normalize(path.join(src, entry));
  if (!inside(entryPath) || !/\.html?$/i.test(entry) || !fs.existsSync(entryPath)) throw new Error(t('Không tìm thấy trang HTML trong thư mục này'));
  checkFolderSize(src, 1024 ** 3);
  const id = 'w' + data.uid();
  await fs.promises.cp(src, path.join(LIVE_WALLPAPERS, id), { recursive: true, filter: (p) => !fs.lstatSync(p).isSymbolicLink() });
  let previewFile = '';
  const previewPath = preview && path.normalize(path.join(src, String(preview)));
  if (previewPath && inside(previewPath) && IMAGE_EXT.test(previewPath) && fs.existsSync(previewPath)) {
    fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
    previewFile = `live-${id}${path.extname(previewPath).toLowerCase()}`;
    fs.copyFileSync(previewPath, path.join(USER_WALLPAPERS, previewFile));
  }
  const item = { id, title: String(title).slice(0, 120), entry, preview: previewFile, added: Date.now() };
  writeLiveIndex([item, ...readLiveIndex()]);
  return { ...item, thumb: previewFile ? `tyran://userdata/${previewFile}` : '' };
}

function removeLiveWallpaper(id) {
  const item = readLiveIndex().find((w) => w.id === id);
  if (!item) return false;
  fs.rmSync(path.join(LIVE_WALLPAPERS, path.basename(item.id)), { recursive: true, force: true });
  if (item.preview) fs.rmSync(path.join(USER_WALLPAPERS, path.basename(item.preview)), { force: true });
  writeLiveIndex(readLiveIndex().filter((w) => w.id !== id));
  return true;
}

// The page a web wallpaper shows: only https pages, imported packages and downloaded game characters.
// (Blue Archive's normal lobby: TyranWeb's own page, its student's lines got ready first)
function liveUrl(web = {}) {
  if (web.preset === 'bluearchive' && web.baMode === 'normal')
    return blueArchiveModels()
      .then((list) => require('./balobby').pageUrl(list.find((m) => m.key === web.model)?.normal, require('./i18n').current()))
      .catch(() => null);
  if (web.preset === 'bluearchive') return BLUE_ARCHIVE_VIEWER;
  if (web.preset === 'nikke') return require('./nikke').pageUrl(String(web.nikke || 'c010'), String(web.nikkeOutfit || ''));
  if (web.preset === 'azurlane') return require('./azurlane').pageUrl(String(web.azur || ''), String(web.azurSkin || ''));
  if (web.preset === 'sekai') return require('./sekai').pageUrl(String(web.sekai || ''), String(web.sekaiOutfit || ''));
  if (web.preset === 'url') return /^https:\/\/\S+$/i.test(web.url || '') ? web.url : null;
  if (web.preset === 'package') {
    const item = readLiveIndex().find((w) => w.id === web.package);
    if (!item || !fs.existsSync(path.join(LIVE_WALLPAPERS, item.id))) return null;
    return `livewp://${item.id}/${item.entry.split('/').map(encodeURIComponent).join('/')}`;
  }
  return null;
}

// Display names: English names and memorial-lobby thumbnails from SchaleDB (a community
// database, cached for a week), else the Japanese names the viewer page lists. Previews are
// pictures of the lobby TyranWeb takes itself the first time it shows one.
const baNamesFile = path.join(LIVE_WALLPAPERS, 'blue-archive-names.json');
const schaleFile = path.join(LIVE_WALLPAPERS, 'schaledb-students.json');
const BA_PREVIEWS = path.join(USER_WALLPAPERS, 'ba-previews');
const SCHALE = 'https://schaledb.com';

async function schaleStudents() {
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(schaleFile, 'utf8'));
    // caches from before the normal lobby have no birthday
    if (cached.some((x) => 'birthday' in x) && Date.now() - fs.statSync(schaleFile).mtimeMs < 7 * 86400000) return cached;
  } catch {
    /* no cache yet */
  }
  try {
    const json = await getJson(SCHALE + '/data/en/students.min.json');
    const list = (Array.isArray(json) ? json : Object.values(json)).map((x) => ({
      id: x.Id,
      dev: String(x.DevName || ''),
      path: String(x.PathName || ''),
      name: String(x.Name || ''),
      school: String(x.School || ''),
      personal: String(x.PersonalName || ''),
      family: String(x.FamilyName || ''),
      tags: Array.isArray(x.SearchTags) ? x.SearchTags.map(String) : [],
      bgm: Number(x.MemoryLobbyBGM) || 0,
      birthday: String(x.BirthDay || ''), // ("3/12")
    }));
    fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
    fs.writeFileSync(schaleFile, JSON.stringify(list));
    return list;
  } catch {
    return cached || [];
  }
}

// (pictures taken before the lobbies went back to their own framing, all but Momoi and Kayoko (New
// Year), show the game camera's)
const BA_FRAMED = Date.parse('2026-10-21T20:40:00Z');
function baPreviewUrl(key) {
  const file = path.join(BA_PREVIEWS, key + '.jpg');
  try {
    const t = fs.statSync(file).mtimeMs;
    return t < BA_FRAMED ? '' : `tyran://userdata/ba-previews/${key}.jpg?v=${Math.round(t)}`;
  } catch {
    return '';
  }
}

const memoryLobbyFile = path.join(LIVE_WALLPAPERS, 'memory-lobby.json');

// The game's memorial-lobby table (about 100 KB, cached a week): its prefab names match the lobby
// folders ("LobbyCH0258" -> ch0258_home, "LobbyShiroko_multi" -> lobbyshiroko_multi).
async function memoryLobbies() {
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(memoryLobbyFile, 'utf8'));
    // caches from before the lobby songs were kept have no bgm field
    if (cached.some((x) => 'bgm' in x) && Date.now() - fs.statSync(memoryLobbyFile).mtimeMs < 7 * 86400000) return cached;
  } catch {
    /* no cache yet */
  }
  try {
    const json = await getJson('https://ba.svdex.moe/data/jp/TableBundles/Excel/MemoryLobbyExcelTable.json');
    const list = (json.DataList || json).map((x) => ({ prefab: String(x.PrefabName || ''), id: x.CharacterId, bgm: x.BGMId }));
    fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
    fs.writeFileSync(memoryLobbyFile, JSON.stringify(list));
    return list;
  } catch {
    return cached || [];
  }
}

let baModels = null;
const baFiles = new Map(); // lobby key -> its skeleton's file name (some lobbies sit in two folders)

// Lobbies the viewer cannot show (empty skeleton, or nothing drawn), as of 2026-10, plus those
// found at run time (wallpapers:baBroken). A lobby that fails is not taken for broken at once (a
// slow network or a server that did not answer, a window out of sight while it loaded, made good
// lobbies look broken): each app start it fails in counts once, three in a row make it broken, and
// one showing clears it (wallpapers:baWorks).
const BA_BROKEN = ['airi_home', 'hare_home', 'ch0159_home', 'ch0088_home', 'ch0156_home', 'juri_home'];
// { mark: { n: app starts it failed in, at: the last of them } }; marks "alt:<key>": the second source
const baStrikesFile = path.join(LIVE_WALLPAPERS, 'blue-archive-strikes.json');
const baOldBrokenFile = path.join(LIVE_WALLPAPERS, 'blue-archive-broken.json'); // (before: one failure was enough)
const BA_STRIKES = 3;
const APP_START = Date.now();
function baStrikes() {
  let s = readJson(baStrikesFile);
  if (!s) {
    s = Object.fromEntries((readJson(baOldBrokenFile) || []).map((m) => [m, { n: 1, at: 0 }]));
    writeStrikes(s);
    fs.rmSync(baOldBrokenFile, { force: true });
  }
  return s;
}
function writeStrikes(s) {
  fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
  fs.writeFileSync(baStrikesFile, JSON.stringify(s));
}
const baBroken = () => new Set([...BA_BROKEN, ...Object.entries(baStrikes()).filter(([, v]) => v.n >= BA_STRIKES).map(([m]) => m)]);

// The second source: asdfdsa12's BA-Spine-Viewer, whose assets (one skeleton per lobby, and the
// voices) sit on GitHub and follow the newest banners. It gives the lobbies respectZ's viewer does
// not have, and the ones it cannot read; respectZ's viewer still draws them (it loads any files).
const BA_ALT = 'https://raw.githubusercontent.com/asdfdsa12/BA-Spine-Viewer-Asset/main/memorial';
const BA_ALT_LIST = 'https://raw.githubusercontent.com/asdfdsa12/BA-Spine-Viewer/main/memorial/Characters.json';
const baAltFile = path.join(LIVE_WALLPAPERS, 'blue-archive-alt.json');
async function baAltLobbies() {
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(baAltFile, 'utf8'));
    if (Date.now() - fs.statSync(baAltFile).mtimeMs < 86400000) return cached;
  } catch {
    /* no cache yet */
  }
  try {
    const json = await getJson(BA_ALT_LIST);
    // the students' lobbies only (not the story scenes, raid bosses or background layers)
    const list = (json.characters || []).filter((c) => /^[a-z0-9_]+(_home|_multi)$/i.test(c.id || '') && !/bg_home$/i.test(c.id)).map((c) => ({ id: String(c.id), name: String(c.name || '') }));
    fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
    fs.writeFileSync(baAltFile, JSON.stringify(list));
    return list;
  } catch {
    return cached || [];
  }
}

// a student SchaleDB does not list yet, from the second source's Korean name ("슌(수영복)")
const KR_OUTFITS = { 수영복: 'Swimsuit', 드레스: 'Dress', 교복: 'School', 파자마: 'Pajamas', 온천: 'Hot Spring', 바니걸: 'Bunny', 밴드: 'Band', 무장: 'Armed', 매지컬: 'Magical', 라이딩: 'Riding', 정월: 'New Year', 응원단: 'Cheer Squad', 캠핑: 'Camp', 메이드: 'Maid', 크리스마스: 'Christmas', 아이돌: 'Pop Idol', 체육복: 'Track', 사복: 'Casual', 가이드: 'Guide', 할로윈: 'Halloween' };
let schaleKr = null;
async function krStudent(krName) {
  const [, base, outfit] = /^([^(]+?)\s*(?:\(([^)]+)\))?$/.exec(krName || '') || [];
  if (!base) return null;
  schaleKr ||= await getJson(SCHALE + '/data/kr/students.min.json').then((j) => (Array.isArray(j) ? j : Object.values(j)), () => []);
  const hit = schaleKr.find((x) => x.Name === base) || schaleKr.find((x) => x.PersonalName === base);
  return hit ? { id: hit.Id, outfit: outfit ? KR_OUTFITS[outfit] || outfit : '' } : null;
}

async function blueArchiveModels() {
  if (!baModels) {
    const json = await getJson(BLUE_ARCHIVE_MODELS);
    baModels = Object.keys(json).filter((key) => /^[a-z0-9_]+_home$|_multi$/i.test(key));
    for (const key of baModels) baFiles.set(key, String((json[key] || [])[0] || '').split('/').pop().toLowerCase());
  }
  const broken = baBroken();
  const alt = new Map((await baAltLobbies()).map((c) => [c.id.toLowerCase(), c]));
  // every lobby of either source, and where each one is drawn from
  const keys = [...new Set([...baModels, ...[...alt.keys()].filter((k) => !baModels.some((x) => x.toLowerCase() === k))])];
  const sourceOf = (key) => {
    const a = alt.get(key.toLowerCase());
    if (baModels.includes(key) && !broken.has(key)) return null;
    return a && !broken.has('alt:' + key) ? a : null;
  };
  const names = readJson(baNamesFile) || {};
  const [students, lobbies] = await Promise.all([schaleStudents(), memoryLobbies()]);
  // (the students with a normal lobby: balobby.js)
  const normals = await require('./balobby').withSprites(students).catch(() => new Set());
  const byId = new Map(students.map((st) => [st.id, st]));
  const byPrefab = new Map(lobbies.map((l) => [l.prefab.toLowerCase().replace(/^lobby/, ''), l.id]));
  const bgmOf = new Map(lobbies.map((l) => [l.prefab.toLowerCase().replace(/^lobby/, ''), l.bgm]));
  const songs = readJson(path.join(ROOT, 'assets', 'ba-ost.json')) || { tracks: {}, aliases: {} };
  const byDev = new Map();
  for (const st of students) {
    byDev.set(st.dev.toLowerCase(), st);
    if (!byDev.has(st.path.toLowerCase())) byDev.set(st.path.toLowerCase(), st);
  }
  const title = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const studentOf = (key) => {
    const dev = key.replace(/_home$/i, '').replace(/^lobby/i, '').toLowerCase();
    return byId.get(byPrefab.get(dev)) || byDev.get(dev) || byDev.get(dev.replace(/\d+$/, ''));
  };
  // (a new student SchaleDB has not listed yet: found by the second source's Korean name)
  const kr = new Map();
  for (const key of keys) if (!studentOf(key) && alt.has(key.toLowerCase())) kr.set(key, await krStudent(alt.get(key.toLowerCase()).name));
  return keys
    .map((key) => {
      const dev = key.replace(/_home$/i, '').replace(/^lobby/i, '').toLowerCase();
      const k = kr.get(key);
      const st = studentOf(key) || (k && byId.get(k.id));
      const src = sourceOf(key);
      const romaji = key.replace(/_home$/i, '').split('_').map(title).join(' ');
      const jp = typeof names[key] === 'string' ? names[key] : '';
      // the Abydos members' second lobbies (SchaleDB only pictures the first one)
      const multi = /_multi$/i.test(key);
      // the lobby's song in the YouTube OST playlist (OST numbers are the game's BGM ids)
      // (SchaleDB knows the song of a lobby the game table lacks; not for an outfit only found by name)
      const bgm = bgmOf.get(dev) ?? (studentOf(key)?.bgm || undefined);
      const n = songs.lobbies?.[key] ?? songs.aliases?.[bgm] ?? bgm; // (lobbies: a song given per lobby)
      const track = songs.tracks?.[n];
      const extra = songs.extra?.[bgm]; // songs outside the numbered OST (Miku's Blue New World)
      // for the picker's filters: the student herself ("Hoshino"), her school, and the outfit the
      // lobby shows ("Swimsuit" from "Hoshino (Swimsuit)"; '' for her usual one)
      const outfit = multi ? 'Lobby 2' : k?.outfit || (/\(([^)]+)\)\s*$/.exec(st?.name || '') || [])[1] || '';
      const name = st ? (multi ? t('{0} · Abydos (sảnh 2)', st.name) : k?.outfit ? `${st.name} (${k.outfit})` : st.name) : jp || alt.get(key.toLowerCase())?.name || romaji;
      return {
        key,
        ost: track ? { n, video: track.id, title: track.title || `OST ${n}` } : extra ? { n: 0, video: extra.id, title: extra.title } : bgm ? { n: bgm, video: '', title: '' } : null,
        name,
        // drawn from the second source: its files (respectZ's viewer loads them) and voices
        urls: src ? [`${BA_ALT}/assets/${src.id}.skel`] : null,
        voices: src ? `${BA_ALT}/audio` : '',
        broken: !src && (broken.has(key) || !baModels.includes(key)),
        group: `${st ? st.id : dev}|${baFiles.get(key) || key}`,
        student: st?.personal || name.replace(/\s*\(.*$/, ''),
        school: st?.school || '',
        outfit,
        search: [st?.family, st?.personal, ...(st?.tags || [])].filter(Boolean).join(' '),
        jp,
        thumb: st && !multi && !k ? `${SCHALE}/images/student/lobby/${st.id}.webp` : '',
        preview: baPreviewUrl(key),
        // her normal lobby (the lobby button switches to it): her SchaleDB id, 0 if she has none
        normal: st && normals.has(st.id) ? st.id : 0,
        portrait: st ? `${SCHALE}/images/student/portrait/${st.id}.webp` : '',
      };
    })
    .map((m, i, list) => {
      // The same lobby listed twice (Airi in airi_home and airi0_home, Ibuki in ibuki_home and
      // ch0077_home): one entry stays, the one that works and has a song; the other is hidden and
      // points at it (alt), and an entry without a song borrows its twin's.
      const twins = list.filter((x) => x.group === m.group);
      // (respectZ's own files first, when both sources can show it)
      const main = [...twins].sort((a, b) => Number(a.broken) - Number(b.broken) || Number(!!a.urls) - Number(!!b.urls) || Number(!a.ost?.video) - Number(!b.ost?.video) || a.key.localeCompare(b.key))[0];
      const song = m.ost?.video ? m.ost : twins.find((x) => x.ost?.video)?.ost || m.ost;
      return { ...m, ost: song, hidden: main !== m, alt: main !== m ? main.key : '' };
    })
    .sort((x, y) => (x.thumb ? 0 : 1) - (y.thumb ? 0 : 1) || x.name.localeCompare(y.name) || x.key.localeCompare(y.key))
    // a student with two different lobbies gets them numbered (among the ones listed)
    .map((m, i, list) => {
      const same = list.filter((x) => x.name === m.name && !x.hidden);
      return same.length > 1 && !m.hidden ? { ...m, name: `${m.name} ${same.indexOf(m) + 1}` } : m;
    });
}

// A lobby the viewer could not show: counted (once an app start; not when the computer is offline or
// the window was out of sight: `counts` false), and once broken, its working twin (if any) given
// back. { alt: the lobby to show instead ('' none), broken: taken for broken now }
async function blueArchiveBroken(key, counts = true) {
  if (!/^[a-z0-9_]+$/i.test(key)) throw new Error('bad key');
  const before = (await blueArchiveModels()).find((x) => x.key === key);
  const mark = before?.urls ? 'alt:' + key : key;
  const s = baStrikes();
  const v = s[mark] || { n: 0, at: 0 };
  if (counts && v.at !== APP_START && !BA_BROKEN.includes(mark)) {
    s[mark] = { n: v.n + 1, at: APP_START };
    writeStrikes(s);
  }
  if ((s[mark]?.n || 0) < BA_STRIKES && !BA_BROKEN.includes(mark)) return { alt: '', broken: false };
  const list = await blueArchiveModels();
  const m = list.find((x) => x.key === key);
  if (m && !m.broken) return { alt: key, broken: true }; // (now from the other source)
  const twin = m && list.find((x) => x.group === m.group && x.key !== key && !x.broken);
  return { alt: twin ? twin.key : '', broken: true };
}
// A lobby that showed: its failures are forgotten (from the source it was drawn from).
async function blueArchiveWorks(key) {
  if (!/^[a-z0-9_]+$/i.test(key)) return false;
  const m = (await blueArchiveModels()).find((x) => x.key === key);
  const mark = m?.urls ? 'alt:' + key : key;
  const s = baStrikes();
  if (!s[mark]) return true;
  delete s[mark];
  writeStrikes(s);
  return true;
}

// ---------- a lobby chosen by itself (Settings → Hình nền → Chọn sảnh khi mở app)
// 'random': any lobby. 'season': the season's outfits (Christmas in December, the new year's and
// qipaos around it, swimsuits in the summer; out of their season those are left out), and by night
// (18:00-6:00) the darker half of them, by day the brighter (measured from their pictures by the
// window, wallpaper.js; ba-brightness.json). Only the favourites if asked. A choice that would leave
// nothing is dropped, the time of day first. Another lobby than the one shown, when there is one.
const baBrightFile = path.join(LIVE_WALLPAPERS, 'ba-brightness.json');
const SEASONAL = ['Christmas', 'New Year', 'Qipao', 'Hot Spring', 'Swimsuit'];
function seasonOf(d = new Date()) {
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  if (md >= 1201 && md <= 1225) return { id: 'christmas', outfits: ['Christmas', 'Hot Spring'] };
  if (md >= 1226 || md <= 220) return { id: 'newyear', outfits: ['New Year', 'Qipao', 'Hot Spring'] };
  if (md >= 601 && md <= 831) return { id: 'summer', outfits: ['Swimsuit'] };
  return { id: 'other', outfits: [] };
}
const nightAt = (d) => d.getHours() >= 18 || d.getHours() < 6;
const lobbyPeriod = (d = new Date()) => seasonOf(d).id + '|' + (nightAt(d) ? 'night' : 'day');

async function pickLobby(web, d = new Date()) {
  const list = (await blueArchiveModels()).filter((m) => !m.hidden && !m.broken);
  const favs = new Set(web.favorites || []);
  let pool = web.pickFavorites && list.some((m) => favs.has(m.key)) ? list.filter((m) => favs.has(m.key)) : list;
  if (web.lobbyPick === 'season') {
    const s = seasonOf(d);
    const inSeason = pool.filter((m) => s.outfits.includes(m.outfit));
    const season = inSeason.length ? inSeason : pool.filter((m) => !SEASONAL.includes(m.outfit));
    const lum = readJson(baBrightFile) || {};
    const known = season.filter((m) => typeof lum[m.key] === 'number');
    let timed = [];
    if (known.length >= 4) {
      const mid = known.map((m) => lum[m.key]).sort((a, b) => a - b)[Math.floor(known.length / 2)];
      timed = known.filter((m) => (nightAt(d) ? lum[m.key] < mid : lum[m.key] >= mid));
    }
    pool = timed.length ? timed : season.length ? season : pool;
  }
  const others = pool.filter((m) => m.key !== web.model);
  const from = others.length ? others : pool;
  return from.length ? from[Math.floor(Math.random() * from.length)].key : '';
}

// what the window measures the lobbies' brightness from: TyranWeb's own picture of one, else SchaleDB's
async function baPictureBytes(key) {
  if (!/^[a-z0-9_]+$/i.test(key)) throw new Error('bad key');
  const file = path.join(BA_PREVIEWS, key + '.jpg');
  if (baPreviewUrl(key)) return fs.promises.readFile(file);
  const m = (await blueArchiveModels()).find((x) => x.key === key);
  if (!m?.thumb) return null;
  const res = await net.fetch(m.thumb, { headers: UA });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}
const baBrightness = () => readJson(baBrightFile) || {};
function saveBaBrightness(found) {
  const all = baBrightness();
  for (const [k, v] of Object.entries(found || {})) if (/^[a-z0-9_]+$/i.test(k) && typeof v === 'number' && v >= 0 && v <= 1) all[k] = v;
  fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
  fs.writeFileSync(baBrightFile, JSON.stringify(all));
  return true;
}

async function saveBlueArchivePreview(wc, key) {
  if (!/^[a-z0-9_]+$/i.test(key)) throw new Error('bad key');
  let img = await wc.capturePage();
  if (img.isEmpty()) throw new Error('empty');
  if (img.getSize().width > 1280) img = img.resize({ width: 1280, quality: 'best' });
  fs.mkdirSync(BA_PREVIEWS, { recursive: true });
  fs.writeFileSync(path.join(BA_PREVIEWS, key + '.jpg'), img.toJPEG(86));
  return baPreviewUrl(key);
}

function saveBlueArchiveNames(list) {
  if (!Array.isArray(list)) return false;
  const names = {};
  for (const text of list.slice(0, 2000)) {
    const m = /^(.{1,60}?)\s*\(([a-z0-9_]+_home)\)$/i.exec(String(text).trim());
    if (m) names[m[2]] = m[1];
  }
  fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
  fs.writeFileSync(baNamesFile, JSON.stringify(names));
  return true;
}

async function importLocalWallpaper(win) {
  const r = await dialog.showOpenDialog(win, {
    title: t('Chọn ảnh nền'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Ảnh'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }],
  });
  if (r.canceled) return [];
  fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
  const added = [];
  for (const src of r.filePaths) {
    if (!IMAGE_EXT.test(src)) continue;
    const file = `local-${data.uid()}${path.extname(src).toLowerCase()}`;
    fs.copyFileSync(src, path.join(USER_WALLPAPERS, file));
    added.push(addUserWallpaper(file, { title: path.basename(src), source: t('Máy tính') }));
  }
  return added;
}

async function downloadImage(url, meta = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error(t('Chỉ hỗ trợ ảnh https'));
  const res = await net.fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(t('Không phải ảnh'));
  const ext = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' }[type.split(';')[0]] || '.jpg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 40 * 1024 * 1024) throw new Error(t('Ảnh quá lớn'));
  fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
  const file = `${meta.slug || 'web-' + data.uid()}${ext}`;
  fs.writeFileSync(path.join(USER_WALLPAPERS, file), buf);
  return addUserWallpaper(file, { title: meta.title || '', source: meta.source || url, page: meta.page || '', anime: meta.anime || '' });
}

// ---------------------------------------------------------------- many wallpapers at once
// Pictures and videos come in many at a time: chosen files, a whole folder (with its sub-folders)
// or a .zip (opened with Windows' own tar, which refuses paths that climb out). A file whose name
// is already among the wallpapers is skipped, so adding the same folder twice adds nothing twice.
// (the developer test harness, TYRAN_SHOT, answers the folder / file pickers with TYRAN_TEST_PICK)
const pick = (win, opts) =>
  process.env.TYRAN_SHOT && process.env.TYRAN_TEST_PICK ? Promise.resolve({ canceled: false, filePaths: process.env.TYRAN_TEST_PICK.split('|') }) : dialog.showOpenDialog(win, opts);
const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|mp4|webm|m4v|mov|mkv|ogv)$/i;

// one picture file (the NIKKE wallpaper's backdrop)
async function pickImage(win) {
  const r = await pick(win, { title: t('Chọn ảnh nền'), properties: ['openFile'], filters: [{ name: t('Ảnh'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }] });
  return r.canceled ? '' : r.filePaths[0] || '';
}

function mediaIn(dir, max = 5000) {
  const out = [];
  const visit = (d, depth) => {
    if (depth > 8 || out.length >= max) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (out.length >= max) return;
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile() && MEDIA_EXT.test(e.name)) out.push(p);
    }
  };
  visit(dir, 0);
  return out;
}

async function importMedia(paths) {
  const known = new Set(readUserIndex().map((w) => String(w.title || '').toLowerCase()));
  const added = [];
  let skipped = 0;
  fs.mkdirSync(USER_WALLPAPERS, { recursive: true });
  for (const src of paths) {
    const name = path.basename(src);
    const video = VIDEO_EXT.test(name);
    if (known.has(name.toLowerCase()) || (video && fs.statSync(src).size > VIDEO_MAX)) {
      skipped++;
      continue;
    }
    known.add(name.toLowerCase());
    const file = `${video ? 'video' : 'local'}-${data.uid()}${path.extname(name).toLowerCase()}`;
    await fs.promises.copyFile(src, path.join(USER_WALLPAPERS, file));
    if (video) await makePoster(file);
    added.push(addUserWallpaper(file, { type: video ? 'video' : 'image', title: name, source: t('Máy tính') }));
  }
  return { added, skipped };
}

// kind: 'files' | 'folder' | 'zip'
async function importMany(win, kind) {
  if (kind === 'folder') {
    const r = await pick(win, { title: t('Chọn thư mục ảnh / video'), properties: ['openDirectory'] });
    return r.canceled ? { added: [], skipped: 0 } : importMedia(mediaIn(r.filePaths[0]));
  }
  if (kind === 'zip') {
    const r = await pick(win, { title: t('Chọn file zip ảnh / video'), properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (r.canceled) return { added: [], skipped: 0 };
    const tmp = path.join(data.dir, `unzip-${data.uid()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await new Promise((resolve, reject) => execFile(tar, ['-xf', r.filePaths[0], '-C', tmp], { windowsHide: true }, (err) => (err ? reject(new Error(t('Không mở được file zip này'))) : resolve())));
      return await importMedia(mediaIn(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const r = await pick(win, {
    title: t('Chọn ảnh / video làm hình nền'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Ảnh và video'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm', 'm4v', 'mov', 'mkv', 'ogv'] }],
  });
  return r.canceled ? { added: [], skipped: 0 } : importMedia(r.filePaths.filter((p) => MEDIA_EXT.test(p)));
}

// Linked folders: their pictures and videos are used where they are (nothing copied), and the list
// follows the folder as files come and go.
const linkedFolders = () => readJson(LINKED_FILE) || [];
function linkedWallpapers() {
  const images = [];
  const videos = [];
  const folders = [];
  // (one file per name, as when adding: a name already among the wallpapers is not listed twice)
  const seen = new Set(readUserIndex().map((w) => String(w.title || '').toLowerCase()));
  for (const f of linkedFolders()) {
    const files = fs.existsSync(f.path) ? mediaIn(f.path, 3000) : [];
    folders.push({ ...f, count: files.length, missing: !fs.existsSync(f.path) });
    for (const file of files) {
      const name = path.basename(file).toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      const rel = path.relative(f.path, file).split(path.sep).map(encodeURIComponent).join('/');
      const url = `tyran://linked/${f.id}/${rel}`;
      const entry = { kind: 'linked', url, title: path.basename(file), folder: f.id, source: f.path };
      if (VIDEO_EXT.test(file)) videos.push({ ...entry, type: 'video', thumb: '' });
      else images.push({ ...entry, type: 'image', thumb: url });
    }
  }
  return { images, videos, folders };
}

let watchers = [];
let wallpapersChanged = () => {};
function watchLinked(notify) {
  if (notify) wallpapersChanged = notify;
  for (const w of watchers) w.close();
  watchers = [];
  let timer = 0;
  for (const f of linkedFolders()) {
    try {
      watchers.push(
        fs.watch(f.path, { recursive: true }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => wallpapersChanged(), 800); // (a burst of changes, one update)
        })
      );
    } catch {
      /* the folder is gone (a removed drive): listed as missing */
    }
  }
}

async function linkFolder(win) {
  const r = await pick(win, { title: t('Chọn thư mục ảnh / video để liên kết (không sao chép)'), properties: ['openDirectory'] });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  const list = linkedFolders();
  if (!list.some((f) => path.resolve(f.path).toLowerCase() === path.resolve(dir).toLowerCase())) {
    list.push({ id: data.uid().toLowerCase().replace(/[^a-z0-9-]/g, ''), path: dir, title: path.basename(dir) || dir });
    fs.writeFileSync(LINKED_FILE, JSON.stringify(list, null, 2));
  }
  watchLinked();
  return linkedWallpapers();
}

function unlinkFolder(id) {
  fs.writeFileSync(LINKED_FILE, JSON.stringify(linkedFolders().filter((f) => f.id !== id), null, 2));
  watchLinked();
  return true;
}

// Moves the wallpaper folder (copies everything, then removes the old one); the app restarts to
// use it.
async function moveWallpaperFolder(win) {
  const r = await pick(win, { title: t('Chọn nơi lưu hình nền của TyranWeb'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return null;
  const dest = path.join(r.filePaths[0], 'TyranWeb wallpapers');
  if (path.resolve(dest).toLowerCase() === path.resolve(USER_WALLPAPERS).toLowerCase()) return null;
  if (path.resolve(dest).toLowerCase().startsWith(path.resolve(USER_WALLPAPERS).toLowerCase() + path.sep)) throw new Error(t('Không thể chuyển vào bên trong thư mục hiện tại'));
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(USER_WALLPAPERS)) await fs.promises.cp(USER_WALLPAPERS, dest, { recursive: true, force: true });
  fs.writeFileSync(WALLPAPER_FOLDER_FILE, JSON.stringify({ dir: dest }));
  try {
    fs.rmSync(USER_WALLPAPERS, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a file still in use (the playing video): the old copy stays behind, unused */
  }
  return dest;
}

const wallpaperFolder = () => USER_WALLPAPERS;

// ---------------------------------------------------------------- moving TyranWeb's data
// Settings → Giới thiệu → Thư mục dữ liệu → Chuyển chỗ: everything of TyranWeb's own (settings,
// history, bookmarks, the wallpapers kept in the data folder, downloaded characters and their music,
// cursors, extensions...) is copied into "<chosen>/TyranWeb data", the profile's data-folder.json
// points there, and the app restarts; the old copies are removed as it starts (see data.js). The
// browser profile (sign-ins such as Google's, cookies, site data, caches) stays where it is. Choosing
// the profile folder itself brings the data back into it.
const OWN_DATA = ['settings.json', 'history.json', 'bookmarks.json', 'downloads.json', 'session.json', 'notes.json', 'window-state.json']
  .flatMap((f) => [f, f + '.bak'])
  .concat(['wallpaper-folder.json', 'linked-folders.json', 'adblock-engine.bin', 'adblock-brave.bin', 'brave-adblock', 'live', 'wallpapers', 'cursors', 'extensions']);
let moving = false;
async function moveData(win, onProgress = () => {}) {
  if (moving) throw new Error(t('Đang chuyển dữ liệu'));
  const r = await pick(win, { title: t('Chọn nơi lưu dữ liệu của TyranWeb'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return null;
  const key = (p) => path.resolve(p).toLowerCase();
  const inside = (a, b) => key(a).startsWith(key(b) + path.sep);
  const from = data.dir;
  const home = key(r.filePaths[0]) === key(data.profile);
  let dest = home ? data.profile : path.join(r.filePaths[0], 'TyranWeb data');
  if (key(dest) === key(from)) return null;
  if (!home && (inside(dest, from) || inside(dest, data.profile))) throw new Error(t('Không thể chuyển vào bên trong thư mục dữ liệu hiện tại'));
  for (let n = 2; !home && fs.existsSync(dest) && fs.readdirSync(dest).length; n++) dest = path.join(r.filePaths[0], `TyranWeb data (${n})`);

  // what is TyranWeb's (in the profile folder, only its own; a moved folder is all its own), less
  // wallpapers kept elsewhere by their own move and passing leftovers
  const ownFolder = key(from) === key(data.profile);
  const items = (ownFolder ? OWN_DATA : fs.readdirSync(from)).filter(
    (n) => fs.existsSync(path.join(from, n)) && !n.startsWith('unzip-') && !(n === 'wallpapers' && key(USER_WALLPAPERS) !== key(path.join(from, 'wallpapers')))
  );
  const files = [];
  const walk = (rel) => {
    const st = fs.lstatSync(path.join(from, rel));
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) return void files.push({ rel, size: st.size });
    files.push({ rel, dir: true });
    for (const c of fs.readdirSync(path.join(from, rel))) walk(path.join(rel, c));
  };
  for (const n of items) walk(n);
  const total = files.reduce((t, f) => t + (f.size || 0), 0);
  const free = await fs.promises.statfs(r.filePaths[0]).then((s) => s.bavail * s.bsize, () => Infinity);
  if (free < total + 50e6) throw new Error(t('Không đủ chỗ trống ở đó (cần {0} GB)', (total / 1e9).toFixed(1)));

  moving = true;
  data.flushAll();
  const made = [];
  try {
    fs.mkdirSync(dest, { recursive: true });
    let done = 0;
    let last = 0;
    for (const f of files) {
      const to = path.join(dest, f.rel);
      if (!f.rel.includes(path.sep)) made.push(to);
      if (f.dir) fs.mkdirSync(to, { recursive: true });
      else {
        await fs.promises.copyFile(path.join(from, f.rel), to);
        done += f.size;
      }
      if (Date.now() - last > 200) (last = Date.now()), onProgress({ done, total });
    }
    onProgress({ done: total, total, finished: true });
  } catch (err) {
    // (nothing changes: what was copied so far goes again)
    for (const p of home ? made : [dest]) fs.rmSync(p, { recursive: true, force: true });
    moving = false;
    throw new Error(t('Không chép được dữ liệu: ') + (err.code || err.message));
  }
  // from the next start on, the data is read there; what is left here goes then
  const leftover = ownFolder ? items.map((n) => path.join(from, n)) : [from];
  fs.writeFileSync(data.DATA_FOLDER_FILE, JSON.stringify(home ? { leftover } : { dir: dest, leftover }));
  return dest;
}

// ---------------------------------------------------------------- mouse cursor
// Settings → Giao diện → Con trỏ chuột: a built-in set (drawn here) or the user's own files, for
// three slots: the ordinary arrow, over a link or button, over text. .cur / .ico keep their hotspot,
// .ani its frames (animated in TyranWeb's own pages; websites get the first frame).
const CURSOR_DIR = path.join(data.dir, 'cursors');
const CURSOR_EXT = /\.(cur|ani|ico|png|svg|webp|gif)$/i;
const CURSOR_FALLBACK = { arrow: 'default', hand: 'pointer', text: 'text' };

const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
// an arrow, the same arrow with a heart (links and buttons) and an I-beam, in each set's colours
function cursorSet(name) {
  const C = {
    sakura: ['#ffb3cc', '#e0718f', '#ffffff', '#ff5d8f'],
    night: ['#8f7cc9', '#3a2f5c', '#f1ecff', '#ffb3cc'],
    mint: ['#9ff0dc', '#3fb8a0', '#ffffff', '#ff7aa2'],
  }[name];
  if (!C) return null;
  const [a, b, line, heart] = C;
  const grad = `<defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="1" stdDeviation="0.8" flood-opacity="0.35"/></filter></defs>`;
  const arrow = `<path d="M3.5 2.5v21l5.6-5.2 3.7 8.4 3.7-1.6-3.6-8.2h7.6z" fill="url(#g)" stroke="${line}" stroke-width="1.6" stroke-linejoin="round" filter="url(#s)"/>`;
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${grad}${body}</svg>`;
  const hand = svg(arrow + `<path d="M24.5 30s-6-3.6-6-7.4a3 3 0 0 1 6-.6 3 3 0 0 1 6 .6c0 3.8-6 7.4-6 7.4z" fill="${heart}" stroke="${line}" stroke-width="1.3" filter="url(#s)"/>`);
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${grad}<path d="M11 5.5h3.2c1 0 1.8.8 1.8 1.8 0-1 .8-1.8 1.8-1.8H21M16 7.3v17.4M11 26.5h3.2c1 0 1.8-.8 1.8-1.8 0 1 .8 1.8 1.8 1.8H21" fill="none" stroke="${line}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 5.5h3.2c1 0 1.8.8 1.8 1.8 0-1 .8-1.8 1.8-1.8H21M16 7.3v17.4M11 26.5h3.2c1 0 1.8-.8 1.8-1.8 0 1 .8 1.8 1.8 1.8H21" fill="none" stroke="${b}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return {
    arrow: { css: `${svgUrl(svg(arrow))} 4 3, default` },
    hand: { css: `${svgUrl(hand)} 4 3, pointer` },
    text: { css: `${svgUrl(text)} 16 16, text` },
  };
}

// one image of a .cur / .ico: its data URL and hotspot (an .ico's is its centre)
function icoFrame(buf) {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || ![1, 2].includes(buf.readUInt16LE(2))) return null;
  const w = buf[6] || 256;
  const hgt = buf[7] || 256;
  const cur = buf.readUInt16LE(2) === 2;
  return { url: `url("data:image/x-icon;base64,${buf.toString('base64')}")`, x: cur ? buf.readUInt16LE(10) : Math.round(w / 2), y: cur ? buf.readUInt16LE(12) : Math.round(hgt / 2) };
}

// .ani (RIFF "ACON"): its frames ("icon" chunks, each a .cur / .ico), in the order of "seq " and for
// as long as "rate" says (in 1/60 s), else the header's display rate
function aniFrames(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'ACON') return null;
  const icons = [];
  let rate = null;
  let seq = null;
  let jif = 10;
  const walk = (start, end) => {
    for (let p = start; p + 8 <= end; ) {
      const id = buf.toString('ascii', p, p + 4);
      const size = buf.readUInt32LE(p + 4);
      const body = p + 8;
      if (body + size > buf.length) break;
      if (id === 'LIST') walk(body + 4, body + size);
      else if (id === 'icon') icons.push(buf.subarray(body, body + size));
      else if (id === 'anih' && size >= 36) jif = buf.readUInt32LE(body + 28) || 10;
      else if (id === 'rate') rate = Array.from({ length: size / 4 }, (_, i) => buf.readUInt32LE(body + i * 4));
      else if (id === 'seq ') seq = Array.from({ length: size / 4 }, (_, i) => buf.readUInt32LE(body + i * 4));
      p = body + size + (size & 1);
    }
  };
  walk(12, buf.length);
  const frames = icons.map(icoFrame);
  if (!frames.length || frames.some((f) => !f)) return null;
  const order = (seq || frames.map((f, i) => i)).filter((i) => frames[i]).slice(0, 120);
  return order.map((i, step) => ({ ...frames[i], ms: Math.max(30, Math.round(((rate?.[step] ?? jif) * 1000) / 60)) }));
}

// the CSS for one of the user's cursor files (null: unreadable)
function cursorFromFile(file, slot) {
  const fallback = CURSOR_FALLBACK[slot];
  let buf;
  try {
    buf = fs.readFileSync(path.join(CURSOR_DIR, path.basename(String(file || ''))));
  } catch {
    return null;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ani') {
    const frames = aniFrames(buf);
    if (!frames) return null;
    const css = (f) => `${f.url} ${f.x} ${f.y}, ${fallback}`;
    return { css: css(frames[0]), frames: frames.length > 1 ? frames.map((f) => ({ css: css(f), ms: f.ms })) : null };
  }
  if (ext === '.cur' || ext === '.ico') {
    const f = icoFrame(buf);
    return f && { css: `${f.url} ${f.x} ${f.y}, ${fallback}` };
  }
  const type = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
  // (a picture has no hotspot: the tip of an arrow is its top left, an I-beam's its centre)
  let x = 0;
  let y = 0;
  if (slot === 'text' && ext === '.png' && buf.length > 24) [x, y] = [Math.round(buf.readUInt32BE(16) / 2), Math.round(buf.readUInt32BE(20) / 2)];
  return type ? { css: `url("data:${type};base64,${buf.toString('base64')}") ${x} ${y}, ${fallback}` } : null;
}

// What every page is given: null for Windows' own cursors, else the three slots
function cursorConfig() {
  const c = data.settings.data.appearance.cursor || {};
  if (!c.set || c.set === 'system') return null;
  const set = c.set === 'custom' ? {} : cursorSet(c.set);
  if (!set) return null;
  if (c.set === 'custom') for (const slot of ['arrow', 'hand', 'text']) set[slot] = c[slot]?.file ? cursorFromFile(c[slot].file, slot) : null;
  if (!set.arrow && !set.hand && !set.text) return null;
  return { ...set, pages: c.pages !== false };
}

async function importCursor(win) {
  const r = await pick(win, { title: t('Chọn con trỏ chuột'), properties: ['openFile'], filters: [{ name: t('Con trỏ'), extensions: ['cur', 'ani', 'ico', 'png', 'svg', 'webp', 'gif'] }] });
  if (r.canceled || !CURSOR_EXT.test(r.filePaths[0])) return null;
  const src = r.filePaths[0];
  if (fs.statSync(src).size > 2 * 1024 ** 2) throw new Error(t('File con trỏ quá lớn (tối đa 2 MB)'));
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  const file = `cursor-${data.uid()}${path.extname(src).toLowerCase()}`;
  fs.copyFileSync(src, path.join(CURSOR_DIR, file));
  if (!cursorFromFile(file, 'arrow')) {
    fs.rmSync(path.join(CURSOR_DIR, file), { force: true });
    throw new Error(t('Không đọc được file con trỏ này'));
  }
  return { file, name: path.basename(src) };
}

// ---------------------------------------------------------------- a wallpaper's own music
// Either audio files (copied into the wallpaper folder, music/) or one link: a YouTube video or
// playlist, a SoundCloud track or set, a Spotify track / album / playlist (its embed player).
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|weba)$/i;
const MUSIC_DIR = () => path.join(USER_WALLPAPERS, 'music');

async function importMusic(win) {
  const r = await pick(win, {
    title: t('Chọn nhạc cho hình nền'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Nhạc'), extensions: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'] }],
  });
  if (r.canceled) return [];
  fs.mkdirSync(MUSIC_DIR(), { recursive: true });
  const out = [];
  const seen = new Set();
  for (const src of r.filePaths.filter((p) => AUDIO_EXT.test(p))) {
    const title = path.basename(src);
    if (seen.has(title.toLowerCase())) continue; // (the same name twice: once)
    seen.add(title.toLowerCase());
    const file = `music-${data.uid()}${path.extname(src).toLowerCase()}`;
    await fs.promises.copyFile(src, path.join(MUSIC_DIR(), file));
    out.push({ src: `tyran://userdata/music/${file}`, title: title.replace(AUDIO_EXT, '') });
  }
  return out;
}

// removes the copied songs no wallpaper uses any more
function cleanMusic(music) {
  const used = new Set();
  for (const m of Object.values(music || {})) for (const f of m?.files || []) used.add(path.basename(String(f.src || '')));
  let names = [];
  try {
    names = fs.readdirSync(MUSIC_DIR());
  } catch {
    return;
  }
  for (const n of names) if (/^music-/.test(n) && !used.has(n)) fs.rmSync(path.join(MUSIC_DIR(), n), { force: true });
}

const BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Accept-Language': 'en' };
const titleFrom = (oembed) => getJson(oembed).then((j) => String(j.title || '').slice(0, 200), () => '');

async function musicLink(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error(t('Link không hợp lệ'));
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(t('Link không hợp lệ'));
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be' || host === 'youtube.com') {
    let video = host === 'youtu.be' ? u.pathname.slice(1, 12) : u.searchParams.get('v') || /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(u.pathname)?.[1] || '';
    const list = /^[\w-]{10,64}$/.test(u.searchParams.get('list') || '') ? u.searchParams.get('list') : '';
    if (!/^[\w-]{11}$/.test(video)) video = '';
    if (!video && !list) throw new Error(t('Không thấy video hay playlist trong link YouTube này'));
    // a playlist link alone: its first video is where it starts
    if (!video) {
      const page = await net.fetch(`https://www.youtube.com/playlist?list=${list}`, { headers: BROWSER_UA }).then((r) => r.text(), () => '');
      video = /"videoId":"([\w-]{11})"/.exec(page)?.[1] || '';
      if (!video) throw new Error(t('Không mở được playlist này (riêng tư hoặc đã bị xoá?)'));
    }
    const path = list && !u.searchParams.get('v') ? `playlist?list=${list}` : `watch?v=${video}${list ? '&list=' + list : ''}`;
    const title = await titleFrom('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/' + path));
    // (it plays on YouTube Music, and opens there in a tab)
    return { kind: 'youtube', url: 'https://music.youtube.com/' + path, video, list, title: title || 'YouTube' };
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    // (short links lead to the real page)
    const real = host === 'on.soundcloud.com' ? await net.fetch(u.href, { headers: BROWSER_UA }).then((r) => r.url, () => '') : u.href;
    const page = new URL(real || u.href);
    if (page.hostname.replace(/^(www|m)\./, '') !== 'soundcloud.com' || page.pathname.split('/').filter(Boolean).length < 1) throw new Error(t('Link SoundCloud không hợp lệ'));
    const url = `https://soundcloud.com${page.pathname.replace(/\/$/, '')}`;
    const title = await titleFrom('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(url));
    return { kind: 'soundcloud', url, title: title || 'SoundCloud' };
  }
  if (host === 'open.spotify.com') {
    const m = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/.exec(u.pathname);
    if (!m) throw new Error(t('Link Spotify không hợp lệ'));
    const url = `https://open.spotify.com/${m[1]}/${m[2]}`;
    const title = await titleFrom('https://open.spotify.com/oembed?url=' + encodeURIComponent(url));
    return { kind: 'spotify', url, title: title || 'Spotify' };
  }
  throw new Error(t('Chỉ dùng được link YouTube, SoundCloud hoặc Spotify'));
}

function removeUserWallpaper(file) {
  const safe = path.basename(file);
  for (const f of [safe, safe + '.thumb.jpg']) fs.rmSync(path.join(USER_WALLPAPERS, f), { force: true });
  writeUserIndex(readUserIndex().filter((w) => w.file !== safe));
  return true;
}

// Wallhaven: SFW anime wallpapers, native 4K by default. `preAI` keeps only uploads before Aug 2022.
const RESOLUTIONS = { '4k': '3840x2160', '1440p': '2560x1440', '1080p': '1920x1080' };
const SORTINGS = new Set(['favorites', 'toplist', 'views', 'date_added', 'relevance', 'random']);
// Tags that mark upscales or AI images: refused on download.
const BAD_TAGS = /waifu2x|upscal|ai art|ai generated|ai-generated|stable diffusion|novelai|midjourney/i;

async function searchWallhaven({ query = '', page = 1, preAI = true, resolution = '4k', sorting = 'favorites' } = {}) {
  const params = new URLSearchParams({
    q: query,
    categories: '010',
    purity: '100',
    sorting: SORTINGS.has(sorting) ? sorting : 'favorites',
    order: 'desc',
    atleast: RESOLUTIONS[resolution] || RESOLUTIONS['4k'],
    ratios: 'landscape',
    ai_art_filter: '1',
  });
  // The pre-AI filter can empty most of a page, so keep reading pages (up to 4) until there is
  // enough to show. `page` in the result is the last page read.
  const found = [];
  let json = null;
  let current = Math.max(1, Number(page) || 1);
  for (let read = 0; read < 4; read++, current++) {
    params.set('page', String(current));
    json = await getJson('https://wallhaven.cc/api/v1/search?' + params);
    found.push(...(json.data || []).filter((w) => !preAI || (w.created_at || '9999') < AI_CUTOFF));
    if (found.length >= 12 || current >= (json.meta?.last_page || current)) break;
  }
  const items = found
    .map((w) => ({
      id: w.id,
      page: w.url,
      full: w.path,
      thumb: w.thumbs?.small,
      resolution: w.resolution,
      uploaded: (w.created_at || '').slice(0, 10),
      source: w.source || '',
      colors: w.colors || [],
    }));
  return { items, page: json.meta?.current_page || current, lastPage: json.meta?.last_page || current, total: json.meta?.total || 0 };
}

async function downloadWallhaven(item) {
  const id = String(item?.id || '').replace(/\W/g, '');
  if (!id) throw new Error(t('URL không hợp lệ'));
  // Re-read the wallpaper's own record: trusted file URL, and tags to refuse upscaled / AI images.
  const info = (await getJson(`https://wallhaven.cc/api/v1/w/${id}`)).data || {};
  if (!/^https:\/\/w\.wallhaven\.cc\//.test(info.path || '')) throw new Error('URL không hợp lệ');
  const bad = (info.tags || []).map((t) => t.name).find((t) => BAD_TAGS.test(t));
  if (bad) throw new Error(t('Ảnh bị gắn thẻ "{0}" nên đã bỏ qua', bad));
  return downloadImage(info.path, { slug: 'wallhaven-' + id, title: 'Wallhaven ' + id, source: info.source || info.url, page: info.url });
}

module.exports = {
  cursorConfig,
  importCursor,
  pickImage,
  importMusic,
  cleanMusic,
  musicLink,
  importMany,
  linkFolder,
  unlinkFolder,
  watchLinked,
  moveWallpaperFolder,
  wallpaperFolder,
  moveData,
  blueArchiveBroken,
  blueArchiveWorks,
  suggest,
  animeOfTheDay,
  listWallpapers,
  importLocalWallpaper,
  importLocalVideo,
  downloadVideo,
  importLiveWallpaper,
  removeLiveWallpaper,
  liveUrl,
  blueArchiveModels,
  schaleStudentList: schaleStudents,
  pickLobby,
  lobbyPeriod,
  baPictureBytes,
  baBrightness,
  saveBaBrightness,
  saveBlueArchiveNames,
  saveBlueArchivePreview,
  downloadImage,
  removeUserWallpaper,
  searchWallhaven,
  downloadWallhaven,
  AI_CUTOFF,
};
