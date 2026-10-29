'use strict';
// TyranWeb — main process entry.
const path = require('path');
const mark = require('./timing');
const { app, BrowserWindow, Menu, nativeTheme, session } = require('electron');

// Optional separate profile folder (portable use, testing): TYRAN_PROFILE=D:\path
if (process.env.TYRAN_PROFILE) app.setPath('userData', process.env.TYRAN_PROFILE);

const protocol = require('./protocol');
protocol.registerPrivileges();
if (process.env.TYRAN_SHOT) require('./devshot')();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const data = require('./data');
const sessions = require('./sessions');
const windows = require('./windows');
const ipc = require('./ipc');
const adblock = require('./adblock');
const tabHistory = require('./tabhistory');
const otherSound = require('./othersound');
const { getShortcuts, toAccelerator } = require('./shortcuts');
mark('modules');

const WEBVIEW_PRELOAD = path.join(__dirname, '..', 'preload', 'webview.js');
const ALLOWED_PARTITIONS = new Set([sessions.PARTITION, sessions.PRIVATE_PARTITION]);

app.setAppUserModelId('app.tyranweb.browser');
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');
if (!data.settings.data.general.smoothScrolling) app.commandLine.appendSwitch('disable-smooth-scrolling');

// ---------- keyboard shortcuts reserved by the browser ----------
let reservedKeys = new Map();
function rebuildShortcuts() {
  reservedKeys = new Map();
  for (const [id, def] of Object.entries(getShortcuts(data.settings.data.shortcuts))) {
    if (!def.reserved) continue;
    for (const k of def.keys) reservedKeys.set(k, id);
  }
}

function applyPageScheme(s) {
  const scheme = s.appearance.pageScheme || 'theme';
  nativeTheme.themeSource = scheme === 'theme' ? (s.appearance.dark ? 'dark' : 'light') : scheme;
}

// ---------- guests (web pages inside <webview>) ----------
function openInTab(guest, url, background) {
  const host = guest.hostWebContents;
  if (host && !host.isDestroyed()) return host.send('tab:open', { url, background, openerWcId: guest.id });
  const win = BrowserWindow.getFocusedWindow() || [...windows.windows.values()].find((w) => !w.private)?.win;
  win?.webContents.send('tab:open', { url, background: false });
}

function setupGuest(contents) {
  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    const isPopup = disposition === 'new-window' && !!features;
    if (isPopup || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          icon: path.join(__dirname, '..', '..', 'assets', 'icon', 'icon.png'),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    // only internal pages may open other internal pages
    const fromInternal = contents.getURL().startsWith('tyran:');
    if (/^https?:/i.test(url) || (fromInternal && /^tyran:/i.test(url))) openInTab(contents, url, disposition === 'background-tab');
    return { action: 'deny' };
  });

  if (contents.getType() === 'webview') {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const acc = toAccelerator(input);
      const cmd = acc && reservedKeys.get(acc);
      if (!cmd) return;
      event.preventDefault();
      contents.hostWebContents?.send('command', { id: cmd, wcId: contents.id });
    });
    contents.on('zoom-changed', (e, direction) => {
      contents.hostWebContents?.send('command', { id: direction === 'in' ? 'page.zoomIn' : 'page.zoomOut', wcId: contents.id });
    });
  }

  // Web pages may not navigate to internal tyran:// pages (the address bar still can:
  // loadURL does not emit will-navigate).
  contents.on('will-navigate', (e) => {
    const from = contents.getURL();
    if ((e.url || '').startsWith('tyran:') && from && !from.startsWith('tyran:')) e.preventDefault();
  });
  contents.on('will-frame-navigate', (e) => {
    if ((e.url || '').startsWith('tyran:') && !e.isMainFrame) e.preventDefault();
  });

  contents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) adblock.resetCount(contents.id);
  });

  // Google's sign-in pages get a user agent without the Chrome version (sessions.js says why). It is
  // switched once a page has loaded: changing it while a navigation or redirect is under way cancels
  // that navigation (cross-site sign-in form posts would break).
  let google = false;
  contents.on('did-navigate', (e, url) => {
    const want = sessions.isGoogleSignIn(url);
    if (want === google) return;
    google = want;
    const ua = contents.session.getUserAgent();
    contents.setUserAgent(want ? sessions.googleSignInUserAgent(ua) : ua);
  });
}

// Live wallpaper pages: untrusted, no preload, no popups; Esc / the Lobby shortcut leave Lobby mode.
function setupWallpaperGuest(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => {
    if (!/^(https|livewp):/i.test(e.url || '')) e.preventDefault();
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const acc = toAccelerator(input);
    const id = acc === 'Esc' ? 'wallpaper.lobbyExit' : reservedKeys.get(acc) === 'wallpaper.lobby' ? 'wallpaper.lobby' : null;
    if (!id) return;
    event.preventDefault();
    contents.hostWebContents?.send('command', { id });
  });
}

app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (e, prefs, params) => {
    if (params.partition === sessions.WALLPAPER_PARTITION) {
      delete prefs.preload;
      delete prefs.preloadURL;
      // a wallpaper's music may start on its own (it is muted unless the user turned sound on)
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, plugins: false, spellcheck: false, autoplayPolicy: 'no-user-gesture-required' });
      if (!contents.getURL().startsWith('tyran://app/') || !/^(https|livewp):/i.test(params.src || '')) e.preventDefault();
      return;
    }
    tabHistory.claim(params); // (a tab given back its back/forward list)
    delete prefs.preloadURL;
    prefs.preload = WEBVIEW_PRELOAD;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    prefs.allowRunningInsecureContent = false;
    prefs.spellcheck = true;
    prefs.plugins = true; // built-in PDF viewer
    prefs.scrollBounce = false;
    prefs.transparent = true;
    if (!ALLOWED_PARTITIONS.has(params.partition)) e.preventDefault();
    // (an installed extension's own page: its popup or options, opened by TyranWeb itself)
    const extPage = /^chrome-extension:\/\/([a-p]{32})\//.exec(params.src || '');
    const extOk = extPage && contents.getURL().startsWith('tyran://app/') && sessions.browsing().extensions.getExtension(extPage[1]);
    if (!/^(https?|tyran|about|data|view-source):/i.test(params.src || 'about:blank') && !extOk) e.preventDefault();
  });
  contents.on('did-attach-webview', (e, guest) => tabHistory.attached(guest));
  // tabs, and popup windows opened by web pages (they share the browsing session)
  const type = contents.getType();
  if (type === 'webview' && contents.session === sessions.wallpaper()) setupWallpaperGuest(contents);
  else if (type === 'webview' || (type === 'window' && contents.session !== session.defaultSession)) {
    if (type === 'webview') tabHistory.adopt(contents);
    otherSound.watch(contents); // (its sound pauses the new tab page's music)
    setupGuest(contents);
  }
  if (type === 'window') {
    // The browser shell itself must never navigate away from tyran://app (reloading itself is fine:
    // the first-start language pick does that).
    contents.on('will-navigate', (e) => {
      if (contents.getURL().startsWith('tyran://app/') && e.url !== contents.getURL()) e.preventDefault();
    });
  }
});

// ---------- startup ----------
function openUrlFromArgs(argv) {
  const url = argv.slice(1).find((a) => /^(https?:\/\/|file:\/\/)/i.test(a));
  return url || null;
}

// Settings → Hình nền → Blue Archive → Chọn sảnh khi mở app (Ngẫu nhiên, Theo mùa và giờ): each start
// shows another lobby, picked among the ones that work (not waiting more than a moment for the list).
async function randomLobby() {
  const w = data.settings.data.wallpaper;
  // (it was a switch, "Sảnh ngẫu nhiên mỗi lần mở app", before the three choices)
  if (w.web?.randomLobby && w.web.lobbyPick === 'fixed') data.updateSettings({ wallpaper: { web: { lobbyPick: 'random', randomLobby: false } } });
  if (w.type !== 'web' || w.web?.preset !== 'bluearchive' || !['random', 'season'].includes(w.web.lobbyPick)) return;
  const services = require('./services');
  const key = await Promise.race([services.pickLobby(w.web).catch(() => ''), new Promise((r) => setTimeout(() => r(''), 2500))]);
  if (key) data.updateSettings({ wallpaper: { web: { model: key, autoPeriod: services.lobbyPeriod() } } });
}

function startup() {
  const s = data.settings.data;
  const url = openUrlFromArgs(process.argv);
  const saved = data.sessionStore.data.windows || [];
  // (the tabs closed before quitting go to the first window: Ctrl+Shift+T reopens them there)
  if (s.general.startup === 'restore' && saved.length) {
    saved.forEach((w, i) => windows.createWindow({ restore: w, url: i === 0 ? url : null, closed: i === 0 }));
  } else {
    windows.createWindow({ url, closed: true });
  }
}

app.on('second-instance', (event, argv) => {
  const url = openUrlFromArgs(argv);
  const entry = [...windows.windows.values()].find((w) => !w.private);
  if (!entry) return windows.createWindow({ url });
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.focus();
  entry.win.webContents.send('tab:open', { url: url || null, background: false });
});

app.whenReady().then(async () => {
  mark('ready');
  Menu.setApplicationMenu(null);
  rebuildShortcuts();
  applyPageScheme(data.settings.data);
  mark('shortcuts+scheme');
  sessions.init(ipc.broadcast);
  mark('sessions');
  // Chrome extensions, in the browsing session (not in incognito, as in Chrome)
  require('./extensions').init(sessions.browsing(), () => ipc.broadcast('extensions:changed'));
  ipc.register({
    onSettings: (s, prev) => {
      if (JSON.stringify(s.shortcuts) !== JSON.stringify(prev.shortcuts)) {
        rebuildShortcuts();
        ipc.broadcast('shortcuts:changed', getShortcuts(s.shortcuts));
      }
      applyPageScheme(s);
      otherSound.settingsChanged();
    },
  });
  otherSound.init(ipc.broadcast);
  mark('sessions+extensions');
  await randomLobby();
  mark('randomLobby');
  startup();
});

let cleaned = false;
app.on('before-quit', async (e) => {
  windows.saveSession({ fresh: true }); // (each open tab's history as it is now: where its pages are scrolled to)
  windows.setQuitting();
  data.flushAll();
  if (data.settings.data.privacy.clearOnExit && !cleaned) {
    e.preventDefault();
    cleaned = true;
    try {
      await sessions.clearBrowsingData({ history: true, cookies: true, cache: true });
    } finally {
      data.flushAll();
      app.quit();
    }
  }
});

app.on('window-all-closed', () => {
  data.flushAll();
  app.quit();
});

process.on('uncaughtException', (err) => console.error('[main] uncaught', err));
