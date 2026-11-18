// Downloads: toolbar button with a progress ring + a popover with recent downloads.
import { api, h, esc, fmtBytes } from './util.js';
import { S } from './state.js';
import { createTab, hasIncognito } from './tabs.js';
import { openPopover, closePopover, isPopoverOpen, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

let button = null;
let pop = null;

// The row's colour: none while downloading, yellow paused, green done, red cancelled, failed or with
// a threat in it (Kiểm tra tệp tải về: main/filescan.js)
const VT = 'https://www.virustotal.com/gui/file/';
const RISKY = /\.(exe|bat|cmd|com|scr|msi|msix|ps1|vbs|js|jar|dll|lnk|hta|zip|rar|7z)$/i;
const flagged = (d) => ['threat', 'removed'].includes(d.scan?.state);
function tone(d) {
  if (d.state === 'progressing') return d.paused ? 'paused' : '';
  if (d.state === 'completed') return flagged(d) ? 'bad' : 'done';
  return 'bad';
}
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

export function downloadsButton() {
  button = h('button', { class: 'icon-btn dl-btn', title: t('Tải xuống (Ctrl+J)') });
  button.addEventListener('click', () => showPopover(button));
  renderButton();
  return button;
}

function activeDownloads() {
  return [...S.downloads.values()].filter((d) => d.state === 'progressing');
}

function renderButton() {
  if (!button) return;
  const act = activeDownloads();
  const total = act.reduce((a, d) => a + (d.totalBytes || 0), 0);
  const got = act.reduce((a, d) => a + (d.receivedBytes || 0), 0);
  const p = total ? got / total : act.length ? 0.15 : 0;
  const C = 2 * Math.PI * 10;
  button.classList.toggle('busy', act.length > 0);
  button.innerHTML =
    icon('download', 17) +
    (act.length
      ? `<svg class="dl-ring" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}"/></svg><span class="dl-count">${act.length}</span>`
      : '');
}

function statusText(d) {
  if (d.state === 'progressing') {
    const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) + '% · ' : '';
    return `${d.paused ? t('Tạm dừng · ') : ''}${pct}${fmtBytes(d.receivedBytes)}${d.totalBytes ? ' / ' + fmtBytes(d.totalBytes) : ''}`;
  }
  if (d.state === 'completed') return [t('Hoàn tất · {0}', fmtBytes(d.totalBytes || d.receivedBytes)), scanText(d.scan)].filter(Boolean).join(' · ');
  if (d.state === 'cancelled') return t('Đã hủy');
  return [t('Thất bại'), scanText(d.scan)].filter(Boolean).join(' · ');
}

function row(d) {
  const pct = d.totalBytes ? (d.receivedBytes / d.totalBytes) * 100 : 0;
  const actions = [];
  if (d.state === 'progressing') {
    actions.push(d.paused ? ['resume', 'play', t('Tiếp tục')] : ['pause', 'pause', t('Tạm dừng')]);
    actions.push(['cancel', 'x', t('Hủy')]);
  } else if (d.state === 'completed') {
    if (d.scan?.state === 'threat') actions.push(['quarantine', 'trash', t('Cách ly')]);
    if (d.scan?.sha256 && (flagged(d) || RISKY.test(d.filename || ''))) actions.push(['virustotal', 'shield', 'VirusTotal']);
    if (d.scan?.state !== 'removed') actions.push(['show', 'folder', t('Mở thư mục')]);
  } else if (!flagged(d)) {
    actions.push(['retry', 'reload', t('Thử lại')]); // (not one Defender stopped)
  }
  const ic = d.state === 'progressing' ? (d.paused ? 'pause' : 'download') : d.state !== 'completed' ? 'x' : flagged(d) ? 'warn' : 'check';
  return `<div class="dl-row ${d.state} ${tone(d)}" data-id="${esc(d.id)}">
    <span class="dl-file">${icon(ic, 16)}</span>
    <span class="dl-info"><span class="dl-name" title="${esc(d.path || d.filename)}">${esc(d.filename)}</span>
      <span class="dl-status">${esc(statusText(d))}</span>
      ${d.state === 'progressing' ? `<span class="dl-bar"><i style="width:${pct.toFixed(1)}%"></i></span>` : ''}</span>
    <span class="dl-actions">${actions.map(([a, ic, t]) => `<button class="icon-btn" data-act="${a}" title="${t}">${icon(ic, 15)}</button>`).join('')}</span>
  </div>`;
}

async function showPopover(anchor) {
  const list = await api.invoke('downloads:list');
  for (const d of list) if (!S.downloads.has(d.id)) S.downloads.set(d.id, d);
  const body = h('div', { class: 'dl-pop' });
  const render = () => {
    const items = [...S.downloads.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 7);
    body.innerHTML = `<div class="pop-head"><span class="pop-head-ico">${icon('download', 18)}</span><b>${t('Tải xuống gần đây')}</b></div>
      <div class="dl-list">${items.length ? items.map(row).join('') : t('<div class="empty-note">Chưa có gì được tải xuống ✿</div>')}</div>
      <div class="pop-foot"><button class="btn ghost small" data-all>${t('Xem tất cả')}</button></div>`;
  };
  render();
  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-all]')) {
      closePopover();
      createTab({ url: 'tyran://downloads/' });
      return;
    }
    const btn = e.target.closest('[data-act]');
    const rowEl = e.target.closest('.dl-row');
    if (!rowEl) return;
    const id = rowEl.dataset.id;
    const d = S.downloads.get(id);
    if (btn?.dataset.act === 'virustotal') {
      closePopover();
      if (d?.scan?.sha256) createTab({ url: VT + d.scan.sha256 });
    } else if (btn) told(await api.invoke('downloads:action', id, btn.dataset.act));
    else if (d?.state === 'completed') told(await api.invoke('downloads:action', id, 'open'));
  });
  pop = { render };
  openPopover(body, anchor, { align: 'end', onClose: () => (pop = null), focus: false });
}

// what an action came back with, told
function told(r) {
  if (r === 'missing') toast(t('Không tìm thấy file (có thể đã bị xóa/di chuyển)'), { icon: 'warn' });
  if (r === 'threat') toast(t('Tệp này có mã độc nên không được mở'), { icon: 'warn' });
}

export function openDownloadsPopover() {
  if (button && button.isConnected && button.offsetParent) showPopover(button);
  else createTab({ url: 'tyran://downloads/' });
}

export function initDownloads() {
  api.invoke('downloads:list').then((list) => {
    for (const d of list) S.downloads.set(d.id, d);
    renderButton();
  });
  api.on('downloads:update', (d) => {
    // downloads started in private windows only show up in private windows
    if (d.private && !hasIncognito()) return;
    const isNew = !S.downloads.has(d.id);
    S.downloads.set(d.id, d);
    renderButton();
    if (pop && isPopoverOpen()) pop.render();
    if (isNew && d.state === 'progressing') {
      toast(t('Đang tải xuống: {0}', d.filename), { icon: 'download' });
      button?.classList.add('bump');
      setTimeout(() => button?.classList.remove('bump'), 600);
    }
  });
  api.on('downloads:done', (d) => {
    if (d.private && !hasIncognito()) return;
    toast(t('Đã tải xong: {0}', d.filename), { icon: 'check', action: { label: t('Mở'), run: () => api.invoke('downloads:action', d.id, 'open').then(told) } });
  });
  api.on('downloads:threat', (d) => {
    if (d.private && !hasIncognito()) return;
    const name = d.scan?.threat || '?';
    if (d.scan?.state === 'removed') toast(t('Windows Defender đã chặn {0} ({1})', d.filename, name), { icon: 'warn' });
    else toast(t('Có mã độc trong {0} ({1})', d.filename, name), { icon: 'warn', action: { label: t('Cách ly'), run: () => api.invoke('downloads:action', d.id, 'quarantine') } });
  });
  api.on('downloads:changed', async () => {
    const list = await api.invoke('downloads:list');
    S.downloads = new Map(list.map((d) => [d.id, d]));
    renderButton();
    if (pop && isPopoverOpen()) pop.render();
  });
}
