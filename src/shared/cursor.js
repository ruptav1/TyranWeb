// The mouse cursor chosen in Settings → Giao diện, put on a page: its own arrow everywhere, its link
// cursor wherever the page shows a hand, its text cursor in text fields. (A copy of this lives in
// src/preload/webview.js, for every tab.) `animate`: play an .ani's frames (TyranWeb's own pages
// only; on websites the first frame stays, so a heavy page is not restyled many times a second).
const FALLBACK = { arrow: 'default', hand: 'pointer', text: 'text' };

export function cursorKit(doc, animate) {
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
