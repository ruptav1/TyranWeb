'use strict';
// Browser windows: frameless shell with native Windows caption buttons (Snap Layouts work).
const path = require('path');
const { BrowserWindow, screen, webContents } = require('electron');
const data = require('./data');
const sessions = require('./sessions');
const tabHistory = require('./tabhistory');
const { t } = require('./i18n');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon', 'icon.png');
const windows = new Map(); // id -> { win, private, tabs, active, strip, focusedAt, noHistory, drag }

// (Mica, Acrylic: Windows' own materials behind the window; transparent: nothing, the desktop shows)
function backgroundFor(settings) {
  const type = settings.wallpaper.type;
  return type === 'mica' || type === 'acrylic' || type === 'transparent' ? '#00000000' : settings.appearance.bg;
}

function materialFor(settings) {
  const type = settings.wallpaper.type;
  return type === 'mica' ? 'mica' : type === 'acrylic' ? 'acrylic' : 'none';
}

function validBounds(b) {
  if (!b) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.y < area.y + area.height - 40 && b.x + b.width > area.x + 80 && b.y >= area.y - 10;
  return visible ? b : null;
}

// (bounds: where it opens, as a tab dragged out of another window is dropped)
function createWindow({ isPrivate = false, restore = null, url = null, closed = false, bounds = null } = {}) {
  require('./timing')('createWindow' + (isPrivate ? ' (private)' : ''));
  const s = data.settings.data;
  const saved = (bounds && validBounds(bounds)) || (isPrivate ? null : validBounds(data.windowStore.data.bounds));
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: saved?.width || Math.min(1360, Math.round(area.width * 0.88)),
    height: saved?.height || Math.min(880, Math.round(area.height * 0.9)),
    x: saved?.x,
    y: saved?.y,
    minWidth: 520,
    minHeight: 380,
    show: false, // (shown at once below, in its background colour, while the interface loads)
    title: isPrivate ? t('TyranWeb — Ẩn danh') : 'TyranWeb',
    icon: ICON,
    backgroundColor: backgroundFor(s),
    backgroundMaterial: materialFor(s),
    // (a window is see-through or not from the start: switching to or from it restarts TyranWeb)
    transparent: s.wallpaper.type === 'transparent',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: s.appearance.text, height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  windows.set(win.id, { win, private: isPrivate, tabs: [], active: 0, initial: { restore, url, closed } });
  if (!isPrivate && !bounds && data.windowStore.data.maximized) win.maximize();

  const query = new URLSearchParams({ wid: String(win.id) });
  if (isPrivate) query.set('private', '1');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(`tyran://app/index.html?${query}`);
  // the window comes up at once (its colour, then the interface as it loads), not half a second later
  win.show();
  win.once('ready-to-show', () => require('./timing')('window painted ' + win.id));

  const remember = () => {
    if (isPrivate || win.isDestroyed()) return;
    data.windowStore.data.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) data.windowStore.data.bounds = win.getBounds();
    data.windowStore.save();
  };
  win.on('resize', remember);
  win.on('move', remember);
  // (where it is on the screen, for the desktop's picture behind it: Nền desktop)
  const placed = () => !win.isDestroyed() && win.webContents.send('win:placement', placement(win));
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, placed);
  win.on('maximize', () => { remember(); win.webContents.send('win:state', state(win)); });
  win.on('unmaximize', () => { remember(); win.webContents.send('win:state', state(win)); });
  win.on('enter-full-screen', () => win.webContents.send('win:state', state(win)));
  win.on('leave-full-screen', () => win.webContents.send('win:state', state(win)));
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') win.webContents.send('command', { id: 'nav.back' });
    if (cmd === 'browser-forward') win.webContents.send('command', { id: 'nav.forward' });
  });
  win.on('focus', () => {
    const entry = windows.get(win.id);
    if (entry) entry.focusedAt = Date.now();
    win.webContents.send('win:state', state(win));
  });
  // (moved by its title bar onto another window's tab strip: its tabs go there, as Chrome's do; not
  // while TyranWeb moves it itself, along with a dragged tab)
  win.on('moved', () => {
    const entry = windows.get(win.id);
    if (!entry || entry.drag) return;
    const at = screen.getCursorScreenPoint();
    const target = stripAt(at, win.id, entry.private);
    if (target) win.webContents.send('win:mergeInto', { targetId: target.win.id, x: at.x, y: at.y });
  });
  win.on('blur', () => win.webContents.send('win:state', state(win)));

  // (the last window closing: its tabs are kept with their histories as they are now; any window closed
  // goes into the history of tab groups, unless its tabs went to another window)
  win.on('close', () => {
    if (isPrivate) return;
    saveSession({ fresh: true });
    const entry = windows.get(win.id);
    if (entry && !entry.noHistory && !quitting) recordGroup(entry);
  });
  win.on('closed', () => {
    const entry = windows.get(win.id);
    windows.delete(win.id);
    if (entry && !entry.private) saveSession();
    if (isPrivate && ![...windows.values()].some((w) => w.private)) sessions.clearPrivate();
  });
  return win;
}

function state(win) {
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() };
}

// The window's page on the screen, the screen it is on and all of them (in the same units)
function placement(win) {
  const content = win.getContentBounds();
  const all = screen.getAllDisplays().map((d) => d.bounds);
  return { content, display: screen.getDisplayMatching(content).bounds, all };
}

// Remember open tabs for "restore last session" (private windows are never saved).
let quitting = false;
function updateSession(winId, tabs, active) {
  const entry = windows.get(winId);
  if (!entry || entry.private) return;
  entry.tabs = tabs;
  entry.active = active;
  saveSession();
}

// (fresh: each open tab's history read again, with the page states Chromium has kept since)
function saveSession({ fresh = false } = {}) {
  if (quitting) return;
  const onDisk = ({ wcId, ...tab }) => {
    const h = fresh && wcId ? tabHistory.read(webContents.fromId(wcId)) : null;
    return h ? { ...tab, history: h } : tab;
  };
  const list = [...windows.values()].filter((w) => !w.private && w.tabs.length).map((w) => ({ tabs: w.tabs.map(onDisk), active: w.active }));
  // Closing the last window keeps its tabs so the next launch can restore them.
  if (!list.length && windows.size) return;
  if (list.length) {
    data.sessionStore.data.windows = list;
    data.sessionStore.save();
  }
}

// ---- tab strips: where each window's is on the screen (reported by its interface), and which one a
// point is over (a dragged tab or window dropped there); the window most recently used first
function stripAt(point, exceptId, isPrivate) {
  const hits = [...windows.values()].filter((w) => {
    if (w.win.id === exceptId || w.win.isDestroyed() || !w.strip || !!w.private !== !!isPrivate || w.win.isMinimized() || !w.win.isVisible()) return false;
    const c = w.win.getContentBounds();
    const r = { x: c.x + w.strip.x, y: c.y + w.strip.y, w: w.strip.w, h: w.strip.h };
    return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y - 6 && point.y <= r.y + r.h + 6;
  });
  return hits.sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0))[0] || null;
}

// tabs given to a window (from another one), placed where the point is over its strip
function adopt(entry, tabs, point) {
  const c = entry.win.getContentBounds();
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.webContents.send('tabs:adopt', { tabs, x: point ? point.x - c.x : null, y: point ? point.y - c.y : null });
  entry.win.focus();
}

// ---- the history of tab groups (Lịch sử → Nhóm tab): a window's tabs when it closed, with their
// back/forward lists; new tab pages left out; the same group twice in a row kept once
let onGroups = () => {};
function recordGroup(entry) {
  const tabs = (entry.tabs || [])
    .filter((t) => t && !/^tyran:\/\/newtab/i.test(t.url))
    .map(({ wcId, ...t }) => {
      const h = wcId ? tabHistory.read(webContents.fromId(wcId)) : null;
      return h ? { ...t, history: h } : t;
    });
  if (!tabs.length) return;
  const store = data.windowHistoryStore;
  const items = store.data.items || [];
  const key = (g) => g.tabs.map((t) => t.url).join('\n');
  if (items[0] && key(items[0]) === key({ tabs })) items[0].at = Date.now();
  else items.unshift({ id: data.uid('g'), at: Date.now(), tabs, active: Math.min(entry.active | 0, tabs.length - 1) });
  store.data.items = items.slice(0, 40);
  store.save();
  onGroups();
}
// (TyranWeb quitting: every window open then, as a group)
let recordedAll = false; // (before-quit can come twice)
function recordAll() {
  if (recordedAll) return;
  recordedAll = true;
  for (const w of windows.values()) if (!w.private && !w.noHistory) recordGroup(w);
}

// Tabs closed (Ctrl+Shift+T reopens them, after a restart too); never those of an incognito window
function addClosed(winId, tab) {
  if (windows.get(winId)?.private) return;
  const list = (data.sessionStore.data.closed || []).filter((c) => c.id !== tab.id);
  list.push(tab);
  data.sessionStore.data.closed = list.slice(-25);
  data.sessionStore.save();
}

function removeClosed(id) {
  const list = data.sessionStore.data.closed || [];
  if (!list.some((c) => c.id === id)) return;
  data.sessionStore.data.closed = list.filter((c) => c.id !== id);
  data.sessionStore.save();
}

function setQuitting() {
  quitting = true;
}

function applyChrome(win, { symbolColor, height }) {
  try {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor, height: Math.round(height) });
  } catch {
    /* not supported */
  }
}

function applyBackground(settings) {
  for (const { win } of windows.values()) {
    if (win.isDestroyed()) continue;
    win.setBackgroundColor(backgroundFor(settings));
    try {
      win.setBackgroundMaterial(materialFor(settings));
    } catch {
      /* Windows 11 only */
    }
  }
}

module.exports = {
  windows,
  createWindow,
  stripAt,
  adopt,
  recordGroup,
  recordAll,
  onGroupsChange: (fn) => (onGroups = fn),
  updateSession,
  saveSession,
  addClosed,
  removeClosed,
  setQuitting,
  applyChrome,
  applyBackground,
  state,
  placement,
};
