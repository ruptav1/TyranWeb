'use strict';
// Browsing sessions (normal + private): user agent, permissions, downloads, privacy headers.
const fs = require('fs');
const path = require('path');
const { app, session, BrowserWindow, webContents, shell, dialog } = require('electron');
const data = require('./data');
const protocol = require('./protocol');
const adblock = require('./adblock');
const privacy = require('./privacy');
const { step } = require('./webrequest');

const PARTITION = 'persist:tyran';
const PRIVATE_PARTITION = 'tyran-private';
// Live (web page) wallpapers run in their own session: no tyran://, no permissions, no downloads.
const WALLPAPER_PARTITION = 'persist:tyran-wallpaper';

// Everything else (incl. third-party cookie access requested by embedded iframes) is denied.
const ASK = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'idle-detection', 'openExternal', 'speaker-selection', 'window-management']);
const ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);

let broadcast = () => {};
const pendingPermissions = new Map();
const liveDownloads = new Map();

function cleanUserAgent(ua) {
  return ua.replace(/\s(tyranweb|TyranWeb|Electron)\/\S+/g, '');
}

// Google refuses to sign in from a browser it takes for an embedded one. On its sign-in pages the
// user agent loses the Chrome version ("Chrome/152.0.x.y" -> "Chrome"), as Ferdium (an Electron app)
// does; main.js switches it once a page there has loaded.
const GOOGLE_SIGNIN = /^https:\/\/accounts\.google\.com(\/|$)/i;
const isGoogleSignIn = (url) => GOOGLE_SIGNIN.test(url || '');
const googleSignInUserAgent = (ua) => ua.replace(/Chrome\/[\d.]+/, 'Chrome');

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url || '';
  }
}

function hostWindowOf(wc) {
  const host = wc.hostWebContents || wc;
  return BrowserWindow.fromWebContents(host) || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
}

function setupPermissions(ses, isPrivate) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALWAYS.has(permission)) return callback(true);
    if (!ASK.has(permission)) return callback(false);
    const origin = originOf(details.requestingUrl || wc.getURL());
    if (permission === 'openExternal') {
      // Asked every time: an external app is about to be launched.
      return ask(wc, origin, permission, details, callback, isPrivate);
    }
    const saved = data.settings.data.sitePermissions[origin]?.[permission];
    if (saved === 'allow') return callback(true);
    if (saved === 'deny') return callback(false);
    ask(wc, origin, permission, details, callback, isPrivate);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (ALWAYS.has(permission)) return true;
    const saved = data.settings.data.sitePermissions[originOf(requestingOrigin)]?.[permission];
    return saved === 'allow';
  });
}

function ask(wc, origin, permission, details, callback, isPrivate) {
  const win = hostWindowOf(wc);
  if (!win) return callback(false);
  const id = data.uid('p');
  pendingPermissions.set(id, { callback, origin, permission, isPrivate });
  win.webContents.send('perm:request', {
    id,
    wcId: wc.id,
    origin,
    permission,
    mediaTypes: details.mediaTypes || [],
    externalURL: details.externalURL || '',
    private: !!isPrivate, // (an incognito tab or window: nothing is remembered)
  });
}

function respondPermission(id, allow, remember) {
  const p = pendingPermissions.get(id);
  if (!p) return;
  pendingPermissions.delete(id);
  if (remember && !p.isPrivate && p.permission !== 'openExternal') {
    const all = data.settings.data.sitePermissions;
    all[p.origin] = { ...(all[p.origin] || {}), [p.permission]: allow ? 'allow' : 'deny' };
    data.settings.save();
    broadcast('settings:changed', data.settings.data);
  }
  p.callback(!!allow);
}

// ---------- downloads ----------
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function serializeDownload(id, item, extra = {}) {
  return {
    id,
    url: item.getURL(),
    filename: item.getFilename(),
    path: item.getSavePath(),
    mime: item.getMimeType(),
    totalBytes: item.getTotalBytes(),
    receivedBytes: item.getReceivedBytes(),
    state: item.getState(),
    paused: item.isPaused(),
    canResume: item.canResume(),
    startTime: Math.round(item.getStartTime() * 1000),
    ...extra,
  };
}

function setupDownloads(ses, isPrivate) {
  ses.on('will-download', (event, item) => {
    const g = data.settings.data.general;
    const dir = g.downloadDir && fs.existsSync(g.downloadDir) ? g.downloadDir : app.getPath('downloads');
    if (!g.askDownloadLocation) item.setSavePath(uniquePath(dir, item.getFilename()));
    else item.setSaveDialogOptions({ defaultPath: path.join(dir, item.getFilename()) });

    const id = data.uid('d');
    liveDownloads.set(id, item);
    let last = 0;
    const push = (force) => {
      const now = Date.now();
      if (!force && now - last < 250) return;
      last = now;
      broadcast('downloads:update', serializeDownload(id, item, { private: isPrivate }));
    };
    push(true);
    item.on('updated', () => push(false));
    item.once('done', (e, state) => {
      liveDownloads.delete(id);
      const record = serializeDownload(id, item, { state, endTime: Date.now(), private: isPrivate });
      if (!isPrivate && item.getSavePath()) {
        data.downloadStore.data.items.unshift(record);
        data.downloadStore.data.items.splice(500);
        data.downloadStore.save();
      }
      broadcast('downloads:update', record);
      if (state === 'completed') broadcast('downloads:done', record);
    });
  });
}

function downloadsList() {
  const live = [...liveDownloads.entries()].map(([id, item]) => serializeDownload(id, item));
  return [...live, ...data.downloadStore.data.items];
}

async function downloadAction(id, action) {
  const item = liveDownloads.get(id);
  const record = data.downloadStore.data.items.find((d) => d.id === id);
  const file = item ? item.getSavePath() : record?.path;
  switch (action) {
    case 'pause': item?.pause(); break;
    case 'resume': if (item?.canResume()) item.resume(); break;
    case 'cancel': item?.cancel(); break;
    case 'open': if (file && fs.existsSync(file)) return shell.openPath(file); return 'missing';
    case 'show': if (file && fs.existsSync(file)) shell.showItemInFolder(file); else return 'missing'; break;
    case 'remove':
      data.downloadStore.data.items = data.downloadStore.data.items.filter((d) => d.id !== id);
      data.downloadStore.save();
      break;
    case 'retry': {
      const url = item ? item.getURL() : record?.url;
      if (url) session.fromPartition(PARTITION).downloadURL(url);
      break;
    }
  }
  broadcast('downloads:changed');
  return true;
}

function clearDownloads() {
  data.downloadStore.data.items = [];
  data.downloadStore.save();
  broadcast('downloads:changed');
}

// ---------- session setup ----------
function setupSession(ses, isPrivate) {
  protocol.install(ses);
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  setupPermissions(ses, isPrivate);
  setupDownloads(ses, isPrivate);
  step(ses, 'onBeforeSendHeaders', 'dnt', (details, cb) => {
    if (!data.settings.data.privacy.doNotTrack) return cb({});
    cb({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
  });
  privacy.apply(ses, data.settings.data.privacy);
  try {
    const langs = ses.availableSpellCheckerLanguages || [];
    ses.setSpellCheckerLanguages(['en-US', 'vi'].filter((l) => langs.includes(l)));
  } catch {
    /* spellchecker unavailable */
  }
  if (data.settings.data.privacy.adblock) adblock.setEnabled(ses, true);
  return ses;
}

function setupWallpaperSession(ses) {
  protocol.installLive(ses);
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}

let browsing;
let privateSes;
let wallpaperSes;

function init(broadcastFn) {
  broadcast = broadcastFn;
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
  protocol.install(session.defaultSession);
  setupPermissions(session.defaultSession, false);
  adblock.setMode(data.settings.data.privacy.adblockEngine);
  browsing = setupSession(session.fromPartition(PARTITION), false);
  privateSes = setupSession(session.fromPartition(PRIVATE_PARTITION), true);
  wallpaperSes = setupWallpaperSession(session.fromPartition(WALLPAPER_PARTITION));
  // Incognito tabs can sit in ordinary windows too: once nothing uses the private session any more
  // (its last tab or window closed), whatever it kept is wiped.
  app.on('web-contents-created', (e, wc) => {
    if (wc.session !== privateSes) return;
    wc.once('destroyed', () =>
      setTimeout(() => {
        if (!webContents.getAllWebContents().some((w) => !w.isDestroyed() && w.session === privateSes)) clearPrivate().catch(() => {});
      }, 1000)
    );
  });
  adblock.onBlockedCount((wcId, count) => {
    const wc = webContents.fromId(wcId);
    const host = wc?.hostWebContents;
    if (host && !host.isDestroyed()) host.send('adblock:count', { wcId, count });
  });
}

// third-party cookies, HTTPS-only (Settings → Quyền riêng tư)
function setPrivacy() {
  for (const ses of [browsing, privateSes]) privacy.apply(ses, data.settings.data.privacy);
}

async function setAdblock(enabled) {
  await adblock.setEnabled(browsing, enabled);
  await adblock.setEnabled(privateSes, enabled);
}

async function clearBrowsingData({ history, cookies, cache, downloads } = {}) {
  if (history) data.history.clear();
  if (cookies) await browsing.clearStorageData();
  if (cache) {
    await browsing.clearCache();
    await browsing.clearCodeCaches({});
  }
  if (downloads) clearDownloads();
}

async function clearPrivate() {
  await privateSes.clearStorageData();
  await privateSes.clearCache();
}

module.exports = {
  PARTITION,
  PRIVATE_PARTITION,
  WALLPAPER_PARTITION,
  init,
  respondPermission,
  downloadsList,
  downloadAction,
  clearDownloads,
  setAdblock,
  setPrivacy,
  clearBrowsingData,
  clearPrivate,
  isGoogleSignIn,
  googleSignInUserAgent,
  browsing: () => browsing,
  wallpaper: () => wallpaperSes,
};
