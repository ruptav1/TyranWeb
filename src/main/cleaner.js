'use strict';
// Dọn rác (Settings → Quyền riêng tư → Dọn rác): what can go without losing anything of the user's.
//  - TyranWeb's: its sessions' caches (pages' files, compiled scripts) and the leftovers of its own
//    unfinished work (half downloads, unpacked zips, update and backup folders in Windows' temp).
//    History, sign-ins, wallpapers and downloads are not touched.
//  - Windows' temp folder (the user's %TEMP%): files not changed for a week; a file in use is left.
// Measured when Settings shows it, done on a press, and once a week at start (privacy.autoClean).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { session } = require('electron');
const data = require('./data');
const { USER_WALLPAPERS, LIVE_WALLPAPERS } = require('./protocol');

const WEEK = 7 * 864e5;
const MAX_ENTRIES = 300000; // (a temp folder of a million files: the first part of it)

function sessions() {
  const s = require('./sessions');
  return [s.browsing(), session.fromPartition(s.PRIVATE_PARTITION), session.fromPartition('persist:tyran-store'), s.wallpaper()].filter(Boolean);
}

// walks a folder (never through links), giving each file to `fn(file, stat)`; how far it got
async function walk(dir, fn, budget = { left: MAX_ENTRIES }) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (--budget.left < 0) return;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(p, fn, budget);
    else if (e.isFile()) {
      try {
        await fn(p, await fs.promises.lstat(p));
      } catch {
        /* (gone meanwhile) */
      }
    }
  }
}
const sizeOf = async (dir) => {
  let n = 0;
  await walk(dir, (f, st) => (n += st.size));
  return n;
};

// ---- TyranWeb's own leftovers: [path, isFolder]
async function leftovers() {
  const out = [];
  const tops = (dir, re) => {
    try {
      return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  };
  // (unpacked zips and Special's downloads, half-written files)
  out.push(...tops(data.dir, /^(unzip|special)-/));
  out.push(...tops(USER_WALLPAPERS, /\.(part|unzip)$/), ...tops(path.join(USER_WALLPAPERS, 'videos'), /\.part$/));
  out.push(...tops(path.join(LIVE_WALLPAPERS, 'sora-shop'), /\.part$/));
  // (update and backup folders left in Windows' temp, older than a day: none in use)
  const day = Date.now() - 864e5;
  out.push(...tops(os.tmpdir(), /^tyranweb-/).filter((p) => {
    try {
      return fs.statSync(p).mtimeMs < day;
    } catch {
      return false;
    }
  }));
  return out;
}

async function appBytes() {
  let n = 0;
  for (const ses of sessions()) {
    n += await ses.getCacheSize().catch(() => 0);
    if (ses.storagePath) n += await sizeOf(path.join(ses.storagePath, 'Code Cache'));
  }
  for (const p of await leftovers()) {
    try {
      const st = fs.statSync(p);
      n += st.isDirectory() ? await sizeOf(p) : st.size;
    } catch {
      /* gone */
    }
  }
  return n;
}

// ---- Windows' temp: files not changed for a week
async function tempOld(fn) {
  const cutoff = Date.now() - WEEK;
  await walk(os.tmpdir(), async (f, st) => {
    if (st.mtimeMs < cutoff) await fn(f, st);
  });
}

async function measure() {
  let temp = 0;
  let files = 0;
  await tempOld((f, st) => {
    temp += st.size;
    files++;
  });
  return { app: await appBytes(), temp, tempFiles: files };
}

// empty folders left behind in temp, deepest first (not the temp folder itself)
async function pruneEmpty(dir, top = true) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) await pruneEmpty(path.join(dir, e.name), false);
  if (top) return;
  try {
    const st = await fs.promises.stat(dir);
    if (st.mtimeMs < Date.now() - WEEK) await fs.promises.rmdir(dir); // (fails, as it should, unless empty)
  } catch {
    /* not empty, or in use */
  }
}

let running = null;
function clean({ app = true, temp = false } = {}) {
  running ||= (async () => {
    let freed = 0;
    let left = 0;
    if (app) {
      const before = await appBytes();
      for (const ses of sessions()) {
        await ses.clearCache().catch(() => {});
        await ses.clearCodeCaches({}).catch(() => {});
      }
      for (const p of await leftovers()) fs.rmSync(p, { recursive: true, force: true, maxRetries: 1 });
      freed += Math.max(0, before - (await appBytes()));
    }
    if (temp) {
      await tempOld(async (f, st) => {
        try {
          await fs.promises.unlink(f);
          freed += st.size;
        } catch {
          left++; // (in use, or not ours to remove)
        }
      });
      await pruneEmpty(os.tmpdir());
    }
    data.updateSettings({ privacy: { cleanedAt: Date.now() } });
    return { freed, left };
  })().finally(() => (running = null));
  return running;
}

// once a week, a little after start, as Settings says
function auto() {
  const p = data.settings.data.privacy || {};
  if (!p.autoClean || Date.now() - (p.cleanedAt || 0) < WEEK) return;
  setTimeout(() => clean({ app: p.cleanApp !== false, temp: !!p.cleanTemp }).catch(() => {}), 90000);
}

module.exports = { measure, clean, auto };
