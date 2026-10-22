'use strict';
// "Brave đầy đủ" in the pages (main/brave-adblock.js), top frame only like the Ghostery preload it
// stands in for: before the page's own scripts, the scriptlets for the address (uBlock Origin's and
// Brave's, as Brave injects them) and its element-hiding rules; then the rules for the classes and
// ids the page has and gets later, and the procedural rules (:has-text, :upward, :remove()...)
// applied as the page changes. Runs in an isolated world; web pages never see it.
const { ipcRenderer, webFrame } = require('electron');

// "/re/flags" as a RegExp, else null
function regex(arg) {
  const m = /^\/(.+)\/([imsu]*)$/.exec(arg);
  try {
    return m ? new RegExp(m[1], m[2]) : null;
  } catch {
    return null;
  }
}
// a test of a text: a regex, or the text itself (contained, or `exact`)
function matcher(arg, exact) {
  const re = regex(arg);
  if (re) return (s) => re.test(s);
  return exact ? (s) => s === arg : (s) => s.includes(arg);
}
const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1');
const all = (root, sel) => {
  try {
    return [...root.querySelectorAll(sel)];
  } catch {
    return [];
  }
};

// the procedural operators, each from the elements so far (null: the whole document) to the next
function cssMatcher(arg, pseudo) {
  const i = arg.indexOf(':');
  const prop = arg.slice(0, i).trim();
  const ok = matcher(arg.slice(i + 1).trim(), true);
  return (els) => els.filter((e) => ok(getComputedStyle(e, pseudo).getPropertyValue(prop)));
}
const OPS = {
  'css-selector': (els, arg) => {
    if (!els) return all(document, arg);
    const s = arg.trim();
    if (s[0] === '+' || s[0] === '~') {
      const sel = s.slice(1).trim();
      const next = (e) => {
        const out = [];
        for (let n = e.nextElementSibling; n; n = s[0] === '+' ? null : n.nextElementSibling) if (n.matches(sel)) out.push(n);
        return out;
      };
      return els.flatMap(next);
    }
    return els.flatMap((e) => all(e, ':scope ' + s));
  },
  'has-text': (els, arg) => {
    const ok = matcher(arg);
    return (els || []).filter((e) => ok(e.textContent));
  },
  'min-text-length': (els, arg) => (els || []).filter((e) => e.textContent.length >= Number(arg)),
  'matches-path': (els, arg) => (matcher(arg)(location.pathname + location.search) ? els : []),
  'matches-attr': (els, arg) => {
    const m = /^(\/.+?\/[imsu]*|"[^"]*"|[^=]+)(?:=(.*))?$/.exec(arg.trim());
    if (!m) return [];
    const name = matcher(unquote(m[1]), true);
    const value = m[2] == null ? () => true : matcher(unquote(m[2]), true);
    return (els || []).filter((e) => [...e.attributes].some((a) => name(a.name) && value(a.value)));
  },
  'matches-css': (els, arg) => cssMatcher(arg, null)(els || []),
  'matches-css-before': (els, arg) => cssMatcher(arg, '::before')(els || []),
  'matches-css-after': (els, arg) => cssMatcher(arg, '::after')(els || []),
  upward: (els, arg) => {
    const n = /^\d+$/.test(arg.trim()) ? Number(arg) : 0;
    const up = (e) => {
      if (!n) return e.parentElement?.closest(arg) || null;
      for (let i = 0; i < n && e; i++) e = e.parentElement;
      return e;
    };
    return [...new Set((els || []).map(up).filter(Boolean))];
  },
  xpath: (els, arg) =>
    (els || [document]).flatMap((ctx) => {
      const out = [];
      try {
        const r = document.evaluate(arg, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) if (r.snapshotItem(i).nodeType === 1) out.push(r.snapshotItem(i));
      } catch {
        /* a bad expression */
      }
      return out;
    }),
};

function select(ops) {
  let els = null;
  for (const { type, arg } of ops) {
    els = OPS[type] ? OPS[type](els, String(arg ?? '')) : [];
    if (els && !els.length) return [];
  }
  return els || [];
}

function start({ css, script, procedural, exceptions, generic }) {
  if (script) webFrame.executeJavaScript(script).catch(() => {});
  const sheet = (c) => webFrame.insertCSS(c, { cssOrigin: 'user' });
  css.forEach(sheet);

  // the generic rules for ids and classes not seen yet
  const seen = new Set();
  function features(roots) {
    if (!generic) return;
    const classes = [];
    const ids = [];
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll('[id],[class]')]) {
        if (el.id && !seen.has('#' + el.id)) seen.add('#' + el.id), ids.push(el.id);
        for (const c of el.classList) if (!seen.has('.' + c)) seen.add('.' + c), classes.push(c);
      }
    }
    if (classes.length || ids.length) ipcRenderer.invoke('brave-adblock:more', classes, ids, exceptions).then((list) => list.forEach(sheet), () => {});
  }

  // procedural rules: hidden by an attribute of this page's own (a stylesheet keeps them hidden)
  const rules = procedural
    .map((p) => {
      try {
        return JSON.parse(p);
      } catch {
        return null;
      }
    })
    .filter((r) => r && Array.isArray(r.selector));
  const mark = 'b' + Math.random().toString(36).slice(2, 9);
  const styled = new Map(); // a :style()'s declarations -> its attribute
  if (rules.length) sheet(`[${mark}]{display:none!important}`);
  function act(el, a) {
    if (!a) return el.setAttribute(mark, '');
    if (a.type === 'remove') return el.remove();
    if (a.type === 'remove-attr') return el.removeAttribute(a.arg);
    if (a.type === 'remove-class') return el.classList.remove(a.arg);
    if (a.type === 'style') {
      let attr = styled.get(a.arg);
      if (!attr) {
        attr = `${mark}-${styled.size}`;
        styled.set(a.arg, attr);
        sheet(`[${attr}]{${a.arg}}`);
      }
      el.setAttribute(attr, '');
    }
  }
  function apply() {
    for (const r of rules) for (const el of select(r.selector)) act(el, r.action);
  }

  const pending = new Set();
  let timer = 0;
  const flush = () => {
    timer = 0;
    const roots = [...pending].filter((n) => n.isConnected);
    pending.clear();
    features(roots);
    if (rules.length) apply();
  };
  const observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') pending.add(m.target);
      else for (const n of m.addedNodes) if (n.nodeType === 1) pending.add(n);
    }
    if (pending.size && !timer) timer = setTimeout(flush, 50);
  });
  const begin = () => {
    features([document.documentElement]);
    if (rules.length) apply();
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
}

if (window === window.top && /^https?:/.test(location.href)) {
  const first = ipcRenderer.sendSync('brave-adblock:page', location.href);
  if (first) start(first);
}
