'use strict';
// IPC between the browser UI / internal pages (tyran://) and the main process.
const fs = require('fs');
const path = require('path');
const { app, ipcMain, webContents, BrowserWindow, dialog, clipboard, shell } = require('electron');
const data = require('./data');
const sessions = require('./sessions');
const services = require('./services');
const windows = require('./windows');
const adblock = require('./adblock');
const tabHistory = require('./tabhistory');
const otherSound = require('./othersound');
const { getShortcuts } = require('./shortcuts');
const { SEARCH_ENGINES, SETTINGS } = require('./defaults');
const { t } = require('./i18n');

const SPECTRUM_WORLD = 1077; // (the bar's measuring in tabs: a script world of its own)

const isInternal = (e) => (e.senderFrame?.url || '').startsWith('tyran://');
const isUI = (e) => (e.senderFrame?.url || '').startsWith('tyran://app/');

function broadcast(channel, payload) {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    if (wc.getURL().startsWith('tyran://')) wc.send(channel, payload);
  }
}

// Register a handler callable from any tyran:// page (UI or internal page).
function handle(channel, fn, { uiOnly = false } = {}) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (uiOnly ? !isUI(event) : !isInternal(event)) throw new Error('Not allowed');
    return fn(event, ...args);
  });
}

// The UI may only drive webviews that live inside its own window.
function guestOf(event, wcId) {
  const wc = webContents.fromId(Number(wcId));
  if (!wc || wc.isDestroyed() || wc.hostWebContents !== event.sender) throw new Error('Unknown tab');
  return wc;
}

let onSettingsChanged = () => {};
let pickLobbyNow = () => {};

function afterSettingsChange(prev) {
  const s = data.settings.data;
  broadcast('settings:changed', s);
  if (s.wallpaper.web?.lobbyPick === 'season' && prev.wallpaper.web?.lobbyPick !== 'season') pickLobbyNow();
  if (prev.privacy.adblockEngine !== s.privacy.adblockEngine) adblock.setMode(s.privacy.adblockEngine);
  if (prev.privacy.adblock !== s.privacy.adblock) sessions.setAdblock(s.privacy.adblock);
  if (prev.privacy.blockThirdPartyCookies !== s.privacy.blockThirdPartyCookies || prev.privacy.httpsOnly !== s.privacy.httpsOnly) sessions.setPrivacy();
  if (prev.wallpaper.type !== s.wallpaper.type || prev.appearance.bg !== s.appearance.bg) windows.applyBackground(s);
  onSettingsChanged(s, prev);
  // another language (Settings → Chung): TyranWeb starts again in it, its tabs restored (the first
  // pick, on the first start, only reloads the window that asked)
  // ...as it does for a see-through window, or back from one (only made so: see windows.js)
  const clear = (x) => x.wallpaper.type === 'transparent';
  if (((prev.general.language && prev.general.language !== s.general.language) || clear(prev) !== clear(s)) && !process.env.TYRAN_SHOT) {
    data.flushAll();
    setTimeout(() => (app.relaunch(), app.exit(0)), 400);
  }
  // a new mouse cursor: every page (the window, its tabs, panels) takes it at once
  if (JSON.stringify(prev.appearance.cursor) !== JSON.stringify(s.appearance.cursor)) {
    const cfg = services.cursorConfig();
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) wc.send('cursor:changed', cfg);
  }
}

// the search engines, the ones named in words (Cốc Cốc, Tùy chỉnh) in the user's language
const enginesNamed = () => Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([k, v]) => [k, { ...v, name: t(v.name) }]));

function changeSettings(patch) {
  const prev = structuredClone(data.settings.data);
  data.updateSettings(patch);
  afterSettingsChange(prev);
  return data.settings.data;
}

async function capture(wc) {
  const image = await wc.capturePage();
  const dir = path.join(app.getPath('pictures'), 'TyranWeb');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `TyranWeb-${stamp}.png`);
  fs.writeFileSync(file, image.toPNG());
  clipboard.writeImage(image);
  return file;
}

function safeName(title, ext) {
  const base = String(title || 'trang').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'trang';
  return base + ext;
}

const PIP_SCRIPT = `(() => {
  if (document.pictureInPictureElement) { document.exitPictureInPicture(); return 'exit'; }
  const vids = [...document.querySelectorAll('video')].filter(v => v.readyState > 0);
  vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  const v = vids.find(v => !v.paused) || vids[0];
  if (!v) return 'none';
  v.disablePictureInPicture = false;
  return v.requestPictureInPicture().then(() => 'ok', () => 'fail');
})()`;

function register({ onSettings } = {}) {
  if (onSettings) onSettingsChanged = onSettings;

  // ---- settings ----
  handle('settings:get', () => data.settings.data);
  handle('settings:set', (e, patch) => changeSettings(patch));
  handle('i18n:get', () => require('./i18n').info());
  // NIKKE and Azur Lane, still being tried out, are opened with a password (only its SHA-256 is kept);
  // once given, Settings remembers it
  handle('labs:unlock', (e, password) => {
    const ok = typeof password === 'string' && require('crypto').createHash('sha256').update(password).digest('hex') === 'e5173fd908d33f67f21213c611a1cdcf92819fc920c76e977bd4e4fd23213e45';
    if (ok) changeSettings({ general: { labsUnlocked: true } });
    return ok;
  });
  handle('settings:reset', (e, section) => {
    const prev = structuredClone(data.settings.data);
    if (section && SETTINGS[section]) data.settings.data[section] = structuredClone(SETTINGS[section]);
    else if (!section) data.settings.data = structuredClone(SETTINGS);
    data.settings.save();
    afterSettingsChange(prev);
    return data.settings.data;
  });
  handle('settings:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender);
    const r = await dialog.showSaveDialog(win, { title: t('Xuất theme'), defaultPath: 'tyranweb-theme.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return false;
    const { appearance, wallpaper, layout, newtab } = data.settings.data;
    fs.writeFileSync(r.filePath, JSON.stringify({ tyranweb: 1, appearance, wallpaper, layout, newtab }, null, 2));
    return r.filePath;
  });
  handle('settings:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender);
    const r = await dialog.showOpenDialog(win, { title: t('Nhập theme'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return false;
    const json = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!json || json.tyranweb !== 1) throw new Error(t('File theme không hợp lệ'));
    const patch = {};
    for (const k of ['appearance', 'wallpaper', 'layout', 'newtab']) if (json[k] && typeof json[k] === 'object') patch[k] = json[k];
    changeSettings(patch);
    return true;
  });
  handle('shortcuts:get', () => getShortcuts(data.settings.data.shortcuts));
  // Any tab's preload may ask for the page-overridable shortcuts (accelerator -> command).
  ipcMain.handle('guest:shortcuts', () => {
    const map = {};
    for (const [id, def] of Object.entries(getShortcuts(data.settings.data.shortcuts))) {
      if (!def.reserved) for (const k of def.keys) map[k] = id;
    }
    return map;
  });
  handle('search:engines', () => enginesNamed());

  // ---- history ----
  handle('history:query', (e, q) => data.history.query(q));
  handle('history:suggest', (e, text) => data.history.suggest(text));
  handle('history:top', (e, n) => data.history.topSites(n));
  handle('history:remove', (e, ids) => (data.history.remove(ids), broadcast('history:changed'), true));
  handle('history:clear', (e, since) => (data.history.clear(since), broadcast('history:changed'), true));
  handle('history:add', (e, entry) => data.history.add(entry), { uiOnly: true });
  handle('history:update', (e, entry) => data.history.update(entry), { uiOnly: true });

  // ---- bookmarks ----
  const bm = (fn) => (...args) => {
    const r = fn(...args);
    broadcast('bookmarks:changed', data.bookmarks.all());
    return r;
  };
  handle('bookmarks:get', () => data.bookmarks.all());
  handle('bookmarks:add', bm((e, b) => data.bookmarks.add(b)));
  handle('bookmarks:update', bm((e, id, patch) => data.bookmarks.update(id, patch)));
  handle('bookmarks:remove', bm((e, id) => data.bookmarks.remove(id)));
  handle('bookmarks:move', bm((e, id, beforeId) => data.bookmarks.move(id, beforeId)));
  handle('bookmarks:folderAdd', bm((e, name) => data.bookmarks.addFolder(name)));
  handle('bookmarks:folderRename', bm((e, id, name) => data.bookmarks.renameFolder(id, name)));
  handle('bookmarks:folderRemove', bm((e, id) => data.bookmarks.removeFolder(id)));
  handle('bookmarks:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender);
    const r = await dialog.showSaveDialog(win, { title: t('Xuất dấu trang'), defaultPath: 'tyranweb-bookmarks.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, data.bookmarks.exportHtml());
    return r.filePath;
  });
  handle('bookmarks:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender);
    const r = await dialog.showOpenDialog(win, { title: t('Nhập dấu trang (HTML từ Chrome, Edge, Firefox...)'), properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] });
    if (r.canceled) return 0;
    const n = data.bookmarks.importHtml(fs.readFileSync(r.filePaths[0], 'utf8'));
    broadcast('bookmarks:changed', data.bookmarks.all());
    return n;
  });

  // ---- downloads ----
  handle('downloads:list', () => sessions.downloadsList());
  handle('downloads:action', (e, id, action) => sessions.downloadAction(id, action));
  handle('downloads:clear', () => sessions.clearDownloads());
  handle('downloads:pickDir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender);
    const r = await dialog.showOpenDialog(win, { title: t('Chọn thư mục tải xuống'), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---- notes ----
  handle('notes:get', () => data.notes.get());
  handle('notes:set', (e, text) => data.notes.set(text));

  // ---- wallpapers & online services ----
  handle('wallpapers:list', () => services.listWallpapers());
  handle('wallpapers:import', (e) => services.importLocalWallpaper(BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender)));
  handle('wallpapers:remove', (e, file) => services.removeUserWallpaper(file));
  // ---- Kho nền video (tyran://store: main/livewalls.js), and Sora's shop for it (main/sorashop.js)
  handle('livewalls:page', (e, url) => require('./livewalls').page(url));
  handle('livewalls:download', async (e, item) => {
    const entry = await require('./livewalls').download(e.sender, item);
    broadcast('wallpapers:changed');
    return entry;
  });
  handle('livewalls:cancel', (e, id) => require('./livewalls').cancel(id));
  handle('wallpapers:meta', (e, file, patch) => services.updateUserWallpaper(String(file || ''), patch));
  handle('sorashop:prepare', () => require('./sorashop').prepare());
  // Web động → Special: interactive web wallpapers on GitHub (main/specials.js)
  handle('specials:search', (e, q, page) => require('./specials').search(q, page));
  handle('specials:inspect', (e, full, branch) => require('./specials').inspect(String(full || ''), String(branch || '')));
  handle('specials:install', async (e, item) => {
    const entry = await require('./specials').install(e.sender, item);
    broadcast('wallpapers:changed');
    return entry;
  });
  handle('specials:cancel', (e, id) => require('./specials').cancel(id));
  handle('wallpapers:search', (e, q) => services.searchWallhaven(q));
  handle('wallpapers:wallhaven', (e, item) => services.downloadWallhaven(item));
  handle('wallpapers:fromUrl', (e, url) => services.downloadImage(url, { source: url }));
  handle('wallpapers:importVideo', (e) => services.importLocalVideo(BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender)));
  // many at once (files / a folder / a zip), linked folders, and where the wallpapers are kept
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender);
  handle('wallpapers:importMany', (e, kind) => services.importMany(winOf(e), ['files', 'folder', 'zip'].includes(kind) ? kind : 'files'));
  handle('wallpapers:linkFolder', (e) => services.linkFolder(winOf(e)));
  handle('wallpapers:unlinkFolder', (e, id) => services.unlinkFolder(String(id || '')));
  // NIKKE wallpapers: downloaded on request (Settings → Hình nền → Web động → NIKKE)
  const nikke = require('./nikke');
  handle('nikke:list', () => nikke.list());
  handle('nikke:install', async (e, id) => {
    try {
      return await nikke.install(String(id || ''), (p) => broadcast('nikke:progress', { id, ...p }));
    } finally {
      broadcast('nikke:changed');
      nikke.makeCards(() => broadcast('nikke:cards')).catch(() => {});
    }
  });
  // one of her outfits (she comes first when she is not downloaded yet)
  handle('nikke:installOutfit', async (e, id, outfit) => {
    try {
      return await nikke.installOutfit(String(id || ''), String(outfit || ''), (p) => broadcast('nikke:progress', { id: outfit, ...p }));
    } finally {
      broadcast('nikke:changed');
      nikke.makeCards(() => broadcast('nikke:cards')).catch(() => {});
    }
  });
  handle('nikke:removeOutfit', (e, id, outfit) => {
    const ok = nikke.removeOutfit(String(id || ''), String(outfit || ''));
    broadcast('nikke:changed');
    return ok;
  });
  handle('nikke:cancel', () => nikke.cancel());
  // the cards' pictures still missing (Settings asks when it shows them)
  handle('nikke:cards', () => (nikke.makeCards(() => broadcast('nikke:cards')).catch(() => {}), true));
  handle('nikke:remove', (e, id) => {
    const ok = nikke.remove(String(id || ''));
    broadcast('nikke:changed');
    return ok;
  });
  // her backdrop: a picture of the user's (chosen here), or none (only the colour)
  handle('nikke:backdrop', async (e, choose) => {
    const file = choose ? await services.pickImage(winOf(e)) : '';
    if (choose && !file) return null;
    const name = nikke.setBackdrop(file);
    changeSettings({ wallpaper: { web: { nikkeImage: name } } });
    return name;
  });
  // Azur Lane wallpapers: downloaded on request too (Settings → Hình nền → Web động → Azur Lane)
  const azur = require('./azurlane');
  handle('azur:list', () => azur.list());
  handle('azur:install', async (e, id) => {
    try {
      return await azur.install(String(id || ''), (p) => broadcast('azur:progress', { id, ...p }));
    } finally {
      broadcast('azur:changed');
      azur.makeCards(() => broadcast('azur:cards')).catch(() => {});
    }
  });
  handle('azur:cancel', () => azur.cancel());
  handle('azur:remove', (e, id) => {
    const ok = azur.remove(String(id || ''));
    broadcast('azur:changed');
    return ok;
  });
  handle('azur:cards', () => (azur.makeCards(() => broadcast('azur:cards')).catch(() => {}), true));
  handle('azur:tracks', () => azur.tracks());
  handle('azur:music', (e, name) => azur.music(String(name || '')));
  // The computer's signed apps, from the sidebar (only those of the list are ever started)
  const apps = require('./apps');
  apps.init(() => broadcast('apps:changed'));
  handle('apps:list', (e, force) => apps.list(!!force), { uiOnly: true });
  handle('apps:icon', (e, id) => apps.icon(String(id || '')), { uiOnly: true });
  handle('apps:launch', (e, id) => apps.launch(String(id || '')), { uiOnly: true });
  // updates from GitHub Releases (Settings → Giới thiệu → Cập nhật; main/updates.js)
  const updates = require('./updates');
  updates.init((u) => broadcast('update:state', u));
  handle('update:status', () => updates.status());
  handle('update:check', () => updates.check(true));
  handle('update:download', () => updates.download());
  handle('update:install', () => updates.install());
  // "Brave đầy đủ" (Settings → Quyền riêng tư): Brave's engine, built here on request, then in use
  const braveBuild = require('./brave-build');
  braveBuild.cleanup();
  handle('adblock:brave', () => braveBuild.status());
  handle('adblock:braveInstall', async () => {
    await braveBuild.install((p) => broadcast('adblock:braveProgress', p));
    changeSettings({ privacy: { adblockEngine: 'brave-full' } });
    return true;
  });
  handle('adblock:braveCancel', () => braveBuild.cancel());
  // Project SEKAI wallpapers: one outfit at a time, downloaded on request (Settings → Hình nền → Web động)
  const sekai = require('./sekai');
  handle('sekai:list', () => sekai.list());
  handle('sekai:install', async (e, id, outfit) => {
    try {
      return await sekai.install(String(id || ''), String(outfit || ''), (p) => broadcast('sekai:progress', { id, ...p }));
    } finally {
      broadcast('sekai:changed');
      sekai.makeCards(() => broadcast('sekai:cards')).catch(() => {});
    }
  });
  handle('sekai:cancel', () => sekai.cancel());
  handle('sekai:remove', (e, id) => {
    const ok = sekai.remove(String(id || ''));
    broadcast('sekai:changed');
    return ok;
  });
  handle('sekai:cards', () => (sekai.makeCards(() => broadcast('sekai:cards')).catch(() => {}), true));
  // Chrome extensions (Settings → Tiện ích, the toolbar button, the Chrome Web Store bar)
  const ext = require('./extensions');
  handle('ext:list', () => ext.list());
  handle('ext:prepare', (e, raw) => ext.prepare(String(raw || '')));
  handle('ext:cancel', (e, token) => ext.cancel(String(token || '')));
  handle('ext:confirm', (e, token) => ext.confirm(String(token || '')));
  handle('ext:setEnabled', (e, id, on) => ext.setEnabled(String(id || ''), !!on));
  handle('ext:remove', (e, id) => ext.remove(String(id || '')));
  handle('ext:checkUpdates', () => ext.checkUpdates());
  handle('ext:update', (e, id) => ext.update(String(id || '')));
  handle('ext:pages', (e, id) => ext.pages(String(id || '')));
  handle('crx:tabs-state', (e, list) => ext.setTabs(BrowserWindow.fromWebContents(e.sender), list), { uiOnly: true });
  ext.registerBridge(ipcMain);
  handle('ext:addFolder', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), { title: t('Chọn thư mục tiện ích đã giải nén (có manifest.json)'), properties: ['openDirectory'] });
    return r.canceled ? null : ext.addFolder(r.filePaths[0]);
  });
  // the mouse cursor (Settings → Giao diện): any page's preload, and the window, ask for it
  ipcMain.handle('guest:cursor', () => services.cursorConfig());
  handle('cursor:import', (e) => services.importCursor(winOf(e)));
  // a wallpaper's own music: key (see musicKey in shared/theme.js) -> entry, or null to remove it
  handle('wallpapers:importMusic', (e) => services.importMusic(winOf(e)));

  // ---- the user's own fonts (main/fonts.js): picked or dropped; the first one added is used ----
  const addFonts = (files) => {
    const added = require('./fonts').add(files);
    if (!added.length) return [];
    const a = data.settings.data.appearance;
    changeSettings({ appearance: { customFonts: [...(a.customFonts || []), ...added], font: `"${added[0].family}", "Segoe UI", system-ui, sans-serif` } });
    return [...new Set(added.map((f) => f.family))];
  };
  handle('fonts:pick', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), { title: t('Chọn phông chữ'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('Phông chữ'), extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }] });
    return r.canceled ? [] : addFonts(r.filePaths);
  });
  handle('fonts:add', (e, files) => addFonts(Array.isArray(files) ? files.slice(0, 200) : []));
  handle('fonts:remove', (e, family) => {
    const left = require('./fonts').removeFamily(String(family));
    const a = data.settings.data.appearance;
    // (the interface back on the first font when it was using this one)
    const font = a.font.startsWith(`"${family}"`) ? SETTINGS.appearance.font : a.font;
    changeSettings({ appearance: { customFonts: left, font } });
    return true;
  });
  handle('wallpapers:musicLink', (e, url) => services.musicLink(url));
  handle('wallpapers:setMusic', (e, key, entry) => {
    key = String(key || '').slice(0, 2000);
    if (!key) return false;
    changeSettings({ wallpaper: { music: { [key]: null } } }); // (replaced whole, never merged)
    if (entry && typeof entry === 'object') changeSettings({ wallpaper: { music: { [key]: entry } } });
    services.cleanMusic(data.settings.data.wallpaper.music);
    return true;
  });
  // the window's shape, for framing a wallpaper by hand
  handle('wallpapers:frameAspect', (e) => {
    const [w, h] = winOf(e)?.getContentSize() || [16, 9];
    return w / h || 16 / 9;
  });
  handle('wallpapers:openFolder', () => shell.openPath(services.wallpaperFolder()));
  handle('wallpapers:moveFolder', async (e) => {
    const dest = await services.moveWallpaperFolder(winOf(e));
    if (dest && !process.env.TYRAN_SHOT) setTimeout(() => (app.relaunch(), app.exit(0)), 300); // (the app restarts to use it)
    return dest;
  });
  services.watchLinked(() => broadcast('wallpapers:changed'));
  handle('wallpapers:videoFromUrl', (e, url) => services.downloadVideo(String(url || '')));
  handle('wallpapers:importWeb', (e) => services.importLiveWallpaper(BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender)));
  // Settings → Giới thiệu → Sao lưu / Khôi phục (backup.js)
  const testFile = (f) => (process.env.TYRAN_SHOT && typeof f === 'string' ? f : undefined); // (headless tests only)
  handle('backup:make', (e, f) => require('./backup').make(BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender), !!data.settings.data.general.backupMedia, testFile(f)));
  handle('backup:restore', (e, f) => require('./backup').restore(BrowserWindow.fromWebContents(e.sender.hostWebContents || e.sender), testFile(f)));
  handle('wallpapers:removeWeb', (e, id) => services.removeLiveWallpaper(String(id || '')));
  handle('wallpapers:baModels', () => services.blueArchiveModels());
  handle('balobby:song', () => require('./balobby').song());
  // a lobby chosen by itself (Settings → Chọn sảnh khi mở app → Theo mùa và giờ): at the turn of day
  // and night, or of a season, another one that fits, unless a lobby was chosen by hand since
  // (now: just switched to it)
  const autoLobby = async (now) => {
    const w = data.settings.data.wallpaper;
    if (w.type !== 'web' || w.web?.preset !== 'bluearchive' || w.web.lobbyPick !== 'season' || (!now && w.web.autoPeriod === services.lobbyPeriod())) return;
    const key = await services.pickLobby(w.web).catch(() => '');
    if (key) changeSettings({ wallpaper: { web: { model: key, autoPeriod: services.lobbyPeriod() } } });
  };
  setInterval(autoLobby, 60e3);
  pickLobbyNow = () => autoLobby(true);
  handle('wallpapers:baPicture', (e, key) => services.baPictureBytes(String(key || '')), { uiOnly: true });
  handle('wallpapers:baBrightness', () => services.baBrightness(), { uiOnly: true });
  handle('wallpapers:baSaveBrightness', (e, found) => services.saveBaBrightness(found), { uiOnly: true });
  handle('wallpapers:baBroken', (e, key, counts) => services.blueArchiveBroken(String(key), counts !== false), { uiOnly: true });
  handle('wallpapers:baWorks', (e, key) => services.blueArchiveWorks(String(key)), { uiOnly: true });
  handle('wallpapers:baNames', (e, list) => services.saveBlueArchiveNames(list), { uiOnly: true });
  handle('wallpapers:liveUrl', (e, web) => services.liveUrl(web), { uiOnly: true });
  handle(
    'wallpaper:savePreview',
    async (e, wcId, key) => {
      const wc = guestOf(e, wcId);
      if (wc.session !== sessions.wallpaper()) throw new Error('Not a wallpaper');
      const url = await services.saveBlueArchivePreview(wc, String(key || ''));
      broadcast('ba:preview', { key, url });
      return url;
    },
    { uiOnly: true }
  );
  // Last frame of a live wallpaper, shown in its place while the page is paused.
  handle(
    'wallpaper:snapshot',
    async (e, wcId) => {
      const wc = guestOf(e, wcId);
      if (wc.session !== sessions.wallpaper()) throw new Error('Not a wallpaper');
      try {
        return 'data:image/jpeg;base64,' + (await wc.capturePage()).toJPEG(88).toString('base64');
      } catch {
        return null; // nothing to capture yet (or shutting down)
      }
    },
    { uiOnly: true }
  );
  handle('anime:today', (e, genre) => services.animeOfTheDay(genre));
  handle('suggest', (e, text) => services.suggest(String(text || '')));

  // ---- privacy ----
  handle('data:clear', async (e, opts) => {
    await sessions.clearBrowsingData(opts);
    broadcast('history:changed');
    if (opts?.history) broadcast('closed:cleared');
    return true;
  });
  handle('perm:reset', (e, origin) => {
    const prev = structuredClone(data.settings.data);
    delete data.settings.data.sitePermissions[origin];
    data.settings.save();
    afterSettingsChange(prev);
    return true;
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData: data.dir,
    aiCutoff: services.AI_CUTOFF,
  }));
  handle('data:move', async (e) => {
    const dest = await services.moveData(winOf(e), (p) => broadcast('data:progress', p));
    if (dest && !process.env.TYRAN_SHOT) setTimeout(() => (app.relaunch(), app.exit(0)), 300); // (the app restarts to use it)
    return dest;
  });
  handle('app:openPath', (e, which) => {
    const target = which === 'screenshots' ? path.join(app.getPath('pictures'), 'TyranWeb') : which === 'userData' ? data.dir : null;
    if (target) {
      fs.mkdirSync(target, { recursive: true });
      shell.openPath(target);
    }
  });

  // ---- UI-only: windows, tabs, guests ----
  handle('win:init', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const entry = windows.windows.get(win.id);
    const initial = entry?.initial || {};
    entry && (entry.initial = {});
    return {
      winId: win.id,
      private: !!entry?.private,
      restore: initial.restore || null,
      url: initial.url || null,
      closed: initial.closed ? data.sessionStore.data.closed || [] : [],
      otherAudio: otherSound.isOther(),
      settings: data.settings.data,
      shortcuts: getShortcuts(data.settings.data.shortcuts),
      engines: enginesNamed(),
      state: windows.state(win),
    };
  }, { uiOnly: true });
  handle('win:placement', (e) => windows.placement(BrowserWindow.fromWebContents(e.sender)), { uiOnly: true });
  handle('desktop:wallpaper', () => require('./desktop').desktopWallpaper());

  handle('win:action', (e, action) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    switch (action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'close': win.close(); break;
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'leaveFullscreen': if (win.isFullScreen()) win.setFullScreen(false); break;
      case 'new': windows.createWindow(); break;
      case 'private': windows.createWindow({ isPrivate: true }); break;
      case 'uiDevtools': e.sender.openDevTools({ mode: 'detach' }); break;
      case 'quit': app.quit(); break;
    }
    return windows.state(win);
  }, { uiOnly: true });

  handle('win:chrome', (e, opts) => windows.applyChrome(BrowserWindow.fromWebContents(e.sender), opts), { uiOnly: true });

  // (an open tab's history is read from its page; a sleeping one sends the one it keeps)
  const liveTab = (e, wcId) => {
    try {
      return wcId ? guestOf(e, wcId) : null;
    } catch {
      return null;
    }
  };
  handle('session:update', (e, tabs, active) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const clean = (Array.isArray(tabs) ? tabs : [])
      .filter((t) => t && typeof t.url === 'string')
      .slice(0, 300)
      .map((t) => {
        const wc = liveTab(e, t.wcId);
        const history = wc ? tabHistory.read(wc) : tabHistory.clean(t.history);
        return { url: t.url, title: String(t.title || ''), favicon: String(t.favicon || ''), pinned: !!t.pinned, ...(wc ? { wcId: wc.id } : {}), ...(history ? { history } : {}) };
      });
    windows.updateSession(win.id, clean, active | 0);
  }, { uiOnly: true });
  handle('tabs:history', (e, wcId) => tabHistory.read(liveTab(e, wcId)), { uiOnly: true });
  handle('tabs:stash', (e, token, history) => tabHistory.stash(String(token), history), { uiOnly: true });
  handle('closed:add', (e, tab) => {
    if (!tab || typeof tab.url !== 'string' || !/^[\w-]{1,80}$/.test(String(tab.id))) return;
    const history = tabHistory.clean(tab.history);
    const keep = { id: String(tab.id), url: tab.url.slice(0, 8192), title: String(tab.title || '').slice(0, 500), favicon: String(tab.favicon || '').slice(0, 100000), index: Math.max(0, tab.index | 0), pinned: !!tab.pinned, ...(history ? { history } : {}) };
    windows.addClosed(BrowserWindow.fromWebContents(e.sender).id, keep);
  }, { uiOnly: true });
  handle('closed:remove', (e, id) => windows.removeClosed(String(id)), { uiOnly: true });
  // the new tab page's music: its own players' pages, and whether it is meant to play (othersound.js)
  handle('audio:mine', (e, wcId) => otherSound.markMine(guestOf(e, wcId)), { uiOnly: true });
  handle('audio:listen', (e, on) => otherSound.listen(e.sender, !!on), { uiOnly: true });
  // Thanh nhạc → Nhận cả âm thanh từ tab khác: the levels of this window's tab that makes sound,
  // measured in a world of its own in the page (the page cannot see or change it); undefined: no tab
  // makes sound. The measuring code is the bar's own (visualizer.js spectrumHook), given once.
  let spectrumCode = '';
  handle('spectrum:code', (e, code) => (spectrumCode = String(code || '')), { uiOnly: true });
  handle('spectrum:tab', async (e, n) => {
    const wc = otherSound.audibleGuest(e.sender);
    if (!wc) return undefined;
    n = Math.max(1, Math.min(128, n | 0));
    const run = (code) => wc.executeJavaScriptInIsolatedWorld(SPECTRUM_WORLD, [{ code }]).catch(() => null);
    let v = await run(`typeof window.__tyranSpectrum === 'function' ? window.__tyranSpectrum(${n}) : 'install'`);
    if (v === 'install' && spectrumCode) v = await run(`(${spectrumCode})()(${n})`);
    return Array.isArray(v) ? v.slice(0, n).map((x) => Math.max(0, Math.min(255, Number(x) | 0))) : null;
  }, { uiOnly: true });

  handle('perm:respond', (e, id, allow, remember) => sessions.respondPermission(id, allow, remember), { uiOnly: true });
  handle('share:respond', (e, id, sourceId, audio) => sessions.respondShare(String(id), String(sourceId || ''), !!audio), { uiOnly: true });
  handle('adblock:count', (e, wcId) => adblock.getCount(Number(wcId)), { uiOnly: true });
  // HTTPS-only: a page that could not be reached over https:// (the tab's error page offers http://)
  handle('privacy:httpUrl', (e, url) => require('./privacy').httpUrl(String(url || '')), { uiOnly: true });
  handle('privacy:allowHttp', (e, url) => require('./privacy').allowHttp(String(url || '')), { uiOnly: true });
  handle('clipboard:write', (e, text) => clipboard.writeText(String(text)), { uiOnly: true });

  handle('wc:action', async (e, wcId, action, arg = {}) => {
    const wc = guestOf(e, wcId);
    const win = BrowserWindow.fromWebContents(e.sender);
    switch (action) {
      case 'capture':
        return capture(wc);
      case 'savePage': {
        const r = await dialog.showSaveDialog(win, { title: t('Lưu trang'), defaultPath: path.join(app.getPath('downloads'), safeName(wc.getTitle(), '.html')), filters: [{ name: t('Trang web, hoàn chỉnh'), extensions: ['html'] }] });
        if (r.canceled) return false;
        await wc.savePage(r.filePath, 'HTMLComplete');
        return r.filePath;
      }
      case 'pdf': {
        const r = await dialog.showSaveDialog(win, { title: t('Lưu thành PDF'), defaultPath: path.join(app.getPath('downloads'), safeName(wc.getTitle(), '.pdf')), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (r.canceled) return false;
        fs.writeFileSync(r.filePath, await wc.printToPDF({ printBackground: true }));
        return r.filePath;
      }
      case 'copyImageAt':
        wc.copyImageAt(arg.x | 0, arg.y | 0);
        return true;
      case 'download':
        if (/^(https?|data|blob):/i.test(arg.url || '')) wc.downloadURL(arg.url);
        return true;
      case 'pip':
        return wc.executeJavaScript(PIP_SCRIPT, true);
      case 'wallpaperFromImage': {
        const w = await services.downloadImage(arg.url, { source: wc.getURL() });
        changeSettings({ wallpaper: { type: 'image', image: w.url } });
        return w;
      }
      case 'resetAdblockCount':
        adblock.resetCount(wc.id);
        return 0;
      default:
        throw new Error('Unknown action ' + action);
    }
  }, { uiOnly: true });
}

module.exports = { register, broadcast, changeSettings };
