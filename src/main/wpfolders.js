'use strict';
// The wallpaper folder (Settings → Hình nền → Thư mục lưu hình nền) kept sorted into its own
// folders (protocol.js WALLPAPER_DIRS):
//  - images/      picture wallpapers
//  - videos/      video wallpapers
//  - thumbnails/  the videos' posters, the live wallpapers' pictures
//  - live/        live (web) wallpapers: imported pages and packages, downloaded game characters, lobbies
//  - music/       the wallpapers' own music files
//  - previews/    pictures kept of game lobbies and characters (lobbies/, azur/, nikke/, sekai/), a
//                 copy of the desktop's wallpaper
// Files at its top (all of them before 1.1.76; a backup restored from then) are put in their place
// at each start, and every tyran://userdata/ address in the settings and the live wallpapers' list
// follows them. live/ was in the data folder before: moved at once on the same drive (protocol.js),
// else copied here in the background and used from the next start, when the old one goes.
const fs = require('fs');
const path = require('path');
const data = require('./data');
const { USER_WALLPAPERS, WALLPAPER_DIRS: D, LIVE_WALLPAPERS, OLD_LIVE } = require('./protocol');

const FOLDERS = { 'ba-previews': 'previews/lobbies', 'azur-cards': 'previews/azur', 'nikke-cards': 'previews/nikke', 'sekai-cards': 'previews/sekai' };
const IMAGE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const VIDEO = /\.(mp4|webm|m4v|mov|mkv|ogv)$/i;
const MARK = path.join(data.dir, 'live-moved.json'); // { at }: when live/ was copied over

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// a folder into another: at once when that one is not there yet, else what it lacks
function mergeDir(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    return fs.renameSync(from, to);
  }
  for (const n of fs.readdirSync(from)) if (!fs.existsSync(path.join(to, n))) fs.renameSync(path.join(from, n), path.join(to, n));
  if (!fs.readdirSync(from).length) fs.rmdirSync(from);
}

// where each thing at the top of the folder belongs (relative to it), or '' to leave it
function placeOf(name, isDir, types) {
  if (isDir) return FOLDERS[name] || '';
  if (name === 'index.json' || /\.(part|unzip|moving)$/i.test(name)) return '';
  if (/\.thumb\.jpg$/i.test(name) || /^live-w[0-9a-f]+\.\w+$/i.test(name)) return 'thumbnails/' + name;
  if (name === 'desktop-wallpaper.jpg') return 'previews/' + name;
  if (types.has(name)) return types.get(name) + '/' + name;
  if (VIDEO.test(name)) return 'videos/' + name;
  if (IMAGE.test(name)) return 'images/' + name;
  return '';
}

function organize() {
  for (const [k, d] of Object.entries(D)) if (k !== 'live') fs.mkdirSync(d, { recursive: true }); // (live/: only by moving it)
  const index = readJson(path.join(USER_WALLPAPERS, 'index.json')) || [];
  const types = new Map(index.map((w) => [w.file, w.type === 'video' ? 'videos' : 'images']));
  const moved = new Map(); // what it was (relative) → where it is now; a folder ends with /
  let entries = [];
  try {
    entries = fs.readdirSync(USER_WALLPAPERS, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const to = placeOf(e.name, e.isDirectory(), types);
    if (!to) continue;
    try {
      if (e.isDirectory()) {
        mergeDir(path.join(USER_WALLPAPERS, e.name), path.join(USER_WALLPAPERS, to));
        moved.set(e.name + '/', to + '/');
      } else if (!fs.existsSync(path.join(USER_WALLPAPERS, to))) {
        fs.renameSync(path.join(USER_WALLPAPERS, e.name), path.join(USER_WALLPAPERS, to));
        moved.set(e.name, to);
      }
    } catch (err) {
      console.warn('[wallpapers] could not move', e.name, err.message);
    }
  }
  follow(moved);
}

// where an address of the wallpaper folder (relative) points now: what moved this time, a folder of
// before 1.1.76, a file of its top found in its folder (settings from a backup restored); '' if the same
function where(rel, moved) {
  if (moved.has(rel)) return moved.get(rel);
  for (const [a, b] of Object.entries(FOLDERS)) if (rel.startsWith(a + '/')) return b + '/' + rel.slice(a.length + 1);
  if (rel.includes('/') || fs.existsSync(path.join(USER_WALLPAPERS, rel))) return '';
  const to = placeOf(rel, false, new Map());
  return to && fs.existsSync(path.join(USER_WALLPAPERS, to)) ? to : '';
}

// the addresses in the settings and the live wallpapers' list that pointed at what moved
function follow(moved) {
  const fix = (s) => s.replace(/tyran:\/\/userdata\/([^?#"'\s]+)/g, (all, rel) => {
    const to = where(rel, moved);
    return to ? 'tyran://userdata/' + to : all;
  });
  const walk = (v) => (typeof v === 'string' ? fix(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), walk(x)])) : v);
  const before = JSON.stringify(data.settings.data);
  if (before.includes('tyran://userdata/')) {
    const after = walk(data.settings.data);
    if (JSON.stringify(after) !== before) {
      Object.assign(data.settings.data, after); // (the same object: whoever holds it sees the new addresses)
      data.settings.save();
    }
  }
  // (the live wallpapers' list names their pictures by file)
  const liveIndex = path.join(LIVE_WALLPAPERS, 'index.json');
  const list = readJson(liveIndex);
  if (Array.isArray(list) && list.some((w) => w.preview && where(w.preview, moved))) {
    fs.writeFileSync(liveIndex, JSON.stringify(list.map((w) => (w.preview && where(w.preview, moved) ? { ...w, preview: where(w.preview, moved) } : w)), null, 2));
  }
}

// live/ from the data folder on another drive: copied beside the wallpapers (in use from the next
// start); at that start, what changed in the old one meanwhile comes along and the old one goes
async function moveLive() {
  if (path.resolve(OLD_LIVE) === path.resolve(D.live) || !fs.existsSync(OLD_LIVE)) return;
  if (LIVE_WALLPAPERS === D.live) {
    const mark = readJson(MARK);
    if (!mark) return; // (not one this copied)
    for (const e of await fs.promises.readdir(OLD_LIVE, { withFileTypes: true })) {
      const from = path.join(OLD_LIVE, e.name);
      const to = path.join(D.live, e.name);
      const st = await fs.promises.stat(from);
      if (!fs.existsSync(to) || st.mtimeMs > mark.at) await fs.promises.cp(from, to, { recursive: true, force: true });
    }
    await fs.promises.rm(OLD_LIVE, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(MARK, { force: true });
    return;
  }
  const part = D.live + '.moving';
  await fs.promises.rm(part, { recursive: true, force: true });
  const at = Date.now();
  await fs.promises.cp(OLD_LIVE, part, { recursive: true, force: true });
  if (fs.existsSync(D.live)) return void (await fs.promises.rm(part, { recursive: true, force: true }));
  fs.renameSync(part, D.live);
  fs.writeFileSync(MARK, JSON.stringify({ at }));
}

module.exports = { organize, moveLive };
