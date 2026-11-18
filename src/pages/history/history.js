import { api, boot, h, $, esc, debounce, hostOf, faviconHtml, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const list = $('#list');
let offset = 0;
let text = '';
let lastDay = '';
let loading = false;
let done = false;
// what is listed: the pages visited, the tab groups (windows closed, each with its tabs), or the
// files scanned (Đã quét)
const MODES = ['pages', 'groups', 'scans'];
let mode = MODES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'pages';
const PLACEHOLDER = { pages: () => t('Tìm trong lịch sử…'), groups: () => t('Tìm trong nhóm tab…'), scans: () => t('Tìm trong tệp đã quét…') };
const CLEAR = { pages: 'history:clear', groups: 'winhistory:clear', scans: 'scanhistory:clear' };

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('Hôm nay');
  if (d.toDateString() === y.toDateString()) return t('Hôm qua');
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function load(reset) {
  if (mode === 'groups') return reset && loadGroups();
  if (mode === 'scans') return reset && loadScans();
  if (loading || (done && !reset)) return;
  loading = true;
  if (reset) {
    offset = 0;
    lastDay = '';
    done = false;
    list.innerHTML = '';
  }
  const rows = await api.invoke('history:query', { text, limit: 120, offset });
  offset += rows.length;
  done = rows.length < 120;
  for (const v of rows) {
    const day = dayLabel(v.time);
    if (day !== lastDay) {
      lastDay = day;
      list.append(h('div', { class: 'list-group', text: day }));
    }
    const item = h('div', { class: 'list-item', title: v.url });
    item.innerHTML = `<span class="time">${new Date(v.time).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>${faviconHtml(v.favicon, v.title, v.url)}
      <span class="li-text"><span class="li-title">${esc(v.title || v.url)}</span><span class="li-sub">${esc(hostOf(v.url))}</span></span>
      <span class="li-actions"><button class="icon-btn" data-act="tab" title="${t('Mở trong tab mới')}">${icon('external', 15)}</button><button class="icon-btn" data-act="del" title="${t('Xóa khỏi lịch sử')}">${icon('trash', 15)}</button></span>`;
    item.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'del') {
        await api.invoke('history:remove', [v.id]);
        item.remove();
      } else if (act === 'tab') openUrl(v.url, true, true);
      else openUrl(v.url, e.ctrlKey);
    });
    list.append(item);
  }
  if (!list.children.length) list.innerHTML = `<div class="empty"><span class="kao">(｡•́︿•̀｡)</span>${text ? t('Không tìm thấy gì') : t('Lịch sử trống trơn')}</div>`;
  $('#more').textContent = done ? '' : t('Cuộn xuống để xem thêm');
  loading = false;
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
    row.innerHTML = `<span class="time">${new Date(g.at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
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
  if (!list.children.length) list.innerHTML = `<div class="empty"><span class="kao">(｡•́︿•̀｡)</span>${text ? t('Không tìm thấy gì') : t('Chưa có nhóm tab nào')}</div>`;
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
    row.innerHTML = `<span class="time">${new Date(x.at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="scan-ico">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : icon(lv ? 'warn' : 'shieldCheck', 18)}</span>
      <span class="li-text"><span class="li-title">${esc(x.filename)}</span><span class="li-sub">${esc([words, inside, hostOf(x.url || '')].filter(Boolean).join(' · '))}</span></span>
      <span class="li-actions"><button class="icon-btn" data-act="del" title="${t('Xóa khỏi lịch sử')}">${icon('trash', 15)}</button></span>`;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act]')?.dataset.act === 'del') await api.invoke('scanhistory:remove', x.id);
      else openUrl('tyran://scan/?id=' + encodeURIComponent(x.id), true, e.ctrlKey);
    });
    list.append(row);
  }
  if (!list.children.length) list.innerHTML = `<div class="empty"><span class="kao">(｡•́︿•̀｡)</span>${text ? t('Không tìm thấy gì') : t('Chưa quét tệp nào')}</div>`;
  $('#more').textContent = '';
}

function showMode() {
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#q').placeholder = PLACEHOLDER[mode]();
}

await boot();
showMode();
document.querySelectorAll('#mode button').forEach((b) =>
  b.addEventListener('click', () => {
    if (mode === b.dataset.mode) return;
    mode = b.dataset.mode;
    history.replaceState(null, '', mode === 'pages' ? '#' : '#' + mode);
    showMode();
    load(true);
  })
);
api.on('winhistory:changed', () => mode === 'groups' && loadGroups());
api.on('scanhistory:changed', debounce(() => mode === 'scans' && loadScans(), 200));
$('#q').addEventListener('input', debounce(() => {
  text = $('#q').value.trim();
  load(true);
}, 150));
window.addEventListener('scroll', () => {
  if (window.innerHeight + window.scrollY > document.body.scrollHeight - 400) load(false);
});
let armed = false;
$('#clear').addEventListener('click', async () => {
  const btn = $('#clear');
  if (!armed) {
    armed = true;
    btn.lastElementChild.textContent = t('Bấm lần nữa để xóa');
    setTimeout(() => {
      armed = false;
      btn.lastElementChild.textContent = t('Xóa lịch sử');
    }, 3000);
    return;
  }
  armed = false;
  btn.lastElementChild.textContent = t('Xóa lịch sử');
  const span = Number($('#range').value);
  await api.invoke(CLEAR[mode], span ? Date.now() - span : 0);
  load(true);
});
api.on('history:changed', () => mode === 'pages' && load(true));
load(true);
$('#q').focus();
