'use strict';
// Preload for every tab (<webview>). Runs in an isolated world; web pages never see it.
//  * all pages: browser shortcuts the page did not handle (mouse back/forward is app-command)
//  * tyran:// pages only: the `window.tyran` bridge used by internal pages
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CODE_KEYS = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', Numpad0: 'Numpad0',
};

function toAccelerator(e) {
  const code = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

let soft = new Map();
ipcRenderer
  .invoke('guest:shortcuts')
  .then((map) => (soft = new Map(Object.entries(map || {}))))
  .catch(() => {});

window.addEventListener(
  'keydown',
  (e) => {
    if (!e.isTrusted || (!e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.code))) return;
    const acc = toAccelerator(e);
    const id = acc && soft.get(acc);
    if (!id) return;
    // Let the page react first; only act when it did not claim the key.
    setTimeout(() => {
      if (!e.defaultPrevented) ipcRenderer.sendToHost('tyran:shortcut', id);
    }, 0);
  },
  false
);

if (location.protocol === 'tyran:') {
  const EVENTS = new Set(['settings:changed', 'shortcuts:changed', 'bookmarks:changed', 'history:changed', 'downloads:update', 'downloads:done', 'downloads:changed', 'ba:preview', 'wallpapers:changed', 'extensions:changed', 'nikke:progress', 'nikke:changed', 'nikke:cards', 'azur:progress', 'azur:changed', 'azur:cards', 'sekai:progress', 'sekai:changed', 'sekai:cards', 'data:progress', 'adblock:braveProgress', 'update:state', 'livewalls:progress']);
  contextBridge.exposeInMainWorld('tyran', {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on(channel, cb) {
      if (!EVENTS.has(channel)) throw new Error('Unknown event ' + channel);
      const fn = (_e, ...args) => cb(...args);
      ipcRenderer.on(channel, fn);
      return () => ipcRenderer.removeListener(channel, fn);
    },
    // Ask the browser shell to do something (open a tab, run a command...).
    host: (type, payload) => ipcRenderer.sendToHost('tyran:host', { type, payload }),
    // where a file dropped on the page is on the disk (fonts dropped in Settings)
    pathOf: (file) => webUtils.getPathForFile(file),
  });
}

// ---------------------------------------------------------------- mouse cursor
// The cursor chosen in Settings → Giao diện (a copy of src/shared/cursor.js, which the window uses):
// on TyranWeb's own pages always, on websites unless turned off there. Websites get an .ani's first
// frame only.
const FALLBACK = { arrow: 'default', hand: 'pointer', text: 'text' };

function cursorKit(doc, animate) {
  let style = null;
  let timers = {};
  let on = false;
  // a page's own hand / arrow, found as the pointer comes over it
  doc.addEventListener(
    'mouseover',
    (e) => {
      const el = e.target;
      if (!on || !el || el.nodeType !== 1 || el.hasAttribute('data-tyran-cur')) return;
      const c = getComputedStyle(el).cursor;
      if (c === 'pointer') el.setAttribute('data-tyran-cur', 'hand');
      else if (c === 'default') el.setAttribute('data-tyran-cur', 'arrow');
    },
    true
  );
  return (cfg) => {
    for (const t of Object.values(timers)) clearTimeout(t);
    timers = {};
    for (const k of Object.keys(FALLBACK)) doc.documentElement?.style.removeProperty('--tyran-' + k);
    on = !!cfg;
    if (!cfg) {
      style?.remove();
      style = null;
      for (const el of doc.querySelectorAll('[data-tyran-cur]')) el.removeAttribute('data-tyran-cur');
      return;
    }
    style ||= Object.assign(doc.createElement('style'), { id: 'tyran-cursor' });
    const slot = (k) => cfg[k]?.css || FALLBACK[k];
    style.textContent =
      `:root{--tyran-arrow:${slot('arrow')};--tyran-hand:${slot('hand')};--tyran-text:${slot('text')};cursor:var(--tyran-arrow)!important}` +
      '[data-tyran-cur=arrow]{cursor:var(--tyran-arrow)!important}[data-tyran-cur=hand]{cursor:var(--tyran-hand)!important}' +
      ':where(input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image]),textarea,[contenteditable]:not([contenteditable=false])){cursor:var(--tyran-text)}';
    const put = () => (doc.head || doc.documentElement)?.append(style);
    if (doc.documentElement) put();
    else doc.addEventListener('DOMContentLoaded', put, { once: true });
    if (!animate) return;
    for (const k of Object.keys(FALLBACK)) {
      const frames = cfg[k]?.frames;
      if (!frames?.length) continue;
      let i = 0;
      const next = () => {
        doc.documentElement?.style.setProperty('--tyran-' + k, frames[i].css);
        const ms = frames[i].ms;
        i = (i + 1) % frames.length;
        timers[k] = setTimeout(next, ms);
      };
      next();
    }
  };
}

{
  const internal = location.protocol === 'tyran:';
  const apply = cursorKit(document, internal);
  const use = (cfg) => apply(cfg && (internal || cfg.pages) ? cfg : null);
  ipcRenderer.invoke('guest:cursor').then(use, () => {});
  ipcRenderer.on('cursor:changed', (_e, cfg) => use(cfg));
}
