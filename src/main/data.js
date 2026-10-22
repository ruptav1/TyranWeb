'use strict';
// User data: settings, history, bookmarks, downloads list, session and notes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { JsonStore, deepMerge } = require('./store');
const { SETTINGS, BOOKMARKS } = require('./defaults');
const { t } = require('./i18n');

// TyranWeb's own data (these files, the wallpapers, downloaded characters, extensions...) lives in
// the profile folder (userData) or wherever it was moved to (Settings → Giới thiệu → Thư mục dữ
// liệu), recorded in the profile's data-folder.json. The browser profile itself (sign-ins, cookies,
// site data, caches) always stays in userData. What a move left behind is removed at the next start,
// when nothing has it open any more.
const profile = app.getPath('userData');
const DATA_FOLDER_FILE = path.join(profile, 'data-folder.json');
function dataFolder() {
  let p = null;
  try {
    p = JSON.parse(fs.readFileSync(DATA_FOLDER_FILE, 'utf8'));
  } catch {
    return profile;
  }
  if (Array.isArray(p.leftover)) {
    for (const f of p.leftover) {
      try {
        fs.rmSync(f, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* still in use: it stays behind */
      }
    }
    delete p.leftover;
    try {
      if (p.dir) fs.writeFileSync(DATA_FOLDER_FILE, JSON.stringify(p));
      else fs.rmSync(DATA_FOLDER_FILE, { force: true });
    } catch {
      /* the next start tries again */
    }
  }
  return p.dir && fs.existsSync(p.dir) ? p.dir : profile;
}
const dir = dataFolder();
const uid = (p = '') => p + crypto.randomBytes(6).toString('hex');

// (a profile that already has settings is from before languages could be picked: it was Vietnamese)
const existing = fs.existsSync(path.join(dir, 'settings.json'));
const settings = new JsonStore(path.join(dir, 'settings.json'), SETTINGS, { delay: 250 });
if (existing && !settings.data.general.language) settings.data.general.language = 'vi';
const historyStore = new JsonStore(path.join(dir, 'history.json'), { visits: [] }, { delay: 1500 });
const bookmarkStore = new JsonStore(path.join(dir, 'bookmarks.json'), BOOKMARKS);
const downloadStore = new JsonStore(path.join(dir, 'downloads.json'), { items: [] });
const sessionStore = new JsonStore(path.join(dir, 'session.json'), { windows: [] }, { delay: 800 });
const notesStore = new JsonStore(path.join(dir, 'notes.json'), { text: '', updated: 0 });
const windowStore = new JsonStore(path.join(dir, 'window-state.json'), { bounds: null, maximized: false });

const MAX_VISITS = 40000;
const MERGE_WINDOW = 10 * 60 * 1000;

const isRecordable = (url) => /^https?:\/\//i.test(url || '');

const history = {
  add({ url, title, favicon }) {
    if (!isRecordable(url)) return null;
    const visits = historyStore.data.visits;
    const now = Date.now();
    const last = visits[visits.length - 1];
    if (last && last.url === url && now - last.time < MERGE_WINDOW) {
      last.time = now;
      if (title) last.title = title;
      if (favicon) last.favicon = favicon;
    } else {
      visits.push({ id: uid('h'), url, title: title || url, favicon: favicon || '', time: now });
      if (visits.length > MAX_VISITS) visits.splice(0, visits.length - MAX_VISITS);
    }
    historyStore.save();
    return true;
  },
  update({ url, title, favicon }) {
    const visits = historyStore.data.visits;
    for (let i = visits.length - 1; i >= Math.max(0, visits.length - 30); i--) {
      if (visits[i].url === url) {
        if (title) visits[i].title = title;
        if (favicon) visits[i].favicon = favicon;
        historyStore.save();
        return true;
      }
    }
    return false;
  },
  query({ text = '', limit = 100, offset = 0 } = {}) {
    const q = text.trim().toLowerCase();
    const visits = historyStore.data.visits;
    const out = [];
    let skipped = 0;
    for (let i = visits.length - 1; i >= 0 && out.length < limit; i--) {
      const v = visits[i];
      if (q && !v.url.toLowerCase().includes(q) && !(v.title || '').toLowerCase().includes(q)) continue;
      if (skipped++ < offset) continue;
      out.push(v);
    }
    return out;
  },
  // Aggregated per-URL entries ranked by "frecency" for the address bar.
  suggest(text, limit = 6) {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const now = Date.now();
    const byUrl = new Map();
    const visits = historyStore.data.visits;
    for (let i = visits.length - 1; i >= 0; i--) {
      const v = visits[i];
      const u = v.url.toLowerCase();
      const t = (v.title || '').toLowerCase();
      if (!u.includes(q) && !t.includes(q)) continue;
      const age = (now - v.time) / 86400000;
      const w = age < 1 ? 100 : age < 7 ? 70 : age < 30 ? 50 : age < 90 ? 30 : 10;
      const hit = byUrl.get(v.url);
      if (hit) hit.score += w;
      else {
        const host = u.replace(/^https?:\/\/(www\.)?/, '');
        const prefix = host.startsWith(q) ? 400 : 0;
        byUrl.set(v.url, { url: v.url, title: v.title, favicon: v.favicon, score: w + prefix });
      }
    }
    return [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  },
  topSites(limit = 8) {
    const counts = new Map();
    for (const v of historyStore.data.visits.slice(-5000)) {
      let origin;
      try { origin = new URL(v.url).origin; } catch { continue; }
      const c = counts.get(origin) || { url: origin + '/', title: v.title, favicon: v.favicon, n: 0 };
      c.n++;
      if (v.favicon) c.favicon = v.favicon;
      counts.set(origin, c);
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  },
  remove(ids) {
    const set = new Set(ids);
    historyStore.data.visits = historyStore.data.visits.filter((v) => !set.has(v.id));
    historyStore.save();
  },
  clear(sinceMs = 0) {
    historyStore.data.visits = sinceMs ? historyStore.data.visits.filter((v) => v.time < sinceMs) : [];
    historyStore.save();
  },
};

const bookmarks = {
  all() {
    // (the two folders of its own, named in the user's language unless renamed)
    const d = bookmarkStore.data;
    return { ...d, folders: d.folders.map((f) => (f.system ? { ...f, name: t(f.name) } : f)) };
  },
  find(url) {
    return bookmarkStore.data.items.find((b) => b.url === url) || null;
  },
  add({ url, title, favicon = '', folder = 'bar' }) {
    const existing = bookmarks.find(url);
    if (existing) return existing;
    const item = { id: uid('b'), url, title: title || url, favicon, folder, created: Date.now() };
    bookmarkStore.data.items.push(item);
    bookmarkStore.save();
    return item;
  },
  update(id, patch) {
    const item = bookmarkStore.data.items.find((b) => b.id === id);
    if (!item) return null;
    for (const k of ['url', 'title', 'favicon', 'folder']) if (k in patch) item[k] = patch[k];
    bookmarkStore.save();
    return item;
  },
  remove(id) {
    bookmarkStore.data.items = bookmarkStore.data.items.filter((b) => b.id !== id);
    bookmarkStore.save();
  },
  move(id, beforeId) {
    const items = bookmarkStore.data.items;
    const from = items.findIndex((b) => b.id === id);
    if (from < 0) return;
    const [item] = items.splice(from, 1);
    const to = beforeId ? items.findIndex((b) => b.id === beforeId) : -1;
    if (to < 0) items.push(item);
    else items.splice(to, 0, item);
    bookmarkStore.save();
  },
  addFolder(name) {
    const folder = { id: uid('f'), name: name || t('Thư mục mới') };
    bookmarkStore.data.folders.push(folder);
    bookmarkStore.save();
    return folder;
  },
  renameFolder(id, name) {
    const f = bookmarkStore.data.folders.find((x) => x.id === id);
    if (f && name) f.name = name;
    bookmarkStore.save();
  },
  removeFolder(id) {
    const f = bookmarkStore.data.folders.find((x) => x.id === id);
    if (!f || f.system) return;
    bookmarkStore.data.folders = bookmarkStore.data.folders.filter((x) => x.id !== id);
    for (const b of bookmarkStore.data.items) if (b.folder === id) b.folder = 'other';
    bookmarkStore.save();
  },
  exportHtml() {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const { folders, items } = bookmarkStore.data;
    let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    for (const f of folders) {
      const own = items.filter((b) => b.folder === f.id);
      html += `  <DT><H3${f.id === 'bar' ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${esc(f.name)}</H3>\n  <DL><p>\n`;
      for (const b of own) html += `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.created || 0) / 1000)}">${esc(b.title)}</A>\n`;
      html += '  </DL><p>\n';
    }
    return html + '</DL><p>\n';
  },
  // Import a Netscape bookmark HTML file (exported by Chrome, Edge, Firefox, Cốc Cốc...).
  importHtml(html) {
    const folder = bookmarks.addFolder(t('Đã nhập ') + new Date().toLocaleDateString(require('./i18n').info().locale));
    const re = /<A\s[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
    let m;
    let n = 0;
    const known = new Set(bookmarkStore.data.items.map((b) => b.url));
    const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    while ((m = re.exec(html))) {
      const url = decode(m[1]);
      if (!/^https?:/i.test(url) || known.has(url)) continue;
      known.add(url);
      bookmarkStore.data.items.push({ id: uid('b'), url, title: decode(m[2]) || url, favicon: '', folder: folder.id, created: Date.now() });
      n++;
    }
    bookmarkStore.save();
    return n;
  },
};

const notes = {
  get: () => notesStore.data,
  set(text) {
    notesStore.data = { text: String(text || ''), updated: Date.now() };
    notesStore.save();
  },
};

function updateSettings(patch) {
  deepMerge(settings.data, patch);
  settings.save();
  return settings.data;
}

function flushAll() {
  for (const s of [settings, historyStore, bookmarkStore, downloadStore, sessionStore, notesStore, windowStore]) {
    if (s.timer) s.flush();
  }
}

module.exports = {
  dir,
  profile,
  DATA_FOLDER_FILE,
  uid,
  settings,
  updateSettings,
  history,
  historyStore,
  bookmarks,
  bookmarkStore,
  downloadStore,
  sessionStore,
  notes,
  windowStore,
  flushAll,
};
