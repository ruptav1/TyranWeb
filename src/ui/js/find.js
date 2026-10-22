// Find in page (Ctrl+F).
import { h, $, on } from './util.js';
import { active } from './tabs.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

let bar;
let input;
let count;
let tabId = null;

function build() {
  input = h('input', { type: 'text', class: 'find-input', placeholder: t('Tìm trong trang'), spellcheck: 'false' });
  count = h('span', { class: 'find-count' });
  bar = h(
    'div',
    { id: 'findbar', hidden: true },
    h('span', { class: 'find-ico', html: icon('search', 15) }),
    input,
    count,
    h('button', { class: 'icon-btn', title: t('Trước (Shift+Enter)'), html: icon('chevronUp', 16), onclick: () => step(false) }),
    h('button', { class: 'icon-btn', title: t('Tiếp (Enter)'), html: icon('chevronDown', 16), onclick: () => step(true) }),
    h('button', { class: 'icon-btn', title: t('Đóng (Esc)'), html: icon('x', 15), onclick: closeFind })
  );
  input.addEventListener('input', () => search(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('#content').append(bar);
}

function search(fresh) {
  const t = active();
  if (!t?.ready) return;
  const text = input.value;
  if (!text) {
    t.webview.stopFindInPage('clearSelection');
    count.textContent = '';
    return;
  }
  t.webview.findInPage(text, { findNext: !fresh, forward: true });
}

function step(forward) {
  const t = active();
  if (!t?.ready || !input.value) return;
  t.webview.findInPage(input.value, { forward, findNext: true });
}

export function openFind() {
  if (!bar) build();
  const t = active();
  if (!t) return;
  tabId = t.id;
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) search(true);
}

export function closeFind() {
  if (!bar || bar.hidden) return;
  bar.hidden = true;
  const t = active();
  if (t?.ready) t.webview.stopFindInPage('keepSelection');
  count.textContent = '';
  t?.webview?.focus();
}

on('find:result', ({ tab, result }) => {
  if (!bar || bar.hidden || tab.id !== tabId) return;
  if (result.finalUpdate !== false) count.textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : t('Không thấy');
  count.classList.toggle('none', !result.matches);
});

on('active', (t) => {
  if (bar && !bar.hidden && t.id !== tabId) closeFind();
});
