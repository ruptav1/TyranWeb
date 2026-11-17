import { api, boot, h, $, esc, debounce, hostOf, faviconHtml, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const list = $('#list');
let offset = 0;
let text = '';
let lastDay = '';
let loading = false;
let done = false;
// what is listed: the pages visited, or the tab groups (windows closed, each with its tabs)
let mode = location.hash === '#groups' ? 'groups' : 'pages';

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

function showMode() {
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#q').placeholder = mode === 'groups' ? t('Tìm trong nhóm tab…') : t('Tìm trong lịch sử…');
}

await boot();
showMode();
document.querySelectorAll('#mode button').forEach((b) =>
  b.addEventListener('click', () => {
    if (mode === b.dataset.mode) return;
    mode = b.dataset.mode;
    history.replaceState(null, '', mode === 'groups' ? '#groups' : '#');
    showMode();
    load(true);
  })
);
api.on('winhistory:changed', () => mode === 'groups' && loadGroups());
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
  await api.invoke(mode === 'groups' ? 'winhistory:clear' : 'history:clear', span ? Date.now() - span : 0);
  load(true);
});
api.on('history:changed', () => mode === 'pages' && load(true));
load(true);
$('#q').focus();
