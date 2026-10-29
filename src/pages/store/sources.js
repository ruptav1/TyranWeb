// The sites the store searches, read the way their pages are made (2026-10). Each source gives the
// address of a list page (a search, or its anime wallpapers when nothing is searched), reads the
// cards on it, and reads a card's own page for its video: the files there (4K, HD...), their sizes
// and resolutions, its date, tags and where it came from. Pages are fetched by main (livewalls.js)
// and parsed here, inert (DOMParser runs no scripts).
//
// An item: { id, site, page, title, thumb, preview, width, height, tags, date, ai, files: [{ label,
// file, width, height, bytes }], origin, read }

const num = (s) => Number(String(s ?? '').replace(/[^\d.]/g, '')) || 0;
// "46.3 MB", "14.7 mb", "(50.1Mb)" → bytes
export const bytesOf = (s) => {
  const m = /([\d.]+)\s*([KMG])i?B/i.exec(String(s || ''));
  return m ? Math.round(Number(m[1]) * 1024 ** { K: 1, M: 2, G: 3 }[m[2].toUpperCase()]) : 0;
};
const resOf = (s) => {
  const m = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(String(s || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
};
const abs = (url, base) => {
  try {
    return new URL(url, base).href;
  } catch {
    return '';
  }
};
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
// WordPress puts a post's tags and resolution in its classes: tag-elf, resolutions-3840x2160
const classTags = (el) => [...(el?.classList || [])].filter((c) => c.startsWith('tag-')).map((c) => c.slice(4));
const classRes = (el) => resOf([...(el?.classList || [])].find((c) => /^(resolutions|category)-.*\d{3,5}x\d{3,5}/.test(c)) || '');

// Made with AI, as the sites mark it (a tag, or the title): left out of the store
// (not a bare "ai": Ai Hoshino and her like are tagged by their names)
const AI_TAGS = /^(ai-art|ai-arts|ai-generated|ai-generated-art|ai-artwork|ai-animation|stable-diffusion|midjourney|novelai|niji-journey)(-z|-\d)?$/i;
export const isAi = (item) => (item.tags || []).some((t) => AI_TAGS.test(String(t).toLowerCase().replace(/\s+/g, '-'))) || /\bAI[\s-]*(art|generated|animation|artwork)\b|[([]AI[)\]]/i.test(item.title || '');

const wpSearch = (home, q, p) => (p > 1 ? `${home}page/${p}/?s=${encodeURIComponent(q)}` : `${home}?s=${encodeURIComponent(q)}`);
const wpList = (cat, p) => (p > 1 ? `${cat}page/${p}/` : cat);

export const SOURCES = [
  {
    id: 'moewalls',
    name: 'MoeWalls',
    site: 'https://moewalls.com/',
    list: (q, p) => (q ? wpSearch('https://moewalls.com/', q, p) : wpList('https://moewalls.com/category/anime/', p)),
    cards(doc, base) {
      return [...doc.querySelectorAll('article')].flatMap((art) => {
        const a = art.querySelector('a.g1-frame[href]') || art.querySelector('a[href][title]');
        const img = art.querySelector('img');
        if (!a || !img) return [];
        const thumb = abs(img.getAttribute('src'), base);
        // (its preview: /wp-content/uploads/2026/10/<name>-thumb-364x205.jpg → …/preview/2026/<name>-preview.webm)
        const m = /\/wp-content\/uploads\/(\d{4})\/\d{2}\/(.+?)-thumb(?:-\d+x\d+)?\.\w+$/.exec(new URL(thumb, base).pathname);
        const big = (img.getAttribute('srcset') || '').split(',').map((s) => s.trim().split(' ')[0]).find((u) => /-728x410\./.test(u));
        return [{ page: abs(a.getAttribute('href'), base), title: a.getAttribute('title') || text(art.querySelector('.entry-title')), thumb: abs(big || thumb, base), preview: m ? abs(`/wp-content/uploads/preview/${m[1]}/${m[2]}-preview.webm`, base) : '', tags: classTags(art), ...classRes(art) }];
      });
    },
    read(doc, base, item) {
      const info = {};
      for (const li of doc.querySelectorAll('.g1-card-simple li')) {
        const k = text(li.querySelector('em'));
        if (k) info[k.toLowerCase()] = text(li).slice(k.length).trim();
      }
      const jump = doc.querySelector('.g1-card-simple form[action*="jump.php?url="]')?.getAttribute('action') || '';
      let origin = '';
      try {
        origin = new URL(atob(decodeURIComponent(jump.split('url=')[1] || ''))).hostname.replace(/^www\./, '');
      } catch {
        /* none */
      }
      const btn = doc.querySelector('#moe-download[data-url]');
      const res = resOf(info.resolution).width ? resOf(info.resolution) : { width: item.width, height: item.height };
      const tags = [...doc.querySelectorAll('a[rel=tag][href*="/tag/"]')].map((a) => a.getAttribute('href').split('/tag/')[1].replace(/\/$/, ''));
      return {
        date: info.date || '',
        origin,
        tags: tags.length ? tags : item.tags,
        ...res,
        files: btn ? [{ label: res.height >= 2160 ? '4K' : res.height ? `${res.height}p` : '', file: `https://go.moewalls.com/download.php?video=${btn.dataset.url}`, ...res, bytes: bytesOf(info['file size']) }] : [],
      };
    },
  },
  {
    id: 'motionbgs',
    name: 'MotionBGs',
    site: 'https://motionbgs.com/',
    list: (q, p) => (q ? `https://motionbgs.com/search?q=${encodeURIComponent(q)}${p > 1 ? `&page=${p}` : ''}` : `https://motionbgs.com/tag:anime/${p > 1 ? `${p}/` : ''}`),
    cards(doc, base) {
      return [...doc.querySelectorAll('.tmb > a[href]')].flatMap((a) => {
        const src = [...a.querySelectorAll('source, img')].map((s) => (s.getAttribute('srcset') || s.getAttribute('src') || '').split(' ')[0]).find((s) => /\/media\/\d+\//.test(s) && !/\.webp$/.test(s)) || '';
        const m = /\/media\/(\d+)\/([^/.]+)\.(\d+x\d+)\./.exec(src);
        if (!m) return [];
        return [{ page: abs(a.getAttribute('href'), base), title: (a.getAttribute('title') || '').replace(/\s+live wallpaper$/i, ''), thumb: abs(src, base), preview: abs(`/media/${m[1]}/${m[2]}.960x540.mp4`, base), tags: [], ...resOf(m[3]) }];
      });
    },
    read(doc, base, item) {
      let date = '';
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) date ||= /"datePublished"\s*:\s*"([\d-]+)/.exec(s.textContent)?.[1] || '';
      // (the page's own tags sit with its title; the site's menu repeats every category)
      const tags = [...doc.querySelectorAll('.mb-5 a[href^="/tag:"]')].map((a) => text(a).replace(/\s+live wallpapers$/i, '')).filter(Boolean);
      const files = [...doc.querySelectorAll('a[href^="/dl/"]')].map((a) => {
        const label = text(a.querySelector('.font-bold')) || /\/dl\/(\w+)\//.exec(a.getAttribute('href'))?.[1]?.toUpperCase() || '';
        return { label, file: abs(a.getAttribute('href').replace(/\/?$/, '/'), base), ...resOf(text(a)), bytes: bytesOf(text(a)) };
      });
      const best = files.slice().sort((x, y) => y.width - x.width)[0];
      return { date, tags: [...new Set([...item.tags, ...tags])], files, ...(best ? { width: best.width, height: best.height } : {}) };
    },
  },
  {
    id: 'wallpaperwaifu',
    name: 'WallpaperWaifu',
    site: 'https://wallpaperwaifu.com/',
    list: (q, p) => (q ? wpSearch('https://wallpaperwaifu.com/', q, p) : wpList('https://wallpaperwaifu.com/category/anime/', p)),
    cards(doc, base) {
      return [...doc.querySelectorAll('article.wall-grid-item')].flatMap((art) => {
        const a = art.querySelector('a[href][title]') || art.querySelector('a[href]');
        const img = art.querySelector('img');
        if (!a || !img) return [];
        const thumb = abs(img.getAttribute('data-src') || img.getAttribute('src'), base);
        const m = /\/wp-content\/uploads\/(\d{4})\/\d{2}\/(.+?)-thumb(?:-\d+x\d+)?\.\w+$/.exec(new URL(thumb, base).pathname);
        return [{ page: abs(a.getAttribute('href'), base), title: a.getAttribute('title') || text(art.querySelector('.wall-caption')), thumb, preview: m ? abs(`/wp-content/uploads/preview/${m[1]}/${m[2]}-preview.webm`, base) : '', tags: classTags(art), ...classRes(art) }];
      });
    },
    read(doc, base, item) {
      const lines = [...doc.querySelectorAll('li, p, div')].filter((e) => e.children.length < 4).map(text);
      // (the line itself, not a box around several of them: the shortest that starts so)
      const field = (k) => lines.filter((l) => l.toLowerCase().startsWith(k + ':')).sort((x, y) => x.length - y.length)[0]?.slice(k.length + 1).trim() || '';
      const btn = doc.querySelector('#wf-download[data-url]');
      const res = resOf(field('resolution')).width ? resOf(field('resolution')) : { width: item.width, height: item.height };
      const origin = field('source');
      const preview = doc.querySelector('video source[src], video[src]')?.getAttribute('src');
      return {
        date: field('date'),
        origin: /not provided/i.test(origin) ? '' : origin,
        ...res,
        ...(preview ? { preview: abs(preview, base) } : {}),
        files: btn ? [{ label: res.height >= 2160 ? '4K' : res.height ? `${res.height}p` : '', file: `https://go.wallpaperwaifu.com/download.php?video=${btn.dataset.url}`, ...res, bytes: bytesOf(field('file size')) }] : [],
      };
    },
  }
];

export const sourceOf = (id) => SOURCES.find((s) => s.id === id);

// a list page's cards, as items
export function readList(src, html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return src.cards(doc, url).map((c) => ({ id: `${src.id}:${new URL(c.page).pathname}`, site: src.id, date: '', origin: '', files: [], read: false, ...c, title: c.title.replace(/\s+live wallpaper$/i, '').trim() || c.title }));
}

// an item with what its own page says
export function readItem(item, html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { ...item, ...sourceOf(item.site).read(doc, url, item), read: true };
}

export { num };
