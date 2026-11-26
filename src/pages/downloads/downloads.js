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
// (a threat by Defender, or by 3 or more of VirusTotal's vendors, as main/filescan.js counts it)
const flagged = (d) => ['threat', 'removed'].includes(d.scan?.state) || (d.scan?.vt?.stats?.malicious || 0) >= 3;
const tone = (d) => (d.state === 'progressing' ? (d.paused ? 'paused' : '') : d.state === 'completed' && !flagged(d) ? 'done' : 'bad');
// Defender's verdict, then VirusTotal's count (vendors calling it malicious, of those that judged it)
function scanText(s) {
  const st = s?.vt?.state === 'done' ? s.vt.stats || {} : null;
  const judged = st ? ['malicious', 'suspicious', 'undetected', 'harmless'].reduce((n, k) => n + (st[k] || 0), 0) : 0;
  return [defenderText(s), judged ? `VirusTotal ${st.malicious || 0}/${judged}` : ''].filter(Boolean).join(' · ');
}
function defenderText(s) {
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

// a comic chapter (Tải truyện tranh: main/manga.js): its pictures, done of all, and those that failed
function pagesStatus(d) {
  const failed = d.pagesFailed ? t('{0} ảnh lỗi', d.pagesFailed) : '';
  if (d.state === 'progressing') return [`${d.pagesTotal ? Math.round((d.pagesDone / d.pagesTotal) * 100) : 0}%`, t('{0}/{1} ảnh', d.pagesDone || 0, d.pagesTotal || 0), failed].filter(Boolean).join(' · ');
  if (d.state === 'completed') return [t('Hoàn tất · {0} ảnh', d.pagesDone || 0), d.totalBytes ? fmtBytes(d.totalBytes) : '', failed, new Date(d.endTime || d.startTime).toLocaleString(LOCALE)].filter(Boolean).join(' · ');
  if (d.state === 'cancelled') return t('Đã hủy');
  return [t('Thất bại'), failed].filter(Boolean).join(' · ');
}

function render() {
  const list = $('#list');
  const q = $('#q').value.trim().toLowerCase();
  const shown = items.filter((d) => !q || (d.filename + ' ' + (d.label || '') + ' ' + d.url).toLowerCase().includes(q));
  list.innerHTML = '';
  for (const d of shown) {
    const pages = d.unit === 'pages';
    const pct = pages ? (d.pagesTotal ? Math.round((d.pagesDone / d.pagesTotal) * 100) : 0) : d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0;
    const status =
      pages ? [pagesStatus(d), d.state === 'completed' ? scanText(d.scan) : ''].filter(Boolean).join(' · ') :
      d.state === 'progressing' ? `${d.paused ? t('Tạm dừng · ') : ''}${pct}% · ${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}` :
      d.state === 'completed' ? [fmtBytes(d.totalBytes || d.receivedBytes), scanText(d.scan), new Date(d.endTime || d.startTime).toLocaleString(LOCALE)].filter(Boolean).join(' · ') :
      d.state === 'cancelled' ? t('Đã hủy') : [t('Thất bại'), scanText(d.scan)].filter(Boolean).join(' · ');
    const actions = [];
    if (d.state === 'progressing') actions.push(...(pages ? [] : [d.paused ? ['resume', 'play', t('Tiếp tục')] : ['pause', 'pause', t('Tạm dừng')]]), ['cancel', 'x', t('Hủy')]);
    else if (d.state === 'completed') {
      if (d.scan?.state === 'threat') actions.push(['quarantine', 'trash', t('Cách ly')]);
      else if (!flagged(d)) actions.push(['open', 'external', t('Mở tệp')]);
      if (d.scan) actions.push(['result', 'shield', t('Kết quả kiểm tra')]);
      if (d.scan?.state !== 'removed') actions.push(['show', 'folder', t('Mở thư mục')]);
    } else if (!flagged(d)) actions.push(['retry', 'reload', t('Tải lại')]); // (not one Defender stopped)
    if (d.state !== 'progressing') actions.push(['remove', 'x', t('Xóa khỏi danh sách')]);
    const mood = tone(d);
    // (a finished one can be dragged out: into a page, onto the tabs, into a folder: main/sessions.js downloadDrag)
    const drag = d.state === 'completed' && !flagged(d);
    const item = h('div', { class: `list-item${mood ? ' dl-' + mood : ''}`, title: d.path || d.url, draggable: drag ? 'true' : null });
    if (drag) {
      item.addEventListener('dragstart', (e) => {
        e.preventDefault();
        api.invoke('downloads:drag', d.id).then((r) => {
          if (r === 'missing') host('toast', t('Không tìm thấy file (có thể đã bị xóa/di chuyển)'));
          if (r === 'threat') host('toast', t('Tệp này có mã độc nên không được mở'));
        }, () => {});
      });
    }
    const ic = d.state === 'progressing' ? (d.paused ? 'pause' : 'download') : d.state !== 'completed' ? 'x' : flagged(d) ? 'warn' : 'check';
    item.innerHTML = `<span class="state-ico ${{ done: 'ok', bad: 'bad', paused: 'warn' }[mood] || ''}">${icon(ic, 18)}</span>
      <span class="li-col"><span class="li-title">${esc(d.label || d.filename)}</span><span class="li-sub">${esc(status)} · ${esc(hostOf(d.url))}</span>
      ${d.state === 'progressing' ? `<span class="dl-progress"><i style="width:${pct}%"></i></span>` : ''}</span>
      <span class="li-actions" style="opacity:1">${actions.map(([a, ic, t]) => `<button class="icon-btn" data-act="${a}" title="${t}">${icon(ic, 15)}</button>`).join('')}</span>`;
    item.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'result') return openUrl('tyran://scan/?id=' + encodeURIComponent(d.id), true);
      if (act === 'retry' && pages) return openUrl(d.url, true); // (a comic chapter: its page opened again, to download it from there)
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
