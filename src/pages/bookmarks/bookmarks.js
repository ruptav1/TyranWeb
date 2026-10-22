import { api, boot, h, $, esc, hostOf, faviconHtml, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

let data = { folders: [], items: [] };
let folder = 'bar';
let editing = null;

function renderFolders() {
  const box = $('#folders');
  box.innerHTML = '';
  for (const f of data.folders) {
    const n = data.items.filter((b) => b.folder === f.id).length;
    const b = h('button', { class: `folder${f.id === folder ? ' on' : ''}`, html: `${icon(f.id === 'bar' ? 'bookmark' : 'folder', 16)}<span class="name">${esc(f.name)}</span><span class="count">${n}</span>` });
    b.addEventListener('click', () => {
      folder = f.id;
      $('#q').value = '';
      render();
    });
    if (!f.system) {
      b.addEventListener('dblclick', async () => {
        const name = await ask(t('Đổi tên thư mục'), f.name);
        if (name) api.invoke('bookmarks:folderRename', f.id, name);
      });
    }
    box.append(b);
  }
  const add = h('button', { class: 'folder', html: `${icon('plus', 16)}<span class="name">${t('Thư mục mới')}</span>` });
  add.addEventListener('click', async () => {
    const name = await ask(t('Tên thư mục mới'), '');
    if (name) {
      const f = await api.invoke('bookmarks:folderAdd', name);
      folder = f.id;
    }
  });
  box.append(add);
}

function ask(title, value) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', class: 'input', value });
    const close = (v) => {
      scrim.remove();
      resolve(v);
    };
    const form = h('form', { class: 'dlg' }, h('b', { text: title }), input, h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn ghost', text: t('Hủy'), onclick: () => close(null) }), h('button', { type: 'submit', class: 'btn primary', text: t('Lưu') })));
    const scrim = h('div', { class: 'dlg-scrim' }, form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      close(input.value.trim());
    });
    scrim.addEventListener('pointerdown', (e) => e.target === scrim && close(null));
    document.body.append(scrim);
    input.select();
  });
}

function renderList() {
  const list = $('#list');
  const q = $('#q').value.trim().toLowerCase();
  const items = data.items.filter((b) => (q ? (b.title + ' ' + b.url).toLowerCase().includes(q) : b.folder === folder));
  list.innerHTML = '';
  const f = data.folders.find((x) => x.id === folder);
  if (!q && f && !f.system) {
    const bar = h('div', { class: 'list-group', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('span', { text: f.name, style: { flex: '1' } }));
    bar.append(
      h('button', { class: 'btn small ghost', text: t('Đổi tên'), onclick: async () => {
        const name = await ask(t('Đổi tên thư mục'), f.name);
        if (name) api.invoke('bookmarks:folderRename', f.id, name);
      } }),
      h('button', { class: 'btn small ghost danger', text: t('Xóa thư mục'), onclick: () => {
        api.invoke('bookmarks:folderRemove', f.id);
        folder = 'bar';
      } })
    );
    list.append(bar);
  }
  for (const b of items) {
    const item = h('div', { class: 'list-item', title: b.url });
    if (editing === b.id) {
      const title = h('input', { type: 'text', class: 'input', value: b.title, style: { flex: '1' } });
      const url = h('input', { type: 'text', class: 'input', value: b.url, style: { flex: '1.3' } });
      const sel = h('select', {}, ...data.folders.map((x) => h('option', { value: x.id, selected: x.id === b.folder, text: x.name })));
      const save = h('button', { class: 'btn small primary', text: t('Lưu') });
      save.addEventListener('click', async (e) => {
        e.stopPropagation();
        editing = null;
        await api.invoke('bookmarks:update', b.id, { title: title.value.trim() || b.url, url: url.value.trim() || b.url, folder: sel.value });
      });
      item.append(title, url, sel, save);
      item.style.cursor = 'default';
      list.append(item);
      continue;
    }
    item.innerHTML = `${faviconHtml(b.favicon, b.title, b.url)}<span class="li-text"><span class="li-title">${esc(b.title || b.url)}</span><span class="li-sub">${esc(hostOf(b.url))}</span></span>
      <span class="li-actions"><button class="icon-btn" data-act="edit" title="${t('Sửa')}">${icon('edit', 15)}</button><button class="icon-btn" data-act="tab" title="${t('Mở trong tab mới')}">${icon('external', 15)}</button><button class="icon-btn" data-act="del" title="${t('Xóa')}">${icon('trash', 15)}</button></span>`;
    item.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'del') api.invoke('bookmarks:remove', b.id);
      else if (act === 'edit') {
        editing = b.id;
        renderList();
      } else if (act === 'tab') openUrl(b.url, true, true);
      else openUrl(b.url, e.ctrlKey);
    });
    list.append(item);
  }
  if (!items.length) list.append(h('div', { class: 'empty', html: `<span class="kao">☆</span>${q ? t('Không tìm thấy dấu trang nào') : t('Thư mục này chưa có gì')}` }));
}

function render() {
  if (!data.folders.find((f) => f.id === folder)) folder = 'bar';
  renderFolders();
  renderList();
}

await boot();
data = await api.invoke('bookmarks:get');
render();
$('#q').addEventListener('input', renderList);
$('#export').addEventListener('click', () => api.invoke('bookmarks:export'));
$('#import').addEventListener('click', async () => {
  const n = await api.invoke('bookmarks:import');
  if (n) {
    data = await api.invoke('bookmarks:get');
    folder = data.folders[data.folders.length - 1].id;
    render();
  }
});
api.on('bookmarks:changed', (d) => {
  data = d;
  render();
});
