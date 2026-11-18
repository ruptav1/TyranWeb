'use strict';
// Ad & tracker blocking with per-tab blocked counters, by the engine chosen in Settings → Quyền riêng
// tư (privacy.adblockEngine):
//  - 'ghostery': @ghostery/adblocker-electron with Ghostery's ads + tracking lists;
//  - 'brave': the same engine with the lists Brave turns on by default (brave-adblock.js);
//  - 'brave-full': Brave's own engine, adblock-rust, once built on this computer (brave-adblock.js,
//    brave-build.js); 'brave' stands in while it cannot be loaded.
// Chặn thông báo cookie (privacy.cookieNotices) is Brave's "Cookie notice blocker" lists in an engine
// of their own (Ghostery's, 'cookies'), whichever engine blocks the ads and whether it does, so the
// switch works with all three; Brave's lists for the ads leave them out (brave-adblock.js).
// Sites the user turned it off for (the shield in the address bar: privacy.adblockOff, by site
// domain) get neither its blocking nor its hiding, on every page of theirs and in their frames.
// The library's own enableBlockingInSession() registers global IPC handlers per session and so
// cannot serve two sessions (normal + private); we wire each session ourselves instead, through the
// sessions' shared webRequest steps (webrequest.js).
const fs = require('fs');
const path = require('path');
const { net, ipcMain, webContents } = require('electron');
const data = require('./data');
const { dir } = data;
const brave = require('./brave-adblock');
const { step } = require('./webrequest');

const GHOSTERY_PRELOAD = require.resolve('@ghostery/adblocker-electron-preload', {
  paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))],
});
// Ghostery's uBlock Origin resources (scriptlets, redirects), as its own list loading takes them
const GHOSTERY_RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
// ('brave' was adblock-brave.bin while it held the cookie notice lists too)
const CACHES = { ghostery: 'adblock-engine.bin', brave: 'adblock-brave-2.bin', cookies: 'adblock-cookies.bin' };
fs.rm(path.join(dir, 'adblock-brave.bin'), { force: true }, () => {});
const REFRESH = 4 * 864e5; // lists older than this are fetched again, in the background
const ENGINES = ['ghostery', 'brave', 'brave-full'];

let mode = 'ghostery'; // the engine asked for
let current = null; // the engine in use: { name, mode, preload, onBeforeRequest, onHeadersReceived, blocker? }
let activation = null; // { mode, promise } of the engine being loaded
const ghostery = {}; // 'ghostery' | 'brave' | 'cookies' -> its engine, once loaded
const known = new Set(); // the tabs' sessions (attach)
const enabled = new Set(); // ...the ads are blocked in (setEnabled)
const regs = new Map(); // session -> Map(preload file -> its registration id)
let noticesOn = false; // Chặn thông báo cookie
let notices = null; // ...its engine, once loaded
const counts = new Map(); // webContentsId -> blocked requests on the current page
let onCount = () => {};
let onEngine = () => {};
let ipcReady = false;

// ---------------------------------------------------------------- sites it is off for
function siteOf(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    let d = '';
    try {
      d = require('tldts-experimental').getDomain(host, { allowPrivateDomains: true }) || ''; // (a site of its own on github.io)
    } catch {
      /* (the host itself then) */
    }
    return d || host;
  } catch {
    return '';
  }
}
const offList = () => data.settings.data.privacy.adblockOff || [];
// (a page of that site or of any of its subdomains)
function isOff(url) {
  const list = offList();
  if (!url || !list.length) return false;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return list.some((d) => host === d || host.endsWith('.' + d));
}
// (the page a request is for: its own address when it is the page, else its tab's)
function requestOff(d) {
  if (!offList().length) return false;
  if (d.resourceType === 'mainFrame') return isOff(d.url);
  let top = '';
  try {
    top = d.frame?.top?.url || '';
  } catch {
    /* (its frame is gone) */
  }
  if (!top && d.webContentsId) {
    const wc = webContents.fromId(d.webContentsId);
    if (wc && !wc.isDestroyed()) top = wc.getURL();
  }
  return isOff(top);
}
const senderOff = (e) => {
  try {
    return isOff(e.sender.getURL());
  } catch {
    return false;
  }
};
brave.setSkip(senderOff);

function count(wcId) {
  counts.set(wcId, (counts.get(wcId) || 0) + 1);
  onCount(wcId, counts.get(wcId));
}
brave.setOnBlocked(count);

// ---------------------------------------------------------------- Ghostery's engine
function wire(name, b) {
  b.on('request-blocked', (req) => typeof req.tabId === 'number' && (current?.blocker === b || notices?.blocker === b) && count(req.tabId));
  return { name, preload: GHOSTERY_PRELOAD, blocker: b, onBeforeRequest: b.onBeforeRequest, onHeadersReceived: b.onHeadersReceived };
}

const loadingGhostery = {};
function loadGhostery(name) {
  if (ghostery[name]) return Promise.resolve(ghostery[name]);
  loadingGhostery[name] ??= (async () => {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const fetchFn = (url, opts) => net.fetch(url, opts);
    const fresh =
      name === 'ghostery'
        ? () => ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn)
        : async () => {
            const b = ElectronBlocker.parse(await brave.listsText(name === 'cookies' ? 'cookies' : 'ads'));
            const res = await net.fetch(GHOSTERY_RESOURCES).then((r) => (r.ok ? r.text() : null), () => null);
            if (res) b.updateResources(res, '' + res.length);
            return b;
          };
    const file = path.join(dir, CACHES[name]);
    const b = await ElectronBlocker.fromCached(fresh, { path: file, read: fs.promises.readFile, write: fs.promises.writeFile });
    ghostery[name] = wire(name, b);
    let age = 0;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      /* not written */
    }
    if (age > REFRESH) {
      fresh()
        .then(async (next) => {
          await fs.promises.writeFile(file, next.serialize());
          ghostery[name] = wire(name, next);
          if (current?.name === name) use(ghostery[name], current.mode);
          if (name === 'cookies' && notices) notices = ghostery.cookies;
        })
        .catch((err) => console.warn('[adblock] could not refresh filter lists:', err.message));
    }
    return ghostery[name];
  })()
    .catch((err) => {
      console.warn('[adblock] could not load filter lists:', err.message);
      return null;
    })
    .finally(() => delete loadingGhostery[name]);
  return loadingGhostery[name];
}

// ---------------------------------------------------------------- the engine in use
async function engineFor(m) {
  if (m === 'brave-full') {
    if (await brave.load()) return { name: m, preload: brave.PRELOAD, onBeforeRequest: brave.onBeforeRequest };
    console.warn("[adblock] Brave's engine is not available; using Brave's lists");
    m = 'brave';
  }
  return loadGhostery(m);
}

// `e` handles every session's requests from now on (their preload scripts follow it)
function use(e, m) {
  const was = current?.name;
  current = { ...e, mode: m };
  if (was && was !== e.name) onEngine(e.name, mode); // (another engine now: the user is told)
  brave.setActive(e.name === 'brave-full');
  syncAll();
}

function activate() {
  if (activation?.mode === mode) return activation.promise;
  const m = mode;
  const promise = engineFor(m).then((e) => {
    if (e && mode === m) use(e, m);
    if (!e && activation?.promise === promise) activation = null; // (tried again next time)
  });
  activation = { mode: m, promise };
  return promise;
}

// ---------------------------------------------------------------- sessions
const onBeforeRequest = (d, cb) => (current && !requestOff(d) ? current.onBeforeRequest(d, cb) : cb({}));
const onHeadersReceived = (d, cb) => (current?.onHeadersReceived && !requestOff(d) ? current.onHeadersReceived(d, cb) : cb({}));
const onNoticeRequest = (d, cb) => (notices && !requestOff(d) ? notices.onBeforeRequest(d, cb) : cb({}));

// Ghostery's preload asks from the top frame only (it runs in every frame: main.js), as before;
// both its engines answer it, the one for the ads and the one for cookie notices.
const topFrame = (e) => !!e.senderFrame && !e.senderFrame.parent;
const mainIn = (ses) => enabled.has(ses) && !!current?.blocker;
const noticesIn = (ses) => noticesOn && !!notices && known.has(ses);
function ipc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => {
    if (!topFrame(e) || senderOff(e)) return undefined;
    const ses = e.sender.session;
    return Promise.all([mainIn(ses) && current.blocker.onInjectCosmeticFilters(e, url, msg), noticesIn(ses) && notices.blocker.onInjectCosmeticFilters(e, url, msg)]).then(() => undefined);
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => {
    if (!topFrame(e) || senderOff(e)) return false;
    const ses = e.sender.session;
    return !!((mainIn(ses) && current.blocker.config.enableMutationObserver) || (noticesIn(ses) && notices.blocker.config.enableMutationObserver));
  });
  brave.ipc();
}

// a session's preload scripts and request steps as its settings are now
function sync(ses) {
  const main = enabled.has(ses) && !!current;
  const cookie = noticesIn(ses);
  const want = new Set();
  if (main) want.add(current.preload);
  if (cookie) want.add(GHOSTERY_PRELOAD);
  if (want.size) ipc();
  let reg = regs.get(ses);
  if (!reg) regs.set(ses, (reg = new Map()));
  for (const [file, id] of reg) {
    if (want.has(file)) continue;
    ses.unregisterPreloadScript(id);
    reg.delete(file);
  }
  for (const file of want) if (!reg.has(file)) reg.set(file, ses.registerPreloadScript({ type: 'frame', filePath: file }));
  step(ses, 'onHeadersReceived', 'adblock', main ? onHeadersReceived : null);
  step(ses, 'onBeforeRequest', 'adblock', main ? onBeforeRequest : null);
  step(ses, 'onBeforeRequest', 'notices', cookie ? onNoticeRequest : null);
}
function syncAll() {
  for (const ses of new Set([...known, ...enabled])) sync(ses);
}

// a tab's session (cookie notices are blocked there when that is on)
function attach(ses) {
  known.add(ses);
  sync(ses);
}

async function setEnabled(ses, on) {
  if (!on) {
    enabled.delete(ses);
    sync(ses);
    return true;
  }
  if (current?.mode !== mode) await activate();
  if (!current) return false;
  enabled.add(ses);
  sync(ses);
  return true;
}

// another engine (Settings); loaded now if blocking is on
async function setMode(m) {
  mode = ENGINES.includes(m) ? m : 'ghostery';
  if (enabled.size && current?.mode !== mode) await activate();
}

// Chặn thông báo cookie on or off (its lists loaded the first time)
async function setNotices(on) {
  noticesOn = !!on;
  if (noticesOn && !notices) notices = await loadGhostery('cookies');
  syncAll();
}

// the engine asked for and the one in use (null while none is loaded)
const engine = () => ({ asked: mode, using: current?.name || null });

module.exports = {
  attach,
  setEnabled,
  setMode,
  setNotices,
  engine,
  siteOf,
  isOff,
  onEngineChange: (fn) => (onEngine = fn),
  resetCount: (id) => counts.delete(id),
  getCount: (id) => counts.get(id) || 0,
  onBlockedCount: (fn) => (onCount = fn),
};
