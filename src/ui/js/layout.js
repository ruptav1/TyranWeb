// Applies theme, wallpaper and layout settings to the shell.
import { api, $, on, emit, NEWTAB, isNewTab } from './util.js';
import { S } from './state.js';
import { T, active } from './tabs.js';
import { applyTheme, densityOf, colorsOf } from 'tyran://shared/theme.js';
import { applyWallpaper } from './wallpaper.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

const CAPTION_W = 140;

// The see-through (liquid) chrome belongs with the lobby: while no tab shows the new tab page and
// Lobby mode is off, the bars fall back to frosted glass (the saved choice stays as it is).
export function look(s = S.settings) {
  if (S.lobbyOpen !== false || s.appearance.chromeStyle !== 'clear') return s;
  return { ...s, appearance: { ...s.appearance, chromeStyle: 'glass' } };
}

// whether a lobby is open: some tab on the new tab page, or Lobby mode (the lobby music follows it)
function updateLobbyOpen() {
  const open = !!S.lobby || T.list.some((t) => (t.url || '').startsWith(NEWTAB));
  if (open === S.lobbyOpen) return;
  S.lobbyOpen = open;
  applyTheme(look());
  applyLayout();
  emit('lobby-open', open);
}
on('tabs:changed', updateLobbyOpen);
on('active', updateLobbyOpen);
on('lobby-mode', updateLobbyOpen);

export function applyAll() {
  applyTheme(look());
  applyCustomCSS();
  applyWallpaper();
  applyLayout();
}

export { applyWallpaper, nextWallpaper } from './wallpaper.js';

export function applyCustomCSS() {
  $('#user-css').textContent = S.settings.appearance.customCSS || '';
}

// ---------------------------------------------------------------- layout
export function applyLayout() {
  const L = S.settings.layout;
  const A = S.settings.appearance;
  const app = $('#app');
  const vertical = L.tabsPosition !== 'top';
  app.dataset.tabs = L.tabsPosition;
  app.dataset.toolbar = L.toolbarPosition;
  app.dataset.sidebar = L.sidebarPosition;
  app.dataset.chrome = look().appearance.chromeStyle;
  app.dataset.tabStyle = A.tabStyle;
  app.dataset.close = L.tabCloseButton;
  app.classList.toggle('sidebar-open', !!L.sidebarOpen);
  app.classList.toggle('vtabs-collapsed', vertical && !!L.verticalTabsCollapsed);
  showBookmarksBar();
  app.dataset.bm = A.clearBookmarks === false ? 'frosted' : 'clear'; // (the bookmarks bar out of liquid glass)
  app.classList.toggle('content-shadow', !!L.contentShadow);
  app.classList.toggle('private', S.private);

  const strip = T.strip;
  const toolbar = $('#toolbar');
  const topSlot = $('#slot-topbar');
  const title = $('#window-title');
  if (vertical) {
    strip.classList.add('vertical');
    $('#vtabs-list').append(strip);
    if (L.toolbarPosition === 'top') {
      topSlot.append(toolbar);
      title.hidden = true;
    } else {
      $('#slot-toolbar-bottom').append(toolbar);
      title.hidden = false;
    }
  } else {
    strip.classList.remove('vertical');
    topSlot.append(strip);
    title.hidden = true;
    $(L.toolbarPosition === 'top' ? '#slot-toolbar-top' : '#slot-toolbar-bottom').append(toolbar);
  }
  app.classList.toggle('topbar-toolbar', vertical && L.toolbarPosition === 'top');
  updateCaption();
}

// Native min/max/close buttons are drawn by Windows on top of our top bar.
export function updateCaption() {
  const L = S.settings.layout;
  const d = densityOf(S.settings);
  const vertical = L.tabsPosition !== 'top';
  const height = vertical && L.toolbarPosition === 'top' ? d.toolbar : d.topbar;
  document.documentElement.style.setProperty('--caption-w', S.window.fullscreen ? '0px' : `${CAPTION_W}px`);
  document.documentElement.style.setProperty('--topbar-real-h', `${height}px`);
  api.invoke('win:chrome', { symbolColor: colorsOf(S.settings.appearance).text, height });
}

export function updateWindowTitle() {
  const t = active();
  const title = $('#window-title');
  if (title) title.textContent = t ? t.title : 'TyranWeb';
  document.title = t ? `${t.title} — TyranWeb` : 'TyranWeb';
}

export function brandHtml() {
  return S.private ? `<span class="private-badge" title="${t('Cửa sổ ẩn danh')}">${icon('incognito', 16)}<span>${t('Ẩn danh')}</span></span>` : '';
}

on('active', updateWindowTitle);

// (Thanh dấu trang: on every page, on the new tab page only, or never)
function showBookmarksBar() {
  const mode = S.settings.layout.bookmarksBar;
  $('#app').classList.toggle('has-bookmarks-bar', mode === 'always' || (mode === 'newtab' && isNewTab(active()?.url)));
}
on('active', showBookmarksBar);
on('tab:update', (tab) => tab.id === T.activeId && showBookmarksBar());
on('tab:update', (t) => t.id === T.activeId && updateWindowTitle());
