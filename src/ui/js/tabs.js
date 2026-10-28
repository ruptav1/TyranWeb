// Tabs: one <webview> per tab, inside a "pane". Handles sleeping tabs, split view,
// drag-to-reorder, closed-tab history and session saving.
import { api, h, $, emit, debounce, NEWTAB, isInternal, isNewTab, hostOf, faviconHtml, clamp } from './util.js';
import { S } from './state.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
let seq = 0;

export const T = {
  list: [],
  activeId: null,
  split: null, // { a, b, ratio }
  closed: [],
  strip: null,
};

export const byId = (id) => T.list.find((t) => t.id === id);
export const active = () => byId(T.activeId);
export const byWc = (wcId) => T.list.find((t) => t.wcId === wcId);
export const indexOf = (id) => T.list.findIndex((t) => t.id === id);

// an incognito tab (or any tab of an incognito window) browses in the private session, which keeps
// nothing: no history, no session, no saved zoom or permissions
function partition(tab) {
  return tab.incognito ? 'tyran-private' : 'persist:tyran';
}
export const hasIncognito = () => S.private || T.list.some((t) => t.incognito);

// ---------------------------------------------------------------- creation
export function createTab({ url = NEWTAB, background = false, index, pinned = false, title, favicon, sleeping = false, openerId, incognito = false, history = null } = {}) {
  const tab = {
    // (a page opened from an incognito tab is incognito too)
    incognito: !!(S.private || incognito || (openerId && byId(openerId)?.incognito)),
    id: `t${++seq}`,
    url,
    title: title || (isNewTab(url) ? t('Tab mới') : url),
    favicon: favicon || '',
    loading: false,
    canBack: false,
    canFwd: false,
    pinned,
    muted: false,
    audible: false,
    sleeping: true,
    ready: false,
    wcId: null,
    zoom: 1,
    blocked: 0,
    error: null,
    lastActive: Date.now(),
    openerId,
    history: null, // (its back/forward list while it has no page: asleep, or not yet woken)
    historyToken: null,
  };
  if (history) keepHistory(tab, history);
  if (index === undefined) {
    const cur = indexOf(T.activeId);
    if (S.settings.general.newTabPosition === 'afterActive' && cur >= 0 && !pinned) {
      let i = cur + 1;
      // keep tabs opened from the same page together, like Chrome
      while (openerId && T.list[i] && T.list[i].openerId === openerId) i++;
      index = i;
    } else index = T.list.length;
  }
  if (!pinned) index = Math.max(index, T.list.filter((t) => t.pinned).length);
  T.list.splice(index, 0, tab);
  if (!sleeping) mount(tab);
  renderStrip();
  if (!background) activate(tab.id);
  saveSession();
  emit('tabs:changed');
  return tab;
}

function mount(tab) {
  if (tab.pane) return;
  tab.sleeping = false;
  tab.ready = false;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', partition(tab));
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
  // (a tab with a history kept opens on it, back and forward included: main/tabhistory.js)
  const url = tab.url || NEWTAB;
  wv.setAttribute('src', tab.historyToken ? `about:blank#tyran-history=${tab.historyToken}|${encodeURIComponent(url)}` : url);
  tab.historyToken = null;
  const pane = h('div', { class: 'pane', dataset: { id: tab.id } }, wv);
  pane.classList.toggle('internal', isInternal(tab.url));
  tab.pane = pane;
  tab.webview = wv;
  wire(tab, wv);
  $('#views').append(pane);
}

async function unmount(tab) {
  if (!tab.pane) return;
  const history = await snapshot(tab);
  // (shown, closed or already asleep meanwhile)
  if (!tab.pane || !byId(tab.id) || tab.id === T.activeId || inVisibleSplit(tab)) return;
  if (history) keepHistory(tab, history);
  tab.pane.remove();
  tab.pane = null;
  tab.webview = null;
  tab.ready = false;
  tab.wcId = null;
  tab.sleeping = true;
  tab.loading = false;
  tab.audible = false;
  renderTab(tab);
}

// ---------------------------------------------------------------- back/forward lists
let stashSeq = 0;
const stashBase = Math.random().toString(36).slice(2, 10);

// the tab keeps `history` until it has a page again, which is then opened on it
function keepHistory(tab, history) {
  tab.history = history;
  tab.historyToken = `${stashBase}-${++stashSeq}`;
  api.invoke('tabs:stash', tab.historyToken, history).catch(() => {});
}

// its back/forward list as the page has it now (or the one it keeps while it has none)
function snapshot(tab) {
  if (!tab.ready || !tab.wcId) return Promise.resolve(tab.history);
  const late = new Promise((ok) => setTimeout(() => ok(null), 1500));
  return Promise.race([api.invoke('tabs:history', tab.wcId).catch(() => null), late]);
}

// ---------------------------------------------------------------- webview events
function wire(tab, wv) {
  const update = () => {
    renderTab(tab);
    if (tab.id === T.activeId || inVisibleSplit(tab)) emit('tab:update', tab);
    emit('tabs:changed'); // (any tab, e.g. one in the background leaving the new tab page)
  };

  wv.addEventListener('dom-ready', () => {
    if (!tab.ready) {
      tab.ready = true;
      tab.history = null; // (its page has it now)
      tab.wcId = wv.getWebContentsId();
      if (tab.muted) wv.setAudioMuted(true);
    }
    applyZoom(tab);
    syncNav(tab);
    update();
  });

  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    tab.error = null;
    tab.pane?.querySelector('.pane-overlay')?.remove();
    update();
  });

  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    syncNav(tab);
    update();
  });

  wv.addEventListener('did-navigate', (e) => {
    if (hostOf(e.url) !== hostOf(tab.url) || isInternal(e.url)) tab.favicon = '';
    tab.url = e.url;
    tab.blocked = 0;
    tab.pane?.classList.toggle('internal', isInternal(e.url));
    syncNav(tab);
    applyZoom(tab);
    if (!tab.incognito) api.invoke('history:add', { url: e.url, favicon: tab.favicon });
    update();
    saveSession();
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    if (!e.isMainFrame) return;
    tab.url = e.url;
    syncNav(tab);
    if (!tab.incognito) api.invoke('history:add', { url: e.url, title: tab.title });
    update();
    saveSession();
  });

  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || tab.url;
    if (!tab.incognito) api.invoke('history:update', { url: tab.url, title: tab.title });
    update();
    saveSession();
  });

  wv.addEventListener('page-favicon-updated', (e) => {
    const icon = (e.favicons || []).find((f) => /^(https?:|data:image\/)/.test(f));
    if (!icon || isInternal(tab.url)) return;
    tab.favicon = icon;
    if (!tab.incognito) api.invoke('history:update', { url: tab.url, favicon: icon });
    update();
    saveSession();
  });

  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return;
    tab.loading = false;
    tab.error = { code: e.errorCode, desc: e.errorDescription, url: e.validatedURL };
    tab.url = e.validatedURL || tab.url;
    tab.title = hostOf(tab.url) || tab.url;
    tab.favicon = '';
    showError(tab);
    update();
  });

  wv.addEventListener('render-process-gone', () => {
    tab.loading = false;
    tab.error = { code: 'crash', desc: t('Trang đã bị dừng đột ngột'), url: tab.url };
    showError(tab);
    update();
  });

  wv.addEventListener('update-target-url', (e) => emit('status', { tab, url: e.url }));
  wv.addEventListener('found-in-page', (e) => emit('find:result', { tab, result: e.result }));
  wv.addEventListener('enter-html-full-screen', () => emit('html-fullscreen', true));
  wv.addEventListener('leave-html-full-screen', () => emit('html-fullscreen', false));
  // muted videos also "play media": ask Chromium whether sound is actually coming out
  const checkAudible = () => {
    for (const ms of [400, 1500]) {
      setTimeout(() => {
        if (!tab.ready || !tab.webview) return;
        const audible = tab.webview.isCurrentlyAudible();
        if (audible !== tab.audible) {
          tab.audible = audible;
          update();
        }
      }, ms);
    }
  };
  wv.addEventListener('media-started-playing', checkAudible);
  wv.addEventListener('media-paused', checkAudible);
  wv.addEventListener('context-menu', (e) => emit('context-menu', { tab, params: e.params }));
  wv.addEventListener('close', () => closeTab(tab.id));
  wv.addEventListener('focus', () => {
    if (T.split && inVisibleSplit(tab) && T.activeId !== tab.id) activate(tab.id, { focus: false });
  });
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'tyran:shortcut') emit('command', { id: e.args[0], tab });
    if (e.channel === 'tyran:host') emit('host-message', { tab, ...e.args[0] });
  });
}

function syncNav(tab) {
  const wv = tab.webview;
  if (!wv || !tab.ready) return;
  try {
    tab.canBack = wv.canGoBack();
    tab.canFwd = wv.canGoForward();
  } catch {
    /* not attached yet */
  }
}

// ---------------------------------------------------------------- error overlay
const KAOMOJI = ['(´・ω・`)', '(・_・;)', '(；一_一)', '(╥﹏╥)', '(⊙_⊙)？', '¯\\_(ツ)_/¯'];
function errorText(err) {
  const c = err.code;
  if (c === 'crash') return [t('Trang bị crash rồi'), t('Tiến trình hiển thị trang đã dừng. Thử tải lại nhé.')];
  if (c === -105 || c === -137) return [t('Không tìm thấy trang'), t('Không phân giải được tên miền. Kiểm tra lại địa chỉ hoặc kết nối mạng.')];
  if (c === -106) return [t('Bạn đang ngoại tuyến'), t('Hãy kiểm tra kết nối Internet rồi thử lại.')];
  if (c === -102 || c === -7 || c === -118) return [t('Không kết nối được'), t('Máy chủ không phản hồi hoặc từ chối kết nối.')];
  if (c <= -200 && c > -300) return [t('Kết nối không an toàn'), t('Chứng chỉ bảo mật của trang này không hợp lệ, TyranWeb đã chặn để bảo vệ bạn.')];
  if (c === -20 || c === -21) return [t('Trang bị chặn'), t('Trang này đã bị chặn.')];
  return [t('Không tải được trang'), err.desc || t('Đã xảy ra lỗi khi tải trang.')];
}

function showError(tab) {
  if (!tab.pane || !tab.error) return;
  tab.pane.querySelector('.pane-overlay')?.remove();
  const [title, desc] = errorText(tab.error);
  const face = KAOMOJI[Math.abs(String(tab.error.code).length + (tab.error.url || '').length) % KAOMOJI.length];
  const box = h(
    'div',
    { class: 'pane-overlay' },
    h(
      'div',
      { class: 'error-card' },
      h('div', { class: 'error-face', text: face }),
      h('h2', { text: title }),
      h('p', { class: 'muted', text: desc }),
      h('code', { class: 'error-url', text: `${tab.error.url || ''}  ·  ${tab.error.code}` }),
      h(
        'div',
        { class: 'error-actions' },
        h('button', { class: 'btn primary', html: t('{0} Thử lại', icon('reload', 15)), onclick: () => reload(tab.id) }),
        tab.canBack ? h('button', { class: 'btn', html: t('{0} Quay lại', icon('back', 15)), onclick: () => goBack(tab.id) }) : null
      )
    )
  );
  tab.pane.append(box);
  // HTTPS-only asked for this page over https:// in vain: it can still be opened over http://
  const url = tab.error.url;
  api.invoke('privacy:httpUrl', url).then((http) => {
    if (!http || !box.isConnected) return;
    const open = h('button', { class: 'btn', html: t('{0} Mở bằng HTTP (không an toàn)', icon('warn', 15)) });
    open.addEventListener('click', async () => {
      await api.invoke('privacy:allowHttp', url);
      navigate(tab.id, http);
    });
    box.querySelector('.error-actions').append(open);
  }, () => {});
}

// ---------------------------------------------------------------- activation & visibility
export function inVisibleSplit(tab) {
  const s = T.split;
  return !!s && (s.a === tab.id || s.b === tab.id) && (T.activeId === s.a || T.activeId === s.b);
}

export function activate(id, { focus = true } = {}) {
  const tab = byId(id);
  if (!tab) return;
  const prev = active();
  if (prev && prev !== tab) prev.lastActive = Date.now();
  T.activeId = id;
  tab.lastActive = Date.now();
  if (tab.sleeping) mount(tab);
  layoutPanes();
  renderStrip();
  revealActive();
  document.documentElement.classList.toggle('incognito-tab', !!tab.incognito && !S.private);
  emit('active', tab);
  if (focus) focusTab(tab);
  saveSession();
}

export function focusTab(tab = active()) {
  if (!tab) return;
  if (isNewTab(tab.url)) emit('focus-omnibox');
  else requestAnimationFrame(() => tab.webview?.focus());
}

export function layoutPanes() {
  const views = $('#views');
  const s = T.split;
  const splitOn = s && (T.activeId === s.a || T.activeId === s.b) && byId(s.a) && byId(s.b);
  views.classList.toggle('split', !!splitOn);
  for (const t of T.list) {
    if (!t.pane) continue;
    const visible = t.id === T.activeId || (splitOn && (t.id === s.a || t.id === s.b));
    t.pane.classList.toggle('visible', !!visible);
    t.pane.classList.toggle('focused', !!splitOn && t.id === T.activeId);
    t.pane.style.order = '';
    t.pane.style.flexBasis = '';
  }
  if (splitOn) {
    const [left, right] = indexOf(s.a) < indexOf(s.b) ? [byId(s.a), byId(s.b)] : [byId(s.b), byId(s.a)];
    for (const t of [left, right]) if (t.sleeping) mount(t);
    left.pane.style.order = '1';
    right.pane.style.order = '3';
    left.pane.style.flexBasis = `${s.ratio * 100}%`;
    right.pane.style.flexBasis = `${(1 - s.ratio) * 100}%`;
    let divider = $('#split-divider');
    if (!divider) {
      divider = h('div', { id: 'split-divider' });
      divider.addEventListener('pointerdown', startSplitDrag);
      views.append(divider);
    }
    divider.style.order = '2';
  } else {
    $('#split-divider')?.remove();
  }
}

function startSplitDrag(e) {
  const views = $('#views');
  const rect = views.getBoundingClientRect();
  views.classList.add('resizing');
  const move = (ev) => {
    T.split.ratio = clamp((ev.clientX - rect.left) / rect.width, 0.2, 0.8);
    layoutPanes();
  };
  const up = () => {
    views.classList.remove('resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function toggleSplit() {
  const cur = active();
  if (!cur) return;
  if (T.split && (T.split.a === cur.id || T.split.b === cur.id)) {
    T.split = null;
    layoutPanes();
    renderStrip();
    return;
  }
  let partner = T.list[indexOf(cur.id) + 1] || T.list[indexOf(cur.id) - 1];
  if (!partner) partner = createTab({ url: NEWTAB, background: true });
  T.split = { a: cur.id, b: partner.id, ratio: 0.5 };
  activate(cur.id);
}

export function splitWith(id) {
  const cur = active();
  if (!cur || cur.id === id) return;
  T.split = { a: cur.id, b: id, ratio: 0.5 };
  activate(cur.id);
}

// ---------------------------------------------------------------- closing
export function closeTab(id, { force = false } = {}) {
  const i = indexOf(id);
  if (i < 0) return;
  const tab = T.list[i];
  if (tab.pinned && !force && T.list.length > 1 && id !== T.activeId) return;
  const kept = !isNewTab(tab.url) && { id: `c${Date.now().toString(36)}${stashBase}${++seq}`, url: tab.url, title: tab.title, favicon: tab.favicon, index: i, pinned: tab.pinned, incognito: tab.incognito, history: null };
  if (kept) {
    T.closed.push(kept);
    T.closed.splice(0, Math.max(0, T.closed.length - 25));
  }
  if (T.split && (T.split.a === id || T.split.b === id)) T.split = null;
  // its page goes out of sight and quiet at once, and away once its back/forward list is read
  const pane = tab.pane;
  if (pane) {
    pane.classList.remove('visible', 'focused');
    try {
      if (tab.ready) tab.webview.setAudioMuted(true);
    } catch {
      /* not attached */
    }
  }
  snapshot(tab).then((history) => {
    pane?.remove();
    if (!kept) return;
    kept.history = history;
    // (kept after a restart too; an incognito tab never)
    if (!kept.incognito) api.invoke('closed:add', kept).catch(() => {});
  });
  T.list.splice(i, 1);
  emit('tab:closed', tab);
  emit('tabs:changed');
  // closing the last tab keeps the window (and the app) open on a fresh new tab
  if (!T.list.length) {
    createTab();
    return;
  }
  if (T.activeId === id) {
    const opener = tab.openerId && byId(tab.openerId);
    const next = T.list[i] && T.list[i].openerId === tab.openerId && tab.openerId ? T.list[i] : opener || T.list[Math.min(i, T.list.length - 1)];
    activate(next.id);
  } else {
    layoutPanes();
    renderStrip();
  }
  saveSession();
}

export function closeOthers(id) {
  for (const t of [...T.list]) if (t.id !== id && !t.pinned) closeTab(t.id, { force: true });
}

export function closeRight(id) {
  const i = indexOf(id);
  for (const t of T.list.slice(i + 1)) if (!t.pinned) closeTab(t.id, { force: true });
}

export function reopenClosed() {
  const c = T.closed.pop();
  if (!c) return null;
  if (!c.incognito) api.invoke('closed:remove', c.id).catch(() => {});
  return createTab({ url: c.url, title: c.title, favicon: c.favicon, index: Math.min(c.index, T.list.length), pinned: c.pinned, incognito: c.incognito, history: c.history });
}

// ---------------------------------------------------------------- tab ops
export function navigate(id, url) {
  const tab = byId(id);
  if (!tab) return;
  tab.url = url;
  tab.error = null;
  if (tab.sleeping) {
    mount(tab);
    layoutPanes();
  } else {
    tab.webview.loadURL(url).catch(() => {});
  }
  renderTab(tab);
  emit('tab:update', tab);
}

const ready = (id) => {
  const t = byId(id);
  return t && t.ready && t.webview ? t : null;
};

export function goBack(id = T.activeId) {
  const t = ready(id);
  if (t?.webview.canGoBack()) t.webview.goBack();
}
export function goForward(id = T.activeId) {
  const t = ready(id);
  if (t?.webview.canGoForward()) t.webview.goForward();
}
export function reload(id = T.activeId, hard = false) {
  const t = byId(id);
  if (!t) return;
  if (t.sleeping) return activate(id);
  if (!t.ready) return;
  t.error = null;
  t.pane?.querySelector('.pane-overlay')?.remove();
  hard ? t.webview.reloadIgnoringCache() : t.webview.reload();
}
export function stop(id = T.activeId) {
  ready(id)?.webview.stop();
}

// (with its back/forward list, as in Chrome)
export async function duplicate(id = T.activeId) {
  const t = byId(id);
  if (!t) return;
  const history = await snapshot(t);
  createTab({ url: t.url, title: t.title, favicon: t.favicon, index: indexOf(id) + 1, incognito: t.incognito, history });
}

export function togglePin(id = T.activeId) {
  const t = byId(id);
  if (!t) return;
  t.pinned = !t.pinned;
  T.list.splice(indexOf(id), 1);
  // pinned tabs live at the front: pinning appends to that group, unpinning lands right after it
  T.list.splice(T.list.filter((x) => x.pinned).length, 0, t);
  renderStrip();
  saveSession();
}

export function toggleMute(id = T.activeId) {
  const t = byId(id);
  if (!t) return;
  t.muted = !t.muted;
  if (t.ready) t.webview.setAudioMuted(t.muted);
  renderTab(t);
  emit('tab:update', t);
}

export function sleepTab(id) {
  const t = byId(id);
  if (!t || t.id === T.activeId || inVisibleSplit(t)) return;
  unmount(t);
}

export function moveTab(id, toIndex) {
  const from = indexOf(id);
  if (from < 0) return;
  const [t] = T.list.splice(from, 1);
  const pinnedCount = T.list.filter((x) => x.pinned).length;
  toIndex = t.pinned ? clamp(toIndex, 0, pinnedCount) : clamp(toIndex, pinnedCount, T.list.length);
  T.list.splice(toIndex, 0, t);
  renderStrip();
  layoutPanes();
  saveSession();
}

// ---------------------------------------------------------------- zoom
function zoomKey(tab) {
  return isInternal(tab.url) ? null : hostOf(tab.url);
}

function applyZoom(tab) {
  if (!tab.ready) return;
  const key = zoomKey(tab);
  const f = (key && S.settings.zoom[key]) || 1;
  tab.zoom = f;
  try {
    tab.webview.setZoomFactor(f);
  } catch {
    /* ignore */
  }
}

export function zoom(dir, id = T.activeId) {
  const t = ready(id);
  if (!t) return;
  let f = t.zoom || 1;
  if (dir === 0) f = 1;
  else {
    const i = ZOOM_STEPS.findIndex((z) => z >= f - 0.001);
    const next = dir > 0 ? ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS[i] > f + 0.001 ? i : i + 1)] : ZOOM_STEPS[Math.max(0, i - 1)];
    f = next;
  }
  t.zoom = f;
  t.webview.setZoomFactor(f);
  const key = zoomKey(t);
  if (key && !t.incognito) {
    S.settings.zoom[key] = f;
    api.invoke('settings:set', { zoom: { [key]: f } });
  }
  // keep other tabs on the same site in sync
  for (const o of T.list) if (o !== t && o.ready && zoomKey(o) === key) applyZoom(o);
  emit('tab:update', t);
  emit('zoom', t);
}

// ---------------------------------------------------------------- sleeping tabs
// (Settings → Chung → Cho tab ngủ sau; never the tab shown, a pinned one, or one playing sound)
setInterval(() => {
  const mins = S.settings?.general.tabSleepMinutes || 0;
  if (!mins) return;
  const limit = Date.now() - mins * 60000;
  for (const t of T.list) {
    if (t.sleeping || t.pinned || t.id === T.activeId || inVisibleSplit(t) || t.audible || t.lastActive > limit) continue;
    if (isNewTab(t.url)) continue;
    unmount(t);
  }
}, 60000);

// ---------------------------------------------------------------- session
export const saveSession = debounce(() => {
  if (S.private) return;
  const kept = T.list.filter((t) => !t.incognito); // (incognito tabs are never restored)
  // (an open tab's back/forward list is read from its page, a sleeping one sends the one it keeps)
  const tabs = kept.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, wcId: t.ready ? t.wcId : null, history: t.ready ? null : t.history }));
  if (tabs.length) api.invoke('session:update', tabs, Math.max(0, kept.indexOf(active())));
}, 600);

// ---------------------------------------------------------------- tab strip
export function mountStrip(container) {
  if (!T.strip) {
    T.strip = h('div', { id: 'tabstrip' }, h('div', { class: 'tabs-scroll' }), h('button', { class: 'icon-btn newtab-btn', title: t('Tab mới (Ctrl+T) · chuột phải: tab ẩn danh'), html: icon('plus', 17), onclick: () => createTab(), oncontextmenu: (e) => (e.preventDefault(), emit('newtab-menu', { x: e.clientX, y: e.clientY })) }));
    wireStrip(T.strip);
  }
  container.append(T.strip);
  renderStrip();
}

export function renderStrip() {
  if (!T.strip) return;
  const scroll = T.strip.querySelector('.tabs-scroll');
  const seen = new Set();
  let prev = null;
  for (const t of T.list) {
    let el = scroll.querySelector(`.tab[data-id="${t.id}"]`);
    if (!el) el = buildTab(t);
    renderTab(t, el);
    const want = prev ? prev.nextSibling : scroll.firstChild;
    if (want !== el) scroll.insertBefore(el, want);
    prev = el;
    seen.add(t.id);
  }
  for (const el of [...scroll.children]) if (!seen.has(el.dataset.id)) el.remove();
  // very many tabs: icons only (like Chrome)
  const unpinned = T.list.filter((t) => !t.pinned).length;
  const room = T.strip.getBoundingClientRect().width - T.list.filter((t) => t.pinned).length * 45 - 40;
  T.strip.classList.toggle('narrow', unpinned > 0 && room / unpinned < 84);
}

function revealActive() {
  T.strip?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function buildTab(tab) {
  const el = h(
    'div',
    { class: 'tab', dataset: { id: tab.id }, draggable: 'true', role: 'tab' },
    h('span', { class: 'tab-icon' }),
    h('span', { class: 'tab-incog', title: t('Tab ẩn danh'), html: icon('incognito', 13) }),
    h('span', { class: 'tab-title' }),
    h('button', { class: 'tab-audio', tabindex: '-1' }),
    h('button', { class: 'tab-close', tabindex: '-1', title: t('Đóng tab (Ctrl+W)'), html: icon('x', 13) })
  );
  return el;
}

export function renderTab(tab, el = T.strip?.querySelector(`.tab[data-id="${tab.id}"]`)) {
  if (!el) return;
  const s = T.split;
  const inSplit = s && (s.a === tab.id || s.b === tab.id);
  el.classList.toggle('active', tab.id === T.activeId);
  el.classList.toggle('pinned', !!tab.pinned);
  el.classList.toggle('incognito', !!tab.incognito && !S.private);
  el.classList.toggle('sleeping', !!tab.sleeping);
  el.classList.toggle('loading', !!tab.loading);
  el.classList.toggle('in-split', !!inSplit);
  el.classList.toggle('split-visible', !!inSplit && inVisibleSplit(tab));
  el.title = `${tab.title}\n${tab.url}${tab.sleeping ? t('\n(đang ngủ — bấm để đánh thức)') : ''}`;
  const iconBox = el.querySelector('.tab-icon');
  const iconKey = tab.loading ? 'loading' : `${tab.favicon}|${tab.title}`;
  if (iconBox.dataset.key !== iconKey) {
    iconBox.dataset.key = iconKey;
    iconBox.innerHTML = tab.loading
      ? '<span class="spinner"></span>'
      : isInternal(tab.url)
        ? '<img class="favicon" src="tyran://shared/logo.svg" alt="">'
        : faviconHtml(tab.favicon, tab.title, tab.url);
  }
  const title = el.querySelector('.tab-title');
  if (title.textContent !== tab.title) title.textContent = tab.title;
  const audio = el.querySelector('.tab-audio');
  const showAudio = tab.audible || tab.muted;
  audio.hidden = !showAudio;
  if (showAudio) audio.innerHTML = icon(tab.muted ? 'muted' : 'volume', 13);
}

function wireStrip(strip) {
  const scroll = strip.querySelector('.tabs-scroll');
  scroll.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    if (e.button === 1) {
      e.preventDefault();
      closeTab(el.dataset.id, { force: true });
    } else if (e.button === 0 && !e.target.closest('.tab-close, .tab-audio')) {
      activate(el.dataset.id);
    }
  });
  scroll.addEventListener('click', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    if (e.target.closest('.tab-close')) closeTab(el.dataset.id, { force: true });
    else if (e.target.closest('.tab-audio')) toggleMute(el.dataset.id);
  });
  scroll.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tab')) createTab();
  });
  scroll.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    e.preventDefault();
    emit('tab-menu', { tab: byId(el.dataset.id), x: e.clientX, y: e.clientY });
  });
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (strip.classList.contains('vertical')) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        scroll.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // drag & drop reordering (and dropping links to open them)
  let dragId = null;
  const clearMarks = () => scroll.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  scroll.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    dragId = el.dataset.id;
    const t = byId(dragId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/uri-list', t.url);
    e.dataTransfer.setData('text/plain', t.url);
    el.classList.add('dragging');
  });
  scroll.addEventListener('dragend', (e) => {
    e.target.closest?.('.tab')?.classList.remove('dragging');
    dragId = null;
    clearMarks();
  });
  scroll.addEventListener('dragover', (e) => {
    e.preventDefault();
    clearMarks();
    const el = e.target.closest('.tab');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vertical = strip.classList.contains('vertical');
    const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  scroll.addEventListener('dragleave', (e) => {
    if (!scroll.contains(e.relatedTarget)) clearMarks();
  });
  scroll.addEventListener('drop', (e) => {
    e.preventDefault();
    const el = e.target.closest('.tab');
    const after = el?.classList.contains('drop-after');
    clearMarks();
    let target = el ? indexOf(el.dataset.id) + (after ? 1 : 0) : T.list.length;
    if (dragId) {
      if (indexOf(dragId) < target) target--;
      moveTab(dragId, target);
    } else {
      const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
      if (/^https?:\/\//i.test(url)) createTab({ url, index: target });
    }
  });
}
