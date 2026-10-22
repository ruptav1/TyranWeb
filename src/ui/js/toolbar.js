// Toolbar: built from settings.layout.toolbarItems (order + visibility are user-editable).
import { api, h, on } from './util.js';
import { S } from './state.js';
import { T, active, byWc } from './tabs.js';
import { buildOmnibox } from './omnibox.js';
import { downloadsButton } from './downloads.js';
import { openMainMenu, run } from './commands.js';
import { openPopover, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { EXT, extensionsPopover } from './extensions.js';
import { t } from 'tyran://shared/i18n.js';

export const TOOLBAR_ITEMS = {
  back: { label: t('Quay lại'), icon: 'back', cmd: 'nav.back' },
  forward: { label: t('Tiến tới'), icon: 'forward', cmd: 'nav.forward' },
  reload: { label: t('Tải lại'), icon: 'reload', cmd: 'nav.reload' },
  home: { label: t('Trang chủ'), icon: 'home', cmd: 'nav.home' },
  omnibox: { label: t('Thanh địa chỉ') },
  adblock: { label: t('Chặn quảng cáo'), icon: 'shieldCheck' },
  downloads: { label: t('Tải xuống'), icon: 'download' },
  split: { label: t('Chia đôi màn hình'), icon: 'split', cmd: 'split.toggle' },
  screenshot: { label: t('Chụp màn hình'), icon: 'camera', cmd: 'page.screenshot' },
  pip: { label: t('Hình trong hình'), icon: 'pip', cmd: 'page.pip' },
  sidebar: { label: t('Thanh bên'), icon: 'sidebar', cmd: 'sidebar.toggle' },
  palette: { label: t('Bảng lệnh'), icon: 'command', cmd: 'palette.open' },
  theme: { label: t('Đổi theme'), icon: 'palette', cmd: 'theme.next' },
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
      else if (id === 'adblock') el.addEventListener('click', () => adblockPopover(el));
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
  if (btns.adblock) {
    const on = S.settings.privacy.adblock;
    const n = tab?.blocked || 0;
    btns.adblock.classList.toggle('off', !on);
    btns.adblock.innerHTML = icon(on ? 'shieldCheck' : 'shield', 17) + (on && n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
    btns.adblock.title = on ? t('Đã chặn {0} quảng cáo / trình theo dõi trên trang này', n) : t('Chặn quảng cáo đang tắt');
  }
  if (btns.split) btns.split.classList.toggle('on', !!T.split && (T.split.a === T.activeId || T.split.b === T.activeId));
  if (btns.sidebar) btns.sidebar.classList.toggle('on', !!S.settings.layout.sidebarOpen);
}

function adblockPopover(anchor) {
  const tab = active();
  const enabled = S.settings.privacy.adblock;
  const sw = h('input', { type: 'checkbox', checked: enabled });
  sw.addEventListener('change', async () => {
    await api.invoke('settings:set', { privacy: { adblock: sw.checked } });
    toast(sw.checked ? t('Đã bật chặn quảng cáo — tải lại trang để áp dụng') : t('Đã tắt chặn quảng cáo'), { icon: 'shield' });
  });
  const body = h(
    'div',
    { class: 'site-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico ok', html: icon('shieldCheck', 18) }), h('div', {}, h('b', { text: t('Chặn quảng cáo & theo dõi') }), h('div', { class: 'muted small', text: t('Bộ lọc Ghostery (EasyList, EasyPrivacy…)') }))),
    h('div', { class: 'site-row' }, h('span', { text: t('Đã chặn trên trang này') }), h('b', { text: String(tab?.blocked || 0) })),
    h('label', { class: 'site-row' }, h('span', { text: t('Bật chặn quảng cáo') }), h('span', { class: 'switch' }, sw, h('span')))
  );
  openPopover(body, anchor, { align: 'end', focus: false });
}

on('active', syncToolbar);
on('tab:update', (t) => t.id === T.activeId && syncToolbar());
on('settings', () => {
  renderToolbar();
  syncToolbar();
});
api.on('adblock:count', ({ wcId, count }) => {
  const t = byWc(wcId);
  if (!t) return;
  t.blocked = count;
  if (t.id === T.activeId) syncToolbar();
});

// an extension added or removed: the Tiện ích button appears / goes
on('extensions', () => bar && renderToolbar());
