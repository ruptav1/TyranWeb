// Toolbar: built from settings.layout.toolbarItems (order + visibility are user-editable).
import { api, h, on } from './util.js';
import { S } from './state.js';
import { T, active, byWc } from './tabs.js';
import { buildOmnibox } from './omnibox.js';
import { downloadsButton } from './downloads.js';
import { openMainMenu, run } from './commands.js';
import { icon } from 'tyran://shared/icons.js';
import { EXT, extensionsPopover } from './extensions.js';
import { t } from 'tyran://shared/i18n.js';
import { mediaPopover } from './grab.js';

export const TOOLBAR_ITEMS = {
  back: { label: t('Quay lại'), icon: 'back', cmd: 'nav.back' },
  forward: { label: t('Tiến tới'), icon: 'forward', cmd: 'nav.forward' },
  reload: { label: t('Tải lại'), icon: 'reload', cmd: 'nav.reload' },
  home: { label: t('Trang chủ'), icon: 'home', cmd: 'nav.home' },
  omnibox: { label: t('Thanh địa chỉ') },
  media: { label: t('Tải video'), icon: 'video' },
  downloads: { label: t('Tải xuống'), icon: 'download' },
  split: { label: t('Chia đôi màn hình'), icon: 'split', cmd: 'split.toggle' },
  screenshot: { label: t('Chụp màn hình'), icon: 'camera', cmd: 'page.screenshot' },
  pip: { label: t('Hình trong hình'), icon: 'pip', cmd: 'page.pip' },
  sidebar: { label: t('Thanh bên'), icon: 'sidebar', cmd: 'sidebar.toggle' },
  palette: { label: t('Bảng lệnh'), icon: 'command', cmd: 'palette.open' },
  wallpaper: { label: t('Đổi hình nền'), icon: 'shuffle', cmd: 'wallpaper.next' },
  lobby: { label: t('Chế độ Lobby'), icon: 'tv', cmd: 'wallpaper.lobby' },
  zen: { label: t('Chế độ tập trung'), icon: 'eye', cmd: 'window.zen' },
  newtab: { label: t('Tab mới'), icon: 'plus', cmd: 'tab.new' },
  private: { label: t('Cửa sổ ẩn danh'), icon: 'incognito', cmd: 'window.private' },
  incognitoTab: { label: t('Tab ẩn danh mới'), icon: 'incognito', cmd: 'tab.incognito' },
  settings: { label: t('Cài đặt'), icon: 'sliders', cmd: 'open.settings' },
  extensions: { label: t('Tiện ích'), icon: 'puzzle' },
  menu: { label: t('Menu'), icon: 'more' },
};

let bar = null;
const btns = {};
const mediaEarly = new Map(); // (Truy tìm video: a page's first videos, from before its tab knew its webContents id)

export function buildToolbar() {
  bar = h('div', { id: 'toolbar' });
  renderToolbar();
  return bar;
}

let lastKey = '';
export function renderToolbar(force = false) {
  const L = S.settings.layout;
  const hidden = new Set(L.hiddenToolbarItems || []);
  const order = [...(L.toolbarItems || [])];
  // (Tiện ích: shown, before the menu, once an extension is installed; unless the user hid it)
  if (!order.includes('extensions')) order.splice(Math.max(0, order.indexOf('menu')), 0, 'extensions');
  if (!EXT.list.length) hidden.add('extensions');
  // (Tải video: where the adblock button was (now in the address bar), else before the menu; unless
  // the user hid it. Its badge counts the page's videos)
  if (!order.includes('media')) order.splice(order.includes('adblock') ? order.indexOf('adblock') + 1 : Math.max(0, order.indexOf('menu')), 0, 'media');
  for (const id of Object.keys(TOOLBAR_ITEMS)) if (!order.includes(id)) order.push(id), hidden.add(id);
  hidden.delete('omnibox');
  hidden.delete('menu');
  const key = JSON.stringify([order, [...hidden]]);
  if (key === lastKey && !force) return;
  lastKey = key;
  bar.innerHTML = '';
  for (const id of order) {
    if (hidden.has(id)) continue;
    const def = TOOLBAR_ITEMS[id];
    if (!def) continue;
    let el;
    if (id === 'omnibox') el = buildOmnibox();
    else if (id === 'downloads') el = downloadsButton();
    else {
      const keys = def.cmd && S.shortcuts?.[def.cmd]?.keys?.[0];
      el = h('button', { class: `icon-btn tb-${id}`, title: keys ? `${def.label} (${keys})` : def.label, html: icon(def.icon, 17) });
      if (id === 'menu') el.addEventListener('click', () => openMainMenu(el));
      else if (id === 'media') el.addEventListener('click', () => mediaPopover(el));
      else if (id === 'extensions') el.addEventListener('click', () => extensionsPopover(el));
      else if (id === 'reload') el.addEventListener('click', () => run(active()?.loading ? 'nav.stop' : 'nav.reload'));
      else el.addEventListener('click', () => run(def.cmd));
    }
    el.dataset.item = id;
    btns[id] = el;
    bar.append(el);
  }
  syncToolbar();
}

export function syncToolbar() {
  if (!bar) return;
  const tab = active();
  if (btns.back) btns.back.disabled = !tab?.canBack;
  if (btns.forward) btns.forward.disabled = !tab?.canFwd;
  if (btns.reload) {
    const loading = !!tab?.loading;
    btns.reload.innerHTML = icon(loading ? 'x' : 'reload', 17);
    btns.reload.title = loading ? t('Dừng tải') : t('Tải lại (F5)');
  }
  if (btns.media) {
    if (tab?.wcId && mediaEarly.has(tab.wcId)) {
      tab.media = mediaEarly.get(tab.wcId);
      mediaEarly.delete(tab.wcId);
    }
    const n = tab?.media || 0;
    btns.media.innerHTML = icon('video', 17) + (n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
  }
  if (btns.split) btns.split.classList.toggle('on', !!T.split && (T.split.a === T.activeId || T.split.b === T.activeId));
  if (btns.sidebar) btns.sidebar.classList.toggle('on', !!S.settings.layout.sidebarOpen);
}

api.on('media:found', ({ wcId, count }) => {
  const tab = byWc(wcId);
  if (!tab) {
    mediaEarly.set(wcId, count);
    if (mediaEarly.size > 40) mediaEarly.delete(mediaEarly.keys().next().value);
    return;
  }
  tab.media = count;
  if (tab.id === T.activeId) syncToolbar();
});

on('active', syncToolbar);
on('tab:update', (t) => t.id === T.activeId && syncToolbar());
on('settings', () => {
  renderToolbar();
  syncToolbar();
});
// an extension added or removed: the Tiện ích button appears / goes
on('extensions', () => bar && renderToolbar());
