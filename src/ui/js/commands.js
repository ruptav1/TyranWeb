// Command registry, keyboard shortcuts, page / tab context menus and the main menu.
import { api, h, on, NEWTAB, isInternal, resolveInput, searchUrlFor } from './util.js';
import { S } from './state.js';
import { install } from './extensions.js';
import * as tabs from './tabs.js';
import { T, active, createTab } from './tabs.js';
import { openMenu, closePopover, toast } from './menus.js';
import { openFind } from './find.js';
import { openPalette, setCommandSource } from './palette.js';
import { bookmarkPopover } from './bookmarks.js';
import { toggleSidebar } from './sidebar.js';
import { openDownloadsPopover } from './downloads.js';
import { nextWallpaper, toggleLobby, lobbyTouch, nextNikkeOutfit, nextNikkeExpression } from './wallpaper.js';
import { focus as focusOmnibox } from './omnibox.js';
import { PRESETS, presetPatch } from 'tyran://shared/themes.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LANG } from 'tyran://shared/i18n.js';

// Google Translate's code for the app language
const TL = LANG === 'pt-BR' ? 'pt' : LANG;

const wv = () => (active()?.ready ? active().webview : null);

export function openInternal(path) {
  const url = `tyran://${path}`;
  const base = url.split('#')[0];
  const existing = T.list.find((t) => t.url.split('#')[0] === base);
  if (existing) {
    tabs.activate(existing.id);
    if (url !== existing.url) tabs.navigate(existing.id, url);
  } else createTab({ url });
}

async function screenshot() {
  const tab = active();
  if (!tab?.wcId) return;
  const file = await api.invoke('wc:action', tab.wcId, 'capture');
  toast(t('Đã chụp & sao chép vào clipboard'), { icon: 'camera', action: { label: t('Mở thư mục'), run: () => api.invoke('app:openPath', 'screenshots') } });
  return file;
}

function cycleTheme() {
  const i = PRESETS.findIndex((p) => p.id === S.settings.appearance.preset);
  const p = PRESETS[(i + 1) % PRESETS.length];
  api.invoke('settings:set', presetPatch(p));
  toast(`Theme: ${p.name} — ${p.sub}`, { icon: 'palette' });
}

function toggleZen() {
  S.zen = !S.zen;
  document.body.classList.toggle('zen', S.zen);
  if (S.zen) toast(t('Chế độ tập trung — rê chuột lên mép trên để hiện thanh công cụ, Ctrl+Shift+Z để thoát'), { icon: 'eye', timeout: 4200 });
}

// id -> { label, icon, run }
export const COMMANDS = {
  'tab.new': { icon: 'plus', run: () => createTab() },
  'tab.incognito': { icon: 'incognito', run: () => createTab({ incognito: true }) },
  'tab.close': { icon: 'x', run: () => active() && tabs.closeTab(T.activeId, { force: true }) },
  'tab.reopen': { icon: 'history', run: () => tabs.reopenClosed() || toast(t('Không còn tab nào vừa đóng'), { icon: 'info' }) },
  'tab.next': { icon: 'chevronRight', run: () => cycle(1) },
  'tab.prev': { icon: 'chevronLeft', run: () => cycle(-1) },
  'tab.duplicate': { icon: 'copy', run: () => tabs.duplicate() },
  'tab.pin': { icon: 'pin', run: () => tabs.togglePin() },
  'tab.mute': { icon: 'muted', run: () => tabs.toggleMute() },
  'tab.gotoLast': { run: () => T.list.length && tabs.activate(T.list[T.list.length - 1].id) },
  'window.new': { icon: 'window', run: () => api.invoke('win:action', 'new') },
  'window.private': { icon: 'incognito', run: () => api.invoke('win:action', 'private') },
  'window.fullscreen': { icon: 'fullscreen', run: () => api.invoke('win:action', 'fullscreen') },
  'window.zen': { icon: 'eye', run: toggleZen },
  'nav.back': { icon: 'back', run: () => tabs.goBack() },
  'nav.forward': { icon: 'forward', run: () => tabs.goForward() },
  'nav.reload': { icon: 'reload', run: () => tabs.reload() },
  'nav.hardReload': { icon: 'reload', run: () => tabs.reload(T.activeId, true) },
  'nav.home': { icon: 'home', run: () => active() && tabs.navigate(T.activeId, S.settings.general.homepage || NEWTAB) },
  'nav.stop': { icon: 'x', run: () => tabs.stop() },
  'omnibox.focus': { icon: 'search', run: () => focusOmnibox() },
  'page.find': { icon: 'search', run: openFind },
  'page.zoomIn': { icon: 'zoomIn', run: () => tabs.zoom(1) },
  'page.zoomOut': { icon: 'zoomOut', run: () => tabs.zoom(-1) },
  'page.zoomReset': { icon: 'search', run: () => tabs.zoom(0) },
  'page.print': { icon: 'printer', run: () => wv()?.print() },
  'page.save': { icon: 'save', run: () => active()?.wcId && api.invoke('wc:action', active().wcId, 'savePage') },
  'page.pdf': { icon: 'save', run: async () => {
    const r = active()?.wcId && (await api.invoke('wc:action', active().wcId, 'pdf'));
    if (r) toast(t('Đã lưu PDF'), { icon: 'check' });
  } },
  'page.source': { icon: 'code', run: () => active() && !isInternal(active().url) && createTab({ url: 'view-source:' + active().url }) },
  'page.devtools': { icon: 'terminal', run: () => (wv()?.isDevToolsOpened() ? wv().closeDevTools() : wv()?.openDevTools()) },
  'page.screenshot': { icon: 'camera', run: screenshot },
  'page.pip': { icon: 'pip', run: async () => {
    const r = active()?.wcId && (await api.invoke('wc:action', active().wcId, 'pip'));
    if (r === 'none') toast(t('Không có video nào trên trang'), { icon: 'pip' });
  } },
  'bookmark.toggle': { icon: 'star', run: () => bookmarkPopover(document.querySelector('.omni-star:not([hidden])')) },
  'bookmark.bar': { icon: 'bookmark', run: () => api.invoke('settings:set', { layout: { showBookmarksBar: !S.settings.layout.showBookmarksBar } }) },
  'open.history': { icon: 'history', run: () => openInternal('history/') },
  'open.downloads': { icon: 'download', run: () => openInternal('downloads/') },
  'open.bookmarks': { icon: 'bookmark', run: () => openInternal('bookmarks/') },
  'open.settings': { icon: 'sliders', run: () => openInternal('settings/') },
  'palette.open': { icon: 'command', run: () => openPalette() },
  'sidebar.toggle': { icon: 'sidebar', run: () => toggleSidebar() },
  'split.toggle': { icon: 'split', run: () => tabs.toggleSplit() },
  'theme.next': { icon: 'palette', run: cycleTheme },
  'wallpaper.next': { icon: 'shuffle', run: () => nextWallpaper(true) },
  'wallpaper.lobby': { icon: 'tv', run: () => toggleLobby() },
  'wallpaper.lobbyExit': { run: () => toggleLobby(false) },
  'wallpaper.nikkeOutfit': { icon: 'layers', run: () => nextNikkeOutfit() },
  'wallpaper.nikkeFace': { icon: 'heart', run: () => nextNikkeExpression() },
  'ui.devtools': { icon: 'terminal', run: () => api.invoke('win:action', 'uiDevtools') },
};
for (let i = 1; i <= 8; i++) COMMANDS[`tab.goto${i}`] = { run: () => T.list[i - 1] && tabs.activate(T.list[i - 1].id) };

function cycle(dir) {
  if (T.list.length < 2) return;
  const i = tabs.indexOf(T.activeId);
  tabs.activate(T.list[(i + dir + T.list.length) % T.list.length].id);
}

export function run(id) {
  const c = COMMANDS[id];
  if (!c) return;
  try {
    c.run();
  } catch (err) {
    console.error('[command]', id, err);
  }
}

// ---------------------------------------------------------------- keyboard
let keymap = new Map();
export function rebuildKeymap() {
  keymap = new Map();
  for (const [id, def] of Object.entries(S.shortcuts || {})) for (const k of def.keys) keymap.set(k, id);
}

const CODE_KEYS = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', Numpad0: 'Numpad0',
};
export function toAccelerator(e) {
  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

export function initKeyboard() {
  rebuildKeymap();
  window.addEventListener(
    'keydown',
    (e) => {
      const acc = toAccelerator(e);
      if (!acc) return;
      if (e.key === 'Escape' && S.htmlFullscreen) return;
      const id = keymap.get(acc);
      if (!id) return;
      // plain typing keys inside text fields stay with the field
      const inField = e.target.closest?.('input, textarea, [contenteditable="true"]');
      if (inField && !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      run(id);
    },
    true
  );
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey && e.target.closest?.('#tabstrip, #toolbar')) e.preventDefault();
  }, { passive: false });
}

on('command', ({ id }) => run(id));
api.on('command', ({ id }) => run(id));

setCommandSource(() =>
  Object.entries(COMMANDS)
    .filter(([id]) => S.shortcuts?.[id] && !/^tab\.goto/.test(id))
    .map(([id, c]) => ({ id, label: S.shortcuts[id].label, icon: c.icon, keys: S.shortcuts[id].keys, run: () => run(id) }))
);

// ---------------------------------------------------------------- page context menu
on('context-menu', ({ tab, params: p }) => {
  const view = tab.webview;
  if (!view) return;
  const r = view.getBoundingClientRect();
  const at = { x: r.left + p.x, y: r.top + p.y };
  const items = [];
  const searchUrl = searchUrlFor(S.settings, S.engines);
  const copy = (text) => api.invoke('clipboard:write', text);
  const download = (url) => api.invoke('wc:action', tab.wcId, 'download', { url });

  if (p.misspelledWord) {
    for (const s of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: s, icon: 'check', run: () => view.replaceMisspelling(s) });
    if (!p.dictionarySuggestions?.length) items.push({ label: t('Không có gợi ý chính tả'), disabled: true });
    items.push({ sep: true });
  }
  if (p.linkURL) {
    items.push(
      { label: t('Mở liên kết trong tab mới'), icon: 'plus', run: () => createTab({ url: p.linkURL, openerId: tab.id }) },
      { label: t('Mở trong tab nền'), icon: 'layers', run: () => createTab({ url: p.linkURL, background: true, openerId: tab.id }) },
      tab.incognito ? null : { label: t('Mở liên kết trong tab ẩn danh'), icon: 'incognito', run: () => createTab({ url: p.linkURL, incognito: true, index: tabs.indexOf(tab.id) + 1 }) },
      { label: t('Mở cạnh bên (chia đôi)'), icon: 'split', run: () => {
        const t = createTab({ url: p.linkURL, background: true, index: tabs.indexOf(tab.id) + 1 });
        tabs.splitWith(t.id);
      } },
      { label: t('Sao chép địa chỉ liên kết'), icon: 'link', run: () => copy(p.linkURL) },
      { label: t('Lưu liên kết thành…'), icon: 'download', run: () => download(p.linkURL) },
      { sep: true }
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: t('Mở ảnh trong tab mới'), icon: 'image', run: () => createTab({ url: p.srcURL, background: true }) },
      { label: t('Lưu ảnh…'), icon: 'download', run: () => download(p.srcURL) },
      { label: t('Sao chép ảnh'), icon: 'copy', run: () => api.invoke('wc:action', tab.wcId, 'copyImageAt', { x: p.x, y: p.y }) },
      { label: t('Sao chép địa chỉ ảnh'), icon: 'link', run: () => copy(p.srcURL) },
      /^https:/.test(p.srcURL)
        ? { label: t('Đặt làm hình nền TyranWeb ✿'), icon: 'sparkles', run: async () => {
            try {
              await api.invoke('wc:action', tab.wcId, 'wallpaperFromImage', { url: p.srcURL });
              toast(t('Đã đặt làm hình nền'), { icon: 'image' });
            } catch {
              toast(t('Không tải được ảnh này'), { icon: 'warn' });
            }
          } }
        : null,
      /^https?:/.test(p.srcURL) ? { label: t('Tìm ảnh này với Google Lens'), icon: 'search', run: () => createTab({ url: 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(p.srcURL) }) } : null,
      { sep: true }
    );
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) {
    items.push(
      p.mediaType === 'video' ? { label: t('Hình trong hình'), icon: 'pip', run: () => run('page.pip') } : null,
      /^(https?|blob):/.test(p.srcURL) && !p.srcURL.startsWith('blob:') ? { label: p.mediaType === 'video' ? t('Lưu video…') : t('Lưu âm thanh…'), icon: 'download', run: () => download(p.srcURL) } : null,
      { label: t('Sao chép địa chỉ'), icon: 'link', run: () => copy(p.srcURL) },
      { sep: true }
    );
  }
  if (p.isEditable) {
    const f = p.editFlags || {};
    items.push(
      { label: t('Hoàn tác'), icon: 'back', hint: 'Ctrl+Z', disabled: !f.canUndo, run: () => view.undo() },
      { label: t('Làm lại'), icon: 'forward', hint: 'Ctrl+Y', disabled: !f.canRedo, run: () => view.redo() },
      { sep: true },
      { label: t('Cắt'), icon: 'x', hint: 'Ctrl+X', disabled: !f.canCut, run: () => view.cut() },
      { label: t('Sao chép'), icon: 'copy', hint: 'Ctrl+C', disabled: !f.canCopy, run: () => view.copy() },
      { label: t('Dán'), icon: 'note', hint: 'Ctrl+V', disabled: !f.canPaste, run: () => view.paste() },
      { label: t('Dán dạng văn bản thuần'), icon: 'note', hint: 'Ctrl+Shift+V', disabled: !f.canPaste, run: () => view.pasteAndMatchStyle() },
      { label: t('Chọn tất cả'), icon: 'check', hint: 'Ctrl+A', run: () => view.selectAll() },
      { sep: true }
    );
  } else if (p.selectionText?.trim()) {
    const sel = p.selectionText.trim();
    const short = sel.length > 24 ? sel.slice(0, 24) + '…' : sel;
    const asUrl = !/\s/.test(sel) && /\.[a-z]{2,}/i.test(sel) ? resolveInput(sel, searchUrl) : null;
    items.push(
      { label: t('Sao chép'), icon: 'copy', hint: 'Ctrl+C', run: () => view.copy() },
      { label: t('Tìm “{0}”', short), icon: 'search', run: () => createTab({ url: searchUrl.replace('%s', encodeURIComponent(sel)), openerId: tab.id }) },
      asUrl && /^https?:/.test(asUrl) ? { label: t('Đi tới {0}', short), icon: 'globe', run: () => createTab({ url: asUrl }) } : null,
      { label: t('Dịch đoạn này'), icon: 'globe', run: () => createTab({ url: `https://translate.google.com/?sl=auto&tl=${TL}&text=${encodeURIComponent(sel)}&op=translate` }) },
      { sep: true }
    );
  }
  if (!p.linkURL && !p.isEditable && !p.selectionText?.trim() && p.mediaType === 'none') {
    items.push(
      { label: t('Quay lại'), icon: 'back', hint: 'Alt+←', disabled: !tab.canBack, run: () => tabs.goBack(tab.id) },
      { label: t('Tiến tới'), icon: 'forward', hint: 'Alt+→', disabled: !tab.canFwd, run: () => tabs.goForward(tab.id) },
      { label: t('Tải lại'), icon: 'reload', hint: 'F5', run: () => tabs.reload(tab.id) },
      { sep: true },
      { label: t('Chụp màn hình trang'), icon: 'camera', hint: 'Ctrl+Shift+S', run: screenshot },
      { label: t('Lưu trang thành…'), icon: 'save', hint: 'Ctrl+S', run: () => run('page.save') },
      { label: t('In…'), icon: 'printer', hint: 'Ctrl+P', run: () => view.print() },
      !isInternal(tab.url) ? { label: t('Dịch trang sang tiếng Việt'), icon: 'globe', run: () => createTab({ url: `https://translate.google.com/translate?sl=auto&tl=${TL}&u=${encodeURIComponent(tab.url)}` }) } : null,
      !isInternal(tab.url) ? { label: t('Xem mã nguồn trang'), icon: 'code', hint: 'Ctrl+U', run: () => createTab({ url: 'view-source:' + tab.url }) } : null,
      { sep: true }
    );
  }
  items.push({ label: t('Kiểm tra phần tử'), icon: 'terminal', hint: 'F12', run: () => view.inspectElement(p.x, p.y) });
  openMenu(items, at);
});

// ---------------------------------------------------------------- tab context menu
// right click on a new tab button
on('newtab-menu', ({ x, y }) => {
  const k = (id) => S.shortcuts?.[id]?.keys?.[0] || '';
  openMenu(
    [
      { label: t('Tab mới'), icon: 'plus', hint: k('tab.new'), run: () => run('tab.new') },
      { label: t('Tab ẩn danh mới'), icon: 'incognito', hint: k('tab.incognito'), run: () => run('tab.incognito') },
    ],
    { x, y }
  );
});

on('tab-menu', ({ tab, x, y }) => {
  const i = tabs.indexOf(tab.id);
  const inSplit = T.split && (T.split.a === tab.id || T.split.b === tab.id);
  openMenu(
    [
      { label: t('Tab mới bên phải'), icon: 'plus', run: () => createTab({ index: i + 1 }) },
      { label: t('Tab ẩn danh mới bên phải'), icon: 'incognito', run: () => createTab({ index: i + 1, incognito: true }) },
      tab.incognito ? null : { label: t('Mở lại trang này trong tab ẩn danh'), icon: 'incognito', run: () => createTab({ url: tab.url, index: i + 1, incognito: true }) },
      { sep: true },
      { label: t('Tải lại'), icon: 'reload', run: () => tabs.reload(tab.id) },
      { label: t('Nhân đôi'), icon: 'copy', run: () => tabs.duplicate(tab.id) },
      { label: tab.pinned ? t('Bỏ ghim') : 'Ghim tab', icon: 'pin', run: () => tabs.togglePin(tab.id) },
      { label: tab.muted ? t('Bật tiếng trang') : t('Tắt tiếng trang'), icon: tab.muted ? 'volume' : 'muted', run: () => tabs.toggleMute(tab.id) },
      tab.id !== T.activeId && !inSplit ? { label: t('Chia đôi màn hình với tab đang xem'), icon: 'split', run: () => tabs.splitWith(tab.id) } : null,
      inSplit ? { label: t('Thoát chia đôi màn hình'), icon: 'split', run: () => ((T.split = null), tabs.layoutPanes(), tabs.renderStrip()) } : null,
      tab.id !== T.activeId && !tab.sleeping ? { label: t('Cho tab ngủ (giải phóng RAM)'), icon: 'sleep', run: () => tabs.sleepTab(tab.id) } : null,
      { label: t('Sao chép liên kết'), icon: 'link', run: () => api.invoke('clipboard:write', tab.url) },
      { sep: true },
      { label: t('Đóng tab'), icon: 'x', hint: 'Ctrl+W', run: () => tabs.closeTab(tab.id, { force: true }) },
      { label: t('Đóng các tab khác'), run: () => tabs.closeOthers(tab.id) },
      { label: t('Đóng các tab bên phải'), run: () => tabs.closeRight(tab.id) },
      { sep: true },
      { label: t('Mở lại tab vừa đóng'), icon: 'history', hint: 'Ctrl+Shift+T', disabled: !T.closed.length, run: () => tabs.reopenClosed() },
    ],
    { x, y }
  );
});

// ---------------------------------------------------------------- main menu
export function openMainMenu(anchor) {
  const tab = active();
  const zoomPct = Math.round((tab?.zoom || 1) * 100);
  const zoomRow = h(
    'div',
    { class: 'menu-zoom' },
    h('span', { class: 'mz-label', text: t('Thu phóng') }),
    h('button', { class: 'icon-btn', title: t('Thu nhỏ'), html: icon('minus', 15), onclick: () => (tabs.zoom(-1), refreshZoom()) }),
    h('b', { class: 'mz-val', text: `${zoomPct}%` }),
    h('button', { class: 'icon-btn', title: t('Phóng to'), html: icon('plus', 15), onclick: () => (tabs.zoom(1), refreshZoom()) }),
    h('button', { class: 'icon-btn', title: t('Toàn màn hình (F11)'), html: icon('fullscreen', 15), onclick: () => (closePopover(), run('window.fullscreen')) })
  );
  const refreshZoom = () => (zoomRow.querySelector('.mz-val').textContent = `${Math.round((active()?.zoom || 1) * 100)}%`);
  const k = (id) => S.shortcuts?.[id]?.keys?.[0] || '';
  const items = [
    { label: t('Tab mới'), icon: 'plus', hint: k('tab.new'), run: () => run('tab.new') },
    { label: t('Tab ẩn danh mới'), icon: 'incognito', hint: k('tab.incognito'), run: () => run('tab.incognito') },
    { label: t('Cửa sổ mới'), icon: 'window', hint: k('window.new'), run: () => run('window.new') },
    { label: t('Cửa sổ ẩn danh'), icon: 'incognito', hint: k('window.private'), run: () => run('window.private') },
    { sep: true },
    { custom: zoomRow },
    { sep: true },
    { label: t('Tìm trong trang'), icon: 'search', hint: k('page.find'), run: () => run('page.find') },
    { label: t('Chụp màn hình trang'), icon: 'camera', hint: k('page.screenshot'), run: () => run('page.screenshot') },
    { label: t('Hình trong hình (video)'), icon: 'pip', hint: k('page.pip'), run: () => run('page.pip') },
    { label: t('In…'), icon: 'printer', hint: k('page.print'), run: () => run('page.print') },
    { label: t('Lưu thành PDF…'), icon: 'save', run: () => run('page.pdf') },
    { sep: true },
    { label: t('Lịch sử'), icon: 'history', hint: k('open.history'), run: () => run('open.history') },
    { label: t('Tải xuống'), icon: 'download', hint: k('open.downloads'), run: () => openDownloadsPopover() },
    { label: t('Dấu trang'), icon: 'bookmark', hint: k('open.bookmarks'), run: () => run('open.bookmarks') },
    { sep: true },
    { label: t('Đổi theme tiếp theo'), icon: 'palette', hint: k('theme.next'), run: () => run('theme.next') },
    { label: t('Đổi hình nền'), icon: 'shuffle', hint: k('wallpaper.next'), run: () => run('wallpaper.next') },
    { label: t('Chế độ Lobby'), icon: 'tv', hint: k('wallpaper.lobby'), run: () => run('wallpaper.lobby') },
    { label: t('Tùy biến giao diện…'), icon: 'sparkles', run: () => openInternal('settings/#appearance') },
    { label: t('Chế độ tập trung'), icon: 'eye', hint: k('window.zen'), run: () => run('window.zen') },
    { sep: true },
    { label: t('Công cụ nhà phát triển'), icon: 'terminal', hint: k('page.devtools'), run: () => run('page.devtools') },
    { label: t('Cài đặt'), icon: 'sliders', hint: k('open.settings'), run: () => run('open.settings') },
    { label: t('Thoát TyranWeb'), icon: 'x', run: () => api.invoke('win:action', 'quit') },
  ];
  openMenu(items, anchor, { align: 'end' });
}

// Messages sent by internal pages (tyran://newtab etc.)
on('host-message', ({ tab, type, payload }) => {
  if (type === 'open') {
    const url = String(payload?.url || '');
    // (an extension's options page: only from TyranWeb's own pages, i.e. Settings → Tiện ích)
    if (!/^(https?|tyran):/i.test(url) && !(/^chrome-extension:\/\/[a-p]{32}\//.test(url) && tab.url.startsWith('tyran://'))) return;
    if (payload.newTab) createTab({ url, background: !!payload.background, openerId: tab.id });
    else tabs.navigate(tab.id, url);
  } else if (type === 'ext-install' && tab.url.startsWith('tyran://')) {
    install(String(payload || ''));
  } else if (type === 'command' && COMMANDS[payload]) {
    run(payload);
  } else if (type === 'search') {
    const url = resolveInput(String(payload || ''), searchUrlFor(S.settings, S.engines));
    if (url) tabs.navigate(tab.id, url);
  } else if (type === 'lobby-touch' && tab.url?.startsWith(NEWTAB)) {
    lobbyTouch(tab, payload);
  }
});
