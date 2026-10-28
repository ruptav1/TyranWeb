// Permission prompts and the site-info popover.
import { api, h, $, esc, originOf, hostOf, isNewTab } from './util.js';
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
  api.on('share:request', sharePicker);
  // (a tab shared from the background keeps drawing, out of sight: see sessions.keepDrawn)
  api.on('share:tab', (wcId, on) => byWc(wcId)?.pane?.classList.toggle('shared', !!on));
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

// ---------------------------------------------------------------- sharing the screen
// A page asks to share the screen (getDisplayMedia: a Discord stream, a video call): as Chrome asks,
// a whole screen or one window (a picture of each), and the computer's sound with it when the page
// wants sound. A double click shares at once; Esc or a click beside it cancels.
let sharing = null; // { req, el, close }
function sharePicker(req) {
  sharing?.close(''); // (an older ask, given up)
  // (the window's tabs as the tab strip names them, with their icons; other pages it holds, and new
  // tab pages — see-through, the wallpaper is behind them — left out)
  const pages = req.sources
    .filter((x) => x.kind === 'tab' && byWc(x.wcId) && !isNewTab(byWc(x.wcId).url))
    .map((x) => {
      const tab = byWc(x.wcId);
      return { ...x, name: tab.title || x.name, icon: tab.favicon || '' };
    });
  const screens = req.sources.filter((x) => x.kind === 'screen');
  const windows = req.sources.filter((x) => x.kind === 'window');
  const lists = { tab: pages, window: windows, screen: screens };
  let kind = pages.length ? 'tab' : windows.length ? 'window' : 'screen';
  let picked = '';
  const sound = h('input', { type: 'checkbox', checked: true });
  const soundText = h('span');
  const soundRow = h('label', { class: 'share-sound', hidden: !req.audio }, sound, soundText);
  const tabs = h('div', { class: 'share-tabs' });
  const grid = h('div', { class: 'share-grid' });
  const go = h('button', { type: 'button', class: 'btn primary', text: t('Chia sẻ') });
  const close = (id) => {
    if (sharing?.req !== req) return;
    sharing = null;
    api.invoke('share:respond', req.id, id, !!id && req.audio && sound.checked).catch(() => {});
    el.remove();
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close('');
    } else if (e.key === 'Enter' && picked) {
      e.preventDefault();
      close(picked);
    }
  };
  const draw = () => {
    tabs.replaceChildren(
      ...[['tab', t('Tab trình duyệt')], ['window', t('Cửa sổ')], ['screen', t('Cả màn hình')]]
        .filter(([k]) => lists[k].length)
        .map(([k, label]) => h('button', { type: 'button', class: 'share-tab' + (k === kind ? ' on' : ''), text: label, onclick: () => ((kind = k), (picked = ''), draw()) }))
    );
    soundText.textContent = kind === 'tab' ? t('Chia sẻ cả âm thanh của tab') : t('Chia sẻ cả âm thanh của máy');
    grid.replaceChildren(
      ...lists[kind].map((x) =>
        h(
          'button',
          { type: 'button', class: 'share-item' + (x.id === picked ? ' on' : ''), title: x.name, onclick: () => ((picked = x.id), draw()), ondblclick: () => close(x.id) },
          // (a tab with no picture of it, one in the background: its icon)
          h('span', { class: 'share-thumb' + (!x.thumb && x.icon ? ' icon-only' : ''), style: x.thumb || x.icon ? { backgroundImage: `url("${encodeURI(x.thumb || x.icon)}")` } : {} }),
          h('span', { class: 'share-name', html: `${x.icon ? `<img src="${esc(x.icon)}" alt="">` : ''}<span>${esc(x.name)}</span>` })
        )
      )
    );
    go.disabled = !picked;
  };
  go.addEventListener('click', () => picked && close(picked));
  const el = h(
    'div',
    { class: 'share-scrim' },
    h(
      'div',
      { class: 'share-card', role: 'dialog' },
      h('div', { class: 'share-head' }, h('b', { text: t('Chia sẻ màn hình') }), h('span', { text: hostOf(req.origin) || req.origin })),
      tabs,
      grid,
      h('div', { class: 'share-foot' }, soundRow, h('span', { class: 'share-gap' }), h('button', { type: 'button', class: 'btn', text: t('Huỷ'), onclick: () => close('') }), go)
    )
  );
  el.addEventListener('mousedown', (e) => e.target === el && close(''));
  addEventListener('keydown', onKey, true);
  document.body.append(el);
  sharing = { req, el, close };
  draw();
  // (the tab that asked, shown)
  const tab = byWc(req.wcId);
  if (tab && tab.id !== active()?.id) activate(tab.id);
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
