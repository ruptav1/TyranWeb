import { api, boot, h, $, esc, debounce, hostOf, faviconHtml, openUrl, onSettings } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const main = $('#main');
const list = $('#list');
let offset = 0;
let text = '';
let lastDay = '';
let loading = false;
let done = false;
let gen = 0; // (each new listing: answers for an older one are dropped)
// what is listed: the pages visited, the tab groups (windows closed, each with its tabs), the files
// scanned (Đã quét), or the pages incognito tabs visited (Ẩn danh, kept encrypted when switched on
// in Settings → Ẩn danh: main/privhistory.js; asks for the PIN when one is set)
const MODES = ['pages', 'groups', 'scans', 'private'];
let mode = MODES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'pages';
const PLACEHOLDER = { pages: () => t('Tìm trong lịch sử…'), groups: () => t('Tìm trong nhóm tab…'), scans: () => t('Tìm trong tệp đã quét…'), private: () => t('Tìm trong lịch sử ẩn danh…') };
const CLEAR = { groups: 'winhistory:clear', scans: 'scanhistory:clear' };
const isPages = () => mode === 'pages' || mode === 'private';

// Trang web and Ẩn danh: the words typed (with or without marks, "site:" a site), a time span, by
// time or per site, each with its order, one site picked; the matching ones deleted together
// (main/histquery.js)
const SRC = {
  pages: { find: (f) => api.invoke('history:find', f), domains: (f) => api.invoke('history:domains', f), removeWhere: (f) => api.invoke('history:removeWhere', f), remove: (ids) => api.invoke('history:remove', ids) },
  private: { find: (f) => api.invoke('privhistory:find', f), domains: (f) => api.invoke('privhistory:domains', f), removeWhere: (f) => api.invoke('privhistory:removeWhere', f), remove: (ids) => api.invoke('privhistory:remove', ids) },
};
const src = () => SRC[mode];
const SORTS = {
  time: [
    ['new', t('Mới nhất trước')],
    ['old', t('Cũ nhất trước')],
    ['most', t('Mở nhiều nhất')],
    ['az', t('Tên A → Z')],
    ['za', t('Tên Z → A')],
  ],
  sites: [
    ['most', t('Truy cập nhiều nhất')],
    ['least', t('Truy cập ít nhất')],
    ['recent', t('Mở gần đây nhất')],
    ['az', t('Tên miền A → Z')],
    ['za', t('Tên miền Z → A')],
  ],
};
const tools = { span: 'all', view: 'time', sort: { time: 'new', sites: 'most' }, from: '', to: '' };
let site = '';
let total = 0;
let quietUntil = 0; // (a row deleted here: the list is not made again for it)
try {
  const saved = JSON.parse(localStorage.getItem('history.tools') || 'null');
  if (saved && typeof saved === 'object') Object.assign(tools, saved, { sort: { ...tools.sort, ...saved.sort } });
} catch {
  /* as they come */
}
const keepTools = () => {
  try {
    localStorage.setItem('history.tools', JSON.stringify(tools));
  } catch {
    /* only for now */
  }
};

function range() {
  const now = new Date();
  const day = (d) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d).getTime();
  const date = (s, d = 0) => {
    const [y, m, dd] = String(s).split('-').map(Number);
    return y ? new Date(y, m - 1, dd + d).getTime() : 0;
  };
  switch (tools.span) {
    case 'hour':
      return { since: Date.now() - 3600000 };
    case 'today':
      return { since: day(0) };
    case 'yesterday':
      return { since: day(-1), until: day(0) };
    case 'week':
      return { since: Date.now() - 7 * 86400000 };
    case 'month':
      return { since: Date.now() - 30 * 86400000 };
    case 'thismonth':
      return { since: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
    case 'custom':
      return { since: date(tools.from), until: date(tools.to, 1) };
    default:
      return {};
  }
}
const filter = (extra = {}) => ({ text, host: site, ...range(), ...extra });
const narrowed = () => !!(text || site || (tools.span !== 'all' && (tools.span !== 'custom' || tools.from || tools.to)));

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('Hôm nay');
  if (d.toDateString() === y.toDateString()) return t('Hôm qua');
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
const clock = (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const shortDate = (ms) => new Date(ms).toLocaleDateString(LOCALE, { day: 'numeric', month: 'numeric', year: '2-digit' });
const whenText = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? t('{0} hôm nay', clock(ms)) : shortDate(ms);
};

// Two presses to delete: the first turns the button red for 3 seconds.
function twice(btn, run, label) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    clearTimeout(btn._armed);
    btn.classList.remove('armed');
    btn.title = btn._title;
    return run();
  }
  btn.dataset.armed = '1';
  btn._title = btn.title;
  btn.title = label || t('Bấm lần nữa để xóa');
  btn.classList.add('armed');
  btn._armed = setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.title = btn._title;
  }, 3000);
}

// A page visited: its time (its date when not listed by day), icon, title, how many times (the
// pages opened most), site; open it in a new tab, keep to its site, delete it (every visit of it,
// when counted together).
function visitRow(v, { dated = false, inSite = false } = {}) {
  const item = h('div', { class: 'list-item', title: v.url });
  item.innerHTML = `<span class="time${dated ? ' dated' : ''}">${dated ? shortDate(v.time) : clock(v.time)}</span>${faviconHtml(v.favicon, v.title, v.url)}
      <span class="li-text"><span class="li-title">${esc(v.title || v.url)}</span>${v.visits > 1 ? `<span class="visits">${esc(t('{0} lần', v.visits.toLocaleString(LOCALE)))}</span>` : ''}<span class="li-sub">${esc(hostOf(v.url))}</span></span>
      <span class="li-actions">${site || inSite ? '' : `<button class="icon-btn" data-act="site" title="${esc(t('Chỉ xem trang web này'))}">${icon('target', 15)}</button>`}<button class="icon-btn" data-act="tab" title="${esc(t('Mở trong tab mới'))}">${icon('external', 15)}</button><button class="icon-btn" data-act="del" title="${esc(t('Xóa khỏi lịch sử'))}">${icon('trash', 15)}</button></span>`;
  item.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (act === 'del') {
      quietUntil = Date.now() + 1500; // (the row goes; the list stays as it is, scrolled where it is)
      const n = v.visits > 1 ? await src().removeWhere(filter({ url: v.url })) : (await src().remove([v.id]), 1);
      item.remove();
      total = Math.max(0, total - (Number(n) || 1));
      showCount();
    } else if (act === 'site') pickSite(hostOf(v.url));
    else if (act === 'tab') openUrl(v.url, true, true);
    else openUrl(v.url, e.ctrlKey);
  });
  return item;
}

function empty(words) {
  list.innerHTML = `<div class="empty"><span class="kao">(｡•́︿•̀｡)</span>${esc(words)}</div>`;
}

async function load(reset) {
  if (mode === 'groups') return reset && loadGroups();
  if (mode === 'scans') return reset && loadScans();
  if (reset) {
    gen++;
    loading = false;
  }
  if (loading || (done && !reset)) return;
  const my = gen;
  if (mode === 'private' && reset && !(await privateOpen(my))) return;
  if (tools.view === 'sites') return reset && loadSites(my);
  loading = true;
  if (reset) {
    offset = 0;
    lastDay = '';
    done = false;
  }
  const sort = tools.sort.time;
  let res;
  try {
    res = await src().find(filter({ sort, limit: 120, offset }));
  } catch {
    res = null;
  }
  if (my !== gen) return;
  loading = false;
  if (!res) return mode === 'private' && load(true); // (locked meanwhile)
  if (reset) list.innerHTML = '';
  offset += res.rows.length;
  done = offset >= res.count;
  total = res.total;
  showCount();
  const byDay = sort === 'new' || sort === 'old';
  for (const v of res.rows) {
    if (byDay) {
      const day = dayLabel(v.time);
      if (day !== lastDay) {
        lastDay = day;
        list.append(h('div', { class: 'list-group', text: day }));
      }
    }
    list.append(visitRow(v, { dated: !byDay }));
  }
  if (!list.children.length) empty(narrowed() ? t('Không tìm thấy gì') : mode === 'private' ? t('Chưa có lịch sử ẩn danh') : t('Lịch sử trống trơn'));
  $('#more').textContent = done ? '' : t('Cuộn xuống để xem thêm');
}

// ---- Theo trang web: each site of the pages matching, with how many visits and the latest; pressed,
// its pages show, with a search of its own; kept to (the list by time, that site only); deleted
async function loadSites(my) {
  let res;
  try {
    res = await src().domains(filter({ sort: tools.sort.sites, limit: 1500 }));
  } catch {
    res = null;
  }
  if (my !== gen) return;
  if (!res) return mode === 'private' && load(true);
  total = res.total;
  showCount(res.count);
  list.innerHTML = '';
  for (const d of res.rows) list.append(...siteRow(d));
  if (!list.children.length) empty(narrowed() ? t('Không tìm thấy gì') : mode === 'private' ? t('Chưa có lịch sử ẩn danh') : t('Lịch sử trống trơn'));
  $('#more').textContent = res.count > res.rows.length ? t('Còn {0} trang web nữa: tìm hoặc chọn khoảng thời gian để thu hẹp', (res.count - res.rows.length).toLocaleString(LOCALE)) : '';
}

function siteRow(d) {
  const row = h('div', { class: 'list-item site-row', title: d.host });
  const n = d.visits.toLocaleString(LOCALE);
  row.innerHTML = `<span class="chev">${icon('chevronRight', 14)}</span>${faviconHtml(d.favicon, d.host, 'https://' + d.host)}
      <span class="li-text"><span class="li-title">${esc(d.host)}</span><span class="li-sub">${esc(t('gần nhất {0}', whenText(d.last)))}</span></span>
      <span class="site-count" title="${esc(t('{0} lần truy cập', n))}">${n}</span>
      <span class="li-actions"><button class="icon-btn" data-act="site" title="${esc(t('Chỉ xem trang web này'))}">${icon('target', 15)}</button><button class="icon-btn" data-act="del" title="${esc(t('Xóa {0} mục của {1}', n, d.host))}">${icon('trash', 15)}</button></span>`;
  const inside = h('div', { class: 'site-inside', hidden: true });
  row.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'site') return pickSite(d.host);
    if (btn?.dataset.act === 'del') {
      return twice(btn, async () => {
        await src().removeWhere(filter({ host: d.host, exact: true }));
        load(true);
      });
    }
    if (inside.hidden && !inside.children.length) fillSite(inside, d);
    inside.hidden = !inside.hidden;
    row.classList.toggle('open', !inside.hidden);
    if (!inside.hidden) inside.querySelector('input')?.focus();
  });
  return [row, inside];
}

function fillSite(inside, d) {
  const q = h('input', { class: 'input site-q', type: 'search', placeholder: t('Tìm trong {0}…', d.host) });
  const rows = h('div', { class: 'site-rows' });
  const more = h('button', { type: 'button', class: 'btn small ghost', text: t('Xem thêm'), hidden: true });
  let off = 0;
  let mine = 0;
  const go = async (reset) => {
    const my = reset ? ++mine : mine;
    if (reset) off = 0;
    const words = [text, q.value.trim()].filter(Boolean).join(' ');
    const r = await src()
      .find(filter({ host: d.host, exact: true, text: words, sort: 'new', limit: 50, offset: off }))
      .catch(() => null);
    if (my !== mine || !r) return;
    if (reset) rows.innerHTML = '';
    off += r.rows.length;
    for (const v of r.rows) rows.append(visitRow(v, { dated: true, inSite: true }));
    if (!rows.children.length) rows.append(h('div', { class: 'faint site-empty', text: t('Không tìm thấy gì') }));
    more.hidden = off >= r.count;
  };
  q.addEventListener('input', debounce(() => go(true), 150));
  q.addEventListener('click', (e) => e.stopPropagation());
  more.addEventListener('click', () => go(false));
  inside.append(q, rows, more);
  go(true);
}

function pickSite(host) {
  site = host || '';
  if (site && tools.view === 'sites') tools.view = 'time';
  showTools();
  load(true);
}

// How many there are, and what the delete button deletes: every visit, or those matching.
function showCount(sites) {
  const n = total.toLocaleString(LOCALE);
  $('#count').textContent = tools.view === 'sites' && sites !== undefined ? t('{0} trang web · {1} mục', sites.toLocaleString(LOCALE), n) : t('{0} mục', n);
  const btn = $('#clear');
  if (!isPages() || btn.dataset.armed) return;
  btn.lastElementChild.textContent = !narrowed() ? t('Xóa lịch sử') : text ? t('Xóa {0} mục có “{1}”', n, text) : t('Xóa {0} mục đã lọc', n);
  btn.disabled = narrowed() && !total;
}

function showTools() {
  const pages = isPages();
  $('#tools').hidden = !pages;
  $('#range').hidden = pages;
  $('#span').value = tools.span;
  $('#custom').hidden = tools.span !== 'custom';
  $('#from').value = tools.from;
  $('#to').value = tools.to;
  document.querySelectorAll('#view button').forEach((b) => b.classList.toggle('on', b.dataset.view === tools.view));
  const sel = $('#sort');
  sel.innerHTML = '';
  for (const [v, label] of SORTS[tools.view]) sel.append(h('option', { value: v, text: label }));
  sel.value = tools.sort[tools.view];
  const chip = $('#site-chip');
  chip.hidden = !site;
  chip.innerHTML = site ? `${icon('globe', 13)}<span>${esc(site)}</span><button type="button" class="icon-btn" title="${esc(t('Bỏ lọc trang web'))}">${icon('x', 13)}</button>` : '';
  if (!pages) {
    const btn = $('#clear');
    btn.disabled = false;
    if (!btn.dataset.armed) btn.lastElementChild.textContent = t('Xóa lịch sử');
  }
}

// ---- Ẩn danh: opened with the PIN (or at once without one); locked again by the Khoá button, when
// the page is hidden, or by itself after a while
let priv = null;
async function privateOpen(my) {
  priv = await api.invoke('privhistory:status').catch(() => null);
  if (my !== gen) return false;
  main.classList.remove('locked');
  $('#lock').hidden = !(priv?.open && priv.pin);
  if (!priv) return false;
  if (priv.broken) {
    lockScreen('broken');
    return false;
  }
  if (!priv.recording && !priv.kept) {
    lockScreen('off');
    return false;
  }
  if (priv.open) return true;
  if (!priv.pin) {
    const r = await api.invoke('privhistory:unlock', null).catch(() => null);
    if (my !== gen) return false;
    if (r?.ok) return true;
  }
  lockScreen('pin');
  return false;
}

function lockScreen(kind) {
  main.classList.add('locked');
  $('#more').textContent = '';
  $('#lock').hidden = true;
  if (kind !== 'pin') {
    list.innerHTML = '';
    const box = h(
      'div',
      { class: 'lock-box' },
      h('div', { class: 'lock-ico', html: icon(kind === 'broken' ? 'warn' : 'incognito', 26) }),
      h('b', { text: kind === 'broken' ? t('Không mở được lịch sử ẩn danh') : t('Lịch sử ẩn danh đang tắt') }),
      h('span', { class: 'faint', text: kind === 'broken' ? t('Tệp được tạo trên máy tính hoặc tài khoản Windows khác. Có thể xóa nó trong Cài đặt → Ẩn danh.') : t('Bật trong Cài đặt → Ẩn danh để lưu các trang mở trong tab ẩn danh.') }),
      h('button', { type: 'button', class: 'btn', text: t('Mở cài đặt'), onclick: () => openUrl('tyran://settings/#incognito') })
    );
    list.append(box);
    return;
  }
  const n = priv.pin;
  const input = h('input', { class: 'input pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: n, 'aria-label': t('Mật khẩu') });
  const err = h('span', { class: 'lock-err' });
  const box = h('div', { class: 'lock-box' }, h('div', { class: 'lock-ico', html: icon('lock', 26) }), h('b', { text: t('Lịch sử ẩn danh đã khóa') }), h('span', { class: 'faint', text: t('Nhập mật khẩu {0} số để xem', n) }), input, err);
  list.innerHTML = '';
  list.append(box);
  let tick = null;
  const waitFor = (ms) => {
    clearInterval(tick);
    input.disabled = true;
    const end = Date.now() + ms;
    const show = () => {
      const s = Math.ceil((end - Date.now()) / 1000);
      if (s <= 0) {
        clearInterval(tick);
        input.disabled = false;
        err.textContent = '';
        input.focus();
        return;
      }
      err.textContent = t('Sai quá nhiều lần. Thử lại sau {0} giây', s);
    };
    show();
    tick = setInterval(show, 500);
  };
  input.addEventListener('input', async () => {
    input.value = input.value.replace(/\D/g, '').slice(0, n);
    if (input.value.length < n) return;
    const pin = input.value;
    input.disabled = true;
    const r = await api.invoke('privhistory:unlock', pin).catch(() => ({ ok: false }));
    input.value = '';
    if (r.ok) {
      clearInterval(tick);
      main.classList.remove('locked');
      showTools();
      return load(true);
    }
    input.disabled = false;
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    if (r.wait > 0) return waitFor(r.wait);
    err.textContent = r.left ? t('Sai mật khẩu, còn {0} lần thử', r.left) : t('Sai mật khẩu');
    input.focus();
  });
  if (priv.wait > 0) waitFor(priv.wait);
  else setTimeout(() => input.focus(), 0);
}

function lockPrivate() {
  if (mode !== 'private' || !priv?.pin) return;
  api.invoke('privhistory:lock').catch(() => {});
  priv.open = false;
}

// ---- Nhóm tab: each window closed (or open when TyranWeb quit), its time, its tabs' icons and how
// many; pressed, its tabs show (each opens in a tab); reopened whole as a window
async function loadGroups() {
  const groups = await api.invoke('winhistory:list').catch(() => []);
  const q = text.toLowerCase();
  list.innerHTML = '';
  lastDay = '';
  for (const g of groups) {
    const tabs = q ? g.tabs.filter((x) => (x.title + ' ' + x.url).toLowerCase().includes(q)) : g.tabs;
    if (!tabs.length) continue;
    const day = dayLabel(g.at);
    if (day !== lastDay) {
      lastDay = day;
      list.append(h('div', { class: 'list-group', text: day }));
    }
    const hosts = [...new Set(g.tabs.map((x) => hostOf(x.url)).filter(Boolean))].slice(0, 4).join(' · ');
    const row = h('div', { class: 'list-item group-row', title: g.tabs.map((x) => x.title || x.url).join('\n') });
    row.innerHTML = `<span class="time">${clock(g.at)}</span>
      <span class="group-icons">${g.tabs.slice(0, 10).map((x) => faviconHtml(x.favicon, x.title, x.url)).join('')}</span>
      <span class="li-text"><span class="li-title">${esc(t('{0} tab', g.tabs.length))} · ${esc(g.tabs[g.active]?.title || g.tabs[0].title || g.tabs[0].url)}</span><span class="li-sub">${esc(hosts)}</span></span>
      <span class="li-actions"><button class="icon-btn" data-act="open" title="${t('Mở lại cửa sổ')}">${icon('window', 15)}</button><button class="icon-btn" data-act="del" title="${t('Xóa khỏi lịch sử')}">${icon('trash', 15)}</button></span>`;
    const inside = h('div', { class: 'group-tabs', hidden: true });
    for (const x of tabs) {
      const item = h('div', { class: 'list-item', title: x.url });
      item.innerHTML = `${faviconHtml(x.favicon, x.title, x.url)}<span class="li-text"><span class="li-title">${esc(x.title || x.url)}</span><span class="li-sub">${esc(hostOf(x.url))}</span></span>`;
      item.addEventListener('click', (e) => openUrl(x.url, true, !e.ctrlKey));
      inside.append(item);
    }
    row.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'open') await api.invoke('winhistory:open', g.id);
      else if (act === 'del') await api.invoke('winhistory:remove', g.id);
      else inside.hidden = !inside.hidden;
    });
    list.append(row, inside);
  }
  if (!list.children.length) empty(text ? t('Không tìm thấy gì') : t('Chưa có nhóm tab nào'));
  $('#more').textContent = '';
}

// ---- Đã quét: every file Kiểm tra tệp tải về scanned (main/filescan.js), newest first. Red: a virus
// found (Windows Defender, or 3 or more of VirusTotal's vendors); yellow: a risk (one or two
// vendors, or "suspicious"); nothing found: as any row. Pressed: its result page.
const judgedOf = (st) => ['malicious', 'suspicious', 'undetected', 'harmless'].reduce((n, k) => n + (st[k] || 0), 0);
function verdict(x) {
  const s = x.scan || {};
  const st = s.vt?.state === 'done' ? s.vt.stats || {} : {};
  const mal = st.malicious || 0;
  const sus = st.suspicious || 0;
  const judged = judgedOf(st);
  if (s.state === 'threat') return ['bad', t('Có mã độc: {0}', s.threat || '?')];
  if (s.state === 'removed') return ['bad', t('Đã chặn: {0}', s.threat || '?')];
  if (mal >= 3) return ['bad', t('{0}/{1} hãng bảo mật đánh dấu tệp này là độc hại', mal, judged)];
  if (mal) return ['warn', t('{0}/{1} hãng bảo mật đánh dấu tệp này là độc hại', mal, judged)];
  if (sus) return ['warn', t('{0} hãng bảo mật cho rằng tệp này đáng ngờ', sus)];
  if (['queued', 'scanning'].includes(s.state)) return ['', t('Đang kiểm tra…')];
  if (s.state === 'clean') return ['', [t('Không phát hiện mối nguy'), judged ? `VirusTotal 0/${judged}` : ''].filter(Boolean).join(' · ')];
  return ['', t('Không kiểm tra được')];
}

async function loadScans() {
  const items = await api.invoke('scanhistory:list', text).catch(() => []);
  list.innerHTML = '';
  lastDay = '';
  for (const x of items) {
    const day = dayLabel(x.at);
    if (day !== lastDay) {
      lastDay = day;
      list.append(h('div', { class: 'list-group', text: day }));
    }
    const [lv, words] = verdict(x);
    const inside = x.scan?.inside?.length ? t('Trong file nén: {0}', x.scan.inside.slice(0, 3).map((n) => n.split('/').pop()).join(', ') + (x.scan.insideCount > 3 ? ' …' : '')) : '';
    const row = h('div', { class: `list-item scan-row${lv ? ' lv-' + lv : ''}`, title: x.path || x.filename });
    row.innerHTML = `<span class="time">${clock(x.at)}</span>
      <span class="scan-ico">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : icon(lv ? 'warn' : 'shieldCheck', 18)}</span>
      <span class="li-text"><span class="li-title">${esc(x.filename)}</span><span class="li-sub">${esc([words, inside, hostOf(x.url || '')].filter(Boolean).join(' · '))}</span></span>
      <span class="li-actions"><button class="icon-btn" data-act="del" title="${t('Xóa khỏi lịch sử')}">${icon('trash', 15)}</button></span>`;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act]')?.dataset.act === 'del') await api.invoke('scanhistory:remove', x.id);
      else openUrl('tyran://scan/?id=' + encodeURIComponent(x.id), true, e.ctrlKey);
    });
    list.append(row);
  }
  if (!list.children.length) empty(text ? t('Không tìm thấy gì') : t('Chưa quét tệp nào'));
  $('#more').textContent = '';
}

function showMode() {
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#q').placeholder = PLACEHOLDER[mode]();
  main.classList.remove('locked');
  $('#lock').hidden = true;
  showTools();
}

// (the Ẩn danh button: when its history is switched on, or kept from before)
async function showPrivateButton(s) {
  const st = await api.invoke('privhistory:status').catch(() => null);
  $('#mode [data-mode="private"]').hidden = !(s?.privacy?.privateHistory || st?.kept || st?.broken || mode === 'private');
}

await boot();
showMode();
onSettings(showPrivateButton);
document.querySelectorAll('#mode button').forEach((b) =>
  b.addEventListener('click', () => {
    if (mode === b.dataset.mode) return;
    lockPrivate();
    mode = b.dataset.mode;
    history.replaceState(null, '', mode === 'pages' ? '#' : '#' + mode);
    showMode();
    load(true);
  })
);
api.on('winhistory:changed', () => mode === 'groups' && loadGroups());
api.on('scanhistory:changed', debounce(() => mode === 'scans' && loadScans(), 200));
api.on('privhistory:changed', debounce(() => mode === 'private' && !main.classList.contains('locked') && Date.now() > quietUntil && load(true), 400));
api.on('privhistory:locked', () => mode === 'private' && load(true));
$('#q').addEventListener('input', debounce(() => {
  text = $('#q').value.trim();
  load(true);
}, 150));
$('#span').addEventListener('change', () => {
  tools.span = $('#span').value;
  keepTools();
  showTools();
  load(true);
});
for (const id of ['from', 'to']) {
  $('#' + id).addEventListener('change', () => {
    tools[id] = $('#' + id).value;
    keepTools();
    load(true);
  });
}
document.querySelectorAll('#view button').forEach((b) =>
  b.addEventListener('click', () => {
    if (tools.view === b.dataset.view) return;
    tools.view = b.dataset.view;
    keepTools();
    showTools();
    load(true);
  })
);
$('#sort').addEventListener('change', () => {
  tools.sort[tools.view] = $('#sort').value;
  keepTools();
  load(true);
});
$('#site-chip').addEventListener('click', (e) => e.target.closest('button') && pickSite(''));
$('#lock').addEventListener('click', () => {
  lockPrivate();
  load(true);
});
// (Ẩn danh locks when the page is hidden: back, it asks for the PIN again)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) lockPrivate();
  else if (mode === 'private' && priv?.pin && !priv.open) load(true);
});
window.addEventListener('scroll', () => {
  if (isPages() && tools.view === 'sites') return;
  if (window.innerHeight + window.scrollY > document.body.scrollHeight - 400) load(false);
});
$('#clear').addEventListener('click', async () => {
  const btn = $('#clear');
  const label = btn.lastElementChild.textContent;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn._label = label;
    btn.lastElementChild.textContent = t('Bấm lần nữa để xóa');
    btn._armed = setTimeout(() => {
      delete btn.dataset.armed;
      btn.lastElementChild.textContent = btn._label;
    }, 3000);
    return;
  }
  clearTimeout(btn._armed);
  delete btn.dataset.armed;
  btn.lastElementChild.textContent = btn._label;
  if (isPages()) {
    await src().removeWhere(filter());
    if (mode === 'pages') return; // (history:changed lists them again)
  } else {
    const span = Number($('#range').value);
    await api.invoke(CLEAR[mode], span ? Date.now() - span : 0);
  }
  load(true);
});
api.on('history:changed', () => mode === 'pages' && Date.now() > quietUntil && load(true));
load(true);
$('#q').focus();
