import { api, boot, h, $, esc, debounce, hostOf, host, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

let items = [];

// Kiểm tra tệp tải về (main/filescan.js): what Windows Defender said, and the row's colour (none
// while downloading, yellow paused, green done, red cancelled, failed or with a threat in it)
const VT = 'https://www.virustotal.com/gui/file/';
const flagged = (d) => ['threat', 'removed'].includes(d.scan?.state);
const tone = (d) => (d.state === 'progressing' ? (d.paused ? 'paused' : '') : d.state === 'completed' && !flagged(d) ? 'done' : 'bad');
function scanText(s) {
  switch (s?.state) {
    case 'queued':
    case 'scanning':
      return t('Đang kiểm tra…');
    case 'clean':
      return t('An toàn');
    case 'threat':
      return s.threat ? t('Có mã độc: {0}', s.threat) : t('Có mã độc');
    case 'removed':
      return s.threat ? t('Đã chặn: {0}', s.threat) : t('Đã chặn');
    case 'unavailable':
    case 'error':
      return t('Không kiểm tra được');
  }
  return '';
}

function render() {
  const list = $('#list');
  const q = $('#q').value.trim().toLowerCase();
  const shown = items.filter((d) => !q || (d.filename + ' ' + d.url).toLowerCase().includes(q));
  list.innerHTML = '';
  for (const d of shown) {
    const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
    const status =
      d.state === 'progressing' ? `${d.paused ? t('Tạm dừng · ') : ''}${pct}% · ${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}` :
      d.state === 'completed' ? [fmtBytes(d.totalBytes || d.receivedBytes), scanText(d.scan), new Date(d.endTime || d.startTime).toLocaleString(LOCALE)].filter(Boolean).join(' · ') :
      d.state === 'cancelled' ? t('Đã hủy') : [t('Thất bại'), scanText(d.scan)].filter(Boolean).join(' · ');
    const actions = [];
    if (d.state === 'progressing') actions.push(d.paused ? ['resume', 'play', t('Tiếp tục')] : ['pause', 'pause', t('Tạm dừng')], ['cancel', 'x', t('Hủy')]);
    else if (d.state === 'completed') {
      if (d.scan?.state === 'threat') actions.push(['quarantine', 'trash', t('Cách ly')]);
      else if (!flagged(d)) actions.push(['open', 'external', t('Mở tệp')]);
      if (d.scan?.sha256) actions.push(['virustotal', 'shield', 'VirusTotal']);
      if (d.scan?.state !== 'removed') actions.push(['show', 'folder', t('Mở thư mục')]);
    } else if (!flagged(d)) actions.push(['retry', 'reload', t('Tải lại')]); // (not one Defender stopped)
    if (d.state !== 'progressing') actions.push(['remove', 'x', t('Xóa khỏi danh sách')]);
    const mood = tone(d);
    const item = h('div', { class: `list-item${mood ? ' dl-' + mood : ''}`, title: d.path || d.url });
    const ic = d.state === 'progressing' ? (d.paused ? 'pause' : 'download') : d.state !== 'completed' ? 'x' : flagged(d) ? 'warn' : 'check';
    item.innerHTML = `<span class="state-ico ${{ done: 'ok', bad: 'bad', paused: 'warn' }[mood] || ''}">${icon(ic, 18)}</span>
      <span class="li-col"><span class="li-title">${esc(d.filename)}</span><span class="li-sub">${esc(status)} · ${esc(hostOf(d.url))}</span>
      ${d.state === 'progressing' ? `<span class="dl-progress"><i style="width:${pct}%"></i></span>` : ''}</span>
      <span class="li-actions" style="opacity:1">${actions.map(([a, ic, t]) => `<button class="icon-btn" data-act="${a}" title="${t}">${icon(ic, 15)}</button>`).join('')}</span>`;
    item.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'virustotal') return openUrl(VT + d.scan.sha256, true);
      let r = null;
      if (act) r = await api.invoke('downloads:action', d.id, act);
      else if (d.state === 'completed' && !flagged(d)) r = await api.invoke('downloads:action', d.id, 'open');
      if (r === 'threat') host('toast', t('Tệp này có mã độc nên không được mở'));
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
