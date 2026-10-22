// Permission prompts and the site-info popover.
import { api, h, $, esc, originOf, hostOf } from './util.js';
import { S } from './state.js';
import { active, byWc, activate, zoom } from './tabs.js';
import { openPopover, closePopover, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

const PERM = {
  geolocation: ['mapPin', t('Biết vị trí của bạn')],
  notifications: ['bell', t('Hiển thị thông báo')],
  midi: ['keyboard', t('Dùng thiết bị MIDI')],
  midiSysex: ['keyboard', t('Điều khiển thiết bị MIDI')],
  'clipboard-read': ['copy', t('Đọc nội dung khay nhớ tạm')],
  'idle-detection': ['clock', t('Biết khi bạn không dùng máy')],
  openExternal: ['external', t('Mở một ứng dụng bên ngoài')],
  'storage-access': ['shield', t('Dùng cookie khi được nhúng ở trang khác')],
  'top-level-storage-access': ['shield', t('Dùng cookie khi được nhúng ở trang khác')],
  'speaker-selection': ['volume', t('Chọn loa phát âm thanh')],
  'window-management': ['window', t('Quản lý cửa sổ trên các màn hình')],
};

function describe(req) {
  if (req.permission === 'media') {
    const v = req.mediaTypes.includes('video');
    const a = req.mediaTypes.includes('audio');
    return [v ? 'video' : 'mic', v && a ? t('Dùng camera và micro') : v ? t('Dùng camera') : t('Dùng micro')];
  }
  return PERM[req.permission] || ['info', req.permission];
}

const queue = [];

export function initPrompts() {
  api.on('perm:request', (req) => {
    queue.push(req);
    if (queue.length === 1) showNext();
  });
}

function showNext() {
  $('#permbar')?.remove();
  const req = queue[0];
  if (!req) return;
  const tab = byWc(req.wcId);
  const [ic, text] = describe(req);
  const incognito = S.private || req.private;
  const remember = h('input', { type: 'checkbox', checked: req.permission !== 'openExternal' && !incognito });
  const answer = (allow) => {
    api.invoke('perm:respond', req.id, allow, remember.checked);
    queue.shift();
    showNext();
  };
  const card = h(
    'div',
    { id: 'permbar' },
    h('div', { class: 'perm-ico', html: icon(ic, 20) }),
    h(
      'div',
      { class: 'perm-text' },
      h('b', { text: hostOf(req.origin) || req.origin }),
      h('span', { text: t(' muốn {0}{1}', text.charAt(0).toLowerCase(), text.slice(1)) }),
      req.externalURL ? h('code', { class: 'perm-ext', text: req.externalURL.slice(0, 80) }) : null,
      tab && tab.id !== active()?.id ? h('button', { class: 'link-btn', text: `(tab: ${tab.title.slice(0, 30)})`, onclick: () => activate(tab.id) }) : null,
      req.permission !== 'openExternal' && !incognito ? h('label', { class: 'perm-remember' }, remember, h('span', { text: t('Ghi nhớ cho trang này') })) : null
    ),
    h('div', { class: 'perm-actions' }, h('button', { class: 'btn', text: t('Chặn'), onclick: () => answer(false) }), h('button', { class: 'btn primary', text: t('Cho phép'), onclick: () => answer(true) }))
  );
  $('#content').append(card);
}

// ---------------------------------------------------------------- site info
// labels may start lower-case in some languages (they also end the prompt sentence)
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const PERM_LABEL = { media: t('Camera / micro'), ...Object.fromEntries(Object.entries(PERM).map(([k, v]) => [k, v[1]])) };

export async function siteInfo(anchor) {
  const tab = active();
  if (!tab) return;
  const origin = originOf(tab.url);
  const secure = /^https:/.test(tab.url);
  const internal = /^tyran:/.test(tab.url);
  const blocked = tab.wcId ? await api.invoke('adblock:count', tab.wcId) : 0;
  const perms = S.settings.sitePermissions[origin] || {};
  const body = h('div', { class: 'site-pop' });
  const z = Math.round((tab.zoom || 1) * 100);
  body.innerHTML = `
    <div class="pop-head"><span class="pop-head-ico ${secure || internal ? 'ok' : 'bad'}">${icon(internal ? 'sakura' : secure ? 'lock' : 'warn', 18)}</span>
      <div><b>${esc(internal ? t('Trang của TyranWeb') : hostOf(tab.url) || tab.url)}</b>
      <div class="muted small">${internal ? t('Trang nội bộ an toàn') : secure ? t('Kết nối được mã hóa (HTTPS)') : t('Kết nối KHÔNG được mã hóa — đừng nhập mật khẩu ở đây')}</div></div></div>
    ${internal ? '' : `<div class="site-row">${icon('shieldCheck', 16)}<span>${t('Đã chặn quảng cáo / trình theo dõi')}</span><b>${blocked}</b></div>`}
    <div class="site-row">${icon('zoomIn', 16)}<span>${t('Thu phóng')}</span>
      <span class="zoom-ctl"><button class="icon-btn" data-z="-1">${icon('minus', 14)}</button><b>${z}%</b><button class="icon-btn" data-z="1">${icon('plus', 14)}</button><button class="btn small ghost" data-z="0">${t('Đặt lại')}</button></span></div>
    ${
      Object.keys(perms).length
        ? `<div class="menu-title">${t('Quyền đã lưu')}</div>${Object.entries(perms)
            .map(([k, v]) => `<div class="site-row"><span>${esc(capital(PERM_LABEL[k] || k))}</span><span class="pill ${v}">${v === 'allow' ? t('Cho phép') : t('Chặn')}</span></div>`)
            .join('')}<div class="pop-foot"><button class="btn small" data-reset>${t('Xóa các quyền đã lưu')}</button></div>`
        : ''
    }`;
  body.addEventListener('click', async (e) => {
    const zb = e.target.closest('[data-z]');
    if (zb) {
      zoom(Number(zb.dataset.z));
      closePopover();
      siteInfo(anchor);
    }
    if (e.target.closest('[data-reset]')) {
      await api.invoke('perm:reset', origin);
      closePopover();
      toast(t('Đã xóa quyền của trang. Tải lại trang để áp dụng.'), { icon: 'shield' });
    }
  });
  openPopover(body, anchor, { focus: false });
}
