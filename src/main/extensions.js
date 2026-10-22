'use strict';
// Chrome extensions, installed from the Chrome Web Store (or a folder) into the browsing session.
// The store's package (.crx) is fetched from Google's own update server, its header taken off and
// the zip inside opened with Windows' tar; the key in the header keeps the store's extension ID.
// Electron runs only part of Chrome's extension API: what an extension does inside pages (content
// scripts, styles) usually works, toolbar popups and tab APIs only partly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { net, BrowserWindow, webContents } = require('electron');
const data = require('./data');
const { t } = require('./i18n');

const DIR = path.join(data.dir, 'extensions');
const INDEX = path.join(DIR, 'extensions.json');
const PENDING = new Map(); // token -> a downloaded extension waiting for the user's yes

let ses = null;
let changed = () => {};

const readIndex = () => {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return [];
  }
};
const writeIndex = (list) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(list, null, 2));
  changed();
};
const api = () => ses.extensions || ses; // (Electron 35+: ses.extensions)
const chromeVersion = () => process.versions.chrome || '130.0.0.0';

// ---- the .crx package
// protobuf, just enough of it: the fields of one message (number -> [byte strings])
function fields(buf) {
  const out = {};
  let p = 0;
  const varint = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = buf[p++];
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
      shift += 7;
    }
  };
  while (p < buf.length) {
    const tag = varint();
    const type = tag % 8;
    const num = Math.floor(tag / 8);
    if (type === 2) {
      const len = varint();
      (out[num] ||= []).push(buf.subarray(p, p + len));
      p += len;
    } else if (type === 0) varint();
    else if (type === 5) p += 4;
    else if (type === 1) p += 8;
    else break;
  }
  return out;
}

// the ID Chrome gives a public key: the first 16 bytes of its SHA-256, written with letters a–p
const idOfKey = (key) => [...crypto.createHash('sha256').update(key).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');

// the zip inside a .crx (versions 2 and 3), and the public key that belongs to `id`
function unpackCrx(buf, id) {
  if (buf.toString('ascii', 0, 4) !== 'Cr24') {
    if (buf.readUInt32LE(0) === 0x04034b50) return { zip: buf, key: null }; // (a plain zip)
    throw new Error(t('File tải về không phải tiện ích Chrome'));
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const keyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    const key = buf.subarray(16, 16 + keyLen);
    return { zip: buf.subarray(16 + keyLen + sigLen), key: idOfKey(key) === id ? key : null };
  }
  if (version !== 3) throw new Error(t('Định dạng tiện ích không hỗ trợ'));
  const headerLen = buf.readUInt32LE(8);
  const header = fields(buf.subarray(12, 12 + headerLen));
  let key = null;
  for (const proof of header[2] || []) {
    const k = fields(proof)[1]?.[0];
    if (k && idOfKey(k) === id) key = k;
  }
  return { zip: buf.subarray(12 + headerLen), key };
}

const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
const TAR = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

async function download(id) {
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${chromeVersion()}&acceptformat=crx2,crx3&x=${encodeURIComponent(`id=${id}&uc`)}`;
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(res.status === 204 || res.status === 404 ? t('Không tìm thấy tiện ích này trên Chrome Web Store') : t('Tải tiện ích lỗi (HTTP {0})', res.status));
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 16) throw new Error(t('Không tìm thấy tiện ích này trên Chrome Web Store'));
  return buf;
}

// opens the package into a new folder; the manifest gets the store's key (so the ID stays the store's)
async function extract(buf, id) {
  const { zip, key } = unpackCrx(buf, id);
  fs.mkdirSync(DIR, { recursive: true });
  const dir = path.join(DIR, `.staging-${id}-${data.uid()}`);
  fs.mkdirSync(dir, { recursive: true });
  const zipFile = dir + '.zip';
  fs.writeFileSync(zipFile, zip);
  try {
    await run(TAR(), ['-xf', zipFile, '-C', dir]);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(t('Không giải nén được tiện ích'));
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
  // (the store's signature folder: Chrome's loader refuses names starting with "_" it does not know)
  fs.rmSync(path.join(dir, '_metadata'), { recursive: true, force: true });
  const manifestFile = path.join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(t('Tiện ích không có manifest hợp lệ'));
  }
  if (key && !manifest.key) {
    manifest.key = key.toString('base64');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }
  return { dir, manifest };
}

// the extension's own name (manifests may name it through _locales)
function nameOf(dir, manifest, field = 'name') {
  const raw = String(manifest[field] || '');
  const m = /^__MSG_(\w+)__$/.exec(raw);
  if (!m) return raw;
  for (const lang of [manifest.default_locale, 'vi', 'en', 'en_US'].filter(Boolean)) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', lang, 'messages.json'), 'utf8').replace(/^\uFEFF/, ''));
      const hit = Object.entries(msgs).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
      if (hit) return hit[1].message;
    } catch {
      /* not this language */
    }
  }
  return raw;
}

function iconOf(dir, manifest) {
  const icons = manifest.icons || manifest.action?.default_icon || manifest.browser_action?.default_icon || {};
  const file = typeof icons === 'string' ? icons : Object.entries(icons).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
  if (!file) return '';
  try {
    const buf = fs.readFileSync(path.join(dir, String(file).replace(/^\//, '')));
    const type = /\.svg$/i.test(file) ? 'image/svg+xml' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
    return buf.length < 512 * 1024 ? `data:${type};base64,${buf.toString('base64')}` : '';
  } catch {
    return '';
  }
}

// what the extension asks to be allowed to do, in words
function permissionsOf(manifest) {
  const all = [...(manifest.permissions || []), ...(manifest.host_permissions || []), ...(manifest.optional_permissions || [])].map(String);
  const sites = all.some((p) => /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/.test(p)) || (manifest.content_scripts || []).some((c) => (c.matches || []).some((m) => /<all_urls>|^\*:\/\/\*\/|^https?:\/\/\*\//.test(m)));
  const words = {
    tabs: t('xem các tab và địa chỉ trang'),
    history: t('đọc và đổi lịch sử duyệt web'),
    bookmarks: t('đọc và đổi dấu trang'),
    downloads: t('quản lý tải xuống'),
    cookies: t('đọc và đổi cookie'),
    clipboardRead: t('đọc khay nhớ tạm'),
    clipboardWrite: t('ghi vào khay nhớ tạm'),
    webRequest: t('theo dõi các yêu cầu mạng'),
    declarativeNetRequest: t('chặn hoặc đổi các yêu cầu mạng'),
    storage: t('lưu dữ liệu của riêng nó'),
    notifications: t('hiện thông báo'),
    scripting: t('chạy mã trên trang'),
    proxy: t('đổi proxy'),
    management: t('quản lý các tiện ích khác'),
    nativeMessaging: t('nói chuyện với chương trình trên máy'),
  };
  const out = [];
  if (sites) out.push(t('đọc và thay đổi mọi dữ liệu trên mọi trang web'));
  else {
    const hosts = all.filter((p) => /:\/\//.test(p)).slice(0, 4);
    if (hosts.length) out.push(t('đọc và thay đổi dữ liệu trên ') + hosts.join(', '));
  }
  for (const p of all) if (words[p] && !out.includes(words[p])) out.push(words[p]);
  return out;
}

const entryOf = (x) => ({ ...x, loaded: !!(ses && api().getExtension(x.id)) });

// entry: { id (as loaded), folder (under DIR), storeId (Chrome Web Store), name, version, enabled, icon }
const folderOf = (entry) => path.join(DIR, path.basename(entry.folder || entry.id));
const load = (entry) => api().loadExtension(folderOf(entry), { allowFileAccess: false });

// ---- what the browser calls

function init(browsingSession, onChange) {
  ses = browsingSession;
  if (onChange) changed = onChange;
  // the stand-ins for what Electron's extension API lacks (src/preload/crx-shim.js), before any loads
  const shim = path.join(__dirname, '..', 'preload', 'crx-shim.js');
  if (process.env.TYRAN_SHOT) ses.serviceWorkers.on('console-message', (e, d) => console.log('[sw console]', d.message));
  for (const type of ['service-worker', 'frame']) {
    try {
      ses.registerPreloadScript({ id: 'tyran-crx-' + type, type, filePath: shim });
    } catch (err) {
      console.warn('[extensions] no ' + type + ' preload:', err.message);
    }
  }
  // (left over from an install that never finished)
  try {
    for (const n of fs.readdirSync(DIR)) if (n.startsWith('.staging-')) fs.rmSync(path.join(DIR, n), { recursive: true, force: true });
  } catch {
    /* no extensions yet */
  }
  for (const x of readIndex()) if (x.enabled !== false) load(x).catch((err) => console.warn('[extensions] could not load', x.name, err.message));
}

function list() {
  return readIndex().map(entryOf);
}

// step 1: download it and say what it is and what it may do (nothing runs yet)
async function prepare(raw) {
  const id = (String(raw || '').match(/[a-p]{32}/) || [])[0];
  if (!id) throw new Error(t('Không thấy mã tiện ích (32 chữ a–p) trong link này'));
  const { dir, manifest } = await extract(await download(id), id);
  const token = data.uid('x');
  PENDING.set(token, { id, dir, manifest });
  setTimeout(() => cancel(token), 10 * 60000);
  const name = nameOf(dir, manifest);
  return { token, id, name, version: manifest.version, icon: iconOf(dir, manifest), permissions: permissionsOf(manifest), update: readIndex().some((x) => x.storeId === id), mv: manifest.manifest_version };
}

function cancel(token) {
  const p = PENDING.get(token);
  if (!p) return;
  PENDING.delete(token);
  fs.rmSync(p.dir, { recursive: true, force: true });
}

// step 2: the user said yes
async function confirm(token) {
  const p = PENDING.get(token);
  if (!p) throw new Error(t('Hết hạn, hãy thử lại'));
  PENDING.delete(token);
  const old = readIndex().find((x) => x.storeId === p.id);
  if (old && api().getExtension(old.id)) api().removeExtension(old.id);
  const final = path.join(DIR, p.id);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(p.dir, final);
  const entry = { id: p.id, folder: p.id, storeId: p.id, name: nameOf(final, p.manifest), version: p.manifest.version, enabled: true, icon: iconOf(final, p.manifest), installed: old?.installed || Date.now() };
  const ext = await load(entry);
  entry.id = ext.id; // (the store's ID, unless its key could not be kept)
  writeIndex([...readIndex().filter((x) => x.storeId !== p.id), entry]);
  return entryOf(entry);
}

// an unpacked extension folder of the user's (developer mode); copied in, like the store's
async function addFolder(folder) {
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const name = 'unpacked-' + data.uid();
  const final = path.join(DIR, name);
  await fs.promises.cp(folder, final, { recursive: true });
  fs.rmSync(path.join(final, '_metadata'), { recursive: true, force: true });
  const entry = { id: '', folder: name, storeId: '', name: nameOf(final, manifest), version: manifest.version, enabled: true, icon: iconOf(final, manifest), installed: Date.now() };
  try {
    entry.id = (await load(entry)).id;
  } catch (err) {
    fs.rmSync(final, { recursive: true, force: true });
    throw err;
  }
  writeIndex([...readIndex().filter((x) => x.id !== entry.id), entry]);
  return entryOf(entry);
}

async function setEnabled(id, on) {
  const list = readIndex();
  const x = list.find((e) => e.id === id);
  if (!x) return false;
  x.enabled = !!on;
  if (on && !api().getExtension(id)) await load(x);
  if (!on && api().getExtension(id)) api().removeExtension(id);
  writeIndex(list);
  return true;
}

function remove(id) {
  const x = readIndex().find((e) => e.id === id);
  if (!x) return false;
  if (api().getExtension(id)) api().removeExtension(id);
  fs.rmSync(folderOf(x), { recursive: true, force: true });
  writeIndex(readIndex().filter((e) => e.id !== id));
  return true;
}

// newer versions on the store, per extension (none: up to date)
async function checkUpdates() {
  const store = readIndex().filter((x) => x.storeId);
  if (!store.length) return [];
  const xs = store.map((x) => 'x=' + encodeURIComponent(`id=${x.storeId}&v=${x.version}&uc`)).join('&');
  const xml = await net.fetch(`https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=${chromeVersion()}&acceptformat=crx2,crx3&${xs}`).then((r) => r.text());
  const out = [];
  for (const m of xml.matchAll(/<app appid="([a-p]{32})"[^>]*>\s*<updatecheck([^>]*)\/?>/g)) {
    const version = /version="([^"]+)"/.exec(m[2])?.[1];
    const x = store.find((e) => e.storeId === m[1]);
    if (/status="ok"/.test(m[2]) && version && x && version !== x.version) out.push({ id: x.id, version });
  }
  return out;
}

async function update(id) {
  const entry = readIndex().find((x) => x.id === id);
  if (!entry?.storeId) throw new Error(t('Tiện ích này không đến từ Chrome Web Store'));
  const { dir, manifest } = await extract(await download(entry.storeId), entry.storeId);
  const token = data.uid('x');
  PENDING.set(token, { id: entry.storeId, dir, manifest });
  return confirm(token);
}

// ---- tabs, as extensions see them (chrome.tabs.query / get / create / update / remove, filled in by
// src/preload/crx-shim.js): each window tells which tabs it has and which is shown; incognito tabs
// are never listed. A tab's ID is its page's webContents ID, as in Electron's own chrome.tabs.
const TABS = new Map(); // window id -> [{ wcId, active, pinned, favicon }]

function setTabs(win, list) {
  if (!win) return;
  const before = TABS.get(win.id) || [];
  const now = (Array.isArray(list) ? list : []).slice(0, 500);
  TABS.set(win.id, now);
  if (!before.length && !closedHooked.has(win.id)) {
    closedHooked.add(win.id);
    win.once('closed', () => {
      for (const t of TABS.get(win.id) || []) tell('onRemoved', Number(t.wcId), { windowId: win.id, isWindowClosing: true });
      TABS.delete(win.id);
      closedHooked.delete(win.id);
    });
  }
  tabEvents(win.id, before, now);
}
const closedHooked = new Set();

// The tabs' events for the extensions (their chrome.tabs.onCreated / onUpdated / onActivated /
// onRemoved, see src/preload/crx-shim.js): from the windows' tab lists as they change, and from
// each tab's page as it loads, moves and is renamed.
function tell(name, ...args) {
  if (!ses) return;
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed() && wc.session === ses && wc.getURL().startsWith('chrome-extension://')) wc.send('crx:tab-event', name, ...args);
  }
  for (const v of Object.keys(ses.serviceWorkers.getAllRunning?.() || {})) {
    const sw = ses.serviceWorkers.getWorkerFromVersionID(Number(v));
    if (!sw || sw.isDestroyed?.() || !sw.scope.startsWith('chrome-extension://')) continue;
    try {
      sw.send('crx:tab-event', name, ...args);
    } catch {
      /* stopping */
    }
  }
}
const tabOf = (id) => allTabs().tabs.find((t) => t.id === id);
const watched = new Set(); // tabs whose pages are listened to
function watchTab(wc) {
  if (watched.has(wc.id)) return;
  watched.add(wc.id);
  const id = wc.id;
  const update = (change) => {
    const tab = tabOf(id);
    if (tab) tell('onUpdated', id, change, tab);
  };
  wc.on('did-start-loading', () => update({ status: 'loading' }));
  wc.on('did-stop-loading', () => update({ status: 'complete' }));
  wc.on('did-navigate', (e, url) => update({ url }));
  wc.on('did-navigate-in-page', (e, url, isMainFrame) => isMainFrame && update({ url }));
  wc.on('page-title-updated', (e, title) => update({ title }));
  wc.on('page-favicon-updated', (e, icons) => icons?.[0] && update({ favIconUrl: icons[0] }));
  wc.on('audio-state-changed', (e) => update({ audible: !!e.audible }));
  wc.once('destroyed', () => watched.delete(id));
}
function tabEvents(windowId, before, now) {
  const had = new Map(before.map((t) => [Number(t.wcId), t]));
  const has = new Map(now.map((t) => [Number(t.wcId), t]));
  for (const [id] of has) {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) continue;
    watchTab(wc);
    if (!had.has(id)) {
      const tab = tabOf(id);
      if (tab) tell('onCreated', tab);
    }
  }
  for (const [id] of had) if (!has.has(id)) tell('onRemoved', id, { windowId, isWindowClosing: false });
  const was = before.find((t) => t.active);
  const is = now.find((t) => t.active);
  if (is && Number(is.wcId) !== Number(was?.wcId)) tell('onActivated', { tabId: Number(is.wcId), windowId });
  for (const t of now) {
    const p = had.get(Number(t.wcId));
    if (p && p.pinned !== t.pinned) {
      const tab = tabOf(Number(t.wcId));
      if (tab) tell('onUpdated', tab.id, { pinned: !!t.pinned }, tab);
    }
  }
}

const matches = (pattern, url) => {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url);
  const re = new RegExp('^' + String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/^\*:/, 'https?:').replace(/\*/g, '.*') + '$');
  return re.test(url);
};

function allTabs() {
  const focused = BrowserWindow.getFocusedWindow()?.id ?? [...TABS.keys()][0];
  const out = [];
  for (const [windowId, list] of TABS) {
    list.forEach((t, index) => {
      const wc = webContents.fromId(Number(t.wcId));
      if (!wc || wc.isDestroyed()) return;
      out.push({
        id: wc.id,
        index,
        windowId,
        active: !!t.active,
        highlighted: !!t.active,
        selected: !!t.active,
        pinned: !!t.pinned,
        url: wc.getURL(),
        title: wc.getTitle(),
        favIconUrl: t.favicon || '',
        status: wc.isLoading() ? 'loading' : 'complete',
        incognito: false,
        audible: wc.isCurrentlyAudible(),
        mutedInfo: { muted: wc.isAudioMuted() },
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
      });
    });
  }
  return { tabs: out, focused };
}

// the window an extension page belongs to (its popup's), else the focused one
const windowOf = (sender) => (sender && BrowserWindow.fromWebContents(sender.hostWebContents || sender)?.id) ?? null;

const CRX = {
  'crx:tabs': (sender, q = {}) => {
    const { tabs, focused } = allTabs();
    const current = windowOf(sender) ?? focused;
    const urls = q.url ? [].concat(q.url) : null;
    return tabs.filter(
      (t) =>
        (q.active === undefined || t.active === q.active) &&
        (q.pinned === undefined || t.pinned === q.pinned) &&
        (q.audible === undefined || t.audible === q.audible) &&
        (!q.currentWindow || t.windowId === current) &&
        (!q.lastFocusedWindow || t.windowId === focused) &&
        (q.windowId === undefined || q.windowId < 0 ? q.windowId !== -2 || t.windowId === current : t.windowId === q.windowId) &&
        (q.index === undefined || t.index === q.index) &&
        (!urls || urls.some((p) => matches(p, t.url))) &&
        (!q.title || matches(q.title, t.title))
    );
  },
  'crx:windows': (sender) => {
    const { focused } = allTabs();
    return { current: windowOf(sender) ?? focused, focused, all: [...TABS.keys()] };
  },
  'crx:tab-create': (sender, p = {}) => {
    const win = BrowserWindow.fromId(Number(p.windowId)) || BrowserWindow.getFocusedWindow() || BrowserWindow.fromId([...TABS.keys()][0] ?? -1);
    if (win && /^(https?|chrome-extension):/.test(String(p.url || ''))) win.webContents.send('tab:open', { url: p.url, background: p.active === false });
    return true;
  },
  'crx:tab-update': (sender, id, p = {}) => {
    const wc = webContents.fromId(Number(id));
    if (!wc || !allTabs().tabs.some((t) => t.id === wc.id)) return false;
    if (p.url && /^(https?|chrome-extension):/.test(p.url)) wc.loadURL(p.url).catch(() => {});
    if (typeof p.muted === 'boolean') wc.setAudioMuted(p.muted);
    if (p.active) wc.hostWebContents?.send('crx:activate', wc.id);
    return true;
  },
  'crx:tab-remove': (sender, ids) => {
    for (const id of [].concat(ids)) {
      const wc = webContents.fromId(Number(id));
      if (wc && allTabs().tabs.some((t) => t.id === wc.id)) wc.hostWebContents?.send('crx:close', wc.id);
    }
    return true;
  },
};

// extension pages ask through ipcMain; their service workers through their own channel
function registerBridge(ipcMain) {
  for (const [ch, fn] of Object.entries(CRX)) ipcMain.handle(ch, (e, ...a) => (String(e.sender?.getURL?.() || '').startsWith('chrome-extension://') ? fn(e.sender, ...a) : null));
  const hooked = new Set();
  const hook = (versionId) => {
    if (hooked.has(versionId)) return;
    const sw = ses.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!sw || !sw.scope.startsWith('chrome-extension://')) return;
    hooked.add(versionId);
    for (const [ch, fn] of Object.entries(CRX)) {
      try {
        sw.ipc.handle(ch, (e, ...a) => fn(null, ...a));
      } catch {
        /* already there */
      }
    }
  };
  ses.serviceWorkers.on('running-status-changed', ({ versionId }) => hook(versionId));
  for (const id of Object.keys(ses.serviceWorkers.getAllRunning?.() || {})) hook(Number(id)); // (started already)
}

// the extension's pages: its toolbar popup and its options page
function pages(id) {
  const ext = ses && api().getExtension(id);
  if (!ext) return null;
  const m = ext.manifest || {};
  const popup = m.action?.default_popup || m.browser_action?.default_popup || m.page_action?.default_popup || '';
  const options = m.options_ui?.page || m.options_page || '';
  const url = (p) => (p ? `${ext.url}${String(p).replace(/^\//, '')}` : '');
  return { popup: url(popup), options: url(options) };
}

module.exports = { setTabs, registerBridge, init, list, prepare, cancel, confirm, addFolder, setEnabled, remove, checkUpdates, update, pages, DIR };
