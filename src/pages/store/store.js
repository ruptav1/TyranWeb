// Kho nền video: live video wallpapers from several sites in one search (sources.js), downloaded into
// the video wallpapers (main/livewalls.js) with their size, resolution, length and where they came
// from. With Blue Archive's lobby as the wallpaper the page is Sora's shop (shop.js).
import { api, boot, onSettings, h, $, $$, esc, openUrl, hydrateIcons } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';
import { SOURCES, sourceOf, readList, readItem, isAi } from './sources.js';

let S = null;
const state = { q: '', page: 0, items: [], seen: new Set(), hiddenAi: 0, busy: false, ended: new Set(), failed: new Set(), sites: new Set(SOURCES.map((s) => s.id)), minRes: 0 };
const mine = { list: [], byPage: new Map() };
const jobs = new Map(); // a download's id → { got, total }

// ---------------------------------------------------------------- formats
const fmtBytes = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const resName = (w, hgt) => {
  const m = Math.min(w, hgt) || hgt;
  return m >= 4320 ? '8K' : m >= 2160 ? '4K' : m >= 1440 ? '2K' : m >= 1080 ? '1080p' : m >= 720 ? '720p' : '';
};
const fmtRes = (w, hgt) => (w && hgt ? `${resName(w, hgt)} · ${w}×${hgt}`.replace(/^ · /, '') : '');
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const fmtDate = (d) => {
  const x = new Date(d);
  return d && !isNaN(x) ? x.toLocaleDateString(LOCALE) : '';
};
const best = (it) => (it.files || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
const siteName = (id) => sourceOf(id)?.name || id;
const passes = (it) => !state.minRes || !it.height || Math.min(it.width || it.height, it.height) >= state.minRes;

// ---------------------------------------------------------------- the search
function renderSites() {
  const box = $('#sites');
  box.innerHTML = '';
  for (const s of SOURCES) {
    const b = h('button', { type: 'button', class: `chip${state.sites.has(s.id) ? ' on' : ''}${state.failed.has(s.id) ? ' bad' : ''}`, html: `<span>${esc(s.name)}</span>` });
    b.addEventListener('click', () => {
      if (state.sites.has(s.id) && state.sites.size > 1) state.sites.delete(s.id);
      else state.sites.add(s.id);
      try {
        localStorage.setItem('store.sites', JSON.stringify([...state.sites]));
      } catch {
        /* (kept for this visit only) */
      }
      renderSites();
      search(state.q);
    });
    box.append(b);
  }
}

function renderStatus() {
  const shown = state.items.filter(passes).length;
  const parts = [];
  if (state.busy) parts.push(t('Đang tìm…'));
  else if (state.page) parts.push(t('{0} nền', shown));
  if (state.hiddenAi) parts.push(t('đã ẩn {0} nền gắn nhãn AI', state.hiddenAi));
  const failed = SOURCES.filter((s) => state.failed.has(s.id) && state.sites.has(s.id)).map((s) => s.name);
  if (failed.length) parts.push(t('không đọc được {0}', failed.join(', ')));
  $('#status').textContent = parts.join(' · ');
  $('#more').hidden = state.busy || !state.page || SOURCES.every((s) => !state.sites.has(s.id) || state.ended.has(s.id));
  if (!state.busy && state.page && !shown && !$('#grid .store-empty')) $('#grid').append(h('div', { class: 'store-empty', text: t('Không tìm thấy nền nào') }));
}

async function search(q) {
  Object.assign(state, { q: (q || '').trim(), page: 0, items: [], hiddenAi: 0 });
  state.seen.clear();
  state.ended.clear();
  state.failed.clear();
  reading.length = 0;
  $('#grid').innerHTML = '';
  renderSites();
  await more();
}

async function more() {
  if (state.busy) return;
  state.busy = true;
  renderStatus();
  const p = ++state.page;
  const q = state.q;
  const srcs = SOURCES.filter((s) => state.sites.has(s.id) && !state.ended.has(s.id));
  const lists = await Promise.all(
    srcs.map(async (s) => {
      try {
        const { html, url } = await api.invoke('livewalls:page', s.list(q, p));
        const items = readList(s, html, url).filter((i) => !state.seen.has(i.id));
        if (!items.length) state.ended.add(s.id);
        return items;
      } catch {
        state.failed.add(s.id);
        state.ended.add(s.id);
        return [];
      }
    })
  );
  if (q !== state.q) return; // (another search started meanwhile)
  // the sites' results taken in turns, so each shows near the top
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const it = l[i];
      if (!it || state.seen.has(it.id)) continue;
      state.seen.add(it.id);
      if (isAi(it)) {
        state.hiddenAi++;
        continue;
      }
      state.items.push(it);
      const el = card(it);
      $('#grid').append(el);
      seen.observe(el);
    }
  }
  state.busy = false;
  renderSites();
  renderStatus();
}

// ---------------------------------------------------------------- a card
const byId = (id) => state.items.find((i) => i.id === id);
const jobOf = (it) => [...jobs.entries()].find(([k]) => k.startsWith(it.id + '|'))?.[1];

function card(it) {
  const el = h('article', { class: 'card', dataset: { id: it.id } });
  el.innerHTML = `<div class="thumb"><img loading="lazy" src="${esc(it.thumb)}" alt=""></div><div class="meta"><span class="title" title="${esc(it.title)}">${esc(it.title)}</span><span class="facts"></span></div>`;
  fill(el, it);
  let vid = null;
  el.addEventListener('mouseenter', () => {
    if (!it.preview || vid) return;
    vid = h('video', { muted: true, loop: true, autoplay: true, playsInline: true });
    vid.muted = true;
    vid.src = it.preview;
    vid.addEventListener('error', () => vid?.remove());
    el.querySelector('.thumb').append(vid);
  });
  el.addEventListener('mouseleave', () => {
    vid?.remove();
    vid = null;
  });
  el.addEventListener('click', () => openDetail(it));
  return el;
}

function fill(el, it) {
  const f = best(it);
  const facts = [];
  if (it.width) facts.push(`<span class="res">${esc(fmtRes(it.width, it.height))}</span>`);
  if (f?.bytes) facts.push(`<span>${esc(fmtBytes(f.bytes))}</span>`);
  if (it.date) facts.push(`<span>${esc(fmtDate(it.date))}</span>`);
  facts.push(`<span class="site">${esc(siteName(it.site))}</span>`);
  el.querySelector('.facts').innerHTML = facts.join('');
  el.hidden = !passes(it);
  el.querySelector('.badge')?.remove();
  el.querySelector('.bar')?.remove();
  const job = jobOf(it);
  const have = mine.byPage.get(it.page);
  const thumb = el.querySelector('.thumb');
  if (job) {
    thumb.append(h('span', { class: 'bar', html: `<i style="width:${job.total ? Math.round((job.got / job.total) * 100) : 4}%"></i>` }));
  } else if (have) {
    thumb.append(h('span', { class: 'badge', html: `${icon('check', 12)}<span>${esc(t('Đã tải'))}</span>` }));
  }
}
const refreshCard = (it) => {
  const el = $(`.card[data-id="${CSS.escape(it.id)}"]`);
  if (el) fill(el, it);
};

// a card's own page is read once it comes into sight (a few at a time): its size, date, tags...
const reading = [];
let readers = 0;
const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      const it = byId(e.target.dataset.id);
      if (it && !it.read) reading.push(it);
    }
    pump();
  },
  { rootMargin: '400px' }
);
function pump() {
  while (readers < 3 && reading.length) {
    const it = reading.shift();
    readers++;
    readOne(it).finally(() => {
      readers--;
      pump();
    });
  }
}
async function readOne(it) {
  if (it.read) return it;
  it.reading ||= api
    .invoke('livewalls:page', it.page)
    .then(({ html, url }) => Object.assign(it, readItem(it, html, url)))
    .catch(() => Object.assign(it, { read: true, failed: true }));
  await it.reading;
  it.reading = null;
  // (its own page says it was made with AI: out of the store)
  if (isAi(it) && state.items.includes(it)) {
    state.items = state.items.filter((x) => x !== it);
    state.hiddenAi++;
    $(`.card[data-id="${CSS.escape(it.id)}"]`)?.remove();
    renderStatus();
  } else refreshCard(it);
  return it;
}

// ---------------------------------------------------------------- a wallpaper's own view
let open = null;
async function openDetail(it) {
  open = it;
  const d = $('#detail');
  renderDetail(it);
  if (!d.open) d.showModal();
  if (!it.read) {
    await readOne(it);
    if (open === it) renderDetail(it);
  }
}

function renderDetail(it) {
  const d = $('#detail');
  const keepTime = d.querySelector('video')?.currentTime || 0;
  const facts = [`<span class="site">${esc(siteName(it.site))}</span>`];
  if (it.date) facts.push(`<span>${esc(fmtDate(it.date))}</span>`);
  if (it.origin) facts.push(`<span>${esc(t('nguồn: {0}', it.origin))}</span>`);
  const files = it.read ? it.files || [] : null;
  const have = mine.byPage.get(it.page);
  const rows = files === null
    ? `<div class="file"><span class="what"><span>${esc(t('Đang đọc trang…'))}</span></span></div>`
    : files.length
      ? files.map((f, i) => fileRow(it, f, i, have)).join('')
      : `<div class="file"><span class="what"><span>${esc(t('Không lấy được file của nền này'))}</span></span></div>`;
  d.innerHTML = `<div class="view">${it.preview ? `<video src="${esc(it.preview)}" poster="${esc(it.thumb)}" autoplay muted loop playsinline></video>` : `<img src="${esc(it.thumb)}" alt="">`}
      <button class="icon-btn close" title="${esc(t('Đóng'))}">${icon('x', 16)}</button></div>
    <div class="body">
      <h2>${esc(it.title)}</h2>
      <div class="facts">${facts.join('')}</div>
      <div class="files">${rows}</div>
      ${it.tags?.length ? `<div class="tags">${it.tags.slice(0, 24).map((x) => `<span>${esc(String(x).replace(/-z$/, '').replace(/-/g, ' '))}</span>`).join('')}</div>` : ''}
      <div class="row-actions"><button class="btn" data-act="page">${icon('external', 15)}<span>${esc(t('Mở trang gốc'))}</span></button></div>
    </div>`;
  const v = d.querySelector('video');
  if (v && keepTime) v.currentTime = keepTime;
  v?.addEventListener('error', () => v.replaceWith(h('img', { src: it.thumb, alt: '' })));
}

function fileRow(it, f, i, have) {
  const job = jobs.get(`${it.id}|${i}`);
  const what = `<b>${esc(f.label || resName(f.width, f.height) || t('Video'))}</b>${f.width ? `<span>${f.width}×${f.height}</span>` : ''}${f.bytes ? `<span>${esc(fmtBytes(f.bytes))}</span>` : ''}`;
  let act;
  if (job) act = `<span>${esc(job.total ? `${Math.round((job.got / job.total) * 100)}%` : fmtBytes(job.got))}</span><button class="btn small" data-act="cancel" data-i="${i}">${esc(t('Hủy'))}</button>`;
  else if (have && (!have.width || !f.width || have.width === f.width)) act = `<button class="btn primary small" data-act="use" data-i="${i}">${icon('check', 14)}<span>${esc(t('Đặt làm hình nền'))}</span></button>`;
  else act = `<button class="btn primary small" data-act="get" data-i="${i}">${icon('download', 14)}<span>${esc(t('Tải về'))}</span></button>`;
  const bar = job ? `<span class="bar"><i style="width:${job.total ? Math.round((job.got / job.total) * 100) : 4}%"></i></span>` : '';
  return `<div class="file" data-i="${i}"><span class="what">${what}</span>${act}${bar}</div>`;
}

$('#detail').addEventListener('click', (e) => {
  const d = $('#detail');
  if (e.target === d || e.target.closest('.close')) return d.close();
  const b = e.target.closest('[data-act]');
  if (!b || !open) return;
  const it = open;
  const f = it.files?.[Number(b.dataset.i)];
  if (b.dataset.act === 'page') openUrl(it.page, true);
  if (b.dataset.act === 'get' && f) download(it, f, Number(b.dataset.i));
  if (b.dataset.act === 'cancel') api.invoke('livewalls:cancel', `${it.id}|${b.dataset.i}`);
  if (b.dataset.act === 'use') useVideo(mine.byPage.get(it.page));
});
$('#detail').addEventListener('close', () => {
  open = null;
  $('#detail').innerHTML = '';
});

async function download(it, f, i) {
  const id = `${it.id}|${i}`;
  jobs.set(id, { got: 0, total: f.bytes || 0 });
  redraw(it);
  try {
    await api.invoke('livewalls:download', { id, site: it.site, page: it.page, file: f.file, title: it.title, thumb: it.thumb, width: f.width || it.width, height: f.height || it.height, date: it.date, tags: it.tags, origin: it.origin });
    jobs.delete(id);
    await loadMine();
    window.dispatchEvent(new CustomEvent('store:bought'));
  } catch (err) {
    jobs.delete(id);
    const msg = String(err?.message || '');
    if (/gone/.test(msg)) $('#status').textContent = t('{0} không còn file của nền này', siteName(it.site));
    else if (!/abort/i.test(msg)) $('#status').textContent = t('Không tải được: {0}', it.title);
  }
  redraw(it);
}
const redraw = (it) => {
  refreshCard(it);
  if (open === it) renderDetail(it);
};

api.on('livewalls:progress', ({ id, got, total }) => {
  if (!jobs.has(id)) return;
  jobs.set(id, { got, total });
  const it = byId(id.slice(0, id.lastIndexOf('|')));
  if (!it) return;
  refreshCard(it);
  if (open === it) {
    const row = $(`#detail .file[data-i="${id.slice(id.lastIndexOf('|') + 1)}"]`);
    const pct = total ? Math.round((got / total) * 100) : 4;
    const bar = row?.querySelector('.bar i');
    if (bar) bar.style.width = pct + '%';
    const lbl = row?.querySelector('[data-act="cancel"]')?.previousElementSibling;
    if (lbl) lbl.textContent = total ? `${pct}%` : fmtBytes(got);
  }
});

// ---------------------------------------------------------------- downloaded
async function loadMine() {
  const r = await api.invoke('wallpapers:list').catch(() => null);
  mine.list = (r?.videos || []).filter((v) => v.kind === 'user');
  mine.byPage = new Map(mine.list.filter((v) => v.page).map((v) => [v.page, v]));
  $('#mine-count').textContent = mine.list.length ? String(mine.list.length) : '';
  renderMine();
  for (const it of state.items) refreshCard(it);
}

const using = (v) => S?.wallpaper?.type === 'video' && S.wallpaper.video === v.url;
function useVideo(v) {
  if (v) api.invoke('settings:set', { wallpaper: { type: 'video', video: v.url } });
}

function renderMine() {
  const grid = $('#mine-grid');
  grid.innerHTML = '';
  if (!mine.list.length) return grid.append(h('div', { class: 'store-empty', text: t('Chưa có nền video nào') }));
  for (const v of mine.list) {
    const el = h('article', { class: 'card', dataset: { file: v.file } });
    el.innerHTML = `<div class="thumb">${v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="">` : `<video src="${esc(v.url)}#t=1" muted preload="metadata"></video>`}</div>
      <div class="meta"><span class="title" title="${esc(v.title || '')}">${esc(v.title || t('Video'))}</span><span class="facts"></span>
      <span class="row-actions"><button class="btn primary small" data-act="use"></button><button class="btn small ghost" data-act="del" title="${esc(t('Xóa video'))}">${icon('trash', 14)}</button></span></div>`;
    mineFacts(el, v);
    el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'del') {
        if (using(v)) await api.invoke('settings:set', { wallpaper: { video: '' } });
        await api.invoke('wallpapers:remove', v.file);
        return loadMine();
      }
      if (act === 'use') useVideo(v);
    });
    grid.append(el);
    if (!v.width || !v.duration) probe(v, el);
  }
}

function mineFacts(el, v) {
  const facts = [];
  if (v.width) facts.push(`<span class="res">${esc(fmtRes(v.width, v.height))}</span>`);
  if (v.bytes) facts.push(`<span>${esc(fmtBytes(v.bytes))}</span>`);
  if (v.duration) facts.push(`<span>${esc(fmtDur(v.duration))}</span>`);
  if (v.source) facts.push(`<span class="site">${esc(v.source)}</span>`);
  el.querySelector('.facts').innerHTML = facts.join('');
  const use = el.querySelector('[data-act="use"]');
  use.innerHTML = using(v) ? `${icon('check', 14)}<span>${esc(t('Đang dùng'))}</span>` : `<span>${esc(t('Đặt làm hình nền'))}</span>`;
  use.disabled = using(v);
}

// a video's resolution and length, read from the file itself once (kept with it)
function probe(v, el) {
  const p = document.createElement('video');
  p.preload = 'metadata';
  p.muted = true;
  p.addEventListener('loadedmetadata', async () => {
    const patch = { width: p.videoWidth, height: p.videoHeight, duration: p.duration };
    p.removeAttribute('src');
    p.load();
    Object.assign(v, (await api.invoke('wallpapers:meta', v.file, patch).catch(() => null)) || patch);
    mineFacts(el, v);
  });
  p.src = v.url;
}

// ---------------------------------------------------------------- tabs, filters, the shop
function showTab(id) {
  for (const b of $$('.store-tabs .tab')) b.classList.toggle('on', b.dataset.tab === id);
  for (const el of $$('[data-for]')) el.hidden = el.dataset.for !== id;
}
for (const b of $$('.store-tabs .tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  showTab('find');
  search($('#q').value);
});
$('#more').addEventListener('click', more);
$('#res').addEventListener('change', () => {
  state.minRes = Number($('#res').value) || 0;
  for (const it of state.items) refreshCard(it);
  $('#grid .store-empty')?.remove();
  renderStatus();
});
// (more as the end of the list comes near)
new IntersectionObserver((e) => e[0].isIntersecting && !$('#more').hidden && more(), { rootMargin: '600px' }).observe($('#more'));

let shop = null;
onSettings((s) => {
  S = s;
  for (const el of $$('#mine-grid .card')) {
    const v = mine.list.find((x) => x.file === el.dataset.file);
    if (v) mineFacts(el, v);
  }
  const ba = s.wallpaper?.type === 'web' && s.wallpaper.web?.preset === 'bluearchive';
  if (ba && !shop) shop = import('./shop.js').then((m) => (m.start(s), m));
  else if (!ba && shop) {
    shop.then((m) => m.stop());
    shop = null;
  } else shop?.then((m) => m.settings(s));
});

(async () => {
  try {
    const kept = JSON.parse(localStorage.getItem('store.sites') || 'null');
    if (Array.isArray(kept) && kept.length) state.sites = new Set(kept.filter((k) => sourceOf(k)));
  } catch {
    /* (all of them) */
  }
  if (!state.sites.size) state.sites = new Set(SOURCES.map((s) => s.id));
  await boot();
  hydrateIcons(document);
  api.on('wallpapers:changed', loadMine);
  const q = new URLSearchParams(location.search).get('q') || '';
  $('#q').value = q;
  if (location.hash === '#mine') showTab('mine');
  await loadMine();
  search(q);
})();
