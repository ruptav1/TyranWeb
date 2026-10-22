// The interface's language (see src/main/i18n.js), ready before any page code runs (this module
// waits for it): t(vietnamese, ...values) gives the text in the user's language, {0} {1}... filled
// with the values; translateDom does the same for a page's own HTML (its text, titles, placeholders).
const info = await window.tyran.invoke('i18n:get').catch(() => null);
const dict = info?.dict || {};
export const LANG = info?.lang || 'vi';
export const LOCALE = info?.locale || 'vi-VN';
export const LANGS = info?.langs || [];
export const CHOSEN = info ? info.chosen : true; // (false: the first start, before a language is picked)

export function t(key, ...vals) {
  let s = dict[key] ?? key;
  if (vals.length) s = s.replace(/\{(\d+)\}/g, (m, i) => String(vals[i] ?? ''));
  return s;
}

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
export function translateDom(root = document) {
  if (LANG === 'vi') return;
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim();
    if (text && dict[text]) n.nodeValue = n.nodeValue.replace(text, dict[text]);
  }
  for (const el of (root.body || root).querySelectorAll('[title], [placeholder], [aria-label], [alt]')) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && dict[v]) el.setAttribute(a, dict[v]);
    }
  }
  if (root.title && dict[root.title]) root.title = dict[root.title];
}

document.documentElement.lang = LANG;
