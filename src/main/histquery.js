'use strict';
// Looking through a list of visits ({ id, url, title, favicon, time }) the way Lịch sử does (its pages
// and its incognito pages: main/data.js, main/privhistory.js):
//  - the words typed, in any order, with or without Vietnamese marks ("bun bo" finds "Bún bò"), in
//    the title or the address; "site:example.com" among them (or a site picked) keeps that site
//    and its subdomains (only that one with exact: a site's row in Theo trang web);
//  - a time span (since <= time < until);
//  - newest or oldest first, by name (A→Z, Z→A), or the pages opened most first (each page once,
//    with how many times);
//  - the same visits counted per site (Theo trang web): most or fewest visits first, by name, or
//    the most recent first.

const MARKS = /[̀-ͯ]/g;
const cache = new Map();
function fold(s) {
  s = String(s ?? '');
  let f = cache.get(s);
  if (f === undefined) {
    f = s.toLowerCase().normalize('NFD').replace(MARKS, '').replace(/đ/g, 'd');
    if (cache.size > 120000) cache.clear();
    cache.set(s, f);
  }
  return f;
}

const HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(?:www\.)?([^/:?#]+)/i;
const hostOf = (url) => (HOST.exec(url || '')?.[1] || '').toLowerCase();

const decoded = (url) => {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
};
// (what the words are looked for in: the title and the address, its %-escapes read; kept for each
// visit until its title changes)
const hays = new WeakMap();
function hay(v) {
  const c = hays.get(v);
  if (c && c.title === v.title && c.url === v.url) return c.s;
  const s = `${v.title || ''} ${decoded(v.url || '')}`.toLowerCase().normalize('NFD').replace(MARKS, '').replace(/đ/g, 'd');
  hays.set(v, { title: v.title, url: v.url, s });
  return s;
}

const cleanHost = (s) => String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/:?#].*$/, '');

// The filter's words and site, folded.
function parse({ text = '', host = '' } = {}) {
  const words = [];
  let site = cleanHost(host);
  for (const w of String(text).trim().split(/\s+/)) {
    if (!w) continue;
    const m = /^site:(.+)$/i.exec(w);
    if (m) site = cleanHost(m[1]);
    else words.push(fold(w));
  }
  return { words, site };
}

function matcher(f = {}) {
  const { words, site } = parse(f);
  const since = Number(f.since) || 0;
  const until = Number(f.until) || 0;
  const url = typeof f.url === 'string' ? f.url : ''; // (one page: every visit of it)
  return (v) => {
    if (since && v.time < since) return false;
    if (until && v.time >= until) return false;
    if (url && v.url !== url) return false;
    if (site) {
      const h = hostOf(v.url);
      if (h !== site && (f.exact || !h.endsWith('.' + site))) return false;
    }
    if (words.length) {
      const s = hay(v);
      for (const w of words) if (!s.includes(w)) return false;
    }
    return true;
  };
}

// (nothing narrows it: every visit)
const isEmpty = (f = {}) => !String(f.text || '').trim() && !cleanHost(f.host) && !Number(f.since) && !Number(f.until) && !f.url;

const nameKey = (v) => fold(v.title || v.url).replace(/^[^\p{L}\p{N}]+/u, '');
const byName = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);

// { rows, total, count }: total the visits matching (what deleting them removes), count the rows
// there are to page through (the pages, once each, for 'most').
function find(visits, f = {}) {
  const ok = matcher(f);
  const sort = f.sort || 'new';
  const limit = Math.max(1, Math.min(2000, Number(f.limit) || 120));
  const offset = Math.max(0, Number(f.offset) || 0);
  if (sort === 'new' || sort === 'old') {
    const rows = [];
    let total = 0;
    const take = (v) => {
      if (!ok(v)) return;
      if (total >= offset && rows.length < limit) rows.push(v);
      total++;
    };
    if (sort === 'new') for (let i = visits.length - 1; i >= 0; i--) take(visits[i]);
    else for (const v of visits) take(v);
    return { rows, total, count: total };
  }
  const hits = visits.filter(ok);
  let list;
  if (sort === 'most') {
    const byUrl = new Map();
    for (const v of hits) {
      const p = byUrl.get(v.url);
      if (!p) byUrl.set(v.url, { ...v, visits: 1 });
      else {
        p.visits++;
        if (v.time > p.time) Object.assign(p, { id: v.id, time: v.time, title: v.title || p.title, favicon: v.favicon || p.favicon });
      }
    }
    list = [...byUrl.values()].sort((a, b) => b.visits - a.visits || b.time - a.time);
  } else {
    list = hits.map((v) => ({ v, k: nameKey(v) })).sort(byName);
    if (sort === 'za') list.reverse();
    list = list.map((x) => x.v);
  }
  return { rows: list.slice(offset, offset + limit), total: hits.length, count: list.length };
}

// The sites of the visits matching: { rows: [{ host, visits, last, title, favicon }], total, count }.
function domains(visits, f = {}) {
  const ok = matcher(f);
  const sort = f.sort || 'most';
  const limit = Math.max(1, Math.min(5000, Number(f.limit) || 300));
  const offset = Math.max(0, Number(f.offset) || 0);
  const by = new Map();
  let total = 0;
  for (const v of visits) {
    if (!ok(v)) continue;
    total++;
    const host = hostOf(v.url);
    if (!host) continue;
    const d = by.get(host);
    if (!d) by.set(host, { host, visits: 1, last: v.time, title: v.title || '', favicon: v.favicon || '' });
    else {
      d.visits++;
      if (v.time >= d.last) {
        d.last = v.time;
        if (v.title) d.title = v.title;
      }
      if (v.favicon && (v.time >= d.last || !d.favicon)) d.favicon = v.favicon;
    }
  }
  let list = [...by.values()];
  if (sort === 'least') list.sort((a, b) => a.visits - b.visits || b.last - a.last);
  else if (sort === 'recent') list.sort((a, b) => b.last - a.last);
  else if (sort === 'az' || sort === 'za') {
    list = list.map((d) => ({ d, k: fold(d.host) })).sort(byName).map((x) => x.d);
    if (sort === 'za') list.reverse();
  } else list.sort((a, b) => b.visits - a.visits || b.last - a.last);
  return { rows: list.slice(offset, offset + limit), total, count: list.length };
}

// The visits left once the ones matching are taken out, and how many went.
function without(visits, f = {}) {
  const ok = matcher(f);
  const keep = visits.filter((v) => !ok(v));
  return { keep, removed: visits.length - keep.length };
}

// What the address bar offers from the history for what is typed: each page once, scored by how
// often and how lately it was opened, more when the site's name starts with what is typed, the
// words start words of the title, or it is a site's front page; a site opened often and starting
// with it comes as its front page too.
function suggest(visits, text, limit = 6) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).map(fold);
  if (!words.length) return [];
  const one = words.length === 1 ? words[0].replace(/^[a-z]+:\/\/(www\.)?/, '').replace(/^www\./, '') : '';
  const now = Date.now();
  const byUrl = new Map();
  const sites = new Map();
  for (let i = visits.length - 1; i >= 0; i--) {
    const v = visits[i];
    const s = hay(v);
    let all = true;
    for (const w of words) if (!s.includes(w)) all = false;
    const host = hostOf(v.url);
    const siteHit = one && host.startsWith(one);
    if (!all && !siteHit) continue;
    const age = (now - v.time) / 86400000;
    const w = age < 1 ? 100 : age < 4 ? 80 : age < 14 ? 60 : age < 31 ? 40 : age < 90 ? 20 : 10;
    if (siteHit) {
      const d = sites.get(host) || { host, score: 0, title: '', favicon: '', scheme: /^http:/i.test(v.url) ? 'http' : 'https' };
      d.score += w;
      if (!d.favicon && v.favicon) d.favicon = v.favicon;
      sites.set(host, d);
    }
    if (!all) continue;
    const hit = byUrl.get(v.url);
    if (hit) {
      hit.score += w;
      continue;
    }
    const title = fold(v.title || '');
    let bonus = 0;
    if (one && host.startsWith(one)) bonus += 400;
    else if (one && host.split('.').some((label) => label.startsWith(one))) bonus += 150;
    for (const word of words) if (title.startsWith(word) || title.includes(' ' + word)) bonus += 40;
    let root = false;
    try {
      const u = new URL(v.url);
      root = (u.pathname === '/' || u.pathname === '') && !u.search;
    } catch {
      /* not an address */
    }
    if (root) bonus += 30;
    byUrl.set(v.url, { url: v.url, title: v.title, favicon: v.favicon, score: w + bonus, root, host });
  }
  // (a site of its own, at its front page, when it is opened often and no front page of it is there)
  for (const d of sites.values()) {
    if ([...byUrl.values()].some((x) => x.root && x.host === d.host)) continue;
    if (d.score < 150) continue;
    const url = `${d.scheme}://${d.host}/`;
    if (!byUrl.has(url)) byUrl.set(url, { url, title: d.host, favicon: d.favicon, score: 380 + Math.min(d.score, 600) / 10, root: true, host: d.host });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ url, title, favicon }) => ({ url, title, favicon }));
}

module.exports = { fold, hostOf, parse, matcher, isEmpty, find, domains, without, suggest };
