'use strict';
// Ad & tracker blocking with per-tab blocked counters, by the engine chosen in Settings → Quyền riêng
// tư (privacy.adblockEngine):
//  - 'ghostery': @ghostery/adblocker-electron with Ghostery's ads + tracking lists;
//  - 'brave': the same engine with the lists Brave turns on by default (brave-adblock.js);
//  - 'brave-full': Brave's own engine, adblock-rust, once built on this computer (brave-adblock.js,
//    brave-build.js); 'brave' stands in while it cannot be loaded.
// The library's own enableBlockingInSession() registers global IPC handlers per session and so
// cannot serve two sessions (normal + private); we wire each session ourselves instead, through the
// sessions' shared webRequest steps (webrequest.js).
const fs = require('fs');
const path = require('path');
const { net, ipcMain } = require('electron');
const { dir } = require('./data');
const brave = require('./brave-adblock');
const { step } = require('./webrequest');

const GHOSTERY_PRELOAD = require.resolve('@ghostery/adblocker-electron-preload', {
  paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))],
});
// Ghostery's uBlock Origin resources (scriptlets, redirects), as its own list loading takes them
const GHOSTERY_RESOURCES = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const CACHES = { ghostery: 'adblock-engine.bin', brave: 'adblock-brave.bin' };
const REFRESH = 4 * 864e5; // lists older than this are fetched again, in the background
const ENGINES = ['ghostery', 'brave', 'brave-full'];

let mode = 'ghostery'; // the engine asked for
let current = null; // the engine in use: { name, mode, preload, onBeforeRequest, onHeadersReceived, blocker? }
let activation = null; // { mode, promise } of the engine being loaded
const ghostery = {}; // 'ghostery' | 'brave' -> its engine, once loaded
const sessions = new Map(); // session -> { id, preload } of its preload script
const counts = new Map(); // webContentsId -> blocked requests on the current page
let onCount = () => {};
let ipcReady = false;

function count(wcId) {
  counts.set(wcId, (counts.get(wcId) || 0) + 1);
  onCount(wcId, counts.get(wcId));
}
brave.setOnBlocked(count);

// ---------------------------------------------------------------- Ghostery's engine
function wire(name, b) {
  b.on('request-blocked', (req) => typeof req.tabId === 'number' && current?.blocker === b && count(req.tabId));
  return { name, preload: GHOSTERY_PRELOAD, blocker: b, onBeforeRequest: b.onBeforeRequest, onHeadersReceived: b.onHeadersReceived };
}

const loadingGhostery = {};
function loadGhostery(name) {
  if (ghostery[name]) return Promise.resolve(ghostery[name]);
  loadingGhostery[name] ??= (async () => {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const fetchFn = (url, opts) => net.fetch(url, opts);
    const fresh =
      name === 'brave'
        ? async () => {
            const b = ElectronBlocker.parse(await brave.listsText());
            const res = await net.fetch(GHOSTERY_RESOURCES).then((r) => (r.ok ? r.text() : null), () => null);
            if (res) b.updateResources(res, '' + res.length);
            return b;
          }
        : () => ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn);
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
  current = { ...e, mode: m };
  brave.setActive(e.name === 'brave-full');
  for (const [ses, reg] of sessions) {
    if (reg.preload === e.preload) continue;
    ses.unregisterPreloadScript(reg.id);
    sessions.set(ses, { id: ses.registerPreloadScript({ type: 'frame', filePath: e.preload }), preload: e.preload });
  }
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
const onBeforeRequest = (d, cb) => (current ? current.onBeforeRequest(d, cb) : cb({}));
const onHeadersReceived = (d, cb) => (current?.onHeadersReceived ? current.onHeadersReceived(d, cb) : cb({}));

function enableIn(ses) {
  if (sessions.has(ses)) return;
  if (!ipcReady) {
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => current?.blocker?.onInjectCosmeticFilters(e, url, msg));
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => (current?.blocker ? current.blocker.onIsMutationObserverEnabled(e) : false));
    brave.ipc();
    ipcReady = true;
  }
  sessions.set(ses, { id: ses.registerPreloadScript({ type: 'frame', filePath: current.preload }), preload: current.preload });
  step(ses, 'onHeadersReceived', 'adblock', onHeadersReceived);
  step(ses, 'onBeforeRequest', 'adblock', onBeforeRequest);
}

function disableIn(ses) {
  if (!sessions.has(ses)) return;
  step(ses, 'onHeadersReceived', 'adblock', null);
  step(ses, 'onBeforeRequest', 'adblock', null);
  ses.unregisterPreloadScript(sessions.get(ses).id);
  sessions.delete(ses);
}

async function setEnabled(ses, enabled) {
  if (!enabled) return disableIn(ses), true;
  if (current?.mode !== mode) await activate();
  if (!current) return false;
  enableIn(ses);
  return true;
}

// another engine (Settings); loaded now if blocking is on
async function setMode(m) {
  mode = ENGINES.includes(m) ? m : 'ghostery';
  if (sessions.size && current?.mode !== mode) await activate();
}

module.exports = {
  setEnabled,
  setMode,
  resetCount: (id) => counts.delete(id),
  getCount: (id) => counts.get(id) || 0,
  onBlockedCount: (fn) => (onCount = fn),
};
