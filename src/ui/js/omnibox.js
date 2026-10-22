// Address bar: URL display, inline completion and a suggestion list built from open tabs,
// bookmarks, history and the search engine.
import { api, h, $, on, emit, esc, debounce, resolveInput, searchUrlFor, displayParts, prettyUrl, isNewTab, isInternal, faviconHtml } from './util.js';
import { S } from './state.js';
import { T, active, activate, navigate, createTab } from './tabs.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

let box;
let input;
let display;
let siteBtn;
let zoomBadge;
let starBtn;
let dropdown = null;
let items = [];
let sel = 0;
let typed = '';
let queryId = 0;

export function buildOmnibox() {
  siteBtn = h('button', { class: 'omni-site', title: t('Thông tin trang') });
  input = h('input', { class: 'omni-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('Tìm kiếm hoặc nhập địa chỉ web') });
  display = h('div', { class: 'omni-display' });
  zoomBadge = h('button', { class: 'omni-chip zoom-chip', hidden: true, title: t('Mức thu phóng — bấm để đặt lại') });
  starBtn = h('button', { class: 'omni-star icon-btn', title: t('Thêm dấu trang (Ctrl+D)'), html: icon('star', 16) });
  box = h('div', { class: 'omnibox' }, siteBtn, h('div', { class: 'omni-field' }, input, display), zoomBadge, starBtn);

  input.addEventListener('focus', () => {
    box.classList.add('focused');
    const t = active();
    input.value = t && !isNewTab(t.url) ? prettyUrl(t.url) : '';
    requestAnimationFrame(() => input.select());
  });
  input.addEventListener('blur', () => {
    box.classList.remove('focused');
    setTimeout(() => {
      if (document.activeElement !== input) {
        closeDropdown();
        sync();
      }
    }, 120);
  });
  input.addEventListener('input', (e) => {
    typed = input.value;
    const inserting = e.inputType?.startsWith('insert');
    update(inserting);
  });
  input.addEventListener('keydown', onKey);
  zoomBadge.addEventListener('click', () => emit('command', { id: 'page.zoomReset' }));
  starBtn.addEventListener('click', () => emit('bookmark-popover', starBtn));
  siteBtn.addEventListener('click', () => emit('site-info', siteBtn));
  sync();
  return box;
}

on('active', sync);
on('tab:update', (t) => t.id === T.activeId && sync());
on('bookmarks', sync);
on('focus-omnibox', focus);

export function focus() {
  if (!input) return;
  input.focus();
  input.select();
}

// Reflect the active tab in the (unfocused) address bar.
export function sync() {
  if (!box) return;
  const tab = active();
  const url = tab?.url || '';
  const focused = document.activeElement === input;
  if (!focused) input.value = isNewTab(url) ? '' : prettyUrl(url);
  const parts = displayParts(url);
  display.innerHTML = parts && !focused ? `<span class="scheme">${esc(parts.scheme)}</span><span class="host">${esc(parts.host)}</span><span class="rest">${esc(parts.rest)}</span>` : '';
  box.classList.toggle('show-display', !!parts && !focused);

  let kind = 'search';
  if (isInternal(url) && !isNewTab(url)) kind = 'internal';
  else if (/^https:/i.test(url)) kind = 'secure';
  else if (/^http:/i.test(url)) kind = 'insecure';
  box.dataset.kind = kind;
  siteBtn.innerHTML =
    kind === 'secure' ? icon('lock', 14) : kind === 'insecure' ? `${icon('warn', 14)}<span>${t('Không bảo mật')}</span>` : kind === 'internal' ? icon('sakura', 15) : icon('search', 15);
  siteBtn.title = kind === 'secure' ? t('Kết nối an toàn') : kind === 'insecure' ? t('Kết nối không an toàn') : 'TyranWeb';

  const z = tab?.zoom || 1;
  zoomBadge.hidden = Math.abs(z - 1) < 0.001;
  zoomBadge.textContent = `${Math.round(z * 100)}%`;

  const marked = !!S.bookmarks.items.find((b) => b.url === url);
  starBtn.innerHTML = icon('star', 16, marked ? 'filled' : '');
  starBtn.classList.toggle('on', marked);
  starBtn.hidden = !/^https?:/i.test(url);
}

// ---------------------------------------------------------------- suggestions
function searchUrl() {
  return searchUrlFor(S.settings, S.engines);
}

function engineName() {
  const g = S.settings.general;
  return g.searchEngine === 'custom' ? t('công cụ tùy chỉnh') : (S.engines[g.searchEngine] || S.engines.google).name;
}

const norm = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

async function update(allowInline) {
  const text = typed.trim();
  if (!text) {
    closeDropdown();
    return;
  }
  const id = ++queryId;
  const q = text.toLowerCase();
  const list = [];
  const seen = new Set();
  const push = (it) => {
    const key = it.url || it.query;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(it);
  };

  const target = resolveInput(text, searchUrl());
  const isSearch = target.startsWith(searchUrl().split('%s')[0]) && !/^https?:\/\//i.test(text);
  push(isSearch ? { type: 'search', query: text, url: target } : { type: 'go', url: target });

  for (const t of T.list) {
    if (t.id === T.activeId || isNewTab(t.url)) continue;
    if (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) push({ type: 'tab', url: t.url, title: t.title, favicon: t.favicon, tabId: t.id });
    if (list.length > 3) break;
  }
  for (const b of S.bookmarks.items) {
    if ((b.title || '').toLowerCase().includes(q) || b.url.toLowerCase().includes(q)) push({ type: 'bookmark', url: b.url, title: b.title, favicon: b.favicon });
    if (list.length > 5) break;
  }
  render(list);

  const hist = S.private || active()?.incognito ? [] : await api.invoke('history:suggest', text);
  if (id !== queryId) return;
  for (const v of hist) push({ type: 'history', url: v.url, title: v.title, favicon: v.favicon });

  // inline completion with the best matching host (not once a space is typed, even a trailing one:
  // it would replace the space and keep landing back on the same link)
  if (allowInline && !/\s/.test(typed) && input.selectionStart === input.value.length) {
    const cand = list.find((it) => it.url && norm(it.url).toLowerCase().startsWith(q) && it.type !== 'go' && it.type !== 'search');
    if (cand) {
      const full = norm(cand.url);
      const host = full.split('/')[0];
      const completion = host.toLowerCase().startsWith(q) ? host : full;
      if (completion.length > text.length) {
        input.value = text + completion.slice(text.length);
        input.setSelectionRange(text.length, input.value.length);
        list[0] = { type: 'go', url: 'https://' + completion + (completion === host ? '/' : ''), inline: true };
      }
    }
  }
  render(list.slice(0, 8));

  const remote = S.private || active()?.incognito ? [] : await api.invoke('suggest', text);
  if (id !== queryId) return;
  for (const s of remote) if (s.toLowerCase() !== q) push({ type: 'search', query: s, url: searchUrl().replace('%s', encodeURIComponent(s)) });
  render(list.slice(0, 10));
}

const TYPE_ICON = { search: 'search', go: 'globe', tab: 'tabs', bookmark: 'star', history: 'history' };

function render(list) {
  items = list;
  sel = Math.min(sel, list.length - 1);
  if (sel < 0) sel = 0;
  if (!dropdown) {
    dropdown = h('div', { class: 'omni-dropdown' });
    dropdown.addEventListener('mousedown', (e) => e.preventDefault());
    dropdown.addEventListener('click', (e) => {
      const row = e.target.closest('.omni-item');
      if (row) choose(items[Number(row.dataset.i)], e.ctrlKey || e.button === 1);
    });
    $('#layer').append(dropdown);
  }
  const r = box.getBoundingClientRect();
  dropdown.style.left = `${r.left}px`;
  dropdown.style.width = `${r.width}px`;
  const below = r.bottom + 6;
  if (below + 380 > window.innerHeight && r.top > 380) {
    dropdown.style.top = '';
    dropdown.style.bottom = `${window.innerHeight - r.top + 6}px`;
  } else {
    dropdown.style.bottom = '';
    dropdown.style.top = `${below}px`;
  }
  dropdown.innerHTML = list
    .map((it, i) => {
      let main;
      let sub = '';
      let lead;
      if (it.type === 'search') {
        main = `<b>${esc(it.query)}</b>`;
        sub = t('Tìm với {0}', esc(engineName()));
        lead = icon('search', 16);
      } else if (it.type === 'go') {
        main = esc(prettyUrl(it.url));
        sub = t('Mở trang');
        lead = icon('globe', 16);
      } else {
        main = esc(it.title || it.url);
        sub = esc(prettyUrl(it.url));
        lead = faviconHtml(it.favicon, it.title, it.url);
      }
      const badge = it.type === 'tab' ? t('<span class="omni-badge">Chuyển tới tab</span>') : it.type === 'bookmark' || it.type === 'history' ? `<span class="omni-type">${icon(TYPE_ICON[it.type], 13)}</span>` : '';
      return `<div class="omni-item${i === sel ? ' sel' : ''}" data-i="${i}"><span class="omni-lead">${lead}</span><span class="omni-text"><span class="omni-main">${main}</span><span class="omni-sub">${sub}</span></span>${badge}</div>`;
    })
    .join('');
}

function closeDropdown() {
  dropdown?.remove();
  dropdown = null;
  items = [];
  sel = 0;
  queryId++;
}

function choose(it, newTab = false) {
  if (!it) return;
  closeDropdown();
  if (it.type === 'tab' && it.tabId) {
    activate(it.tabId);
    return;
  }
  open(it.url, newTab);
}

export function open(url, newTab = false) {
  const t = active();
  if (newTab || !t) createTab({ url });
  else {
    navigate(t.id, url);
    t.webview?.focus();
  }
  input.blur();
}

function onKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    const it = items[sel];
    if (it && (it.type === 'go' || it.type === 'search')) input.value = it.query || prettyUrl(it.url);
    else if (it) input.value = prettyUrl(it.url);
    render(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const newTab = e.altKey || e.ctrlKey;
    if (items.length && sel > 0) return choose(items[sel], newTab);
    if (items[0]?.inline && input.value) {
      const url = resolveInput(input.value, searchUrl());
      closeDropdown();
      return open(url, newTab);
    }
    const url = resolveInput(input.value, searchUrl());
    closeDropdown();
    if (url) open(url, newTab);
  } else if (e.key === 'Escape') {
    if (dropdown) {
      e.preventDefault();
      closeDropdown();
      return;
    }
    input.blur();
    active()?.webview?.focus();
  }
}

export const omniboxHost = () => box;

on('settings', () => sync());

// keep the dropdown aligned when the window resizes
window.addEventListener(
  'resize',
  debounce(() => dropdown && render(items), 60)
);
