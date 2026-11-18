// Kết quả kiểm tra (tyran://scan/?id=<download id>): what Windows Defender and VirusTotal's security
// vendors said of a download (main/filescan.js, main/virustotal.js), opened by itself when a
// download is done. Green: nothing found; yellow: a few vendors or "suspicious" only; red: a threat.
import { api, boot, h, $, esc, debounce, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LOCALE } from 'tyran://shared/i18n.js';

const id = new URLSearchParams(location.search).get('id') || '';
const VT_WEB = 'https://www.virustotal.com/gui/file/';
const BUSY = ['queued', 'looking', 'uploading', 'analyzing'];
const VT_BAD = 3; // (as main/filescan.js: one or two vendors alone are often wrong)

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${u[i]}`;
};
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(LOCALE) : '');

// a vendor's verdict: its words and colour
const CATEGORY = {
  malicious: [t('Độc hại'), 'bad', 'warn'],
  suspicious: [t('Đáng ngờ'), 'warn', 'warn'],
  undetected: [t('Không phát hiện'), 'ok', 'check'],
  harmless: [t('Vô hại'), 'ok', 'check'],
  'type-unsupported': [t('Không hỗ trợ loại tệp'), 'na', 'x'],
  timeout: [t('Hết thời gian'), 'na', 'x'],
  'confirmed-timeout': [t('Hết thời gian'), 'na', 'x'],
  failure: [t('Lỗi'), 'na', 'x'],
};
const ORDER = Object.keys(CATEGORY);

// how bad it is, all told: 'bad' | 'warn' | 'ok' | 'busy' | 'na'
function level(rec, stats) {
  const s = rec.scan || {};
  if (['threat', 'removed'].includes(s.state) || (stats.malicious || 0) >= VT_BAD) return 'bad';
  if ((stats.malicious || 0) > 0 || (stats.suspicious || 0) > 0) return 'warn';
  if (['queued', 'scanning'].includes(s.state) || BUSY.includes(s.vt?.state)) return 'busy';
  if (s.state === 'clean' || s.vt?.state === 'done' || stats.undetected || stats.harmless) return 'ok';
  return 'na';
}

function banner(rec, stats, lv, judged) {
  const s = rec.scan || {};
  const n = stats.malicious || 0;
  const sus = stats.suspicious || 0;
  let text;
  if (s.state === 'removed') text = t('Windows Defender đã chặn tệp này: {0}', s.threat || '?');
  else if (s.state === 'threat') text = t('Windows Defender phát hiện mã độc: {0}', s.threat || '?');
  else if (n) text = t('{0}/{1} hãng bảo mật đánh dấu tệp này là độc hại', n, judged);
  else if (sus) text = t('{0} hãng bảo mật cho rằng tệp này đáng ngờ', sus);
  else if (lv === 'busy') text = t('Đang kiểm tra…');
  else if (judged) text = t('Không hãng bảo mật nào đánh dấu tệp này là độc hại');
  else if (s.state === 'clean') text = t('Windows Defender không phát hiện mối nguy nào');
  else text = t('Chưa kiểm tra được tệp này');
  const ic = { bad: 'warn', warn: 'warn', ok: 'shieldCheck', busy: 'shield', na: 'shield' }[lv];
  return h('div', { class: `banner lv-${lv}`, html: `${icon(ic, 18)}<span>${esc(text)}</span>` });
}

// the ring: vendors calling it malicious, of those that judged it (Defender's verdict without them)
function ring(rec, stats, lv, judged) {
  const box = h('div', { class: `ring lv-${lv}` });
  if (!judged) {
    const s = rec.scan || {};
    const word = { clean: t('An toàn'), threat: t('Có mã độc'), removed: t('Đã chặn'), queued: t('Đang kiểm tra…'), scanning: t('Đang kiểm tra…') }[s.state] || t('Không kiểm tra được');
    box.innerHTML = `<div class="ring-ico">${icon(lv === 'ok' ? 'shieldCheck' : lv === 'busy' ? 'shield' : 'warn', 44)}</div><div class="ring-sub">${esc(word)}</div>`;
    return box;
  }
  const n = stats.malicious || 0;
  const C = 2 * Math.PI * 52;
  const part = n ? Math.max(0.04, n / judged) : 1;
  box.innerHTML = `<svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="arc" cx="60" cy="60" r="52" stroke-dasharray="${(C * part).toFixed(1)} ${C.toFixed(1)}"/></svg>
    <div class="ring-num"><b>${n}</b><span>/ ${judged}</span></div>`;
  return box;
}

const chip = (text, lv = '', count) => h('span', { class: `chip${lv ? ' lv-' + lv : ''}`, html: `${esc(text)}${count !== undefined ? ` <b>${count}</b>` : ''}` });

// VirusTotal's state when it has no report yet, with what can be done about it
function vtState(rec) {
  const vt = rec.scan?.vt || {};
  const words = {
    queued: t('Đang chờ tra VirusTotal…'),
    looking: t('Đang tra VirusTotal…'),
    uploading: t('Đang gửi tệp lên VirusTotal…'),
    analyzing: t('VirusTotal đang phân tích tệp…'),
    unknown: t('VirusTotal chưa có dữ liệu về tệp này'),
    toobig: t('Tệp quá lớn để gửi lên VirusTotal'),
    nokey: t('Chưa có API key VirusTotal'),
    badkey: t('API key VirusTotal không hợp lệ'),
    quota: t('Đã hết lượt tra VirusTotal'),
    error: t('Không kết nối được VirusTotal'),
  };
  if (!vt.state && !rec.scan?.sha256) return null;
  const row = h('div', { class: `card vt-state${BUSY.includes(vt.state) ? ' busy' : ''}` }, h('span', { html: icon(BUSY.includes(vt.state) ? 'reload' : 'info', 16) }), h('span', { class: 'grow', text: words[vt.state] || t('Đang chờ tra VirusTotal…') }));
  if (['nokey', 'badkey'].includes(vt.state)) row.append(button(t('Thêm API key'), 'external', () => openUrl('tyran://settings/#general', true)));
  if (['quota', 'error', 'nokey', 'badkey'].includes(vt.state) && rec.scan?.sha256) row.append(button(t('Tra lại'), 'reload', () => api.invoke('scan:recheck', id).then(load)));
  return row;
}

function button(label, ic, run, cls = '') {
  const b = h('button', { type: 'button', class: `btn ${cls}`, html: `${icon(ic, 15)}<span>${esc(label)}</span>` });
  b.addEventListener('click', run);
  return b;
}

function render(d) {
  const root = $('#root');
  root.innerHTML = '';
  if (!d) {
    root.append(h('div', { class: 'empty', html: `<span class="kao">(｡･ω･｡)</span>${esc(t('Không tìm thấy lượt tải này'))}` }));
    return;
  }
  const { rec, report } = d;
  const a = report?.attributes || {};
  const s = rec.scan || {};
  const stats = a.last_analysis_stats || s.vt?.stats || {};
  const judged = ['malicious', 'suspicious', 'undetected', 'harmless'].reduce((n, k) => n + (stats[k] || 0), 0);
  const lv = level(rec, stats);
  document.title = `${t('Kết quả kiểm tra')}: ${rec.filename}`;

  // ---- the summary
  const ext = (a.type_extension || (/\.([a-z0-9]{1,5})$/i.exec(rec.filename || '') || [])[1] || '?').toUpperCase();
  const tags = [...new Set([a.type_tag, ...(a.tags || [])].filter(Boolean))].slice(0, 10);
  const facts = h(
    'div',
    { class: 'facts' },
    h('div', {}, h('span', { class: 'muted', text: t('Kích thước') }), h('b', { text: fmtBytes(a.size || rec.totalBytes || rec.receivedBytes) })),
    a.type_description ? h('div', {}, h('span', { class: 'muted', text: t('Dạng tệp') }), h('b', { text: a.type_description })) : null,
    a.last_analysis_date ? h('div', {}, h('span', { class: 'muted', text: t('Lần phân tích gần nhất') }), h('b', { text: fmtDate(a.last_analysis_date * 1000) })) : null,
    // (a program's or a script's own icon when there is one, with its kind in letters under it)
    d.icon ? h('div', { class: 'typebox has-icon' }, h('img', { src: d.icon, alt: '', width: 32, height: 32 }), h('b', { text: ext.slice(0, 5) })) : h('div', { class: 'typebox', html: `${icon('download', 16)}<b>${esc(ext.slice(0, 5))}</b>` })
  );
  const info = h(
    'div',
    { class: 'card sum-main' },
    banner(rec, stats, lv, judged),
    h('div', { class: 'sum-row' }, h('div', { class: 'sum-id' }, s.sha256 ? h('div', { class: 'sha', text: s.sha256 }) : null, h('div', { class: 'fname', text: rec.filename }), tags.length ? h('div', { class: 'chips' }, ...tags.map((x) => chip(x))) : null), facts)
  );
  const actions = h('div', { class: 'actions' });
  const bad = lv === 'bad';
  if (rec.state === 'completed' && !bad && s.state !== 'removed') actions.append(button(t('Mở tệp'), 'external', () => act('open')));
  if (rec.state === 'completed' && s.state !== 'removed') actions.append(button(t('Mở thư mục'), 'folder', () => act('show')));
  if (bad && s.state !== 'removed' && rec.state === 'completed') actions.append(button(t('Cách ly'), 'trash', () => act('quarantine'), 'danger'));
  if (s.sha256) actions.append(button(t('Xem trên VirusTotal'), 'external', () => openUrl(VT_WEB + s.sha256, true)));
  root.append(h('div', { class: 'scan-sum' }, h('div', { class: 'card ring-card' }, ring(rec, stats, lv, judged), h('span', { class: 'muted small', text: judged ? 'VirusTotal' : 'Windows Defender' })), info), actions);

  // ---- Windows Defender, on this computer
  const dState = {
    queued: [t('Đang chờ kiểm tra…'), 'busy', 'shield'],
    scanning: [t('Đang kiểm tra…'), 'busy', 'shield'],
    clean: [t('Không phát hiện'), 'ok', 'check'],
    threat: [s.threat || t('Có mã độc'), 'bad', 'warn'],
    removed: [t('Đã chặn: {0}', s.threat || '?'), 'bad', 'warn'],
    unavailable: [t('Không kiểm tra được'), 'na', 'x'],
    error: [t('Không kiểm tra được'), 'na', 'x'],
  }[s.state] || [t('Không kiểm tra được'), 'na', 'x'];
  root.append(h('div', { class: 'card defender' }, h('b', { text: 'Windows Defender' }), h('span', { class: `vres lv-${dState[1]}`, html: `${icon(dState[2], 15)}<span>${esc(dState[0])}</span>` })));

  // ---- VirusTotal
  if (!report) {
    const st = vtState(rec);
    if (st) root.append(st);
    return;
  }
  const counts = h('div', { class: 'chips counts' });
  const merged = { ...stats, timeout: (stats.timeout || 0) + (stats['confirmed-timeout'] || 0) };
  for (const k of ORDER) if (k !== 'confirmed-timeout' && merged[k]) counts.append(chip(CATEGORY[k][0], CATEGORY[k][1], merged[k]));
  root.append(h('h2', { class: 'stitle', text: t('Số lượng theo kết quả') }), counts);

  const ptc = a.popular_threat_classification;
  if (ptc && (ptc.suggested_threat_label || ptc.popular_threat_category?.length || ptc.popular_threat_name?.length)) {
    const box = h('div', { class: 'card threats' });
    if (ptc.suggested_threat_label) box.append(h('div', { class: 'threat-label', html: `${icon('warn', 15)}<span>${esc(t('Nhãn mối nguy'))}:</span> <b>${esc(ptc.suggested_threat_label)}</b>` }));
    if (ptc.popular_threat_category?.length) box.append(h('div', { class: 'threat-line' }, h('span', { class: 'muted', text: t('Loại mối nguy') }), h('div', { class: 'chips' }, ...ptc.popular_threat_category.map((c) => chip(c.value, 'bad', c.count)))));
    if (ptc.popular_threat_name?.length) box.append(h('div', { class: 'threat-line' }, h('span', { class: 'muted', text: t('Tên mối nguy') }), h('div', { class: 'chips' }, ...ptc.popular_threat_name.map((c) => chip(c.value, 'warn', c.count)))));
    root.append(h('h2', { class: 'stitle', text: t('Phân loại mối nguy') }), box);
  }

  const results = Object.entries(a.last_analysis_results || {}).map(([name, r]) => ({ name: r.engine_name || name, cat: r.category in CATEGORY ? r.category : 'failure', result: r.result }));
  results.sort((x, y) => ORDER.indexOf(x.cat) - ORDER.indexOf(y.cat) || x.name.localeCompare(y.name));
  const grid = h('div', { class: 'vendors' });
  for (const r of results) {
    const [word, lvl, ic] = CATEGORY[r.cat];
    const text = ['malicious', 'suspicious'].includes(r.cat) && r.result ? r.result : word;
    grid.append(h('div', { class: 'vrow' }, h('span', { class: 'vname', text: r.name }), h('span', { class: `vres lv-${lvl}`, html: `${icon(ic, 15)}<span>${esc(text)}</span>` })));
  }
  root.append(h('h2', { class: 'stitle', html: `${esc(t('Phân tích của các hãng bảo mật'))} <span class="muted">${results.length}</span>` }), h('div', { class: 'card' }, grid));
}

// (opening one with a threat is refused in main: the page already says why)
async function act(what) {
  await api.invoke('downloads:action', id, what);
  load();
}

let busy = false;
async function load() {
  if (busy) return;
  busy = true;
  try {
    render(await api.invoke('scan:get', id));
  } finally {
    busy = false;
  }
}

await boot();
await load();
const refresh = debounce(load, 250);
api.on('downloads:update', (d) => d?.id === id && refresh());
api.on('downloads:changed', refresh);
