'use strict';
// Settings → Quyền riêng tư, two of Brave's protections for the addresses pages are opened at, as
// steps of the sessions' webRequest chain (webrequest.js, set by privacy.js):
//  - Xoá tham số theo dõi (privacy.stripParams): the tracking parameters of Brave's query filter
//    (fbclid, gclid, msclkid, igshid, YouTube's si...) taken off a page's address when it is opened
//    from another site, as Brave does (brave-core components/query_filter).
//  - Bỏ qua trang chuyển hướng theo dõi (privacy.debounce): a link through a tracker that only sends
//    the browser on (an affiliate or mail click counter) goes straight to where it leads, by Brave's
//    debounce rules (brave-core components/debounce). Its AMP rules (Google's and the AMP cache's
//    copies of a page) follow Mở trang gốc thay cho trang AMP (privacy.deAmp) instead.
// Both rule lists are Brave's own (brave/adblock-lists, MPL-2.0): fetched again every few days into
// <data>/privacy-lists, with the copies in ./lists for when they cannot be.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const data = require('./data');
const { getDomain } = require(require.resolve('tldts-experimental', { paths: [path.dirname(require.resolve('@ghostery/adblocker-electron'))] }));

const LISTS = {
  query: { url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/query-filter.json', file: 'brave-query-filter.json' },
  debounce: { url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/debounce.json', file: 'brave-debounce.json' },
};
const HOME = path.join(data.dir, 'privacy-lists');
const REFRESH = 4 * 864e5;
const DE_AMP = 'brave.de_amp.enabled'; // (the one preference Brave's rules name)

// ---------------------------------------------------------------- match patterns
// Brave's rules use extensions' match patterns ("*://*.example.com/r?*"): the path part is matched
// against the path and the query, as Chromium does.
const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function pattern(p) {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(String(p));
  if (!m) return null;
  const [, scheme, host, rest] = m;
  const re = new RegExp('^' + rest.split('*').map(escape).join('.*') + '$');
  const base = host.startsWith('*.') ? host.slice(2) : '';
  return (u) => {
    if (scheme === '*' ? u.protocol !== 'http:' && u.protocol !== 'https:' : u.protocol !== scheme + ':') return false;
    const h = u.hostname;
    if (base) {
      if (h !== base && !h.endsWith('.' + base)) return false;
    } else if (host !== '*' && h !== host) return false;
    return re.test(u.pathname + u.search);
  };
}
function patternSet(list) {
  const tests = (Array.isArray(list) ? list : []).map(pattern).filter(Boolean);
  return (u) => tests.some((t) => t(u));
}

// ---------------------------------------------------------------- the lists
let queryRules = [];
let debounceRules = [];

function compileQuery(json) {
  return json
    .filter((r) => Array.isArray(r?.include) && Array.isArray(r.params))
    .map((r) => ({ include: patternSet(r.include), exclude: patternSet(r.exclude), params: r.params.filter((x) => typeof x === 'string') }));
}
const ACTIONS = new Set(['redirect', 'base64,redirect', 'regex-path', 'regex-path-template']);
function compileDebounce(json) {
  return json
    .filter((r) => Array.isArray(r?.include) && ACTIONS.has(r.action) && typeof r.param === 'string')
    .map((r) => {
      let re = null;
      if (r.action.startsWith('regex-path')) {
        try {
          re = r.param.length <= 200 ? new RegExp(r.param) : null;
        } catch {
          /* (not a pattern JavaScript reads: the rule is left out) */
        }
        if (!re) return null;
      }
      return { include: patternSet(r.include), exclude: patternSet(r.exclude), action: r.action, param: r.param, re, scheme: r.prepend_scheme || '', template: r.redirect_url_template || '', pref: r.pref || '' };
    })
    .filter(Boolean);
}
const COMPILE = { query: compileQuery, debounce: compileDebounce };
const set = (name, json) => {
  const rules = COMPILE[name](json);
  if (!rules.length) return false;
  if (name === 'query') queryRules = rules;
  else debounceRules = rules;
  return true;
};

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

async function fetchList(name) {
  const { url, file } = LISTS[name];
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text);
  if (!Array.isArray(json) || !set(name, json)) throw new Error('no rules');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, file + '.tmp'), text);
  fs.renameSync(path.join(HOME, file + '.tmp'), path.join(HOME, file));
}

let started = false;
// the lists kept last time (or the copies TyranWeb brings), fetched again in the background once old
function init() {
  if (started) return;
  started = true;
  for (const name of Object.keys(LISTS)) {
    const kept = path.join(HOME, LISTS[name].file);
    const json = readJson(kept);
    if (!json || !set(name, json)) set(name, readJson(path.join(__dirname, 'lists', LISTS[name].file)) || []);
    let age = Infinity;
    try {
      if (json) age = Date.now() - fs.statSync(kept).mtimeMs;
    } catch {
      /* not kept yet */
    }
    if (age > REFRESH) fetchList(name).catch((err) => console.warn(`[privacy] ${name} list:`, err.message));
  }
}

// ---------------------------------------------------------------- helpers
const siteOf = (url, priv) => {
  try {
    return getDomain(url, { allowPrivateDomains: priv }) || new URL(url).hostname;
  } catch {
    return '';
  }
};
// the page the tab shows now: where a link was followed from (webRequest gives no initiator)
function fromPage(d) {
  try {
    const u = d.webContents?.getURL() || '';
    return /^https?:/i.test(u) ? u : '';
  } catch {
    return '';
  }
}
const off = (url) => !!url && require('./adblock').isOff(url); // (the shield turned off for that site)
const navigation = (d) => d.resourceType === 'mainFrame' && (!d.method || d.method === 'GET');

// ---------------------------------------------------------------- query filter
// (Brave's own exceptions: these parameters are left on the pages they are needed on)
const CONDITIONAL = { ck_subscriber_id: /\/unsubscribe/, h_sid: /\/email\//, h_slt: /\/email\//, mkt_tok: /([uU]nsubscribe|emailWebview)/ };
const EXEMPT = new Set(['urldefense.com']);

// `url` without its tracking parameters ('' when there are none), the others left as they are
function stripParams(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.search.length < 2 || EXEMPT.has(u.hostname)) return '';
  const blocked = new Set();
  for (const r of queryRules) if (r.include(u) && !r.exclude(u)) for (const p of r.params) blocked.add(p);
  let stripped = false;
  const kept = u.search
    .slice(1)
    .split('&')
    .filter((token) => {
      const i = token.indexOf('=');
      if (i <= 0 || i === token.length - 1) return true; // (not param=value, or an empty one)
      const name = token.slice(0, i);
      const cond = CONDITIONAL[name];
      if (blocked.has(name) || (cond && !cond.test(url))) {
        stripped = true;
        return false;
      }
      return true;
    });
  if (!stripped) return '';
  u.search = kept.length ? '?' + kept.join('&') : '';
  return u.href;
}

function paramsStep(d, cb) {
  if (!navigation(d) || !d.url.includes('?')) return cb({});
  const from = fromPage(d);
  // (a site's own links keep what the site put in them, as in Brave)
  if ((from && siteOf(from, true) === siteOf(d.url, true)) || off(d.url) || off(from)) return cb({});
  const clean = stripParams(d.url);
  cb(clean && clean !== d.url ? { redirectURL: clean } : {});
}

// ---------------------------------------------------------------- debounce
function base64url(s) {
  try {
    const out = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return out.includes('�') ? '' : out;
  } catch {
    return '';
  }
}
const unescape = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};
// the host as a plain reading of the text gives it (Brave's check against tricks like "a.com\@b.com")
const naiveHost = (s) => (s.replace(/^https?:\/\//i, '').split(/[:/?]/).find(Boolean) || '').toLowerCase();

// where `url` leads by `r`, or ''
function apply(r, url, u) {
  if (r.exclude(u) || !r.include(u)) return '';
  let value = '';
  if (r.re) {
    const m = r.re.exec(u.pathname);
    if (!m || m.length < 2) return '';
    const groups = m.slice(1).map((g) => g || '');
    if (r.action === 'regex-path-template') {
      if (groups.length > 9) return '';
      value = r.template;
      for (let i = 0; i < groups.length; i++) {
        if (!value.includes('$' + (i + 1))) return '';
        value = value.split('$' + (i + 1)).join(groups[i]);
      }
      if (/\$[1-9]/.test(value)) return '';
    } else value = groups.join('');
    value = unescape(value);
  } else {
    const v = u.searchParams.get(r.param);
    if (!v) return '';
    value = r.action === 'base64,redirect' ? base64url(v) : v;
  }
  if (!value) return '';
  let next = null;
  try {
    next = new URL(value);
  } catch {
    /* not an address by itself */
  }
  if (r.scheme) {
    if (next) return ''; // (Brave: a rule that prepends a scheme to a whole address is a wrong rule)
    value = `${r.scheme === 'http' ? 'http' : 'https'}://${value}`;
    try {
      next = new URL(value);
    } catch {
      return '';
    }
  }
  if (!next || (next.protocol !== 'http:' && next.protocol !== 'https:')) return '';
  const site = getDomain(next.href);
  if (!site || site === siteOf(url, false) || naiveHost(value) !== next.hostname) return '';
  return next.href;
}

// where `url` finally leads past the trackers' pages ('' when it is not one)
function debounce(url, { trackers, amp }) {
  let cur = url;
  for (let hops = 0; hops < 5; hops++) {
    let u;
    try {
      u = new URL(cur);
    } catch {
      break;
    }
    let next = '';
    for (const r of debounceRules) {
      if (r.pref ? r.pref !== DE_AMP || !amp : !trackers) continue;
      next = apply(r, cur, u);
      if (next) break;
    }
    if (!next) break;
    cur = next;
  }
  return cur === url ? '' : cur;
}

function debounceStep(d, cb) {
  if (!navigation(d)) return cb({});
  const p = data.settings.data.privacy;
  const to = debounce(d.url, { trackers: !!p.debounce, amp: !!p.deAmp });
  if (!to || off(to) || off(fromPage(d))) return cb({});
  cb({ redirectURL: to });
}

module.exports = { init, stripParams, debounce, paramsStep, debounceStep };
