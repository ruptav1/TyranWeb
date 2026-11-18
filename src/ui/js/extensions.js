// Chrome extensions (installed by src/main/extensions.js): the toolbar's Tiện ích button with their
// popups, and "Thêm vào TyranWeb" on a Chrome Web Store page.
import { api, h, on, emit, esc, clamp, debounce } from './util.js';
import { S } from './state.js';
import { T, active, activate, byWc, closeTab, createTab } from './tabs.js';
import { openPopover, closePopover, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

export const EXT = { list: [] };

export async function loadExtensions() {
  EXT.list = await api.invoke('ext:list').catch(() => []);
  emit('extensions');
  syncStoreBar();
  reportTabs();
}

// which tabs this window has, for extensions' chrome.tabs (only while some are installed)
const reportTabs = debounce(() => {
  if (!EXT.list.length) return;
  const tabs = T.list.filter((t) => !t.incognito && t.wcId).map((t) => ({ wcId: t.wcId, active: t.id === T.activeId, pinned: !!t.pinned, favicon: t.favicon || '' }));
  api.invoke('crx:tabs-state', tabs).catch(() => {});
}, 150);
on('tabs:changed', reportTabs);
on('active', reportTabs);
api.on('crx:activate', (wcId) => byWc(wcId) && activate(byWc(wcId).id));
api.on('crx:close', (wcId) => byWc(wcId) && closeTab(byWc(wcId).id, { force: true }));
api.on('extensions:changed', loadExtensions);

const STORE_PAGE = /^https:\/\/(chromewebstore\.google\.com\/detail\/|chrome\.google\.com\/webstore\/detail\/)/;
export const storeIdOf = (url) => (STORE_PAGE.test(url || '') ? (/\/([a-p]{32})(?=[/?#]|$)/.exec(url) || [])[1] || null : null);
const STORE_HOME = 'https://chromewebstore.google.com/';

const iconImg = (x, size = 18) => (x.icon ? `<img class="ext-icon" src="${esc(x.icon)}" width="${size}" height="${size}" alt="">` : icon('puzzle', size));

// ---------------------------------------------------------------- the toolbar button
export function extensionsPopover(anchor) {
  const on = EXT.list.filter((x) => x.enabled !== false && x.loaded);
  const box = h(
    'div',
    { class: 'ext-pop' },
    h('div', { class: 'ext-pop-head' }, h('b', { text: t('Tiện ích') })),
    ...(on.length
      ? on.map((x) => h('button', { class: 'ext-row', html: `${iconImg(x)}<span>${esc(x.name)}</span>`, onclick: () => openExtension(x, anchor) }))
      : [h('p', { class: 'ext-empty', text: t('Chưa có tiện ích nào đang bật.') })]),
    h(
      'div',
      { class: 'ext-pop-foot' },
      h('button', { class: 'btn small ghost', html: `${icon('sliders', 14)}<span>${t('Quản lý')}</span>`, onclick: () => (closePopover(), createTab({ url: 'tyran://settings/#extensions' })) }),
      h('button', { class: 'btn small ghost', html: `${icon('external', 14)}<span>Chrome Web Store</span>`, onclick: () => (closePopover(), createTab({ url: STORE_HOME })) })
    )
  );
  openPopover(box, anchor, { align: 'end', className: 'ext-popover' });
}

// its popup in a small window under the button (else its options page in a tab)
async function openExtension(x, anchor) {
  const p = await api.invoke('ext:pages', x.id).catch(() => null);
  if (p?.popup) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:tyran');
    wv.setAttribute('src', p.popup);
    // (its links and window.open become tabs: main.js lets it open its own pages; without this the
    // webview drops them, as Authenticator's Import pages were)
    wv.setAttribute('allowpopups', '');
    wv.className = 'ext-popup';
    // (on a plain, solid card: the popup's own frosted panes cannot blur through a frosted card)
    const pop = openPopover(h('div', { class: 'ext-popup-wrap' }, wv), anchor, { align: 'end', className: 'ext-popover ext-popup-pop', focus: false });
    // as big as the popup's page wants (Chrome's limits: 800 × 600): its preferred size, told by main
    // as it changes (a page built late, as PreMiD's, grows after it loaded); measured once at first
    const size = (w, hgt) => {
      wv.style.width = clamp(w, 200, Math.min(800, innerWidth - 40)) + 'px';
      wv.style.height = clamp(hgt, 80, Math.min(600, innerHeight - 110)) + 'px';
      pop.reposition();
    };
    let told = false;
    // (a tab it opens takes the focus, so it closes, as Chrome's popups do)
    const offTab = api.on('tab:open', ({ openerWcId }) => {
      if (!wv.isConnected) return offTab();
      let mine = false;
      try {
        mine = openerWcId === wv.getWebContentsId();
      } catch {
        /* not attached */
      }
      if (mine) closePopover();
    });
    const off = api.on('ext:popup-size', (id, s) => {
      if (!wv.isConnected) return off();
      let mine = false;
      try {
        mine = id === wv.getWebContentsId();
      } catch {
        /* not attached yet */
      }
      if (!mine || !s?.width || !s?.height) return;
      told = true;
      size(s.width, s.height);
    });
    const fit = async () => {
      if (told) return;
      const [w, hgt] = await wv.executeJavaScript('[document.documentElement.scrollWidth, document.documentElement.scrollHeight]').catch(() => [360, 480]);
      if (!told) size(w, hgt);
    };
    wv.addEventListener('dom-ready', () => {
      fit();
      setTimeout(fit, 400);
    });
    wv.addEventListener('ipc-message', (e) => e.channel === 'tyran:shortcut' && emit('command', { id: e.args[0] }));
  } else if (p?.options) {
    closePopover();
    createTab({ url: p.options });
  } else toast(t('{0} không có bảng điều khiển', x.name), { icon: 'info' });
}

// ---------------------------------------------------------------- on the Chrome Web Store
let bar = null;
let barFor = '';

export function syncStoreBar() {
  const tab = active();
  const id = tab && !tab.incognito ? storeIdOf(tab.url) : null;
  if (!id) {
    bar?.remove();
    bar = null;
    barFor = '';
    return;
  }
  const have = EXT.list.find((x) => x.storeId === id);
  const key = `${id}|${have?.version || ''}`;
  if (bar && barFor === key && bar.isConnected) return;
  barFor = key;
  bar?.remove();
  bar = h('div', { id: 'ext-store-bar' }, h('span', { class: 'ext-store-ico', html: icon('puzzle', 18) }));
  if (have) {
    bar.append(
      h('span', { class: 'ext-store-text', html: `<b>${esc(have.name)}</b> ${t('đã có trong TyranWeb')}` }),
      h('button', { class: 'btn small', text: t('Cài lại / cập nhật'), onclick: () => install(id) }),
      h('button', { class: 'btn small ghost', text: t('Quản lý'), onclick: () => createTab({ url: 'tyran://settings/#extensions' }) })
    );
  } else {
    bar.append(h('button', { class: 'btn small primary', html: `${icon('plus', 14)}<span>${t('Thêm vào TyranWeb')}</span>`, onclick: () => install(id) }));
  }
  document.querySelector('#content')?.append(bar);
}

// download, show what it is and what it may do, and only then add it
export async function install(raw) {
  const busy = toast(t('Đang tải tiện ích…'), { icon: 'download', timeout: 30000 });
  let info;
  try {
    info = await api.invoke('ext:prepare', raw);
  } catch (err) {
    busy?.remove?.();
    return toast(String(err.message || err).replace(/^.*Error: /, ''), { icon: 'warn', timeout: 5000 });
  }
  busy?.remove?.();
  const card = h(
    'div',
    { class: 'ext-confirm' },
    h('div', { class: 'ext-confirm-head', html: `${iconImg(info, 36)}<div><b>${esc(info.name)}</b><span>${t('Phiên bản')} ${esc(info.version || '?')}${info.update ? t(' · đã cài, sẽ được thay') : ''}</span></div>` }),
    h('p', { text: info.permissions.length ? t('Tiện ích này sẽ có thể:') : t('Tiện ích này không xin quyền đặc biệt nào.') }),
    info.permissions.length ? h('ul', {}, ...info.permissions.map((p) => h('li', { text: p }))) : null,
    h(
      'div',
      { class: 'ext-confirm-actions' },
      h('button', { class: 'btn', text: t('Huỷ'), onclick: () => (api.invoke('ext:cancel', info.token), closePopover()) }),
      h('button', {
        class: 'btn primary',
        text: info.update ? t('Cập nhật') : t('Thêm tiện ích'),
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const x = await api.invoke('ext:confirm', info.token);
            closePopover();
            toast(t('Đã thêm {0}', x.name), { icon: 'check', timeout: 4500 });
            loadExtensions();
          } catch (err) {
            closePopover();
            toast(t('Không nạp được tiện ích: ') + String(err.message || err).replace(/^.*Error: /, ''), { icon: 'warn', timeout: 6000 });
          }
        },
      })
    )
  );
  const r = document.querySelector('#ext-store-bar')?.getBoundingClientRect() || { left: innerWidth / 2 - 200, bottom: 120, width: 400 };
  openPopover(card, { x: Math.max(8, r.left + r.width / 2 - 200), y: r.bottom + 6 }, { className: 'ext-confirm-pop', onClose: () => api.invoke('ext:cancel', info.token) });
}

on('active', syncStoreBar);
on('tab:update', syncStoreBar);
on('tabs:changed', syncStoreBar);
