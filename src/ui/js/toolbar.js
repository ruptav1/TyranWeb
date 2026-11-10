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
  media: { label: t('Video trên trang'), icon: 'video' },
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
  // (Truy tìm video: after the adblock button, shown while the tab has videos; unless the user hid it)
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
      else if (id === 'adblock') el.addEventListener('click', () => adblockPopover(el));
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
  if (btns.adblock) {
    const on = S.settings.privacy.adblock;
    const n = tab?.blocked || 0;
    btns.adblock.classList.toggle('off', !on);
    btns.adblock.innerHTML = icon(on ? 'shieldCheck' : 'shield', 17) + (on && n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
    btns.adblock.title = on ? t('Đã chặn {0} quảng cáo / trình theo dõi trên trang này', n) : t('Chặn quảng cáo đang tắt');
  }
  if (btns.media) {
    if (tab?.wcId && mediaEarly.has(tab.wcId)) {
      tab.media = mediaEarly.get(tab.wcId);
      mediaEarly.delete(tab.wcId);
    }
    const n = tab?.media || 0;
    btns.media.hidden = !n;
    btns.media.innerHTML = icon('video', 17) + (n > 1 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '');
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

// ---- Truy tìm video (main/sniffer.js): what the page plays, each with what is known of it (its kind,
// quality or variants, size, length) and its download (in Tải xuống)
const fmtSize = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n ? `${Math.round(n / 1024)} KB` : '');
const fmtTime = (s) => (s ? `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor((s % 3600) / 60)).padStart(Math.floor(s / 3600) ? 2 : 1, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const kindOf = (m) => (m.kind === 'hls' ? 'HLS' : (/\.(\w{2,4})(?:$|[?#])/.exec(new URL(m.url).pathname)?.[1] || 'video').toUpperCase());
const fileOf = (m) => {
  try {
    const u = new URL(m.url);
    return u.hostname.replace(/^www\./, '') + ' · ' + decodeURIComponent(u.pathname.split('/').pop() || '');
  } catch {
    return m.url;
  }
};

async function mediaPopover(anchor) {
  const tab = active();
  if (!tab?.wcId) return;
  const list = await api.invoke('media:list', tab.wcId).catch(() => []);
  const rows = list.map((m) => {
    const variants = [...(m.variants || [])].map((v, i) => [v, i]).sort(([a], [b]) => b.height - a.height || b.bandwidth - a.bandwidth);
    const pick = variants.length > 1 ? h('select', { class: 'input small' }, ...variants.map(([v, i]) => h('option', { value: String(i), text: [v.height ? `${v.height}p` : '', v.bandwidth && m.duration ? `~${fmtSize((v.bandwidth / 8) * m.duration)}` : v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mb/s` : '', v.audioApart ? t('tiếng riêng') : ''].filter(Boolean).join(' · ') }))) : null;
    const facts = [kindOf(m), variants.length === 1 && variants[0][0].height ? `${variants[0][0].height}p` : '', m.kind === 'file' ? fmtSize(m.size) : variants.length === 1 && variants[0][0].bandwidth && m.duration ? `~${fmtSize((variants[0][0].bandwidth / 8) * m.duration)}` : '', fmtTime(m.duration)].filter(Boolean).join(' · ');
    const blocked = m.drm ? 'DRM' : m.live ? t('Trực tiếp') : '';
    const get = h('button', { class: 'btn small primary', disabled: !!blocked, html: blocked ? `<span>${blocked}</span>` : `${icon('download', 14)}<span>${t('Tải')}</span>` });
    get.addEventListener('click', async () => {
      get.disabled = true;
      try {
        await api.invoke('media:download', tab.wcId, m.id, pick ? Number(pick.value) : variants[0] ? variants[0][1] : undefined);
        toast(t('Đang tải: {0}', m.title || fileOf(m)), { icon: 'download' });
      } catch {
        toast(t('Không tải được video này'), { icon: 'info' });
        get.disabled = false;
      }
    });
    return h('div', { class: 'media-row' }, h('span', { class: 'media-ico', html: icon('video', 18) }), h('div', { class: 'media-what' }, h('b', { text: facts }), h('span', { class: 'muted small', text: fileOf(m), title: m.url })), pick, get);
  });
  const body = h('div', { class: 'site-pop media-pop' }, h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico ok', html: icon('video', 18) }), h('div', {}, h('b', { text: t('Video trên trang') }), h('div', { class: 'muted small', text: tab.title || '' }))), ...(rows.length ? rows : [h('div', { class: 'muted small', text: t('Chưa thấy video nào') })]));
  openPopover(body, anchor, { align: 'end', focus: false });
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
api.on('adblock:count', ({ wcId, count }) => {
  const t = byWc(wcId);
  if (!t) return;
  t.blocked = count;
  if (t.id === T.activeId) syncToolbar();
});

// an extension added or removed: the Tiện ích button appears / goes
on('extensions', () => bar && renderToolbar());
