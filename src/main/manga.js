'use strict';
// Tải truyện tranh: the comic chapter shown in a tab - its page pictures found in the page as it is (lazily
// loaded ones by their real addresses), in reading order, without the site's ads, logos and thumbnails; the
// series' and the chapter's names; the link to the next chapter - downloaded with the tab's own session (its
// cookies, the page as referrer) into the download folder as "<series> - <chapter>.zip" (the default), a
// .cbz for comic reader apps (with a ComicInfo.xml), or a folder "<series> - <chapter>" of pictures.
// Each file is checked to be a picture (an error page saved instead is tried again, from the site's other
// servers too) and saved as a PNG: 001.png, 002.png… One row in Tải xuống per chapter, counting pictures.
// Optionally the chapters after it: the tab goes on to each next chapter, which is read the same way (the
// reader frame found in the first).
// The page side runs in a script world of its own in the tab (the page's own scripts never see it). Known
// reader frames first (WordPress Madara and MangaStream, as named in Haruneko's site templates,
// github.com/manga-download/haruneko, Unlicense; the common Vietnamese and English reader sites), else
// the frame holding the most large pictures.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { session, BrowserWindow, nativeImage } = require('electron');
const dljobs = require('./dljobs');
const { fetchFrom, referers, imageData } = require('./mediaprobe');
const { t } = require('./i18n');

const WORLD = 1083; // (the comic reader's script world in tabs)

// ---------------------------------------------------------------- the page side
// (turned into text and run in the tab: it may use nothing from this file)
function pageSide() {
  // the reader frames of well-known reader sites and site engines (a chapter's pictures are inside)
  const READERS = [
    // WordPress Madara, MangaStream (Haruneko's templates)
    '.reading-content',
    'div.page-break',
    '#readarea',
    '#readerarea',
    '.reader-area',
    // NetTruyen / NhatTruyen and their kind, TruyenQQ, BlogTruyen, CuuTruyen-like readers
    '.reading-detail',
    '.page-chapter',
    '.chapter_content',
    '#chapter_content',
    '.chapter-content',
    '#chapter-content',
    '.content-chapter',
    '.chapter-c',
    '.box_doc',
    '#chapter_boxImages',
    // more long vertical readers (the pages one under another, scrolled through)
    '.list-image-detail',
    '.chapter-content-images',
    '.content-image',
    '.chapter_img',
    '.page_chapter',
    '.reading-box',
    '#chapter-reader',
    '.chapter-detail',
    // Manganato / Mangakakalot, Webtoons, MangaPark-like, others
    '.container-chapter-reader',
    '#vungdoc',
    '.vung-doc',
    '#_imageList',
    '.viewer_lst',
    '.chapter-images',
    '.chapter-img',
    '.images-chapter',
    '.comic-reader',
    '.manga-reader',
    '.read-content',
    '#chapter-images',
    '.reader',
    '#reader',
    '.viewer',
    '#viewer',
  ];
  // where the real address of a picture loaded lazily waits
  const LAZY = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'data-cfsrc', 'data-original-src', 'data-aload', 'data-img', 'data-image', 'data-full', 'data-srcset', 'data-lazy-srcset'];
  // stand-in pictures shown until then
  const PLACEHOLDER = /^data:image\/(?:gif|svg\+xml)|(?:^|[/_.-])(?:loading|lazy|placeholder|blank|spacer|pixel|1x1|transparent)[^/]*\.(?:gif|png|svg|jpe?g|webp)(?:$|[?#])/i;
  const AD_URL = /doubleclick|googlesyndication|adservice|adsystem|\/ads?\/|\/banners?\/|popads|adsterra|exoclick|juicyads|propellerads|histats/i;
  // boxes that hold ads, in or out of the reader
  const AD_BOX = '[class*="advert" i], [id*="advert" i], [class~="ads"], [id~="ads"], [class*="ads-" i], [class*="-ads" i], [class*="ads_" i], [class*="_ads" i], [id*="ads-" i], [class*="banner" i], [class*="quangcao" i], [class*="qc-" i]';
  // parts of a page that are not the reader
  const NOT_READER =
    'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [class*="comment" i], [id*="comment" i], [class*="sidebar" i], [id*="sidebar" i], [class*="widget" i], [class*="related" i], [class*="recommend" i], [class*="advert" i], [id*="advert" i], [class*="banner" i], [class~="ads"], [class*="ads-" i], [class*="-ads" i], [id~="ads"], [class*="logo" i], [class*="avatar" i]';
  // "Chapter 12", "Chương 12", "Chap 12.5", "Ep. 3", "Tập 4", "#12", "第12話"…
  const CHAP = /(?:chap(?:ter)?|chương|chuong|ch\.|episode|ep\.?|tập|tap|#)\s*[-:.]?\s*(\d+(?:[.,]\d+)?)|第\s*(\d+(?:\.\d+)?)\s*[話话章]/i;
  // where a site keeps other servers' copies of the picture (switched to when the first fails)
  const SERVERS = ['data-cdn', 'data-sv1', 'data-sv2', 'data-sv3', 'data-server', 'data-server1', 'data-server2', 'data-backup', 'data-src2', 'data-alt', 'data-fallback', 'data-original', 'data-src', 'src'];

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function abs(u, base) {
    try {
      return new URL(String(u).trim(), base).href;
    } catch {
      return '';
    }
  }
  function srcsetBest(s) {
    let best = '';
    let most = -1;
    for (const part of String(s).split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const v = parseFloat(d) || 1;
      if (u && v > most) (best = u), (most = v);
    }
    return best;
  }
  const hasLazy = (img) => LAZY.some((a) => img.hasAttribute(a));

  // the picture's own address: where a lazy loader keeps it, its largest srcset entry, or what it shows
  function realSrc(img, base) {
    for (const a of LAZY) {
      const v = img.getAttribute(a);
      if (!v || !v.trim()) continue;
      const u = a.endsWith('srcset') ? srcsetBest(v) : v;
      if (u && !PLACEHOLDER.test(u)) return abs(u, base);
    }
    const set = img.getAttribute('srcset');
    if (set) {
      const u = srcsetBest(set);
      if (u && !PLACEHOLDER.test(u)) return abs(u, base);
    }
    const s = img.currentSrc || img.getAttribute('src') || '';
    return s && !PLACEHOLDER.test(s) ? abs(s, base) : '';
  }

  // whether the picture it shows is its own (not a stand-in still waiting for the real one)
  function loadedReal(img, base) {
    if (!img.complete || !(img.naturalWidth > 0)) return false;
    const showing = img.currentSrc || img.src || '';
    return !PLACEHOLDER.test(showing) && showing === realSrc(img, base);
  }

  // What size of picture it is: 'page' (a page of a comic: at least 120 px tall, at most four times as
  // wide as tall), 'slice' (a thin strip of one - long vertical readers, webtoons, cut their pages into
  // strips - kept only beside pages or strips of the same width, which an ad banner is not), or false.
  // Loaded, its own size decides (a page's CSS may stretch a banner to the reader's width); not loaded
  // yet, its place on the page. A fetched page (no layout): only what says it is small is left out.
  function sizeKind(img, live, base) {
    if (!live) {
      const w = +img.getAttribute('width') || 0;
      const h = +img.getAttribute('height') || 0;
      return !(w && w < 150) && !(h && h < 40) ? 'page' : false;
    }
    if (loadedReal(img, base)) {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < 300) return false;
      if (h >= 120 && w / h <= 4) return 'page';
      return h >= 40 ? 'slice' : false;
    }
    const r = img.getBoundingClientRect();
    return r.width >= 250 || (r.width === 0 && hasLazy(img)) ? 'page' : false;
  }

  // the picture's other addresses (other servers, the other lazy attributes), after its own
  function altsOf(img, base, url) {
    const out = [];
    for (const a of SERVERS) {
      const v = img.getAttribute(a);
      if (!v || PLACEHOLDER.test(v)) continue;
      const u = abs(v, base);
      if (u && u !== url && /^https?:/i.test(u) && !out.includes(u)) out.push(u);
    }
    return out.slice(0, 4);
  }

  function pick(imgs, base, live) {
    const seen = new Set();
    const out = [];
    for (const img of imgs) {
      const url = realSrc(img, base);
      if (!url || seen.has(url) || AD_URL.test(url) || !/^(?:https?|data|blob):/i.test(url)) continue;
      const kind = sizeKind(img, live, base);
      if (!kind) continue;
      seen.add(url);
      const alts = altsOf(img, base, url);
      out.push({ url, ...(alts.length ? { alts } : {}), kind, w: (live && img.naturalWidth) || +img.getAttribute('width') || 0, h: (live && img.naturalHeight) || +img.getAttribute('height') || 0, el: img });
    }
    // strips: kept when they are as wide as the reader's pages (or, a reader all of strips, as each other)
    const slices = out.filter((x) => x.kind === 'slice');
    if (slices.length) {
      const pages = out.filter((x) => x.kind === 'page' && x.w);
      const ref = (pages.length ? pages : slices).map((x) => x.w).sort((a, b) => a - b);
      const mid = ref[Math.floor(ref.length / 2)] || 0;
      const sameWidth = (x) => mid && Math.abs(x.w - mid) <= mid * 0.03;
      const keep = pages.length ? sameWidth : (x) => sameWidth(x) && slices.filter(sameWidth).length >= 5;
      for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === 'slice' && !keep(out[i])) out.splice(i, 1);
    }
    // (in one reader the pages are about as wide on screen as each other: a far narrower picture is not one)
    if (live && out.length >= 3) {
      const widths = out.map((x) => x.el.getBoundingClientRect().width).filter(Boolean).sort((a, b) => a - b);
      const mid = widths[Math.floor(widths.length / 2)] || 0;
      if (mid)
        return out.filter((x) => {
          const w = x.el.getBoundingClientRect().width;
          return !w || w >= mid * 0.55;
        });
    }
    return out;
  }

  function byKnownFrame(doc, base, live, hint, min) {
    let best = null;
    for (const sel of hint ? [hint, ...READERS] : READERS) {
      let frames;
      try {
        frames = doc.querySelectorAll(sel);
      } catch {
        continue;
      }
      if (!frames.length) continue;
      const imgs = [...frames].flatMap((f) => [...f.querySelectorAll('img')]).filter((img) => !img.closest(AD_BOX));
      const items = pick(imgs, base, live);
      if (items.length >= min && (!best || items.length > best.items.length)) best = { sel, items };
      // (the frame the chapter before was found in: the same site, so the same reader)
      if (sel === hint && best?.sel === hint) return best;
    }
    return best;
  }

  const escapeCss = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));
  // a selector that finds the frame again (in this page, and in the next chapter's)
  function selectorOf(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      if (e.id && !/\d{3,}/.test(e.id)) {
        parts.unshift(`#${escapeCss(e.id)}`);
        break;
      }
      const cls = [...e.classList].filter((c) => !/\d{3,}|active|show|open|loaded|lazy/i.test(c)).slice(0, 2);
      parts.unshift(e.localName + cls.map((c) => `.${escapeCss(c)}`).join(''));
      if (e.localName === 'body') break;
    }
    return parts.join(' > ');
  }

  // no known frame: the element holding the most large pictures (the deepest of equals)
  function byLargestFrame(doc, base, min) {
    const imgs = [...doc.images].slice(0, 2000).filter((img) => !img.closest(NOT_READER) && !img.closest(AD_BOX));
    const good = pick(imgs, base, true);
    if (good.length < min) return null;
    const count = new Map();
    for (const it of good) {
      let a = it.el.parentElement;
      for (let d = 0; a && a !== doc.documentElement && d < 8; d++, a = a.parentElement) count.set(a, (count.get(a) || 0) + 1);
    }
    let frame = null;
    let n = 0;
    for (const [a, c] of count) if (c > n) (frame = a), (n = c);
    if (!frame || n < min) return null;
    return { sel: selectorOf(frame), items: good.filter((it) => frame.contains(it.el)) };
  }

  // the series' and the chapter's names: from the breadcrumbs, the heading, the title, the address
  function names(doc, url) {
    const u = new URL(url);
    const site = u.hostname.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const siteish = (s) => {
      const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
      return !k || (site && k.includes(site)) || /^(?:home|trang chủ|trang chu|truyện tranh|truyen tranh|manga|manhwa|manhua|comics?)$/i.test(s);
    };
    const h1 = clean(doc.querySelector('h1')?.textContent);
    const og = clean(doc.querySelector('meta[property="og:title"]')?.getAttribute('content'));
    const title = clean(doc.title);
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {}
    let chapter = '';
    for (const s of [h1, og, title, p.replace(/[-_/]+/g, ' ')]) {
      const m = CHAP.exec(s || '');
      if (m) {
        chapter = `Chap ${(m[1] || m[2]).replace(',', '.')}`;
        break;
      }
    }
    const crumbs = [...doc.querySelectorAll('.breadcrumb a, .breadcrumbs a, [itemtype*="BreadcrumbList"] a, nav[aria-label*="readcrumb" i] a, .bread-crumb a, .breadcrumb li')]
      .map((a) => clean(a.textContent))
      .filter((s) => s && s.length < 150 && !siteish(s));
    let series = crumbs.filter((c) => !CHAP.test(c)).pop() || '';
    if (!series) {
      for (const s of [h1, og, title]) {
        if (!s) continue;
        const parts = s.split(/\s+[-|–—»:]\s+|\s*\|\s*/).map(clean).filter(Boolean);
        const i = parts.findIndex((x) => CHAP.test(x));
        if (i > 0) series = parts.slice(0, i).filter((x) => !siteish(x)).join(' - ');
        else if (i === 0) series = clean(parts[0].slice(0, CHAP.exec(parts[0]).index));
        if (series) break;
      }
    }
    if (!series) series = (og || title).split(/\s+[-|–—]\s+/).map(clean).find((x) => !siteish(x)) || u.hostname;
    series = series
      .replace(/^(?:đọc truyện|doc truyen|đọc|read)\s+/i, '')
      .replace(/\s*(?:tiếng việt|vietsub|online|raw|free)\s*$/i, '')
      .replace(/[\s:–—-]+$/, '')
      .trim();
    if (!chapter) chapter = clean(p.split('/').filter(Boolean).pop() || '') || 'Chương';
    return { series: series.slice(0, 120), chapter: chapter.slice(0, 80) };
  }

  // the link to the next chapter (rel=next, "Chương sau", "Next chapter", a "next" button)
  function nextLink(doc, url) {
    const here = new URL(url);
    const cands = [...doc.querySelectorAll('link[rel~="next"], a[rel~="next"]')].map((el) => ({ el, score: 4 }));
    for (const a of doc.querySelectorAll('a[href]')) {
      const text = clean(`${a.textContent} ${a.getAttribute('title') || ''} ${a.getAttribute('aria-label') || ''}`).toLowerCase();
      const cls = `${typeof a.className === 'string' ? a.className : ''} ${a.id}`.toLowerCase();
      let s = 0;
      if (/(?:chap(?:ter)?|chương|chuong|episode|tập)\s*(?:sau|tiếp|kế|next)|next\s*(?:chap|chapter|episode)|chương sau|chap sau|tập sau/.test(text)) s += 6;
      else if (/^(?:next|sau|tiếp|tiếp theo|kế tiếp|›|»|>|→|>>|❯)$/.test(text)) s += 3;
      if (/next|(?:^|[-_ ])sau(?:$|[-_ ])/.test(cls) && !/prev|truoc|trước/.test(cls)) s += 3;
      if (/prev|trước|truoc|previous/.test(`${text} ${cls}`)) s -= 6;
      if (s > 0) cands.push({ el: a, score: s });
    }
    let best = null;
    for (const c of cands) {
      let u;
      try {
        u = new URL(c.el.getAttribute('href'), url);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol) || u.hostname !== here.hostname || u.href.split('#')[0] === here.href.split('#')[0]) continue;
      if (c.el.closest('[class*="comment" i], [id*="comment" i]')) continue;
      // (a chapter's address has a number in it)
      const score = c.score + (/\d/.test(u.pathname) ? 1 : -2);
      if (!best || score > best.score) best = { score, href: u.href };
    }
    return best && best.score >= 3 ? best.href : '';
  }

  // a reader that shows one picture per address: its pages, from the page picker
  function pageList(doc, url) {
    const host = new URL(url).hostname;
    for (const sel of doc.querySelectorAll('select')) {
      const opts = [...sel.options];
      if (opts.length < 3) continue;
      const urls = opts.map((o) => {
        const v = o.getAttribute('data-url') || o.value || '';
        try {
          const u = new URL(v, url);
          return /^https?:$/.test(u.protocol) && u.hostname === host && /\D/.test(v) ? u.href : '';
        } catch {
          return '';
        }
      });
      const looks = opts.some((o) => /(?:page|trang|\d+\s*\/\s*\d+)/i.test(o.textContent) || /^\s*\d+\s*$/.test(o.textContent));
      if (looks && urls.filter(Boolean).length >= opts.length * 0.8) return [...new Set(urls.filter(Boolean))];
    }
    return [];
  }

  // a small picture of a loaded page, for the panel (only one of the page's own site can be read so; the
  // others are made by TyranWeb from the picture fetched again)
  function thumbOf(img, base) {
    try {
      if (!loadedReal(img, base)) return {};
      const w = 96;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = Math.min(160, Math.round((img.naturalHeight / img.naturalWidth) * w)) || 128;
      c.getContext('2d').drawImage(img, 0, 0, w, Math.round((img.naturalHeight / img.naturalWidth) * w));
      return { thumb: c.toDataURL('image/jpeg', 0.72) };
    } catch {
      return {};
    }
  }

  // The chapter in `doc` (the page as shown, or `live: false` for a fetched one): its pictures in order,
  // names, the reader frame's selector (to find it again in the next chapter), the next chapter's link.
  function scanDocument(doc, url, { live = true, hint = '', min = 3 } = {}) {
    const base = live ? doc.baseURI || url : url;
    const found = byKnownFrame(doc, base, live, hint, min) || (live ? byLargestFrame(doc, base, min) : null);
    const items = (found?.items || []).map(({ url: u, alts, w, h, el }, i) => ({ url: u, ...(alts ? { alts } : {}), w, h, ...(live && i < 150 ? thumbOf(el, base) : {}) }));
    const res = { url, host: new URL(url).hostname, ...names(doc, url), items, selector: found?.sel || '', next: nextLink(doc, url), paged: false, pageUrls: [], pending: 0 };
    if (live && found) res.pending = found.items.filter((it) => !loadedReal(it.el, base)).length;
    if (items.length <= 2) {
      const pages = pageList(doc, url);
      if (pages.length >= 3) Object.assign(res, { paged: true, pageUrls: pages });
    }
    return res;
  }

  // scrolls down the page and back, so the pictures it loads only when reached are loaded
  async function autoScroll() {
    const start = scrollY;
    const step = Math.max(500, innerHeight * 0.9);
    let last = -1;
    let same = 0;
    for (let i = 0; i < 150; i++) {
      scrollBy({ top: step, behavior: 'instant' });
      await sleep(110);
      const y = scrollY;
      if (y === last) {
        if (++same >= 4) break;
      } else same = 0;
      last = y;
    }
    await sleep(500);
    scrollTo({ top: start, behavior: 'instant' });
  }

  return {
    // The chapter's pictures. Lazy ones are known by the address they wait with; when too few are found
    // (a reader that fills itself in by script as it is scrolled), the page is scrolled through once and
    // read again. `scroll`: scroll through it first anyway.
    async scan({ scroll = false, hint = '' } = {}) {
      const read = () => scanDocument(document, location.href, { hint });
      if (scroll) await autoScroll();
      let r = read();
      if (!scroll && r.items.length < 3 && !r.paged) {
        await autoScroll();
        r = read();
      }
      return r;
    },
    // how many comic pages the page seems to show (for the address bar's hint; 0: not a comic)
    count() {
      try {
        const found = byKnownFrame(document, location.href, true, '', 4) || byLargestFrame(document, location.href, 4);
        return found ? found.items.length : 0;
      } catch {
        return 0;
      }
    },
    // a one-picture-per-address reader's pages: each fetched (with the user's session) and its picture found
    async pages(urls, hint) {
      const out = [];
      for (const u of urls.slice(0, 500)) {
        try {
          const res = await fetch(u, { credentials: 'include' });
          const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
          const r = scanDocument(doc, u, { live: false, hint, min: 1 });
          if (r.items[0]) out.push(r.items[0]);
        } catch {}
      }
      return out;
    },
    // a picture the page made itself (blob:…): only the page can read it
    async blob(url) {
      try {
        const b = await (await fetch(url)).blob();
        return await new Promise((ok) => {
          const fr = new FileReader();
          fr.onload = () => ok(fr.result);
          fr.onerror = () => ok(null);
          fr.readAsDataURL(b);
        });
      } catch {
        return null;
      }
    },
  };
}

const PAGE_SIDE = `(${pageSide.toString()})()`;
// runs `call` (a method of the page side, with its arguments) in the tab's page
function inPage(wc, call) {
  return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(window.__tyranManga || (window.__tyranManga = ${PAGE_SIDE})).${call}` }]);
}

// ---------------------------------------------------------------- the address bar's hint
// A page that shows four or more comic pages: the address bar offers to download them (read a moment after
// the page has loaded, and again a little later for readers that fill themselves in).
function watch(contents) {
  let shown = false;
  let timers = [];
  const tell = (count) => contents.hostWebContents?.send('manga:hint', { wcId: contents.id, count });
  const check = async () => {
    if (contents.isDestroyed() || !/^https?:/i.test(contents.getURL())) return;
    const n = await inPage(contents, 'count()').catch(() => 0);
    if (contents.isDestroyed()) return;
    if (n >= 4 || shown) tell(n);
    shown = n >= 4;
  };
  const later = () => {
    for (const x of timers) clearTimeout(x);
    timers = [1500, 5000].map((ms) => setTimeout(check, ms));
  };
  contents.on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isSameDocument) return;
    for (const x of timers) clearTimeout(x);
    if (shown) tell(0);
    shown = false;
  });
  contents.on('did-finish-load', later);
  contents.on('did-navigate-in-page', (e, url, isMainFrame) => isMainFrame && later());
  contents.once('destroyed', () => timers.forEach(clearTimeout));
}

// ---------------------------------------------------------------- downloads
// (at most 4 pictures at once, over all chapters: kind to the site)
const slots = { free: 4, waiting: [] };
async function slot() {
  if (slots.free > 0) return void slots.free--;
  await new Promise((r) => slots.waiting.push(r));
}
function release() {
  const next = slots.waiting.shift();
  if (next) next();
  else slots.free++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const safeName = (s, fallback) =>
  String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 100) || fallback;

// what the file really is, by its first bytes (null: not a picture - an error page, most likely)
function pictureKind(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return '.png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return '.webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return '.avif';
  if (b[0] === 0x42 && b[1] === 0x4d) return '.bmp';
  return null;
}

function dataBytes(url) {
  const i = url.indexOf(',');
  const head = url.slice(0, i);
  const body = url.slice(i + 1);
  return /;base64/i.test(head) ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
}

// ---------------------------------------------------------------- every picture as a PNG
// A JPEG is turned into a PNG by Electron itself; a WebP, AVIF, GIF (its first frame) or BMP is drawn in a
// hidden page of its own (nothing loaded in it, closed a minute after its last picture) and taken back as
// a PNG.
let painter = null; // { win, ready }
let painterIdle = null;
function painterPage() {
  clearTimeout(painterIdle);
  painterIdle = setTimeout(() => {
    if (painter && !painter.win.isDestroyed()) painter.win.destroy();
    painter = null;
  }, 60000);
  if (painter && !painter.win.isDestroyed()) return painter.ready;
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  painter = { win, ready: win.loadURL('about:blank').then(() => win) };
  return painter.ready;
}

async function painted(buf) {
  const win = await painterPage();
  return win.webContents.executeJavaScript(`(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:application/octet-stream;base64,' + b64)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    const png = await c.convertToBlob({ type: 'image/png' });
    return await new Promise((ok, no) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result);
      fr.onerror = no;
      fr.readAsDataURL(png);
    });
  })(${JSON.stringify(buf.toString('base64'))})`);
}

// the picture as a PNG (null: it could not be turned into one)
async function asPng(buf, kind) {
  if (kind === '.png') return buf;
  try {
    if (kind === '.jpg') {
      const img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) return img.toPNG();
    }
    const png = dataBytes(await painted(buf));
    return pictureKind(png) === '.png' ? png : null;
  } catch (e) {
    console.error('manga: to PNG', e?.message || e);
    return null;
  }
}

// ---------------------------------------------------------------- the chapter's zip
// A zip written as its pictures come (in any order; listed by name at the end), each stored as it is (a
// PNG is squeezed already), names in UTF-8. Written as <file>.part, so a chapter downloaded again replaces
// its file only once the new one is whole; no folder is made for it.
class ZipOut {
  constructor(file) {
    this.file = file;
    this.tmp = `${file}.part`;
    this.fd = fs.openSync(this.tmp, 'w');
    this.at = 0;
    this.list = [];
    const d = new Date();
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    this.date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  }
  add(name, data) {
    const n = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // names in UTF-8
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(this.time, 10);
    head.writeUInt16LE(this.date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    // (header and picture written at once: no other picture can come between them)
    fs.writeSync(this.fd, Buffer.concat([head, n]));
    fs.writeSync(this.fd, data);
    this.list.push({ n, crc, size: data.length, at: this.at });
    this.at += 30 + n.length + data.length;
  }
  // the zip finished; returns where it is (beside it, under a new name, when the old one cannot be replaced)
  close() {
    const parts = [];
    for (const e of [...this.list].sort((a, b) => Buffer.compare(a.n, b.n))) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); // made by
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(this.time, 12);
      c.writeUInt16LE(this.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.n.length, 28);
      c.writeUInt32LE(e.at, 42); // where its header is
      parts.push(c, e.n);
    }
    const dir = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.list.length, 8);
    end.writeUInt16LE(this.list.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.at, 16);
    fs.writeSync(this.fd, Buffer.concat([dir, end]));
    fs.closeSync(this.fd);
    try {
      fs.renameSync(this.tmp, this.file);
    } catch {
      this.file = dljobs.unique(this.file);
      fs.renameSync(this.tmp, this.file);
    }
    return this.file;
  }
  abort() {
    try {
      fs.closeSync(this.fd);
    } catch {}
    fs.rmSync(this.tmp, { force: true });
  }
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// a .cbz's ComicInfo.xml, which comic readers (Komga, Kavita, Mihon…) read the series and the chapter's
// number from
function comicInfo(job) {
  const num = /(\d+(?:\.\d+)?)/.exec(job.chapter)?.[1] || '';
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    `  <Series>${xmlEscape(job.run.series)}</Series>`,
    `  <Title>${xmlEscape(job.chapter)}</Title>`,
    ...(num ? [`  <Number>${num}</Number>`] : []),
    `  <PageCount>${job.done}</PageCount>`,
    `  <Web>${xmlEscape(job.page)}</Web>`,
    '</ComicInfo>',
    '',
  ].join('\n');
  return Buffer.from(xml, 'utf8');
}

function report(job, now = false) {
  job.row.update({ pagesDone: job.done, pagesTotal: job.total, pagesFailed: job.failed, receivedBytes: job.bytes }, now);
}

// One picture, checked to be a picture: from its own address, then the other servers the site named for
// it (Vietnamese readers keep backups in data-cdn, data-sv1…), then its own once more - up to five tries.
// Saved as <number>.png, into the chapter's zip or folder.
async function fetchOne(job, item, index) {
  const name = String(index + 1).padStart(Math.max(3, String(job.total).length), '0');
  const order = [item.url, ...(Array.isArray(item.alts) ? item.alts : [])].filter((u) => typeof u === 'string' && /^(?:https?|data|blob):/i.test(u));
  if (!order.length) return false;
  const tries = Math.min(5, Math.max(3, order.length + 1));
  const run = job.run;
  for (let attempt = 0; attempt < tries && !run.cancelled; attempt++) {
    const url = order[attempt % order.length];
    try {
      let buf;
      if (url.startsWith('data:')) buf = dataBytes(url);
      else if (url.startsWith('blob:')) {
        const d = await inPage(run.wc, `blob(${JSON.stringify(url)})`);
        if (!d) throw new Error('blob');
        buf = dataBytes(d);
      } else {
        const ctrl = new AbortController();
        run.live.add(ctrl);
        try {
          const res = await fetchFrom(run.ses, url, job.page, { signal: ctrl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buf = Buffer.from(await res.arrayBuffer());
        } finally {
          run.live.delete(ctrl);
        }
      }
      const kind = pictureKind(buf);
      if (!kind) throw new Error('not a picture');
      // (as it came only when it cannot be turned into a PNG: better than losing the page)
      const png = await asPng(buf, kind);
      const data = png || buf;
      if (run.cancelled) break;
      if (job.zip) job.zip.add(name + (png ? '.png' : kind), data);
      else await fs.promises.writeFile(path.join(job.dir, name + (png ? '.png' : kind)), data);
      job.bytes += data.length;
      return true;
    } catch {
      if (run.cancelled) break;
      // (another server next: no need to wait; the same one again: a moment)
      if (order.length === 1 || attempt + 1 >= order.length) await sleep(1500 * (attempt + 1));
    }
  }
  return false;
}

async function runChapter(job) {
  const run = job.run;
  try {
    if (job.ext) job.zip = new ZipOut(job.out);
    else await fs.promises.mkdir(job.dir, { recursive: true });
    // (a reader with one picture per address: its pages are read first)
    if (job.pageUrls.length && !job.items.length) {
      job.items = ((await inPage(run.wc, `pages(${JSON.stringify(job.pageUrls)}, ${JSON.stringify(job.selector)})`).catch(() => null)) || []).filter((x) => x && typeof x.url === 'string');
      job.total = job.items.length;
      report(job, true);
    }
    let next = 0;
    const worker = async () => {
      while (!run.cancelled && next < job.items.length) {
        const i = next++;
        await slot();
        try {
          if (run.cancelled) return;
          (await fetchOne(job, job.items[i], i)) ? job.done++ : job.failed++;
        } finally {
          release();
        }
        report(job);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    console.error('manga: chapter', e);
  }
  let out = job.ext ? job.out : job.dir;
  if (job.zip) {
    try {
      if (run.cancelled || !job.done) throw new Error('nothing to keep');
      if (job.ext === '.cbz') job.zip.add('ComicInfo.xml', comicInfo(job));
      out = job.zip.close();
    } catch (e) {
      if (!run.cancelled && job.done) console.error('manga: packing', e);
      job.zip.abort();
      out = '';
    }
  } else if (!job.done) {
    // (a folder that got nothing)
    await fs.promises.rmdir(job.dir).catch(() => {});
    out = '';
  }
  const state = run.cancelled ? 'cancelled' : job.done && out ? 'completed' : 'interrupted';
  let size = job.bytes;
  try {
    if (out && fs.statSync(out).isFile()) size = fs.statSync(out).size;
  } catch {}
  job.row.finish(state, { path: out || job.out || job.dir, pagesDone: job.done, pagesTotal: job.total, pagesFailed: job.failed, receivedBytes: size, totalBytes: state === 'completed' ? size : 0 });
}

function addChapter(run, ch) {
  const chapter = safeName(ch.chapter, `${t('Chương')} ${run.jobs.length + 1}`);
  const ext = run.format === 'folder' ? '' : `.${run.format}`;
  // (named after the series and the chapter, right in the download folder: "One Piece - Chap 1.zip")
  const base = safeName(`${run.series.slice(0, 90)} - ${chapter.slice(0, 60)}`, chapter);
  const items = (Array.isArray(ch.items) ? ch.items : []).filter((x) => x && typeof x.url === 'string').slice(0, 2000);
  const pageUrls = ch.paged && Array.isArray(ch.pageUrls) ? ch.pageUrls.filter((u) => typeof u === 'string').slice(0, 500) : [];
  const job = {
    run,
    chapter,
    page: String(ch.page || ''),
    selector: String(ch.selector || ''),
    items,
    pageUrls,
    ext,
    dir: ext ? '' : path.join(run.root, base),
    out: ext ? path.join(run.root, base + ext) : '',
    zip: null,
    total: items.length || pageUrls.length,
    done: 0,
    failed: 0,
    bytes: 0,
  };
  job.row = dljobs.start({
    url: job.page,
    path: job.out || job.dir,
    mime: { '.zip': 'application/zip', '.cbz': 'application/vnd.comicbook+zip' }[ext] || 'inode/directory',
    private: run.private,
    cancel: () => cancel(run),
    extra: { unit: 'pages', label: base + ext, pagesDone: 0, pagesTotal: job.total, pagesFailed: 0 },
  });
  run.jobs.push(job);
  runChapter(job);
  return job;
}

// sends the tab to `url` and waits until its page has loaded (and a moment for its scripts)
function goTo(wc, url) {
  return new Promise((done) => {
    if (wc.isDestroyed()) return done(false);
    let over = false;
    const end = (v) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (!wc.isDestroyed()) wc.off('did-stop-loading', stopped);
      if (v) setTimeout(() => done(!wc.isDestroyed()), 1500);
      else done(false);
    };
    const stopped = () => !wc.isLoadingMainFrame() && wc.getURL() !== 'about:blank' && end(true);
    const timer = setTimeout(() => end(true), 45000);
    wc.on('did-stop-loading', stopped);
    wc.once('destroyed', () => end(false));
    wc.loadURL(url).catch(() => {});
  });
}

function cancel(run) {
  if (run.cancelled) return;
  run.cancelled = true;
  for (const c of run.live) c.abort();
}

// ---------------------------------------------------------------- what the interface asks
// the chapter shown in the tab
function scan(wc, opts = {}) {
  if (!/^https?:/i.test(wc.getURL())) throw new Error(t('Mở trang đọc một chương truyện trước đã'));
  return inPage(wc, `scan(${JSON.stringify({ scroll: !!opts.scroll, hint: String(opts.hint || '') })})`);
}

// small pictures of the chapter's pages the page could not make itself (at most 150, six at a time),
// fetched in the tab's session with the page as referrer
async function thumbs(wc, urls) {
  const ses = wc.session;
  referers(ses);
  const page = wc.getURL();
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && /^https?:/i.test(u)).slice(0, 150);
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const url = list[next++];
      const thumb = await imageData(ses, url, page, 96).catch(() => '');
      if (thumb) out.push({ url, thumb });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

const isPrivate = (wc) => wc.session === session.fromPartition(require('./sessions').PRIVATE_PARTITION);

// Starts downloading the chapter the panel showed (the user's names and choice of pictures), then, `next`
// times, the chapter after it. Returns the first chapter's row id.
function start(wc, a = {}) {
  referers(wc.session);
  const g = require('./data').settings.data.general;
  const run = {
    wc,
    ses: wc.session,
    private: isPrivate(wc),
    series: safeName(a.series, t('Truyện tranh')),
    root: dljobs.dir(),
    scroll: !!a.scroll,
    format: ['zip', 'cbz', 'folder'].includes(a.format) ? a.format : ['zip', 'cbz', 'folder'].includes(g.mangaFormat) ? g.mangaFormat : 'zip',
    cancelled: false,
    jobs: [],
    live: new Set(),
  };
  const first = addChapter(run, { chapter: a.chapter, items: a.items, page: a.page || wc.getURL(), selector: a.selector, paged: a.paged, pageUrls: a.pageUrls });
  let left = Math.max(0, Math.min(200, Number(a.next) || 0));
  (async () => {
    let next = typeof a.nextUrl === 'string' && /^https?:/i.test(a.nextUrl) ? a.nextUrl : '';
    let hint = String(a.selector || '');
    const seen = new Set([first.page]);
    while (left-- > 0 && next && !seen.has(next) && !run.cancelled) {
      seen.add(next);
      if (!(await goTo(wc, next)) || run.cancelled) break;
      let s;
      try {
        s = await scan(wc, { scroll: run.scroll, hint });
      } catch {
        break;
      }
      if (!s || (!s.items.length && !s.paged)) break;
      addChapter(run, { chapter: s.chapter, items: s.items, page: s.url, selector: s.selector || hint, paged: s.paged, pageUrls: s.pageUrls });
      next = s.next;
      hint = s.selector || hint;
    }
  })();
  return first.row.rec.id;
}

module.exports = { watch, scan, thumbs, start };
