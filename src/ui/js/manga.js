// Tải truyện tranh: the comic chapter shown in the tab - its pictures found in the page (in reading order,
// lazy ones too, without ads), its series and chapter names - downloaded at once into
// Tải xuống\<series> - <chapter>.zip (or .cbz, or a folder of pictures), every picture a PNG, and on request the
// chapters after it (the tab goes on to each). Reading the page and downloading: main/manga.js.
import { api, h, esc, $, emit } from './util.js';
import { S } from './state.js';
import { active, byWc } from './tabs.js';
import { openPopover, closePopover, toast } from './menus.js';
import { openDownloadsPopover } from './downloads.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

const FORMATS = ['zip', 'cbz', 'folder'];

// (main/manga.js tells how many comic pages a tab's page shows: four or more, the address bar offers to
// download them; 0 once it goes elsewhere)
api.on('manga:hint', ({ wcId, count }) => {
  const tab = byWc(wcId);
  if (!tab || tab.manga === count) return;
  tab.manga = count;
  emit('tab:update', tab);
});

/** Opens the panel for the active tab's page and reads its chapter at once. */
export function openManga(anchor) {
  const tab = active();
  if (!tab?.wcId || !/^https?:/.test(tab.url || '')) return toast(t('Mở trang đọc một chương truyện trước đã'), { icon: 'image' });
  const wcId = tab.wcId;
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  const status = h('div', { class: 'manga-status busy', text: t('Đang tìm ảnh truyện trên trang…') });
  const body = h('div', { class: 'manga-body' });
  const root = h(
    'div',
    { class: 'manga-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico', html: icon('image', 18) }), h('div', { class: 'grab-head' }, h('b', { text: t('Tải truyện tranh') }), h('div', { class: 'muted small', text: host }))),
    status,
    body,
    h('small', { class: 'manga-note', text: t('Tải bằng phiên đăng nhập của bạn trên trang này. Chỉ tải nội dung bạn được phép tải.') })
  );
  const pop = openPopover(root, anchor || $('.omnibox') || { x: innerWidth / 2 - 320, y: 64 }, { align: anchor ? 'end' : 'center', focus: false, className: 'manga-popover' });
  const fit = () => requestAnimationFrame(() => root.isConnected && pop.reposition());

  let scan = null;
  const read = async (scroll) => {
    status.className = 'manga-status busy';
    status.textContent = scroll ? t('Đang cuộn trang để nạp hết ảnh…') : t('Đang tìm ảnh truyện trên trang…');
    body.replaceChildren();
    fit();
    try {
      scan = await api.invoke('manga:scan', wcId, { scroll });
    } catch (e) {
      if (!root.isConnected) return;
      status.className = 'manga-status bad';
      status.textContent = t('Không đọc được trang: {0}', String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
      fit();
      return;
    }
    if (root.isConnected) draw();
  };

  const draw = () => {
    const n = scan.paged ? scan.pageUrls.length : scan.items.length;
    if (!n) {
      status.className = 'manga-status bad';
      status.textContent = t('Không thấy ảnh truyện nào trên trang này.');
      body.append(h('div', { class: 'manga-actions' }, h('button', { class: 'btn', html: `${icon('reload', 15)}<span>${esc(t('Cuộn trang và tìm lại'))}</span>`, onclick: () => read(true) })));
      fit();
      return;
    }
    status.className = 'manga-status';
    status.textContent = scan.paged ? t('Truyện đọc từng trang: {0} trang', n) : t('Tìm thấy {0} ảnh', n);
    const off = new Set(); // pictures left out by the user
    const series = h('input', { type: 'text', value: scan.series, spellcheck: 'false' });
    const chapter = h('input', { type: 'text', value: scan.chapter, spellcheck: 'false' });
    const count = h('span', { class: 'manga-count' });
    const go = h('button', { class: 'btn primary' });
    const refresh = () => {
      const k = scan.paged ? n : n - off.size;
      count.textContent = scan.paged ? '' : t('Đã chọn {0}/{1}', k, n);
      go.innerHTML = `${icon('download', 15)}<span>${esc(t('Tải {0} ảnh', k))}</span>`;
      go.disabled = !k;
    };
    const grid = h('div', { class: 'manga-grid' });
    if (!scan.paged) {
      scan.items.forEach((it, i) => {
        const cell = h('button', { class: 'manga-cell', title: t('Bấm để bỏ / chọn lại ảnh {0}', i + 1) }, it.thumb ? h('img', { src: it.thumb, alt: '' }) : null, h('span', { text: String(i + 1) }));
        cell.addEventListener('click', () => {
          off.has(i) ? off.delete(i) : off.add(i);
          cell.classList.toggle('off', off.has(i));
          refresh();
        });
        grid.append(cell);
      });
    }
    // (the pages the page could not draw small itself, from another site: their previews come a moment
    // later, fetched by TyranWeb with the page as referrer)
    const missing = scan.paged ? [] : scan.items.filter((it) => !it.thumb && /^https?:/.test(it.url)).map((it) => it.url);
    if (missing.length)
      api
        .invoke('manga:thumbs', wcId, missing)
        .then((list) => {
          const at = new Map(list.map((x) => [x.url, x.thumb]));
          scan.items.forEach((it, i) => {
            const thumb = at.get(it.url);
            const cell = grid.children[i];
            if (!thumb || !cell) return;
            it.thumb = thumb;
            cell.querySelector('img')?.remove();
            cell.prepend(h('img', { src: thumb, alt: '' }));
          });
        })
        .catch(() => {});
    const all = h('button', { class: 'btn small ghost', text: t('Chọn tất cả'), onclick: () => (off.clear(), grid.querySelectorAll('.off').forEach((c) => c.classList.remove('off')), refresh()) });
    const nextN = h('input', { type: 'number', min: '0', max: '200', value: '0', disabled: !scan.next });
    const scroll = h('input', { type: 'checkbox' });
    // how each chapter is saved: one zip (the default), one .cbz for comic reader apps, or a folder of pictures
    const format = h(
      'select',
      { class: 'manga-format' },
      ...[
        ['zip', t('File zip')],
        ['cbz', t('File CBZ (cho app đọc truyện)')],
        ['folder', t('Thư mục ảnh')],
      ].map(([v, l]) => h('option', { value: v, text: l }))
    );
    format.value = FORMATS.includes(S.settings?.general?.mangaFormat) ? S.settings.general.mangaFormat : 'zip';
    const ext = () => (format.value === 'folder' ? '' : `.${format.value}`);
    let nextShown = '';
    try {
      nextShown = scan.next ? decodeURIComponent(new URL(scan.next).pathname) : '';
    } catch {
      nextShown = scan.next;
    }
    const dest = h('div', { class: 'manga-dest' });
    body.append(
      h('div', { class: 'manga-names' }, h('label', {}, h('span', { text: t('Tên truyện') }), series), h('label', {}, h('span', { text: t('Chương') }), chapter)),
      scan.paged ? h('div', { class: 'manga-paged', text: t('Mỗi trang của chương nằm ở một địa chỉ riêng: TyranWeb sẽ mở lần lượt từng trang để lấy ảnh.') }) : h('div', { class: 'manga-bar' }, count, h('span', { class: 'grow' }), all),
      grid,
      h(
        'div',
        { class: 'manga-opts' },
        h('label', { class: 'manga-next' }, h('span', { text: t('Tải tiếp') }), nextN, h('span', { text: t('chương sau') }), h('small', { title: scan.next || '', text: scan.next ? `→ ${nextShown}` : t('(không thấy link chương sau)') })),
        h('label', { class: 'manga-check' }, scroll, h('span', { text: t('Luôn cuộn hết mỗi chương (trang nạp ảnh bằng JavaScript)') })),
        h('label', { class: 'manga-fmt' }, h('span', { text: t('Lưu mỗi chương thành') }), format)
      ),
      dest,
      h('div', { class: 'manga-actions' }, h('button', { class: 'btn', html: `${icon('reload', 15)}<span>${esc(t('Tìm lại'))}</span>`, title: t('Cuộn hết trang rồi tìm lại ảnh'), onclick: () => read(true) }), h('span', { class: 'grow' }), go)
    );
    // (named after the series and the chapter, right in the download folder, as main/manga.js names it)
    const syncDest = () => (dest.textContent = t('Lưu vào: Tải xuống › {0}', `${series.value.trim() || '…'} - ${chapter.value.trim() || '…'}${ext()}`));
    series.addEventListener('input', syncDest);
    chapter.addEventListener('input', syncDest);
    // (the choice is kept for next time)
    format.addEventListener('change', () => {
      syncDest();
      api.invoke('settings:set', { general: { mangaFormat: format.value } }).catch(() => {});
    });
    syncDest();
    refresh();
    fit();
    go.addEventListener('click', async () => {
      // (the pictures' addresses only: the small previews stay here)
      const items = scan.paged ? [] : scan.items.filter((_, i) => !off.has(i)).map(({ url, alts, w, h: ht }) => ({ url, alts, w, h: ht }));
      const more = Math.max(0, Math.min(200, Number(nextN.value) || 0));
      go.disabled = true;
      try {
        await api.invoke('manga:download', wcId, { series: series.value.trim(), chapter: chapter.value.trim(), items, page: scan.url, next: more, scroll: scroll.checked, format: format.value, selector: scan.selector, nextUrl: scan.next, paged: !!scan.paged, pageUrls: scan.pageUrls || [] });
      } catch (e) {
        go.disabled = false;
        status.className = 'manga-status bad';
        status.textContent = String(e?.message || e);
        return;
      }
      closePopover();
      const what = scan.paged ? t('{0} trang', n) : t('{0} ảnh', items.length);
      const msg = more ? t('Đang tải {0} ({1}) và {2} chương sau', what, chapter.value, more) : t('Đang tải {0}: {1}', what, `${series.value} — ${chapter.value}`);
      toast(msg, { icon: 'download', timeout: 5000, action: { label: t('Xem'), run: () => openDownloadsPopover() } });
    });
  };
  read(false);
}
