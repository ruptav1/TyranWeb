import { t, LOCALE } from 'tyran://shared/i18n.js';
// Small DOM / URL helpers for the browser shell.

export const api = window.tyran;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function throttle(fn, ms) {
  let last = 0;
  let t;
  return (...a) => {
    const now = Date.now();
    clearTimeout(t);
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else t = setTimeout(() => ((last = Date.now()), fn(...a)), ms - (now - last));
  };
}

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
};

// ---------- URLs ----------
export const NEWTAB = 'tyran://newtab/';
export const isInternal = (url) => /^tyran:/i.test(url || '');
export const isNewTab = (url) => /^tyran:\/\/newtab\/?$/i.test(url || '');

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

const TLD_LIKE = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i;

// Decide whether typed text is a URL or a search query.
export function resolveInput(text, searchUrl) {
  const t = text.trim();
  if (!t) return null;
  if (/^(https?|tyran|file|view-source|about|data):/i.test(t)) {
    if (/^tyran:\/\/[a-z]+$/i.test(t)) return t + '/';
    return t;
  }
  if (!/\s/.test(t) && (TLD_LIKE.test(t) || LOCAL.test(t))) {
    const local = LOCAL.test(t);
    return (local ? 'http://' : 'https://') + t;
  }
  return searchUrl.replace('%s', encodeURIComponent(t));
}

export function searchUrlFor(settings, engines) {
  const g = settings.general;
  if (g.searchEngine === 'custom' && g.customSearchUrl?.includes('%s')) return g.customSearchUrl;
  return (engines[g.searchEngine] || engines.google).url;
}

// Pretty URL for display when the address bar is not focused.
export function displayParts(url) {
  if (!url || isNewTab(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'tyran:') return { scheme: 'tyran://', host: u.hostname, rest: u.pathname === '/' ? '' : u.pathname };
    const host = u.hostname.replace(/^www\./, '');
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return { scheme: u.protocol === 'https:' ? '' : u.protocol + '//', host: host + (u.port ? ':' + u.port : ''), rest };
  } catch {
    return { scheme: '', host: url, rest: '' };
  }
}

export function prettyUrl(url) {
  if (!url) return '';
  if (/^tyran:\/\/[a-z]+\/$/i.test(url)) return url.slice(0, -1);
  return url;
}

export function letterOf(text, url) {
  const src = (hostOf(url) || text || '?').replace(/^www\./, '');
  return src.charAt(0).toUpperCase() || '?';
}

// Broken favicons fall back to a letter tile (see installFaviconFallback).
export function faviconHtml(favicon, title, url, size = 16) {
  const letter = esc(letterOf(title, url));
  if (favicon && /^(https?|data|tyran):/i.test(favicon)) {
    return `<img class="favicon" src="${esc(favicon)}" width="${size}" height="${size}" alt="" data-letter="${letter}">`;
  }
  return `<span class="letter-icon">${letter}</span>`;
}

export function installFaviconFallback(root = document) {
  root.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img?.tagName === 'IMG' && img.classList.contains('favicon')) {
        img.replaceWith(h('span', { class: 'letter-icon', text: img.dataset.letter || '?' }));
      }
    },
    true
  );
}

export function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t('vừa xong');
  if (s < 3600) return t('{0} phút trước', Math.floor(s / 60));
  if (s < 86400) return t('{0} giờ trước', Math.floor(s / 3600));
  return new Date(ms).toLocaleDateString(LOCALE);
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
