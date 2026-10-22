import { api, boot, h, $, esc, debounce, hostOf } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

let items = [];

function render() {
  const list = $('#list');
  const q = $('#q').value.trim().toLowerCase();
  const shown = items.filter((d) => !q || (d.filename + ' ' + d.url).toLowerCase().includes(q));
  list.innerHTML = '';
  for (const d of shown) {
    const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
    const status =
      d.state === 'progressing' ? `${d.paused ? t('Tạm dừng · ') : ''}${pct}% · ${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}` :
      d.state === 'completed' ? `${fmtBytes(d.totalBytes || d.receivedBytes)} · ${new Date(d.endTime || d.startTime).toLocaleString(LOCALE)}` :
      d.state === 'cancelled' ? t('Đã hủy') : t('Thất bại');
    const actions = [];
    if (d.state === 'progressing') actions.push(d.paused ? ['resume', 'play', t('Tiếp tục')] : ['pause', 'pause', t('Tạm dừng')], ['cancel', 'x', t('Hủy')]);
    else if (d.state === 'completed') actions.push(['open', 'external', t('Mở tệp')], ['show', 'folder', t('Mở thư mục')]);
    else actions.push(['retry', 'reload', t('Tải lại')]);
    if (d.state !== 'progressing') actions.push(['remove', 'trash', t('Xóa khỏi danh sách')]);
    const item = h('div', { class: 'list-item', title: d.path || d.url });
    item.innerHTML = `<span class="state-ico ${d.state === 'completed' ? 'ok' : d.state === 'progressing' ? '' : 'bad'}">${icon(d.state === 'completed' ? 'check' : d.state === 'progressing' ? 'download' : 'x', 18)}</span>
      <span class="li-col"><span class="li-title">${esc(d.filename)}</span><span class="li-sub">${esc(status)} · ${esc(hostOf(d.url))}</span>
      ${d.state === 'progressing' ? `<span class="dl-progress"><i style="width:${pct}%"></i></span>` : ''}</span>
      <span class="li-actions" style="opacity:1">${actions.map(([a, ic, t]) => `<button class="icon-btn" data-act="${a}" title="${t}">${icon(ic, 15)}</button>`).join('')}</span>`;
    item.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) await api.invoke('downloads:action', d.id, act);
      else if (d.state === 'completed') await api.invoke('downloads:action', d.id, 'open');
      if (act === 'remove') load();
    });
    list.append(item);
  }
  if (!shown.length) list.innerHTML = `<div class="empty"><span class="kao">(｡･ω･｡)</span>${q ? t('Không tìm thấy tệp nào') : t('Chưa tải xuống gì cả')}</div>`;
}

async function load() {
  items = await api.invoke('downloads:list');
  render();
}

await boot();
await load();
$('#q').addEventListener('input', render);
$('#clear').addEventListener('click', async () => {
  await api.invoke('downloads:clear');
  load();
});
const refresh = debounce(load, 300);
api.on('downloads:update', refresh);
api.on('downloads:changed', refresh);
