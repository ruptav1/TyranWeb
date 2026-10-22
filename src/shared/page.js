// Common bootstrap for internal pages (tyran://newtab, settings, history...).
import { applyTheme } from './theme.js';
import { hydrateIcons } from './icons.js';
import { translateDom } from './i18n.js';

export const api = window.tyran;
export let settings = null;
const listeners = [];

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function faviconHtml(favicon, title, url, size = 16) {
  const letter = esc((hostOf(url) || title || '?').charAt(0).toUpperCase());
  if (favicon && /^(https?|data|tyran):/i.test(favicon)) return `<img class="favicon" src="${esc(favicon)}" width="${size}" height="${size}" alt="" data-letter="${letter}">`;
  return `<span class="letter-icon">${letter}</span>`;
}

export function onSettings(fn) {
  listeners.push(fn);
  if (settings) fn(settings);
}

// Ask the browser shell (the window around this page) to do something.
export const host = (type, payload) => api.host(type, payload);
export const openUrl = (url, newTab = false, background = false) => host('open', { url, newTab, background });

export async function boot() {
  translateDom(document); // (the page's own HTML, in the user's language)
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img?.tagName === 'IMG' && img.classList.contains('favicon')) {
        img.replaceWith(h('span', { class: 'letter-icon', text: img.dataset.letter || '?' }));
      }
    },
    true
  );
  // links inside internal pages: middle / ctrl click opens a background tab
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !/^https?:|^tyran:/.test(a.href)) return;
    if (e.ctrlKey || e.metaKey || e.button === 1) {
      e.preventDefault();
      openUrl(a.href, true, true);
    }
  });
  document.addEventListener('auxclick', (e) => {
    const a = e.target.closest('a[href]');
    if (a && e.button === 1 && /^https?:|^tyran:/.test(a.href)) {
      e.preventDefault();
      openUrl(a.href, true, true);
    }
  });
  settings = await api.invoke('settings:get');
  apply(settings);
  api.on('settings:changed', (s) => {
    settings = s;
    apply(s);
  });
  hydrateIcons(document);
  document.documentElement.classList.add('ready');
  performance.mark('page:ready'); // (the timings TYRAN_TIMING lines up)
  return settings;
}

function apply(s) {
  applyTheme(s);
  for (const fn of listeners) fn(s);
}

export { hydrateIcons };
