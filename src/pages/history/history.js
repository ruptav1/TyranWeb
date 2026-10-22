import { api, boot, h, $, esc, debounce, hostOf, faviconHtml, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const list = $('#list');
let offset = 0;
let text = '';
let lastDay = '';
let loading = false;
let done = false;

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('Hôm nay');
  if (d.toDateString() === y.toDateString()) return t('Hôm qua');
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function load(reset) {
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

await boot();
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
  await api.invoke('history:clear', span ? Date.now() - span : 0);
  load(true);
});
api.on('history:changed', () => load(true));
load(true);
$('#q').focus();
