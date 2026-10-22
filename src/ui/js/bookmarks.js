// Bookmarks bar and the "star" popover.
import { api, h, $, on, emit, faviconHtml } from './util.js';
import { S } from './state.js';
import { active, createTab, navigate } from './tabs.js';
import { openMenu, openPopover, closePopover, promptText, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

export async function loadBookmarks() {
  S.bookmarks = await api.invoke('bookmarks:get');
  renderBar();
  emit('bookmarks');
}

export function openUrl(url, { newTab = false, background = false } = {}) {
  const t = active();
  if (newTab || !t) createTab({ url, background });
  else navigate(t.id, url);
}

function bookmarkMenu(b, at) {
  openMenu(
    [
      { label: t('Mở'), icon: 'external', run: () => openUrl(b.url) },
      { label: t('Mở trong tab mới'), icon: 'plus', run: () => openUrl(b.url, { newTab: true }) },
      { label: t('Mở trong tab nền'), icon: 'layers', run: () => openUrl(b.url, { newTab: true, background: true }) },
      { sep: true },
      { label: t('Sửa…'), icon: 'edit', run: () => editBookmark(b, at) },
      { label: t('Sao chép liên kết'), icon: 'copy', run: () => api.invoke('clipboard:write', b.url) },
      { sep: true },
      { label: t('Xóa'), icon: 'trash', danger: true, run: () => api.invoke('bookmarks:remove', b.id) },
    ],
    at
  );
}

function folderMenu(folder, at) {
  const list = S.bookmarks.items.filter((b) => b.folder === folder.id);
  openMenu(
    [
      { title: folder.name },
      ...list.map((b) => ({ label: b.title || b.url, icon: 'globe', run: () => openUrl(b.url) })),
      list.length ? { sep: true } : { label: t('Thư mục trống'), disabled: true },
      list.length ? { label: t('Mở tất cả ({0})', list.length), icon: 'layers', run: () => list.forEach((b) => createTab({ url: b.url, background: true })) } : null,
    ],
    at
  );
}

export function renderBar() {
  const bar = $('#bookmarks-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const { folders, items } = S.bookmarks;
  for (const b of items.filter((x) => x.folder === 'bar')) {
    const chip = h('button', { class: 'bm-chip', title: `${b.title}\n${b.url}`, draggable: 'true', dataset: { id: b.id }, html: `${faviconHtml(b.favicon, b.title, b.url)}<span>${escapeText(b.title || b.url)}</span>` });
    chip.addEventListener('click', (e) => openUrl(b.url, { newTab: e.ctrlKey, background: e.ctrlKey && !e.shiftKey }));
    chip.addEventListener('auxclick', (e) => e.button === 1 && openUrl(b.url, { newTab: true, background: true }));
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      bookmarkMenu(b, { x: e.clientX, y: e.clientY });
    });
    bar.append(chip);
  }
  for (const f of folders.filter((x) => !x.system)) {
    const chip = h('button', { class: 'bm-chip folder', html: `${icon('folder', 15)}<span>${escapeText(f.name)}</span>` });
    chip.addEventListener('click', () => folderMenu(f, chip));
    bar.append(chip);
  }
  const other = folders.find((x) => x.id === 'other');
  if (other && items.some((b) => b.folder === 'other')) {
    const chip = h('button', { class: 'bm-chip folder end', html: `${icon('folder', 15)}<span>${escapeText(other.name)}</span>` });
    chip.addEventListener('click', () => folderMenu(other, chip));
    bar.append(chip);
  }
  if (!items.some((b) => b.folder === 'bar')) {
    bar.prepend(h('span', { class: 'bm-empty', text: t('Nhấn ☆ trên thanh địa chỉ (Ctrl+D) để lưu trang vào đây') }));
  }
  wireDrag(bar);
}

function escapeText(s) {
  const d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}

let wired = false;
function wireDrag(bar) {
  if (wired) return;
  wired = true;
  let dragId = null;
  bar.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('.bm-chip[data-id]');
    if (!chip) return;
    dragId = chip.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  bar.addEventListener('dragover', (e) => {
    e.preventDefault();
    bar.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
    e.target.closest('.bm-chip[data-id]')?.classList.add('drop-before');
  });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.bm-chip[data-id]');
    bar.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
    if (dragId) {
      if (target?.dataset.id !== dragId) api.invoke('bookmarks:move', dragId, target?.dataset.id || null);
    } else {
      const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
      if (/^https?:\/\//i.test(url)) api.invoke('bookmarks:add', { url, title: url, folder: 'bar' });
    }
    dragId = null;
  });
  bar.addEventListener('dragend', () => (dragId = null));
}

async function editBookmark(b, at) {
  const title = await promptText({ title: t('Đổi tên dấu trang'), value: b.title }, at);
  if (title) api.invoke('bookmarks:update', b.id, { title });
}

// Star button / Ctrl+D: add the current page, then let the user tweak it.
export async function bookmarkPopover(anchor) {
  const tab = active();
  if (!tab || !/^https?:/i.test(tab.url)) return;
  let b = S.bookmarks.items.find((x) => x.url === tab.url);
  const isNew = !b;
  if (!b) b = await api.invoke('bookmarks:add', { url: tab.url, title: tab.title, favicon: tab.favicon, folder: 'bar' });
  const name = h('input', { type: 'text', class: 'input', value: b.title });
  const folder = h('select', {}, ...S.bookmarks.folders.map((f) => h('option', { value: f.id, selected: f.id === b.folder, text: f.name })), h('option', { value: '__new', text: t('+ Thư mục mới…') }));
  const save = async () => {
    let folderId = folder.value;
    if (folderId === '__new') {
      const n = await promptText({ title: t('Tên thư mục mới') });
      if (n) folderId = (await api.invoke('bookmarks:folderAdd', n)).id;
      else folderId = b.folder;
    }
    await api.invoke('bookmarks:update', b.id, { title: name.value.trim() || b.url, folder: folderId });
    closePopover();
  };
  const form = h(
    'form',
    { class: 'bm-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico', html: icon('star', 18, 'filled') }), h('b', { text: isNew ? t('Đã thêm dấu trang') : t('Sửa dấu trang') })),
    h('label', { class: 'field-row' }, h('span', { text: t('Tên') }), name),
    h('label', { class: 'field-row' }, h('span', { text: t('Thư mục') }), folder),
    h(
      'div',
      { class: 'prompt-actions' },
      h('button', {
        type: 'button',
        class: 'btn ghost danger',
        text: t('Xóa'),
        onclick: () => {
          api.invoke('bookmarks:remove', b.id);
          closePopover();
          toast(t('Đã xóa dấu trang'), { icon: 'trash' });
        },
      }),
      h('button', { type: 'submit', class: 'btn primary', text: t('Xong') })
    )
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  openPopover(form, anchor || { x: window.innerWidth - 340, y: 90 }, { align: 'end' });
  requestAnimationFrame(() => name.select());
}

on('bookmarks:changed', (data) => {
  S.bookmarks = data;
  renderBar();
  emit('bookmarks');
});
