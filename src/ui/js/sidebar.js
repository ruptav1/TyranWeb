// Sidebar: bookmarks, history, downloads, quick notes and "web panels" (mini sites).
import { api, h, $, on, emit, esc, debounce, faviconHtml, prettyUrl, timeAgo, fmtBytes, clamp } from './util.js';
import { S } from './state.js';
import { active, createTab } from './tabs.js';
import { openUrl } from './bookmarks.js';
import { openMenu, promptText, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { musicKey, ownMusic } from 'tyran://shared/theme.js';
import { spectrumHook, addSpectrumSource } from './visualizer.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const BUILTIN = [
  { id: 'bookmarks', title: t('Dấu trang'), icon: 'bookmark' },
  { id: 'history', title: t('Lịch sử'), icon: 'history' },
  { id: 'downloads', title: t('Tải xuống'), icon: 'download' },
  { id: 'notes', title: t('Ghi chú nhanh'), icon: 'note' },
  { id: 'ost', title: t('Nhạc nền (nhạc sảnh Blue Archive, nhạc riêng của hình nền)'), icon: 'music' },
  { id: 'apps', title: t('Ứng dụng trên máy'), icon: 'apps' },
];
const OST_PLAYLIST = 'https://music.youtube.com/playlist?list=PLh6Ws4Fpphfqr7VL72Q6HK5Ole9YI54hv';
const webviews = new Map();
let panelId = null;

const L = () => S.settings.layout;

function save(patch) {
  Object.assign(S.settings.layout, patch);
  api.invoke('settings:set', { layout: patch });
}

export function toggleSidebar(panel) {
  const open = L().sidebarOpen;
  if (panel && open && panel !== L().sidebarPanel) return showPanel(panel);
  save({ sidebarOpen: !open, ...(panel ? { sidebarPanel: panel } : {}) });
  emit('layout-changed');
  if (!open) showPanel(panel || L().sidebarPanel);
}

export function openSidebar(panel) {
  if (!L().sidebarOpen) {
    save({ sidebarOpen: true, sidebarPanel: panel });
    emit('layout-changed');
  }
  showPanel(panel);
}

export function initSidebar() {
  const resizer = $('#sidebar .resizer');
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const side = L().sidebarPosition;
    const start = e.clientX;
    const w0 = $('#sidebar').getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = clamp(w0 + (side === 'left' ? ev.clientX - start : start - ev.clientX), 240, 720);
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save({ sidebarWidth: Math.round($('#sidebar').getBoundingClientRect().width) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  renderRail();
  if (L().sidebarOpen) showPanel(L().sidebarPanel);
  lobbyMusic();
}

export function renderRail() {
  const rail = $('#sidebar-rail');
  rail.innerHTML = '';
  for (const p of BUILTIN) {
    rail.append(railBtn(p.id, p.title, icon(p.icon, 18)));
  }
  rail.append(h('div', { class: 'rail-sep' }));
  // the computer's apps pinned here: a press starts one
  const pinned = S.settings.pinnedApps || [];
  for (const a of pinned) {
    const btn = h('button', { class: 'rail-btn rail-app', title: a.name, html: `<span class="letter-icon">${esc((a.name || '?').charAt(0).toUpperCase())}</span>` });
    appIcon(a.id).then((url) => url && (btn.innerHTML = `<img class="favicon" src="${url}" alt="">`));
    btn.addEventListener('click', () => launchApp(a));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu([{ label: t('Bỏ ghim khỏi thanh bên'), icon: 'pin', run: () => pinApp(a, false) }], { x: e.clientX, y: e.clientY });
    });
    rail.append(btn);
  }
  if (pinned.length) rail.append(h('div', { class: 'rail-sep' }));
  for (const wp of S.settings.webPanels || []) {
    const btn = railBtn('wp:' + wp.id, wp.title, faviconHtml(`https://${new URL(wp.url).hostname}/favicon.ico`, wp.title, wp.url, 18));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(
        [
          { label: t('Mở trong tab'), icon: 'external', run: () => createTab({ url: wp.url }) },
          { label: t('Đổi tên…'), icon: 'edit', run: async () => {
            const name = await promptText({ title: t('Tên web panel'), value: wp.title });
            if (name) saveWebPanels(S.settings.webPanels.map((x) => (x.id === wp.id ? { ...x, title: name } : x)));
          } },
          { sep: true },
          { label: t('Gỡ web panel'), icon: 'trash', danger: true, run: () => removeWebPanel(wp.id) },
        ],
        { x: e.clientX, y: e.clientY }
      );
    });
    rail.append(btn);
  }
  const add = h('button', { class: 'rail-btn add', title: t('Thêm web panel (trang web nhỏ ở thanh bên)'), html: icon('plus', 18) });
  add.addEventListener('click', addWebPanel);
  rail.append(add, h('div', { class: 'rail-flex' }));
  const close = h('button', { class: 'rail-btn', title: t('Đóng thanh bên (Ctrl+Shift+E)'), html: icon(L().sidebarPosition === 'left' ? 'chevronLeft' : 'chevronRight', 18) });
  close.addEventListener('click', () => toggleSidebar());
  rail.append(close);
  markRail();
}

function railBtn(id, title, html) {
  const b = h('button', { class: 'rail-btn', title, html, dataset: { panel: id } });
  b.addEventListener('click', () => (panelId === id && L().sidebarOpen ? toggleSidebar() : openSidebar(id)));
  return b;
}

function markRail() {
  for (const b of document.querySelectorAll('#sidebar-rail .rail-btn[data-panel]')) b.classList.toggle('on', b.dataset.panel === panelId);
}

async function addWebPanel() {
  const tab = active();
  const suggestion = tab && /^https?:/.test(tab.url) ? tab.url : 'https://';
  const url = await promptText({ title: t('Địa chỉ trang cho web panel'), value: suggestion, okLabel: t('Thêm') });
  if (!url || !/^https?:\/\/.+\..+/.test(url)) return;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const wp = { id: 'wp-' + Date.now().toString(36), title: host, url };
  saveWebPanels([...(S.settings.webPanels || []), wp]);
  openSidebar('wp:' + wp.id);
}

function saveWebPanels(list) {
  S.settings.webPanels = list;
  api.invoke('settings:set', { webPanels: list });
  renderRail();
}

function removeWebPanel(id) {
  webviews.get('wp:' + id)?.remove();
  webviews.delete('wp:' + id);
  saveWebPanels(S.settings.webPanels.filter((x) => x.id !== id));
  if (panelId === 'wp:' + id) showPanel('bookmarks');
}

// ---------------------------------------------------------------- panels
export function showPanel(id = 'bookmarks') {
  panelId = id;
  if (L().sidebarPanel !== id) save({ sidebarPanel: id });
  const box = $('#sidebar-panel');
  for (const wv of webviews.values()) wv.hidden = true;
  [...box.children].forEach((c) => !c.classList.contains('wp-wrap') && c.remove());
  markRail();
  if (id.startsWith('wp:')) return showWebPanel(id);
  if (id === 'ost') return showOstPanel();
  const builtin = BUILTIN.find((p) => p.id === id) || BUILTIN[0];
  const head = h('div', { class: 'panel-head' }, h('b', { text: builtin.title }));
  const body = h('div', { class: 'panel-body' });
  box.append(head, body);
  ({ bookmarks: bookmarksPanel, history: historyPanel, downloads: downloadsPanel, notes: notesPanel, apps: appsPanel })[builtin.id](body, head);
}

// ---------------------------------------------------------------- the computer's apps
// The signed apps of the Start menu (programs and Store / MSIX apps, main/apps.js): a press starts
// one; the pin keeps it on the rail.
const appIcons = new Map();
const appIcon = (id) => {
  if (!appIcons.has(id)) appIcons.set(id, api.invoke('apps:icon', id).catch(() => ''));
  return appIcons.get(id);
};
async function launchApp(a) {
  try {
    await api.invoke('apps:launch', a.id);
    toast(t('Đang mở {0}…', a.name), { icon: 'apps' });
  } catch (err) {
    toast(String(err?.message || err).replace(/^.*Error: /, ''), { icon: 'warn' });
  }
}
function pinApp(a, on) {
  const list = (S.settings.pinnedApps || []).filter((x) => x.id !== a.id);
  if (on) list.push({ id: a.id, name: a.name });
  S.settings.pinnedApps = list;
  api.invoke('settings:set', { pinnedApps: list });
  renderRail();
  if (panelId === 'apps') showPanel('apps');
}
function appsPanel(body, head) {
  const list = h('div', { class: 'panel-list' });
  let filter = '';
  let apps = null;
  const render = () => {
    if (!apps) return void (list.innerHTML = `<div class="empty-note">${esc(t('Đang tải…'))}</div>`);
    const pinned = new Set((S.settings.pinnedApps || []).map((x) => x.id));
    const shown = apps.filter((a) => !filter || a.name.toLowerCase().includes(filter) || (a.signer || '').toLowerCase().includes(filter)).sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
    list.replaceChildren(
      ...shown.map((a) => {
        const row = h('div', { class: 'panel-item app-item', title: `${a.name}${a.signer ? '\n' + a.signer : ''}` });
        row.innerHTML = `<span class="app-ico letter-icon">${esc(a.name.charAt(0).toUpperCase())}</span><span class="pi-text"><span class="pi-title">${esc(a.name)}</span><span class="pi-sub">${esc(a.signer || '')}</span></span>`;
        appIcon(a.id).then((url) => url && row.querySelector('.app-ico').replaceWith(h('img', { class: 'app-ico', src: url, alt: '' })));
        const on = pinned.has(a.id);
        const pin = h('button', { class: 'icon-btn pi-x app-pin' + (on ? ' on' : ''), title: on ? t('Bỏ ghim khỏi thanh bên') : t('Ghim vào thanh bên'), html: icon('pin', 14) });
        pin.addEventListener('click', (e) => (e.stopPropagation(), pinApp(a, !on)));
        row.append(pin);
        row.addEventListener('click', () => launchApp(a));
        return row;
      })
    );
    if (!shown.length) list.innerHTML = `<div class="empty-note">${esc(t('Không có kết quả'))}</div>`;
  };
  // (the list known so far shows at once; once looked for again, it comes back changed: apps:changed)
  const load = (fresh) => api.invoke('apps:list', fresh).then((l) => list.isConnected && ((apps = l), render()), () => list.isConnected && ((apps = apps || []), render()));
  appsPanelLoad = () => list.isConnected && load(false);
  head.append(h('button', { class: 'icon-btn', title: t('Tải lại'), html: icon('reload', 15), onclick: () => load(true) }));
  body.append(searchBox(t('Tìm ứng dụng'), (q) => ((filter = q), render())), list);
  render();
  load(false);
}
let appsPanelLoad = () => {};
api.on('apps:changed', () => appsPanelLoad());

function searchBox(placeholder, onInput) {
  const input = h('input', { type: 'search', class: 'input panel-search', placeholder });
  input.addEventListener('input', debounce(() => onInput(input.value.trim().toLowerCase()), 120));
  return input;
}

function itemRow({ title, url, favicon, meta, onRemove }) {
  const row = h('div', { class: 'panel-item', title: `${title}\n${url}` });
  row.innerHTML = `${faviconHtml(favicon, title, url)}<span class="pi-text"><span class="pi-title">${esc(title || url)}</span><span class="pi-sub">${esc(meta || prettyUrl(url))}</span></span>`;
  if (onRemove) {
    const x = h('button', { class: 'icon-btn pi-x', title: t('Xóa'), html: icon('x', 14) });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
    row.append(x);
  }
  row.addEventListener('click', (e) => openUrl(url, { newTab: e.ctrlKey }));
  row.addEventListener('auxclick', (e) => e.button === 1 && openUrl(url, { newTab: true, background: true }));
  return row;
}

function bookmarksPanel(body, head) {
  head.append(h('button', { class: 'icon-btn', title: t('Quản lý dấu trang'), html: icon('external', 15), onclick: () => createTab({ url: 'tyran://bookmarks/' }) }));
  const list = h('div', { class: 'panel-list' });
  let filter = '';
  const render = () => {
    list.innerHTML = '';
    for (const f of S.bookmarks.folders) {
      const items = S.bookmarks.items.filter((b) => b.folder === f.id && (!filter || (b.title + b.url).toLowerCase().includes(filter)));
      if (!items.length) continue;
      list.append(h('div', { class: 'panel-group', html: `${icon('folder', 14)}<span>${esc(f.name)}</span>` }));
      for (const b of items) list.append(itemRow({ ...b, onRemove: () => api.invoke('bookmarks:remove', b.id) }));
    }
    if (!list.children.length) list.append(h('div', { class: 'empty-note', text: filter ? t('Không có kết quả') : t('Chưa có dấu trang nào ☆') }));
  };
  body.append(searchBox(t('Tìm dấu trang'), (q) => ((filter = q), render())), list);
  render();
  const off = on('bookmarks', () => (list.isConnected ? render() : off()));
}

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('Hôm nay');
  if (d.toDateString() === y.toDateString()) return t('Hôm qua');
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'numeric' });
}

function historyPanel(body, head) {
  head.append(h('button', { class: 'icon-btn', title: t('Mở trang lịch sử'), html: icon('external', 15), onclick: () => createTab({ url: 'tyran://history/' }) }));
  const list = h('div', { class: 'panel-list' });
  let text = '';
  let offset = 0;
  let loading = false;
  let lastDay = '';
  const load = async (reset) => {
    if (loading) return;
    loading = true;
    if (reset) {
      offset = 0;
      lastDay = '';
      list.innerHTML = '';
    }
    const rows = await api.invoke('history:query', { text, limit: 80, offset });
    offset += rows.length;
    for (const v of rows) {
      const day = dayLabel(v.time);
      if (day !== lastDay) {
        lastDay = day;
        list.append(h('div', { class: 'panel-group', text: day }));
      }
      list.append(
        itemRow({
          ...v,
          meta: new Date(v.time).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) + ' · ' + (new URL(v.url).hostname || ''),
          onRemove: async () => {
            await api.invoke('history:remove', [v.id]);
          },
        })
      );
    }
    if (!list.children.length) list.append(h('div', { class: 'empty-note', text: text ? t('Không có kết quả') : t('Lịch sử trống') }));
    loading = false;
  };
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 200) load(false);
  });
  body.append(searchBox(t('Tìm trong lịch sử'), (q) => ((text = q), load(true))), list);
  load(true);
}

function downloadsPanel(body, head) {
  head.append(h('button', { class: 'icon-btn', title: t('Mở trang tải xuống'), html: icon('external', 15), onclick: () => createTab({ url: 'tyran://downloads/' }) }));
  const list = h('div', { class: 'panel-list' });
  const render = async () => {
    const items = await api.invoke('downloads:list');
    list.innerHTML = '';
    for (const d of items.slice(0, 100)) {
      const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
      const row = h('div', { class: 'panel-item', title: d.path || d.filename });
      row.innerHTML = `<span class="pi-ico">${icon(d.state === 'completed' ? 'check' : 'download', 16)}</span><span class="pi-text"><span class="pi-title">${esc(d.filename)}</span><span class="pi-sub">${
        d.state === 'progressing' ? `${pct}% · ${fmtBytes(d.receivedBytes)}` : d.state === 'completed' ? `${fmtBytes(d.totalBytes)} · ${timeAgo(d.endTime || d.startTime)}` : t('Đã hủy / lỗi')
      }</span></span>`;
      row.addEventListener('click', () => api.invoke('downloads:action', d.id, d.state === 'completed' ? 'open' : 'show'));
      list.append(row);
    }
    if (!items.length) list.append(h('div', { class: 'empty-note', text: t('Chưa có tệp nào') }));
  };
  body.append(list);
  render();
  const refresh = debounce(render, 500);
  const off = api.on('downloads:update', () => (list.isConnected ? refresh() : off()));
}

async function notesPanel(body, head) {
  const area = h('textarea', { class: 'notes-area', placeholder: t('Ghi chú nhanh… (tự động lưu)\n\nMẹo: bấm 🔗 để chèn liên kết trang đang xem.'), spellcheck: 'true' });
  const saved = h('span', { class: 'faint notes-saved' });
  const persist = debounce(async () => {
    await api.invoke('notes:set', area.value);
    saved.textContent = t('Đã lưu');
    setTimeout(() => (saved.textContent = ''), 1200);
  }, 500);
  area.addEventListener('input', persist);
  head.append(
    saved,
    h('button', {
      class: 'icon-btn',
      title: t('Chèn liên kết trang hiện tại'),
      html: icon('link', 15),
      onclick: () => {
        const t = active();
        if (!t) return;
        const line = `${t.title}\n${t.url}\n`;
        const pos = area.selectionStart ?? area.value.length;
        area.value = area.value.slice(0, pos) + (pos && area.value[pos - 1] !== '\n' ? '\n' : '') + line + area.value.slice(pos);
        persist();
        area.focus();
      },
    }),
    h('button', {
      class: 'icon-btn',
      title: t('Sao chép tất cả'),
      html: icon('copy', 15),
      onclick: () => {
        api.invoke('clipboard:write', area.value);
        toast(t('Đã sao chép ghi chú'), { icon: 'copy' });
      },
    })
  );
  body.append(area);
  const n = await api.invoke('notes:get');
  area.value = n.text || '';
}

function showWebPanel(id) {
  const wp = (S.settings.webPanels || []).find((x) => 'wp:' + x.id === id);
  const box = $('#sidebar-panel');
  if (!wp) return showPanel('bookmarks');
  let wrap = webviews.get(id);
  if (!wrap) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', S.private ? 'tyran-private' : 'persist:tyran');
    wv.setAttribute('useragent', MOBILE_UA);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', wp.url);
    const head = h(
      'div',
      { class: 'panel-head' },
      h('b', { text: wp.title }),
      h('button', { class: 'icon-btn', title: t('Quay lại'), html: icon('back', 15), onclick: () => wv.canGoBack() && wv.goBack() }),
      h('button', { class: 'icon-btn', title: t('Tải lại'), html: icon('reload', 15), onclick: () => wv.reload() }),
      h('button', { class: 'icon-btn', title: t('Mở trong tab'), html: icon('external', 15), onclick: () => createTab({ url: wv.getURL() }) })
    );
    wrap = h('div', { class: 'wp-wrap' }, head, h('div', { class: 'wp-view' }, wv));
    wv.addEventListener('ipc-message', (e) => {
      if (e.channel === 'tyran:shortcut') emit('command', { id: e.args[0] });
    });
    webviews.set(id, wrap);
    box.append(wrap);
  }
  wrap.hidden = false;
}

// ---------------------------------------------------------------- lobby music
// The song of the Blue Archive lobby on the wallpaper, from the OST playlist on YouTube. It is the
// YouTube watch page itself (like a web panel), so it keeps playing while other panels are open or
// the sidebar is closed. Like in the game it plays whenever the lobby's sound is on (the Lobby's
// sound button, Settings → Hình nền), and stops when it is turned off.
// One volume for the whole lobby: the lobby's voices, this song, the sliders in the lobby bar,
// Settings and this panel, and YouTube's own volume control all move together.
let ost = null; // { wrap, wv, info, sliders, ready, video, vol, ticking, again }
let ostModels = null;

const isLobby = () => {
  const w = S.settings.wallpaper;
  return w.type === 'web' && w.web?.preset === 'bluearchive';
};
// the wallpaper's own music (Settings → Hình nền → Nhạc nền); for a lobby it takes the place of its OST
const own = () => ownMusic(S.settings.wallpaper);
// a lobby's music plays while its sound is on; another wallpaper's own music while "Phát nhạc nền" is
const soundOn = () => {
  const w = S.settings.wallpaper;
  return isLobby() ? !!w.web?.audio : !!own() && w.musicOn !== false;
};
const ostShown = () => L().sidebarOpen && panelId === 'ost';

async function lobbySong() {
  const w = S.settings.wallpaper;
  const mine = own();
  // (Blue Archive's normal lobby: the game's main lobby theme, for every student)
  if (isLobby() && w.web.baMode === 'normal') {
    const m = await api.invoke('balobby:song').catch(() => null);
    return mine ? { mine, m } : m?.ost?.video ? { m } : { m, reason: t('Không tải được danh sách sảnh.') };
  }
  if (mine) {
    if (isLobby()) ostModels ||= await api.invoke('wallpapers:baModels').catch(() => null);
    return { mine, m: (isLobby() && ostModels?.find((x) => x.key === w.web.model)) || null };
  }
  if (!isLobby()) return { reason: t('Hình nền này chưa có nhạc.') };
  ostModels ||= await api.invoke('wallpapers:baModels').catch(() => null);
  const m = ostModels?.find((x) => x.key === w.web.model);
  if (!m) return { reason: t('Không tải được danh sách sảnh.') };
  if (!m.ost?.video) return { m, reason: m.ost ? t('Bài nhạc của sảnh này (BGM {0}) không có trong playlist OST.', m.ost.n) : t('Sảnh này không có nhạc riêng.') };
  return { m };
}

// While a student talks the song dips, as in the game (never for more than a minute).
const DUCK = 0.3;
let ducked = false;
let duckTimer = 0;
on('lobby-talk', (talking) => {
  if (talking === ducked) return;
  ducked = talking;
  clearTimeout(duckTimer);
  if (talking) duckTimer = setTimeout(() => emit('lobby-talk', false), 60000);
  rampOst();
  setOwnLevel();
});

// a lobby's song plays at the lobby volume times the music volume (0–100, like YouTube's own
// control); another wallpaper's music at its own volume (dipping too while a NIKKE character talks)
const lobbyVolume = () => {
  const w = S.settings.wallpaper;
  const web = w.web || {};
  const v = (isLobby() ? (web.volume ?? 0.6) * (web.musicVolume ?? 1) : (w.musicVolume ?? 0.6)) * (ducked ? DUCK : 1);
  return Math.round(clamp(v, 0, 1) * 100);
};

// sets YouTube's volume, noting it as ours so it is not taken for the user's own change, and as the
// one the page keeps (see tickOst)
const setOstVolume = (v) =>
  ost.wv
    .executeJavaScript(`(() => { window.__tyranWant = ${v}; const p = document.getElementById('movie_player'); if (!p || !p.setVolume) return; window.__tyranExpect = ${v}; p.setVolume(${v}); })()`)
    .catch(() => {});

// glides to the volume the lobby wants (in and out of the dip) over about 0.4 s
let rampSeq = 0;
async function rampOst() {
  if (!ost?.ready) return;
  const seq = ++rampSeq;
  const from = await ost.wv.executeJavaScript("document.getElementById('movie_player')?.getVolume?.() ?? -1").catch(() => -1);
  const to = lobbyVolume();
  if (from < 0 || from === to || seq !== rampSeq) return;
  ost.ramping = true;
  for (let i = 1; i <= 6 && seq === rampSeq; i++) {
    await setOstVolume(Math.round(from + ((to - from) * i) / 6));
    await new Promise((r) => setTimeout(r, 70));
  }
  if (seq === rampSeq) ost.ramping = false;
}

// YouTube's own volume control moved: only the music volume follows (the voices keep theirs);
// above what the lobby volume allows, the lobby volume goes up and the voices are evened out
function musicFromYouTube(yt) {
  if (!isLobby()) return api.invoke('settings:set', { wallpaper: { musicVolume: clamp(yt / 100, 0, 1) } });
  const web = S.settings.wallpaper.web || {};
  const master = web.volume ?? 0.6;
  const want = clamp(yt / 100 / (ducked ? DUCK : 1), 0, 1);
  if (want <= master && master > 0) return api.invoke('settings:set', { wallpaper: { web: { musicVolume: Math.round((want / master) * 100) / 100 } } });
  const voice = clamp(((web.voiceVolume ?? 1) * master) / (want || 1), 0, 1);
  return api.invoke('settings:set', { wallpaper: { web: { volume: want, musicVolume: 1, voiceVolume: Math.round(voice * 100) / 100 } } });
}

// Keeps the song looping and its volume equal to the lobby volume. The volume goes through
// YouTube's own player (it rescales video.volume for loudness itself). YouTube also restores its
// own saved volume while a video starts, so only a change made on the page by the user (a click or
// a key) is taken back to the lobby; any other difference is put right, by the page itself the
// moment it happens: this window's timers barely run while the app sits behind other windows,
// which let the music come back louder for a while.
async function tickOst() {
  if (!ost?.ready || ost.ramping) return;
  if (ost.ticking) return void (ost.again = true);
  ost.ticking = true;
  const r = await ost.wv
    .executeJavaScript(
      `(() => {
        const v = document.querySelector('video');
        const p = document.getElementById('movie_player');
        window.__tyranWant ??= ${lobbyVolume()};
        if (!v || !p || !p.getVolume) return null;
        if (${JSON.stringify(ost.video)} && ${!ost.list} && location.href.includes('v=' + ${JSON.stringify(ost.video)})) v.loop = ${!nextOnEnd()}; // the lobby's song loops (a playlist plays on), unless its end moves on to the next lobby
        if (!v.__tyranEnd) { v.__tyranEnd = true; v.addEventListener('ended', () => (window.__tyranSongEnd = (window.__tyranSongEnd || 0) + 1)); }
        if (window.__tyranHold && location.href.includes('v=' + window.__tyranHoldId) && !v.paused) { p.pauseVideo(); p.seekTo(0, true); } // still waiting for the lobby
        if (!v.__tyranVol) {
          v.__tyranVol = true;
          const keep = () => {
            const now = Math.round(p.getVolume());
            if (navigator.userActivation && navigator.userActivation.isActive && now !== window.__tyranExpect) return void (window.__tyranUserVol = now);
            if (typeof window.__tyranWant === 'number' && now !== window.__tyranWant) { window.__tyranExpect = window.__tyranWant; p.setVolume(window.__tyranWant); }
          };
          v.addEventListener('volumechange', keep);
          v.addEventListener('playing', keep); // (a new video or the end of an ad)
        }
        const user = window.__tyranUserVol;
        window.__tyranUserVol = undefined;
        return { cur: p.getVolume(), user };
      })()`
    )
    .catch(() => null);
  const want = lobbyVolume();
  if (r && typeof r.user === 'number' && Math.round(r.user) !== want) {
    await musicFromYouTube(Math.round(r.user)); // moved with YouTube's own control
  } else if (r && Math.round(r.cur) !== want) {
    await setOstVolume(want);
  }
  ost.ticking = false;
  if (ost.again) {
    ost.again = false;
    tickOst();
  }
}

// the songs play on YouTube Music: its player is YouTube's own (#movie_player), and at the sidebar's
// width it lays itself out as a music player (the cover, the controls, what plays next)
function ostUrl(video, list = '') {
  return `https://music.youtube.com/watch?v=${video}${list ? '&list=' + list : ''}`;
}

// YouTube's desktop pages (which, unlike the mobile ones, keep playing while hidden), when one is
// gone to from YouTube Music, laid out for the sidebar's width: no minimum player width, the player
// on top. YouTube's own top bar stays, for its search (at this width it folds into a search button).
const OST_CSS = `ytd-watch-flexy { --ytd-watch-flexy-min-player-width: 0px !important; --ytd-watch-flexy-sidebar-min-width: 0px !important; }
#primary.ytd-watch-flexy, #columns.ytd-watch-flexy { min-width: 0 !important; margin: 0 !important; padding: 0 !important; }
#below.ytd-watch-flexy { padding: 0 10px !important; }
html, body, ytd-app { min-width: 0 !important; overflow-x: hidden !important; }
#player-ads, #masthead-ad, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-companion-slot-renderer, ytd-banner-promo-renderer,
.ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-ad-module .ytp-ad-overlay-slot { display: none !important; }`;

// YouTube's video ads in the panel (they come from the same servers as the music, so the ad blocker
// cannot stop them): taken away the moment one starts — its skip button when it has one, otherwise
// played to its end at once, muted. Runs inside the page, on the player's own changes.
const AD_SKIP = `(() => {
  if (window.__tyranAds) return;
  window.__tyranAds = true;
  let muted = false;
  const check = () => {
    const p = document.getElementById('movie_player');
    const v = document.querySelector('#movie_player video') || document.querySelector('video');
    if (!p || !v) return;
    if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) {
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button');
      if (skip) skip.click();
      if (!v.muted) { v.muted = true; muted = true; }
      if (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.1) v.currentTime = v.duration - 0.05;
      v.playbackRate = 16;
    } else {
      if (muted) { v.muted = false; muted = false; }
      if (v.playbackRate === 16) v.playbackRate = 1;
    }
  };
  const watch = () => {
    const p = document.getElementById('movie_player');
    if (!p) return setTimeout(watch, 300);
    new MutationObserver(check).observe(p, { attributes: true, attributeFilter: ['class'] });
    check();
  };
  watch();
  setInterval(check, 500);
})()`;

function showOstPanel() {
  ensureOst();
  ost.wrap.hidden = false;
  syncOst();
}

// the player, hidden until the panel is opened
function ensureOst() {
  if (!ost) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', S.private ? 'tyran-private' : 'persist:tyran');
    wv.setAttribute('allowpopups', '');
    const info = h('div', { class: 'ost-info' });
    // a lobby: its overall volume (song and voices) and the song's own; another wallpaper: its music's
    const sliders = [];
    const row = (key, ic, label, lobby) => {
      const s = h('input', { type: 'range', class: 'ost-volume', min: '0', max: '1', step: '0.01', 'aria-label': label, dataset: { key, lobby: lobby ? '1' : '' } });
      s.addEventListener('input', () => api.invoke('settings:set', { wallpaper: lobby ? { web: { [key]: Number(s.value) } } : { [key]: Number(s.value) } }));
      sliders.push(s);
      return h('label', { class: 'ost-vol-row', title: label }, h('span', { html: icon(ic, 15) }), s);
    };
    const volRow = h(
      'div',
      {},
      row('volume', 'sliders', t('Âm lượng chung (nhạc và giọng nói)'), true),
      row('musicVolume', 'music', t('Âm lượng nhạc'), true),
      row('musicVolume', 'music', t('Âm lượng nhạc nền'), false)
    );
    const head = h(
      'div',
      { class: 'panel-head' },
      h('b', { text: t('Nhạc nền') }),
      h('button', { class: 'icon-btn', title: t('Phát lại từ đầu'), html: icon('reload', 15), onclick: () => (own() && own().kind !== 'youtube' ? restartOwn() : syncOst({ force: true })) }),
      h('button', { class: 'icon-btn', title: t('Mở trong tab (bài / playlist đang dùng, hoặc cả playlist OST)'), html: icon('external', 15), onclick: () => createTab({ url: own()?.url || OST_PLAYLIST }) })
    );
    const ytView = h('div', { class: 'wp-view' }, wv);
    // the wallpaper's own music that is not on YouTube: SoundCloud / Spotify players, or its files
    const ownView = h('div', { class: 'wp-view own-view' });
    const files = h('div', { class: 'own-files' });
    ownView.hidden = files.hidden = true;
    const wrap = h('div', { class: 'wp-wrap ost-wrap' }, head, info, volRow, ytView, ownView, files);
    ost = { wrap, wv, info, sliders, ytView, ownView, files, ready: false, video: '', list: '', held: false, ticking: false, again: false };
    syncSliders();
    wv.addEventListener('ipc-message', (e) => {
      if (e.channel === 'tyran:shortcut') emit('command', { id: e.args[0] });
    });
    wv.addEventListener('did-attach', () => muteOst(ost.held));
    wv.addEventListener('dom-ready', () => {
      const first = !ost.ready;
      ost.ready = true;
      // the lobby changed while the first page was loading: go to its song now (later pages are
      // wherever the user went)
      if (first && ost.video && !wv.getURL().includes('v=' + ost.video)) return void wv.loadURL(ostUrl(ost.video, ost.list)).catch(() => {});
      if (/^https:\/\/((www|music)\.)?youtube\.com\//.test(wv.getURL())) {
        wv.insertCSS(OST_CSS).catch(() => {});
        wv.executeJavaScript(`(${spectrumHook})()`).catch(() => {}); // (its song's levels, for the spectrum bar)
        wv.executeJavaScript(AD_SKIP).catch(() => {});
      }
      muteOst(ost.held);
      wv.executeJavaScript(holdScript(ost.held, ost.video)).catch(() => {});
      tickOst();
    });
    setInterval(tickOst, 1500);
    wrap.hidden = true;
    webviews.set('ost', wrap);
    $('#sidebar-panel').append(wrap);
  }
}


// ---- in step with the lobby: a song for a lobby that is still loading waits, silent and paused at
// its very start, until the lobby's intro begins; then both start together. When the intro plays
// again (a late layer, a reload), the song goes back to its start with it.
let lobbyLive = false; // the lobby on the wallpaper has started (its intro is playing or over)
let lastStart = 0;

const muteOst = (muted) => {
  try {
    ost.wv.setAudioMuted(muted);
  } catch {
    /* not attached yet: did-attach does it */
  }
};

// in the YouTube page: while held, any start of the lobby's song is undone (back to 0:00, paused);
// other videos the user goes to play freely
const holdScript = (hold, id) => `(() => {
  window.__tyranHold = ${!!hold};
  window.__tyranHoldId = ${JSON.stringify(id || '')};
  if (window.__tyranHoldOn) return;
  window.__tyranHoldOn = true;
  const hold = () => {
    const p = document.getElementById('movie_player');
    if (window.__tyranHold && location.href.includes('v=' + window.__tyranHoldId) && p && p.pauseVideo) { p.pauseVideo(); p.seekTo(0, true); }
  };
  document.addEventListener('play', hold, true);
  document.addEventListener('playing', hold, true);
})()`;

// resolves true once the held song is buffered at its start (false: nothing held, or it took too long)
async function musicReady() {
  for (let i = 0; i < 50 && ost?.held; i++) {
    if (ost.ready) {
      const ok = await ost.wv
        .executeJavaScript(
          `(() => {
            const v = document.querySelector('video');
            const p = document.getElementById('movie_player');
            if (!v || !p || !p.pauseVideo) return false;
            if (!v.paused) { p.pauseVideo(); p.seekTo(0, true); }
            return v.readyState >= 3;
          })()`
        )
        .catch(() => false);
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

on('lobby-loading', () => (lobbyLive = false));
// nothing to wait for any more (no lobby, or one the viewer cannot show): the song is let go, silent
// until played
function releaseOst() {
  if (!ost?.held) return;
  ost.held = false;
  muteOst(false);
  if (ost.ready) ost.wv.executeJavaScript('window.__tyranHold = false').catch(() => {});
}
on('lobby-failed', releaseOst);
// The wallpaper starts the lobby: the held song (buffered at 0:00, so no seeking and no stall)
// plays first, and the time it has really reached once playing is handed back, for the intro to
// start at that same point.
on('lobby-start-music', ({ resolve }) => startHeldMusic().then(resolve, () => resolve(-1)));
// where the song is now (t, seconds), and when that answer came back (when, performance.now())
on('lobby-music-time', ({ resolve }) => {
  if (!ost?.ready || ost.held || !ost.video) return resolve(null);
  ost.wv
    .executeJavaScript("(() => { const v = document.querySelector('video'); return v && !v.paused ? v.currentTime : -1; })()")
    .then((t) => resolve({ t, when: performance.now() }), () => resolve(null));
});
async function startHeldMusic() {
  lobbyLive = true;
  lastStart = performance.now();
  if (!ost?.held || !ost.ready || !ost.video) {
    if (ost) {
      ost.held = false;
      muteOst(false);
    }
    return -1;
  }
  ost.held = false;
  muteOst(false);
  return ost.wv.executeJavaScript(`new Promise((resolve) => {
    window.__tyranHold = false;
    const v = document.querySelector('video');
    const p = document.getElementById('movie_player');
    if (!v || !p || !p.playVideo) return resolve(-1);
    v.addEventListener('playing', () => resolve(v.currentTime), { once: true });
    setTimeout(() => resolve(v.paused ? -1 : v.currentTime), 1500);
    p.playVideo();
  })`);
}
// the wallpaper asks whether the song is ready before it starts the lobby
on('lobby-music-prepare', ({ resolve }) => (ost?.held ? musicReady() : Promise.resolve(false)).then(resolve));
on('lobby-start', () => {
  if (performance.now() - lastStart < 1500) return; // the same start, heard twice
  lastStart = performance.now();
  lobbyLive = true;
  if (!ost) return;
  const held = ost.held;
  ost.held = false;
  if (!ost.ready || !ost.video || (!held && !soundOn())) return muteOst(false);
  Promise.resolve(onLobbySong("window.__tyranHold = false; const p = document.getElementById('movie_player'); if (p && p.seekTo) { p.seekTo(0, true); p.playVideo(); }")).then(() => muteOst(false));
});

// only the lobby's own song is stopped or restarted by TyranWeb; a video picked in the panel by
// hand plays on untouched (hiding / showing the sidebar, a wallpaper that is not a lobby...)
// (a playlist: any of its videos)
const onLobbySong = (code) =>
  ost?.ready && ost.video
    ? ost.wv.executeJavaScript(`(location.href.includes('v=${ost.video}') ${ost.list ? `|| location.href.includes('list=${ost.list}')` : ''}) && (() => { ${code} })()`).catch(() => {})
    : null;

// resume: the lobby's sound was just turned back on; lobbyChanged: the lobby or its sound switch
// changed (not just the panel being opened)
async function syncOst({ force = false, resume = false, lobbyChanged = false } = {}) {
  if (!ost) return;
  const { m, mine, reason } = await lobbySong();
  const yt = mine?.kind === 'youtube' ? mine : null;
  const song = !m?.ost?.video ? '' : m.ost.n ? `OST ${m.ost.n}${m.ost.title && m.ost.title !== `OST ${m.ost.n}` ? ' · ' + esc(m.ost.title) : ''}` : esc(m.ost.title);
  ost.info.innerHTML = mine
    ? `<span class="ost-who">${esc(m?.name || t('Nhạc riêng của hình nền'))}</span><span class="ost-song">${esc(mine.kind === 'files' ? t('{0} bài nhạc', mine.files.length) : mine.title)}</span><span class="ost-note">${MUSIC_KIND[mine.kind] || ''}</span>`
    : m
      ? `<span class="ost-who">${esc(m.name)}</span>${song ? `<span class="ost-song">${song}</span>` : ''}${reason ? `<span class="ost-note">${esc(reason)}</span>` : ''}`
      : `<span class="ost-note">${esc(reason)}</span>`;
  // which player shows: YouTube's page, SoundCloud's / Spotify's, or the list of files
  ost.ytView.hidden = !!mine && !yt;
  ost.ownView.hidden = !mine || !!yt || mine.kind === 'files';
  ost.files.hidden = mine?.kind !== 'files';
  syncOwn(mine && !yt ? mine : null, soundOn() && S.lobbyOpen !== false);
  const video = yt ? yt.video : mine ? '' : m?.ost?.video || '';
  const pauseLobbySong = () => lobbyChanged && onLobbySong("document.querySelector('video')?.pause()");
  if (!video) {
    // no lobby song now: the previous lobby's song stops (its page stays, so it can still be played)
    pauseLobbySong();
    releaseOst();
    ost.video = '';
    ost.list = '';
    // an empty panel still lets you find music: YouTube Music's home page
    if (!mine && !ost.wv.getAttribute('src')) ost.wv.setAttribute('src', 'https://music.youtube.com/');
    return;
  }
  if (video !== ost.video) ost.list = yt?.list || '';
  // the lobby's sound is off: no song unless it is asked for in the panel
  // ...and while no tab shows the lobby (the new tab page), its song rests too
  if (!force && (S.lobbyOpen === false || (!soundOn() && !ostShown()))) return void pauseLobbySong();
  if (!force && video === ost.video) return void (resume && onLobbySong("document.querySelector('video')?.play()"));
  ost.video = video;
  ost.list = yt?.list || '';
  // a lobby still loading gets its song held until its intro starts (see lobby-start)
  ost.held = !force && !lobbyLive && isLobby();
  muteOst(ost.held);
  if (ost.ready) ost.wv.loadURL(ostUrl(video, ost.list)).catch(() => {});
  // the first page: changing src again while it loads confuses YouTube, so dom-ready catches up
  else if (!ost.wv.getAttribute('src')) ost.wv.setAttribute('src', ostUrl(video, ost.list));
}

// ---- the wallpaper's own music that is not on YouTube: its audio files (played here, one after
// another, round and round) or a SoundCloud / Spotify link (their own embed player, in the panel).
// It plays and rests exactly like a lobby's song.
const MUSIC_KIND = { files: t('File nhạc trên máy'), youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };
let player = { sig: '', mine: null, audio: null, wv: null, wvSig: '', order: [], at: 0, started: false, ended: 0 };

// inside the SoundCloud / Spotify player: every sound it makes is scaled by our volume (its own
// volume control still works on top), and it says when it has played to the end
const VOLUME_HOOK = `(() => {
  if (window.__tyranMedia) return;
  const media = (window.__tyranMedia = new Set());
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  window.__tyranLevel ??= 1;
  const apply = (el) => d.set.call(el, Math.max(0, Math.min(1, (el.__tyranPage ?? 1) * window.__tyranLevel)));
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    get() { return this.__tyranPage ?? d.get.call(this); },
    set(v) { this.__tyranPage = v; apply(this); },
  });
  const seen = (el) => {
    if (media.has(el)) return;
    el.__tyranPage ??= d.get.call(el);
    media.add(el);
    el.addEventListener('playing', () => (window.__tyranEnded = false));
    el.addEventListener('ended', () => (window.__tyranEnded = true));
    apply(el);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { seen(this); return play.apply(this, arguments); };
  const scan = () => document.querySelectorAll('audio, video').forEach(seen);
  scan();
  setInterval(scan, 1000);
  window.__tyranSetLevel = (v) => { window.__tyranLevel = v; media.forEach(apply); };
  window.__tyranPlaying = () => [...media].some((m) => !m.paused && !m.ended);
  window.__tyranPause = () => media.forEach((m) => { m.__tyranWas = !m.paused; m.pause(); });
  window.__tyranResume = () => media.forEach((m) => m.__tyranWas && m.play().catch(() => {}));
})()`;

function embedOf(mine) {
  if (mine.kind === 'soundcloud') return `https://w.soundcloud.com/player/?url=${encodeURIComponent(mine.url)}&auto_play=true&hide_related=true&show_comments=false&show_reposts=false&show_teaser=false&visual=false`;
  if (mine.kind === 'spotify') return mine.url.replace('https://open.spotify.com/', 'https://open.spotify.com/embed/');
  return '';
}

function orderOf(mine) {
  const order = mine.files.map((f, i) => i);
  if (mine.shuffle) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}

function setOwnLevel() {
  const v = lobbyVolume() / 100;
  if (player.audio) player.audio.volume = v;
  if (player.wvSig && player.started) player.wv.executeJavaScript(`window.__tyranSetLevel?.(${v}); window.__tyranLevel = ${v}`).catch(() => {});
}

function stopOwn() {
  if (player.audio) {
    player.audio.pause();
    player.audio.removeAttribute('src');
    player.audio.load();
  }
  // (one SoundCloud / Spotify player, kept: taking a webview away while it loads upsets Electron)
  if (player.wv && player.wvSig) {
    player.wvSig = '';
    player.wv.src = 'about:blank';
  }
  player.started = false;
}

// mine: the music now (null: none); wanted: it should be heard now
function syncOwn(mine, wanted) {
  const sig = mine ? JSON.stringify(mine) : '';
  if (sig !== player.sig) {
    stopOwn();
    player.sig = sig;
    player.mine = mine;
    player.order = mine?.kind === 'files' ? orderOf(mine) : [];
    player.at = 0;
  }
  renderOwnFiles();
  if (!mine) return;
  if (wanted) startOwn();
  else pauseOwn();
}

// Settings → Hình nền → Đổi sảnh khi hết nhạc: when the lobby's song (its OST, or its own music
// played through once) ends, another lobby among those the choices there leave (a school, a
// student, an outfit, the favourites), the next in the list or one picked at random, each once; once all of them
// have played, from the first again (repeat), or the last one stays and its song plays on.
const played = { sig: '', keys: new Set(), done: false, last: '' };
const nextChoices = () => {
  const web = S.settings.wallpaper.web || {};
  const o = web.nextLobby || {};
  // (other choices, or another lobby picked by hand after a round ended: a new round)
  const sig = JSON.stringify([web.nextOnSongEnd, o.school, o.student, o.outfit, o.favorites, o.order, o.repeat]);
  if (sig !== played.sig || (played.done && web.model !== played.last)) Object.assign(played, { sig, keys: new Set(), done: false });
  return o;
};
const nextOnEnd = () => isLobby() && S.settings.wallpaper.web?.baMode !== 'normal' && !!S.settings.wallpaper.web?.nextOnSongEnd && !(nextChoices(), played.done);
async function nextLobby() {
  ostModels ||= await api.invoke('wallpapers:baModels').catch(() => null);
  const o = nextChoices();
  const now = S.settings.wallpaper.web.model;
  const favs = new Set(S.settings.wallpaper.web.favorites || []);
  const list = (ostModels || []).filter((m) => !m.hidden && !m.broken && (!o.school || m.school === o.school) && (!o.student || m.student === o.student) && (!o.outfit || (m.outfit || '_default') === o.outfit) && (!o.favorites || favs.has(m.key)));
  played.keys.add(now);
  let left = list.filter((m) => !played.keys.has(m.key));
  if (!left.length && o.repeat) {
    played.keys = new Set([now]);
    left = list.filter((m) => m.key !== now);
  }
  if (!left.length) {
    // (the last one stays: its song from the start, looping from now on)
    played.done = !o.repeat;
    played.last = now;
    if (ost?.ready && !own()) ost.wv.executeJavaScript("(() => { const v = document.querySelector('video'); if (v) { v.loop = true; v.currentTime = 0; v.play(); } })()").catch(() => {});
    return false;
  }
  let next = left[Math.floor(Math.random() * left.length)];
  if (o.order !== 'shuffle') {
    // the next one after this lobby in the list (around to the first), not played yet
    const i = list.findIndex((m) => m.key === now);
    for (let j = 1; j <= list.length; j++) {
      const m = list[(i + j) % list.length];
      if (!played.keys.has(m.key)) {
        next = m;
        break;
      }
    }
  }
  api.invoke('settings:set', { wallpaper: { web: { model: next.key } } });
  return true;
}
setInterval(async () => {
  if (!nextOnEnd() || !ost?.ready || !ost.video || own()) return;
  const ended = await ost.wv.executeJavaScript('(() => { const n = window.__tyranSongEnd || 0; window.__tyranSongEnd = 0; return n; })()').catch(() => 0);
  if (ended) nextLobby();
}, 1000);

function playFile(at) {
  const mine = player.mine;
  if (mine?.kind !== 'files' || !mine.files.length) return;
  player.at = (at + player.order.length) % player.order.length;
  if (!player.audio) {
    player.audio = new Audio();
    player.audio.crossOrigin = 'anonymous'; // (so its sound can be measured: TyranWeb's files allow it)
    // (the last one goes back to the first; or, its end moving on, the next lobby comes)
    player.audio.addEventListener('ended', async () => (player.at === player.order.length - 1 && nextOnEnd() && (await nextLobby())) || playFile(player.at + 1));
    player.audio.addEventListener('error', () => player.order.length > 1 && setTimeout(() => playFile(player.at + 1), 500));
    player.audio.addEventListener('play', renderOwnFiles);
    player.audio.addEventListener('pause', renderOwnFiles);
  }
  player.audio.src = mine.files[player.order[player.at]].src;
  player.audio.volume = lobbyVolume() / 100;
  player.audio.play().catch(() => {});
  player.started = true;
  renderOwnFiles();
}

function startOwn() {
  const mine = player.mine;
  if (mine.kind === 'files') {
    if (!player.started) return playFile(0);
    player.audio.volume = lobbyVolume() / 100;
    return void player.audio.play().catch(() => {});
  }
  if (player.wv && player.wvSig === player.sig) return void (player.started && player.wv.executeJavaScript('window.__tyranResume?.()').catch(() => {}));
  player.wvSig = player.sig;
  player.started = false;
  if (player.wv) return void (player.wv.src = embedOf(mine));
  const wv = document.createElement('webview');
  wv.setAttribute('partition', S.private ? 'tyran-private' : 'persist:tyran'); // (signed in to Spotify there: whole songs)
  wv.setAttribute('allowpopups', '');
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'tyran:shortcut') emit('command', { id: e.args[0] });
  });
  wv.addEventListener('dom-ready', () => {
    if (!player.wvSig || !/^https:/.test(wv.getURL())) return; // (about:blank, between songs)
    player.started = true;
    wv.executeJavaScript(VOLUME_HOOK).then(setOwnLevel, () => {});
    wv.executeJavaScript(`(${spectrumHook})()`).catch(() => {});
    // Spotify's player waits for its play button
    if (player.mine?.kind === 'spotify') setTimeout(() => wv.executeJavaScript("document.querySelector('[data-testid=\"play-pause-button\"]')?.click()").catch(() => {}), 2500);
  });
  wv.src = embedOf(mine);
  player.wv = wv;
  ost.ownView.append(wv);
}

function pauseOwn() {
  if (player.mine?.kind === 'files') player.audio?.pause();
  else if (player.wvSig && player.started) player.wv.executeJavaScript('window.__tyranPause?.()').catch(() => {});
}

function restartOwn() {
  const mine = player.mine;
  stopOwn();
  if (mine && soundOn()) startOwn();
}

// played to the end (a single SoundCloud song, the end of a set or a Spotify list): again from the top
setInterval(async () => {
  if (!player.wvSig || !player.started || !soundOn() || S.lobbyOpen === false) return (player.ended = 0);
  const ended = await player.wv.executeJavaScript('window.__tyranEnded === true && !window.__tyranPlaying()').catch(() => false);
  player.ended = ended ? player.ended + 1 : 0;
  if (player.ended >= 2) {
    player.ended = 0;
    if (!(nextOnEnd() && (await nextLobby()))) restartOwn();
  }
}, 2000);

// The spectrum bar's music, measured where it plays here: the wallpaper's own music (files, a
// SoundCloud / Spotify player, YouTube) or the lobby's song; undefined when none of it is here.
let readFiles = null;
addSpectrumSource((n) => {
  const mine = own();
  if (!mine && !(ost?.ready && ost.video)) return undefined;
  if (!soundOn() || S.lobbyOpen === false) return null;
  if (mine?.kind === 'files') return player.audio && !player.audio.paused ? (readFiles ||= spectrumHook(() => player.audio))(n) : null;
  const wv = mine && mine.kind !== 'youtube' ? (player.wvSig && player.started ? player.wv : null) : ost?.ready ? ost.wv : null;
  return wv ? wv.executeJavaScript(`window.__tyranSpectrum ? window.__tyranSpectrum(${Number(n) || 48}) : null`) : null;
}, 1);

function renderOwnFiles() {
  const box = ost?.files;
  if (!box) return;
  const mine = player.mine;
  if (mine?.kind !== 'files') return void (box.innerHTML = '');
  const playing = player.audio && !player.audio.paused;
  const current = player.order[player.at];
  box.innerHTML = '';
  box.append(
    h(
      'div',
      { class: 'own-ctl' },
      h('button', { class: 'icon-btn', title: t('Bài trước'), html: icon('chevronLeft', 16), onclick: () => playFile(player.at - 1) }),
      h('button', { class: 'icon-btn', title: playing ? t('Tạm dừng') : t('Phát'), html: icon(playing ? 'pause' : 'play', 16), onclick: () => (playing ? player.audio.pause() : player.started ? player.audio.play().catch(() => {}) : playFile(0)) }),
      h('button', { class: 'icon-btn', title: t('Bài sau'), html: icon('chevronRight', 16), onclick: () => playFile(player.at + 1) }),
      h('span', { class: 'own-mode', text: mine.shuffle ? t('Ngẫu nhiên') : t('Lần lượt') })
    ),
    ...mine.files.map((f, i) =>
      h('button', {
        class: 'own-track' + (i === current && player.started ? ' on' : ''),
        html: `${icon(i === current && playing ? 'volume' : 'music', 14)}<span>${esc(f.title)}</span>`,
        onclick: () => playFile(player.order.indexOf(i)),
      })
    )
  );
}

function syncSliders() {
  const w = S.settings.wallpaper;
  const web = w.web || {};
  for (const s of ost?.sliders || []) {
    const lobby = !!s.dataset.lobby;
    s.parentElement.hidden = lobby !== isLobby();
    const v = lobby ? web[s.dataset.key] ?? (s.dataset.key === 'volume' ? 0.6 : 1) : w.musicVolume ?? 0.6;
    if (document.activeElement !== s) s.value = String(v);
  }
}

// the song follows the lobby on the wallpaper and its sound switch, the volume follows the lobby volume
let ostKey = '';
let ostSound = false;
function lobbyMusic() {
  const wanted = soundOn() && S.lobbyOpen !== false; // (a lobby tab is open: see layout.js)
  if (wanted) ensureOst();
  if (!ost) return;
  const w = S.settings.wallpaper;
  const key = JSON.stringify([w.type, w.web?.preset, w.web?.baMode === 'normal' || w.web?.model, musicKey(w), own(), wanted]);
  if (key !== ostKey) {
    ostKey = key;
    const resume = wanted && !ostSound;
    ostSound = wanted;
    syncOst({ resume, lobbyChanged: true });
  }
  syncSliders();
  if (lobbyVolume() !== ost.vol) {
    ost.vol = lobbyVolume();
    tickOst();
    setOwnLevel();
  }
}
on('settings', lobbyMusic);
on('lobby-open', lobbyMusic);

let railKey = '';
on('settings', () => {
  const key = JSON.stringify([S.settings.webPanels, S.settings.pinnedApps, L().sidebarPosition]);
  if (key === railKey || !document.querySelector('#sidebar-rail')) return;
  railKey = key;
  renderRail();
});
