// Command palette (Ctrl+K / Ctrl+Shift+A): one box to search commands, tabs, themes,
// bookmarks and history. Matching ignores Vietnamese diacritics.
import { api, h, $, esc, faviconHtml, prettyUrl } from './util.js';
import { S } from './state.js';
import { T, activate, active } from './tabs.js';
import { openUrl } from './bookmarks.js';
import { PRESETS, presetPatch } from 'tyran://shared/themes.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

let commandSource = () => [];
export const setCommandSource = (fn) => (commandSource = fn);

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

// subsequence match; contiguous runs and word starts score higher
function score(text, q) {
  if (!q) return 1;
  const t = fold(text);
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === ' ' ? 30 : 0);
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    s += 1 + run * 2;
    ti = found + 1;
  }
  return s;
}

const SETTINGS_SECTIONS = [
  ['appearance', t('Giao diện & theme'), 'palette'],
  ['wallpaper', t('Hình nền'), 'image'],
  ['layout', t('Bố cục'), 'layout'],
  ['newtab', t('Trang tab mới'), 'sparkles'],
  ['general', t('Chung & tìm kiếm'), 'sliders'],
  ['privacy', t('Quyền riêng tư & bảo mật'), 'shield'],
  ['shortcuts', t('Phím tắt'), 'keyboard'],
  ['css', t('CSS tùy chỉnh'), 'code'],
  ['about', t('Giới thiệu & nguồn ảnh'), 'info'],
];

let root = null;

export function openPalette(initial = '') {
  if (root) return root.querySelector('input').focus();
  const input = h('input', { type: 'text', class: 'pal-input', placeholder: t('Gõ lệnh, tên tab, theme, dấu trang… (không cần dấu)'), spellcheck: 'false', value: initial });
  const list = h('div', { class: 'pal-list' });
  const box = h('div', { class: 'palette' }, h('div', { class: 'pal-head' }, h('span', { class: 'pal-ico', html: icon('command', 18) }), input, h('kbd', { text: 'Esc' })), list);
  root = h('div', { class: 'pal-scrim' }, box);
  root.addEventListener('pointerdown', (e) => e.target === root && closePalette());
  $('#layer').append(root);

  let results = [];
  let sel = 0;
  let qid = 0;

  const staticItems = () => {
    const out = [];
    for (const c of commandSource()) out.push({ kind: t('Lệnh'), icon: c.icon || 'command', title: c.label, hint: c.keys?.[0] || '', run: c.run });
    for (const t of T.list) out.push({ kind: 'Tab', fav: t, title: t.title, sub: prettyUrl(t.url), run: () => activate(t.id) });
    for (const p of PRESETS) out.push({ kind: 'Theme', icon: 'palette', title: `Theme: ${p.name}`, sub: p.sub, swatch: p.appearance.accent, run: () => api.invoke('settings:set', presetPatch(p)) });
    for (const [id, label, ic] of SETTINGS_SECTIONS) out.push({ kind: t('Cài đặt'), icon: ic, title: t('Cài đặt: {0}', label), run: () => openUrl(`tyran://settings/#${id}`, { newTab: true }) });
    for (const b of S.bookmarks.items) out.push({ kind: t('Dấu trang'), fav: b, title: b.title || b.url, sub: prettyUrl(b.url), run: () => openUrl(b.url) });
    return out;
  };

  const render = () => {
    list.innerHTML = results.length
      ? results
          .map((r, i) => {
            const lead = r.fav ? faviconHtml(r.fav.favicon, r.fav.title, r.fav.url) : r.swatch ? `<span class="pal-swatch" style="background:${esc(r.swatch)}"></span>` : icon(r.icon, 16);
            return `<div class="pal-item${i === sel ? ' sel' : ''}" data-i="${i}"><span class="pal-lead">${lead}</span><span class="pal-text"><span class="pal-title">${esc(r.title)}</span>${r.sub ? `<span class="pal-sub">${esc(r.sub)}</span>` : ''}</span><span class="pal-kind">${esc(r.kind)}</span>${r.hint ? `<kbd>${esc(r.hint)}</kbd>` : ''}</div>`;
          })
          .join('')
      : t('<div class="empty-note">Không tìm thấy gì (；一_一)</div>');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };

  const update = async () => {
    const q = fold(input.value.trim());
    const id = ++qid;
    const all = staticItems();
    results = all
      .map((r) => ({ r, s: Math.max(score(r.title, q), r.sub ? score(r.sub, q) * 0.6 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, q ? 40 : 30)
      .map((x) => x.r);
    sel = 0;
    render();
    if (q.length >= 2 && !S.private && !active()?.incognito) {
      const hist = await api.invoke('history:suggest', input.value.trim());
      if (id !== qid) return;
      for (const v of hist.slice(0, 6)) results.push({ kind: t('Lịch sử'), fav: v, title: v.title || v.url, sub: prettyUrl(v.url), run: () => openUrl(v.url) });
      render();
    }
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[sel];
      closePalette();
      r?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.pal-item');
    if (!row) return;
    const r = results[Number(row.dataset.i)];
    closePalette();
    r?.run();
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.pal-item');
    if (row && Number(row.dataset.i) !== sel) {
      sel = Number(row.dataset.i);
      list.querySelectorAll('.pal-item').forEach((n, i) => n.classList.toggle('sel', i === sel));
    }
  });
  update();
  requestAnimationFrame(() => input.focus());
}

export function closePalette() {
  root?.remove();
  root = null;
}
