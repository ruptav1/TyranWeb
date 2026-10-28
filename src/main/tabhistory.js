'use strict';
// A tab's back/forward list: kept when the tab sleeps, is closed or TyranWeb quits, and given back
// to it when it wakes, is reopened (Ctrl+Shift+T) or restored at the next start. Chromium keeps each
// page's scroll position and form values with it ("page state"), as Chrome's session restore does.
//
// A <webview> loads its src as soon as it is attached, and a history can only be restored into one
// that has loaded nothing yet: the tab's webview asks for `about:blank#tyran-history=<token>|<url>`,
// its src is emptied in will-attach-webview, and the history stashed under the token is restored
// once it is attached (<url> is loaded instead if nothing is stashed).

const BACK = 25; // pages kept before the current one
const AHEAD = 5; // ...and after it
const STATE_NEAR = 3; // page state only for the pages this close to the current one
const STATE_MAX = 24 * 1024; // (a bigger state is left out: that page opens at its top)
const MARK = /^about:blank#tyran-history=([\w-]{1,64})\|(.*)$/;

const stashed = new Map(); // token → history
const waiting = new Map(); // guest webContents id → history
let next = null;

const keepable = (e) => e && typeof e.url === 'string' && e.url.length <= 8192 && /^(https?|tyran):/i.test(e.url);

// { index, entries: [{ url, title, pageState? }] } trimmed to what is kept, or null
function clean(h) {
  if (!h || !Array.isArray(h.entries) || !Number.isInteger(h.index) || !keepable(h.entries[h.index])) return null;
  const list = [];
  let at = 0;
  h.entries.forEach((e, i) => {
    if (i === h.index) at = list.length;
    if (keepable(e)) list.push({ e, i });
  });
  const from = Math.max(0, at - BACK);
  const entries = list.slice(from, at + AHEAD + 1).map(({ e, i }) => {
    const near = Math.abs(i - h.index) <= STATE_NEAR && typeof e.pageState === 'string' && e.pageState.length <= STATE_MAX;
    return { url: e.url, title: String(e.title || '').slice(0, 500), ...(near ? { pageState: e.pageState } : {}) };
  });
  return { index: at - from, entries };
}

function read(wc) {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const nh = wc.navigationHistory;
    return clean({ index: nh.getActiveIndex(), entries: nh.getAllEntries() });
  } catch {
    return null;
  }
}

function stash(token, history) {
  if (!/^[\w-]{1,64}$/.test(String(token))) return;
  const h = clean(history);
  if (!h) return;
  stashed.set(token, h);
  if (stashed.size > 600) stashed.delete(stashed.keys().next().value);
}

// (will-attach-webview) the src to load instead of the marker: '' when a history is to be restored
function claim(params) {
  const m = MARK.exec(params.src || '');
  if (!m) return;
  const h = stashed.get(m[1]);
  stashed.delete(m[1]);
  let url = '';
  try {
    url = decodeURIComponent(m[2]);
  } catch {
    /* not a url */
  }
  params.src = h ? '' : url;
  next = h || null;
  queueMicrotask(() => (next = null)); // (its webview was refused: no other one takes the history)
}

// (web-contents-created: right after will-attach-webview, for the guest it made)
function adopt(guest) {
  if (next) waiting.set(guest.id, next);
  next = null;
}

// (did-attach-webview)
function attached(guest) {
  const h = waiting.get(guest.id);
  if (!h) return;
  waiting.delete(guest.id);
  guest.navigationHistory.restore(h).catch(() => {});
}

module.exports = { clean, read, stash, claim, adopt, attached };
