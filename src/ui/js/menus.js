// Popovers & menus drawn by the shell (themed, unlike native menus). A transparent scrim
// catches outside clicks — needed because clicks on a <webview> never reach this document.
import { h, $ } from './util.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

const layer = () => $('#layer');
let current = null;

export function closePopover() {
  if (!current) return;
  const c = current;
  current = null;
  c.scrim.remove();
  c.node.remove();
  c.onClose?.();
  window.removeEventListener('keydown', c.onKey, true);
}

export const isPopoverOpen = () => !!current;

function place(node, at, { align = 'start', offset = 6 } = {}) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const r = node.getBoundingClientRect();
  let x;
  let y;
  if (at instanceof Element) {
    const a = at.getBoundingClientRect();
    x = align === 'end' ? a.right - r.width : align === 'center' ? a.left + a.width / 2 - r.width / 2 : a.left;
    y = a.bottom + offset;
    if (y + r.height > H - 8 && a.top - offset - r.height > 8) y = a.top - offset - r.height;
  } else {
    x = at.x;
    y = at.y;
    if (x + r.width > W - 8) x = Math.max(8, x - r.width);
    if (y + r.height > H - 8) y = Math.max(8, H - 8 - r.height);
  }
  x = Math.max(8, Math.min(x, W - r.width - 8));
  y = Math.max(8, Math.min(y, H - r.height - 8));
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
}

// Show arbitrary content anchored to an element or a point.
export function openPopover(content, at, { align, className = '', onClose, focus = true } = {}) {
  closePopover();
  const scrim = h('div', { class: 'scrim' });
  const node = h('div', { class: `popover ${className}`, role: 'dialog' }, content);
  scrim.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    closePopover();
  });
  scrim.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closePopover();
  });
  layer().append(scrim, node);
  place(node, at, { align });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
    }
  };
  window.addEventListener('keydown', onKey, true);
  current = { scrim, node, onClose, onKey };
  if (focus) requestAnimationFrame(() => node.querySelector('input, textarea, select, button')?.focus());
  return { node, close: closePopover, reposition: () => place(node, at, { align }) };
}

// items: { label, icon, hint, run, danger, disabled, checked } | { sep: true } | { title }
export function openMenu(items, at, opts = {}) {
  const list = h('div', { class: 'menu', role: 'menu' });
  const buttons = [];
  for (const it of items.filter(Boolean)) {
    if (it.sep) {
      if (list.lastChild && !list.lastChild.classList.contains('menu-sep')) list.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.title) {
      list.append(h('div', { class: 'menu-title', text: it.title }));
      continue;
    }
    if (it.custom) {
      list.append(it.custom);
      continue;
    }
    const btn = h(
      'button',
      { class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: it.disabled },
      h('span', { class: 'mi-icon', html: it.checked !== undefined ? (it.checked ? icon('check', 16) : '') : it.icon ? icon(it.icon, 16) : '' }),
      h('span', { class: 'label', text: it.label }),
      it.hint ? h('span', { class: 'hint', text: it.hint }) : null
    );
    btn.addEventListener('click', () => {
      closePopover();
      it.run?.();
    });
    btn.addEventListener('pointerenter', () => select(buttons.indexOf(btn)));
    buttons.push(btn);
    list.append(btn);
  }
  if (list.lastChild?.classList.contains('menu-sep')) list.lastChild.remove();
  let sel = -1;
  const select = (i) => {
    buttons[sel]?.classList.remove('sel');
    sel = i;
    buttons[sel]?.classList.add('sel');
  };
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = buttons.length;
      let i = sel;
      for (let k = 0; k < n; k++) {
        i = (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        if (!buttons[i].disabled) break;
      }
      select(i);
      buttons[i].focus();
    } else if (e.key === 'Enter' && buttons[sel]) {
      e.preventDefault();
      buttons[sel].click();
    }
  });
  const pop = openPopover(list, at, { ...opts, className: 'menu-pop', focus: false });
  requestAnimationFrame(() => list.focus());
  list.tabIndex = -1;
  return pop;
}

// ---------- toasts ----------
export function toast(message, { icon: ic = 'sparkles', action, timeout = 3200 } = {}) {
  let box = $('#toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.append(box);
  }
  const node = h(
    'div',
    { class: 'toast' },
    h('span', { class: 'toast-ico', html: icon(ic, 16) }),
    h('span', { class: 'toast-msg', text: message }),
    action ? h('button', { class: 'btn small ghost', text: action.label, onclick: () => (action.run(), node.remove()) }) : null
  );
  box.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, timeout);
  return node;
}

// Simple modal prompt (used for renaming etc.).
export function promptText({ title, value = '', placeholder = '', okLabel = t('Lưu') }, at) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, class: 'input', style: { width: '100%' } });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      closePopover();
    };
    const form = h(
      'form',
      { class: 'prompt-form' },
      h('div', { class: 'prompt-title', text: title }),
      input,
      h('div', { class: 'prompt-actions' }, h('button', { type: 'button', class: 'btn ghost', text: t('Hủy'), onclick: () => finish(null) }), h('button', { type: 'submit', class: 'btn primary', text: okLabel }))
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input.value.trim());
    });
    openPopover(form, at || { x: window.innerWidth / 2 - 160, y: 120 }, { onClose: () => finish(null) });
    requestAnimationFrame(() => input.select());
  });
}
