'use strict';
// Kết quả tìm kiếm ở (general.searchRegion, '' the engine's own choice): the country the search
// engines tailor their results to, as their own region settings do, by the parameter each reads on
// its results pages: Google gl, Bing cc, DuckDuckGo kl (its own region codes), Brave Search country.
// A step of the sessions' webRequest chain (webrequest.js, 'region') adds it to a results page asked
// for without one, so searches from the address bar, the new tab page and the engines' own pages all
// get it. Other engines (Cốc Cốc...) have no such parameter and are left as they are.
const data = require('./data');

// DuckDuckGo's regions (its Settings → Region), by country
const DDG = Object.fromEntries(
  'ar-es au-en at-de be-fr br-pt bg-bg ca-en cl-es cn-zh co-es hr-hr cz-cs dk-da ee-et fi-fi fr-fr de-de gr-el hk-tzh hu-hu is-is in-en id-en ie-en il-en it-it jp-jp kr-kr lv-lv lt-lt my-en mx-es nl-nl nz-en no-no pk-en pe-es ph-en pl-pl pt-pt ro-ro ru-ru xa-ar sg-en sk-sk sl-sl za-en es-es se-sv ch-de tw-tzh th-en tr-tr us-en ua-uk uk-en vn-en'
    .split(' ')
    .map((code) => {
      const cc = code.split('-')[0];
      return [{ uk: 'gb', xa: 'sa', sl: 'si' }[cc] || cc, code];
    })
);

const ENGINES = [
  { param: 'gl', page: (u) => /^(www\.)?google(\.com?)?\.[a-z]{2,3}$/.test(u.hostname) && u.pathname === '/search', value: (cc) => cc },
  { param: 'cc', page: (u) => /^(www\.|cn\.)?bing\.com$/.test(u.hostname) && /^\/(images\/|videos\/|news\/|shop\/)?search$/.test(u.pathname), value: (cc) => cc },
  { param: 'kl', page: (u) => /^(html\.|lite\.)?duckduckgo\.com$/.test(u.hostname) && /^\/(html\/?|lite\/?)?$/.test(u.pathname) && u.searchParams.has('q'), value: (cc) => DDG[cc] },
  { param: 'country', page: (u) => u.hostname === 'search.brave.com' && /^\/(search|images|videos|news)$/.test(u.pathname), value: (cc) => cc },
];
// the engines' suggestions for the address bar, in the same country
const SUGGEST = [
  { param: 'gl', page: (u) => u.hostname === 'suggestqueries.google.com', value: (cc) => cc },
  { param: 'kl', page: (u) => u.hostname === 'duckduckgo.com' && u.pathname === '/ac/', value: (cc) => DDG[cc] },
];

const region = () => {
  const cc = String(data.settings.data.general.searchRegion || '').toLowerCase();
  return /^[a-z]{2}$/.test(cc) ? cc : '';
};

// the engine whose results page (or suggestion list) an address is, and the address parsed
function pageOf(url, list = ENGINES) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const e = list.find((x) => x.page(u));
  return e ? { e, u } : null;
}

// the address with the region's parameter added after the others (the rest of it left as written)
function added(p, v) {
  p.u.search = (p.u.search ? p.u.search + '&' : '?') + p.e.param + '=' + encodeURIComponent(v);
  return p.u.href;
}

function step(d, cb) {
  const cc = region();
  if (!cc || d.method !== 'GET' || (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame' && d.resourceType !== 'xhr')) return cb({});
  const p = pageOf(d.url);
  const v = p && p.e.value(cc);
  if (!v || p.u.searchParams.has(p.e.param)) return cb({});
  cb({ redirectURL: added(p, v) });
}

// A results page asked for again in the region now chosen (its parameter replaced, or taken off for
// the engine's own choice); other addresses as they are.
function regionUrl(url) {
  const p = pageOf(url);
  if (!p) return url;
  p.u.searchParams.delete(p.e.param);
  const v = region() && p.e.value(region());
  return v ? added(p, v) : p.u.href;
}

// an engine's suggestion address, in the region
function suggestUrl(url) {
  const p = pageOf(url, SUGGEST);
  const v = p && region() && p.e.value(region());
  return v && !p.u.searchParams.has(p.e.param) ? added(p, v) : url;
}

module.exports = { step, regionUrl, suggestUrl, isResultsPage: (url) => !!pageOf(url) };
