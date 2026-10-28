// Browser shell bootstrap: wires settings, tabs, toolbar, sidebar and main-process events.
import { api, $, on, emit, installFaviconFallback, NEWTAB } from './util.js';
import { S } from './state.js';
import { cursorKit } from 'tyran://shared/cursor.js';
import * as tabs from './tabs.js';
import { T, createTab, byWc } from './tabs.js';
import { applyAll, applyLayout, applyWallpaper, applyCustomCSS, updateCaption, brandHtml, updateWindowTitle, look } from './layout.js';
import { buildToolbar, renderToolbar, syncToolbar } from './toolbar.js';
import { loadBookmarks, bookmarkPopover } from './bookmarks.js';
import { initDownloads } from './downloads.js';
import { initSidebar } from './sidebar.js';
import { initVisualizer } from './visualizer.js';
import { CHOSEN, translateDom } from 'tyran://shared/i18n.js';
import { welcome } from './welcome.js';
import { loadExtensions } from './extensions.js';
import { initKeyboard, rebuildKeymap } from './commands.js';
import { initPrompts, siteInfo } from './prompts.js';
import { updateMotion } from './wallpaper.js';
import { applyTheme } from 'tyran://shared/theme.js';
import { hydrateIcons } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';
import { toast } from './menus.js';

async function boot() {
  performance.mark('tyran:modules'); // (the timings TYRAN_TIMING lines up)
  const init = await api.invoke('win:init');
  performance.mark('tyran:init');
  S.winId = init.winId;
  S.private = init.private;
  S.settings = init.settings;
  S.shortcuts = init.shortcuts;
  S.engines = init.engines;
  S.window = init.state;

  // the first start: the language before anything else (welcome.js); then the window as it is
  if (!CHOSEN) {
    applyTheme(S.settings);
    applyWallpaper();
    return welcome();
  }
  translateDom(document);

  installFaviconFallback();
  hydrateIcons(document);
  $('#brand').innerHTML = brandHtml();
  document.body.classList.toggle('maximized', S.window.maximized);

  tabs.mountStrip($('#slot-topbar'));
  $('#slot-toolbar-top').append(buildToolbar());
  applyAll();
  initKeyboard();
  initDownloads();
  initPrompts();
  initSidebar();
  initVisualizer();
  loadExtensions();
  await loadBookmarks();
  wireVerticalTabsHeader();
  wireEvents();

  const restore = init.restore;
  if (restore?.tabs?.length) {
    restore.tabs.forEach((t, i) =>
      createTab({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, background: true, sleeping: i !== restore.active, index: i, history: t.history })
    );
    const target = T.list[Math.min(restore.active, T.list.length - 1)];
    if (target) tabs.activate(target.id);
  }
  T.closed.push(...(init.closed || [])); // (closed before TyranWeb last quit)
  if (init.url) createTab({ url: init.url });
  if (!T.list.length) {
    const g = S.settings.general;
    createTab({ url: g.startup === 'home' && g.homepage ? g.homepage : NEWTAB });
  }
  updateWindowTitle();
  document.body.classList.add('ready');
  performance.mark('tyran:ready');
}

function wireVerticalTabsHeader() {
  $('#vtabs-collapse').addEventListener('click', () => {
    api.invoke('settings:set', { layout: { verticalTabsCollapsed: !S.settings.layout.verticalTabsCollapsed } });
  });
  $('#vtabs-new').addEventListener('click', () => createTab());
  $('#vtabs-new').addEventListener('contextmenu', (e) => (e.preventDefault(), emit('newtab-menu', { x: e.clientX, y: e.clientY })));
}

function wireEvents() {
  // a newer TyranWeb on GitHub (main/updates.js): said once per version, updated from Settings → Giới thiệu
  const told = new Set();
  api.on('update:state', (u) => {
    if (u.stage !== 'available' || told.has(u.latest)) return;
    told.add(u.latest);
    toast(t('Có bản TyranWeb {0} mới', u.latest), { icon: 'download', timeout: 12000, action: { label: t('Xem'), run: () => createTab({ url: 'tyran://settings/#about' }) } });
  });
  api.on('settings:changed', (s) => {
    const prevLayout = JSON.stringify(S.settings.layout);
    // appearance values that the layout reads (data-chrome, data-tab-style, caption colour)
    const looks = (a) => [a.density, a.text, a.chromeStyle, a.tabStyle].join('|');
    const prevLooks = looks(S.settings.appearance);
    S.settings = s;
    applyTheme(look(s));
    applyCustomCSS();
    applyWallpaper();
    if (JSON.stringify(s.layout) !== prevLayout || looks(s.appearance) !== prevLooks) applyLayout();
    emit('settings', s);
  });
  api.on('shortcuts:changed', (sc) => {
    S.shortcuts = sc;
    rebuildKeymap();
    renderToolbar(true);
  });
  api.on('bookmarks:changed', (d) => emit('bookmarks:changed', d));
  api.on('closed:cleared', () => (T.closed.length = 0)); // (with the history)
  api.on('tab:open', ({ url, background, openerWcId }) => {
    if (!url) return createTab();
    createTab({ url, background, openerId: byWc(openerWcId)?.id });
  });
  // the mouse cursor of Settings → Giao diện, in the window itself too
  const applyCursor = cursorKit(document, true);
  api.invoke('guest:cursor').then(applyCursor, () => {});
  api.on('cursor:changed', applyCursor);
  api.on('win:state', (st) => {
    S.window = st;
    document.body.classList.toggle('maximized', st.maximized);
    document.body.classList.toggle('fullscreen', st.fullscreen);
    document.body.classList.toggle('blurred', !st.focused);
    updateCaption();
    updateMotion();
  });

  let enteredFullscreen = false;
  on('html-fullscreen', (onFs) => {
    S.htmlFullscreen = onFs;
    document.body.classList.toggle('html-fs', onFs);
    if (onFs && !S.window.fullscreen) {
      enteredFullscreen = true;
      api.invoke('win:action', 'fullscreen');
    } else if (!onFs && enteredFullscreen) {
      enteredFullscreen = false;
      api.invoke('win:action', 'leaveFullscreen');
    }
  });

  const status = $('#status');
  let hideTimer;
  on('status', ({ tab, url }) => {
    if (tab.id !== T.activeId || !S.settings.layout.showStatusBubble) return;
    clearTimeout(hideTimer);
    if (url) {
      status.textContent = url;
      status.classList.add('show');
    } else hideTimer = setTimeout(() => status.classList.remove('show'), 250);
  });
  on('active', () => status.classList.remove('show'));

  on('bookmark-popover', (anchor) => bookmarkPopover(anchor));
  on('site-info', (anchor) => siteInfo(anchor));
  on('layout-changed', () => {
    applyLayout();
    syncToolbar();
  });

  // Zen mode: reveal the chrome when the pointer touches the top edge.
  const hot = $('#zen-hot');
  hot.addEventListener('pointerenter', () => document.body.classList.add('zen-peek'));
  $('#chrome-top').addEventListener('pointerleave', () => document.body.classList.remove('zen-peek'));

  window.addEventListener('resize', () => tabs.renderStrip());
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:24px;color:#c33">${t('TyranWeb không khởi động được:\n')}${String(err?.stack || err)}</pre>`;
});
