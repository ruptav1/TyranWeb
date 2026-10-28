import { api, boot, onSettings, h, $, $$, esc, debounce, hostOf, host, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { frameCss, frameOf, musicKey, ownMusic } from 'tyran://shared/theme.js';
import { PRESETS, presetPatch, ACCENTS } from 'tyran://shared/themes.js';
import { t, LOCALE, LANGS } from 'tyran://shared/i18n.js';

let S = null;
let section = 'appearance';
let bindings = [];
let wallpapers = { bundled: [], user: [], videos: [], live: [] };
let shortcuts = {};
let engines = {};
let info = {};

// ---------------------------------------------------------------- settings access
const get = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), S);
const patchOf = (path, value) => path.split('.').reduceRight((acc, k) => ({ [k]: acc }), value);
const put = (obj, path, value) => {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
};
// Changes sent but not confirmed yet: a settings update for an earlier change must not undo them on
// screen (when the app is busy it answers late, and controls used to jump back, the accent ring to
// vanish...).
const pending = new Map(); // path -> value
function set(path, value) {
  put(S, path, value);
  pending.set(path, value);
  return api.invoke('settings:set', patchOf(path, value)).finally(() => {
    if (pending.get(path) === value) pending.delete(path);
  });
}
const COLOR_PATHS = new Set(['appearance.dark', 'appearance.accent', 'appearance.bg', 'appearance.surface', 'appearance.text']);
function setValue(path, value) {
  if (COLOR_PATHS.has(path) && S.appearance.preset !== 'custom') {
    S.appearance.preset = 'custom';
    api.invoke('settings:set', { appearance: { preset: 'custom' } });
    $$('.preset').forEach((n) => n.classList.remove('on'));
  }
  return set(path, value);
}

function bind(el, update) {
  bindings.push({ el, update });
  update();
  return el;
}

function refresh() {
  for (const b of bindings) {
    if (!b.el.isConnected) continue;
    if (b.el === document.activeElement || b.el.contains(document.activeElement)) continue;
    b.update();
  }
}

// ---------------------------------------------------------------- control builders
const fmt = {
  px: (v) => `${v}px`,
  pct: (v) => `${Math.round(v * 100)}%`,
  x: (v) => `${Number(v).toFixed(2)}×`,
  deg: (v) => `${v}°`,
};

function row(title, desc, ...controls) {
  return h('div', { class: 'row', dataset: { search: `${title} ${desc || ''}` } }, h('div', { class: 'row-text' }, h('b', { text: title }), desc ? h('span', { text: desc }) : null), h('div', { class: 'row-ctl' }, ...controls));
}
const section_ = (...rows) => h('div', { class: 'section' }, ...rows.filter(Boolean));
const stitle = (t) => h('div', { class: 'section-title', text: t });
const head = (title) => [h('h1', { class: 'page-title', text: title })];

function sw(path, after) {
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => {
    setValue(path, input.checked);
    after?.(input.checked);
  });
  return bind(h('label', { class: 'switch' }, input, h('span')), () => (input.checked = !!get(path)));
}

function seg(path, options, after) {
  const box = h('div', { class: 'seg' });
  for (const [value, label] of options) {
    const b = h('button', { type: 'button', text: label });
    b.addEventListener('click', () => {
      setValue(path, value);
      box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      after?.(value);
    });
    b._value = value;
    box.append(b);
  }
  return bind(box, () => box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x._value === get(path))));
}

function range(path, min, max, step, format = (v) => v) {
  const input = h('input', { type: 'range', min, max, step });
  const val = h('span', { class: 'range-val' });
  let t = 0;
  input.addEventListener('input', () => {
    val.textContent = format(Number(input.value));
    const now = Date.now();
    if (now - t > 40) {
      t = now;
      setValue(path, Number(input.value));
    }
  });
  input.addEventListener('change', () => setValue(path, Number(input.value)));
  const wrap = h('span', { class: 'range-wrap' }, input, val);
  return bind(wrap, () => {
    input.value = get(path);
    val.textContent = format(Number(get(path)));
  });
}

function color(path) {
  const input = h('input', { type: 'color' });
  const hex = h('span', { class: 'hex' });
  input.addEventListener('input', debounce(() => {
    hex.textContent = input.value;
    setValue(path, input.value);
  }, 30));
  return bind(h('span', { class: 'color-wrap' }, hex, input), () => {
    input.value = get(path);
    hex.textContent = get(path);
  });
}

function select(path, options, after) {
  const el = h('select', {}, ...options.map(([v, l]) => h('option', { value: String(v), text: l })));
  el.addEventListener('change', () => {
    const opt = options.find(([v]) => String(v) === el.value);
    setValue(path, opt ? opt[0] : el.value);
    after?.(el.value);
  });
  return bind(el, () => (el.value = String(get(path))));
}

// The wallpaper's source. NIKKE and Azur Lane, still being tried out, sit under a frosted pane with a
// lock until the password is given (once: it is remembered); a press on the pane asks for it.
function sourceSeg() {
  const el = seg('wallpaper.web.preset', [['bluearchive', 'Blue Archive'], ['nikke', 'NIKKE'], ['azurlane', 'Azur Lane'], ['sekai', 'Project SEKAI'], ['url', t('Trang web')], ['package', t('Gói nền web')]], () => render());
  if (get('general.labsUnlocked')) return el;
  const locked = [...el.querySelectorAll('button')].filter((b) => b._value === 'nikke' || b._value === 'azurlane');
  const wrap = h('span', { class: 'seg-locked' });
  locked[0].before(wrap);
  wrap.append(...locked);
  for (const b of locked) b.tabIndex = -1;
  const pane = h('button', { type: 'button', class: 'seg-lock', 'aria-label': t('Đã khoá'), html: icon('lock', 15) });
  wrap.append(pane);
  let ask = null;
  const close = () => {
    ask?.remove();
    ask = null;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => ask && !wrap.contains(e.target) && close();
  pane.addEventListener('click', () => {
    if (ask) return close();
    const input = h('input', { type: 'password', class: 'input', autocomplete: 'off', spellcheck: false, 'aria-label': t('Mật khẩu') });
    const submit = async () => {
      if (await api.invoke('labs:unlock', input.value).catch(() => false)) return close(); // (Settings shows them, opened)
      input.value = '';
      input.classList.remove('wrong');
      void input.offsetWidth; // (the shake again)
      input.classList.add('wrong');
      input.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') close();
    });
    ask = h(
      'div',
      { class: 'labs-ask' },
      h('p', { text: t('Vẫn đang trong quá trình thử nghiệm, để có thể truy cập, xin vui lòng nhập mật khẩu.') }),
      input,
      h('div', { class: 'labs-btns' }, button(t('Huỷ'), close, { cls: 'small ghost' }), button(t('Mở khoá'), submit, { cls: 'small primary', ic: 'lock' }))
    );
    wrap.append(ask);
    document.addEventListener('pointerdown', outside, true);
    input.focus();
  });
  return el;
}

// The Azur Lane lobby's song: the game's own for the skin, none, or any of the game's songs (one not
// downloaded yet is fetched when picked)
function azurMusic() {
  const path = 'wallpaper.web.azurMusic';
  const el = h('select', {}, h('option', { value: 'game', text: t('Mặc định') }), h('option', { value: '', text: t('Tắt') }));
  api.invoke('azur:tracks').then((list) => {
    for (const t of list) el.append(h('option', { value: t.name, text: t.title }));
    el.value = String(get(path) ?? 'game');
  }, () => {});
  el.addEventListener('change', () => {
    setValue(path, el.value);
    if (el.value && el.value !== 'game') api.invoke('azur:music', el.value).catch(() => {});
  });
  return bind(el, () => (el.value = String(get(path) ?? 'game')));
}

function text(path, placeholder = '', { width = 260, validate } = {}) {
  const el = h('input', { type: 'text', class: 'input', placeholder, style: { width: `${width}px` } });
  const commit = () => {
    const v = el.value.trim();
    if (validate && !validate(v)) {
      el.classList.add('invalid');
      return;
    }
    el.classList.remove('invalid');
    if (v !== get(path)) setValue(path, v);
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => e.key === 'Enter' && el.blur());
  return bind(el, () => (el.value = get(path) ?? ''));
}

function button(label, onClick, { ic, cls = '' } = {}) {
  const b = h('button', { type: 'button', class: `btn ${cls}`, html: `${ic ? icon(ic, 15) : ''}<span>${esc(label)}</span>` });
  b.addEventListener('click', onClick);
  return b;
}

// Two-step button for destructive actions (no native confirm() dialogs).
function confirmButton(label, confirmLabel, onConfirm) {
  const b = h('button', { type: 'button', class: 'btn small danger', text: label });
  let armed = false;
  let t;
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      t = setTimeout(() => ((armed = false), (b.textContent = label)), 3000);
      return;
    }
    clearTimeout(t);
    armed = false;
    b.textContent = label;
    onConfirm();
  });
  return b;
}

function toast(msg) {
  const t = h('div', { class: 'page-toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2600);
}

// ---------------------------------------------------------------- sections
const SECTIONS = [
  ['appearance', t('Giao diện'), 'palette', appearance],
  ['wallpaper', t('Hình nền'), 'image', wallpaperSection],
  ['layout', t('Bố cục'), 'layout', layout],
  ['newtab', t('Trang tab mới'), 'sparkles', newtab],
  ['general', t('Chung'), 'sliders', general],
  ['privacy', t('Quyền riêng tư'), 'shield', privacy],
  ['extensions', t('Tiện ích'), 'puzzle', extensionsSection],
  ['shortcuts', t('Phím tắt'), 'keyboard', shortcutsSection],
  ['css', t('CSS tùy chỉnh'), 'code', cssSection],
  ['about', t('Giới thiệu'), 'info', about],
];

function thumbOf(url) {
  return url.replace('/assets/wallpapers/', '/assets/wallpapers/thumbs/');
}

function appearance() {
  const grid = h('div', { class: 'presets' });
  for (const p of PRESETS) {
    const card = h('button', { type: 'button', class: 'preset', dataset: { id: p.id } });
    card.innerHTML = `<span class="preset-img" style="background-image:url('${esc(thumbOf(p.wallpaper.image))}')">
        <span class="preset-mock" style="--a:${p.appearance.accent};--s:${p.appearance.surface};--t:${p.appearance.text}"><i></i><i></i><i></i></span>
      </span>
      <span class="preset-name"><span class="dot" style="background:${p.appearance.accent}"></span>${esc(p.name)}</span>
      <span class="preset-sub">${esc(p.sub)}</span>`;
    card.addEventListener('click', () => {
      api.invoke('settings:set', presetPatch(p));
      $$('.preset').forEach((n) => n.classList.toggle('on', n === card));
    });
    grid.append(card);
  }
  bind(grid, () => $$('.preset', grid).forEach((n) => n.classList.toggle('on', n.dataset.id === S.appearance.preset)));

  const swatches = h('div', { class: 'swatches' });
  for (const c of ACCENTS) {
    const b = h('button', { type: 'button', class: 'swatch', style: { background: c }, title: c });
    b.addEventListener('click', () => setValue('appearance.accent', c));
    swatches.append(b);
  }
  bind(swatches, () => $$('.swatch', swatches).forEach((n) => n.classList.toggle('on', n.title.toLowerCase() === S.appearance.accent.toLowerCase())));

  const fonts = [
    ['"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif', t('Segoe UI Variable (mặc định)')],
    ['"Segoe UI", system-ui, sans-serif', 'Segoe UI'],
    ['"Yu Gothic UI", "Segoe UI", sans-serif', t('Yu Gothic UI (Nhật)')],
    ['"Meiryo UI", "Segoe UI", sans-serif', t('Meiryo UI (Nhật)')],
    ['Bahnschrift, "Segoe UI", sans-serif', 'Bahnschrift'],
    ['"Trebuchet MS", "Segoe UI", sans-serif', 'Trebuchet MS'],
    ['Verdana, "Segoe UI", sans-serif', 'Verdana'],
    ['"Comic Sans MS", "Segoe UI", sans-serif', 'Comic Sans MS'],
    ['Georgia, serif', t('Georgia (có chân)')],
    ['Consolas, monospace', t('Consolas (đơn cách)')],
    // (the user's own, added below)
    ...[...new Set((S.appearance.customFonts || []).map((f) => f.family))].map((f) => [`"${f}", "Segoe UI", system-ui, sans-serif`, f]),
  ];

  return [
    ...head(t('Giao diện'), t('Chọn một theme anime có sẵn, rồi tinh chỉnh từng chi tiết theo ý bạn. Mọi thay đổi áp dụng ngay lập tức.')),
    grid,
    stitle(t('Màu sắc')),
    section_(
      row(t('Chế độ'), '', seg('appearance.dark', [[false, t('Sáng')], [true, t('Tối')]])),
      row(t('Tự lấy màu theo hình nền'), '', sw('appearance.autoColor')),
      row(t('Màu nhấn'), '', swatches, color('appearance.accent')),
      row(t('Màu nền cửa sổ'), '', color('appearance.bg')),
      row(t('Màu bề mặt'), '', color('appearance.surface')),
      row(t('Màu chữ'), '', color('appearance.text'))
    ),
    stitle(t('Chất liệu & hình khối')),
    section_(
      row(t('Kiểu thanh giao diện'), '', seg('appearance.chromeStyle', [['glass', t('Kính mờ')], ['solid', t('Đặc')], ['clear', t('Trong suốt')]], () => render())),
      ...(get('appearance.chromeStyle') === 'clear' ? [row(t('Kính trong suốt ở thanh dấu trang'), '', sw('appearance.clearBookmarks')), row(t('Kính trong suốt ở đồng hồ'), '', sw('appearance.clearClock'))] : []),
      row(t('Độ đục bề mặt'), '', range('appearance.surfaceOpacity', 0.1, 1, 0.01, fmt.pct)),
      row(t('Lớp làm rõ chữ'), '', range('appearance.clearScrim', 0, 0.8, 0.01, fmt.pct)),
      row(t('Độ mờ kính'), '', range('appearance.blur', 0, 48, 1, fmt.px)),
      row(t('Bo góc'), '', range('appearance.radius', 0, 24, 1, fmt.px)),
      row(t('Mật độ'), '', seg('appearance.density', [['compact', t('Gọn')], ['comfortable', t('Vừa')], ['spacious', t('Thoáng')]])),
      row(t('Kiểu tab'), '', seg('appearance.tabStyle', [['pill', t('Viên')], ['flat', t('Phẳng')], ['underline', t('Gạch chân')]]))
    ),
    stitle(t('Chữ & chuyển động')),
    fontDrop(section_(
      row(t('Phông chữ giao diện'), '', select('appearance.font', fonts)),
      ownFonts(),
      row(t('Cỡ chữ'), '', range('appearance.fontSize', 11, 16, 0.5, fmt.px)),
      row(t('Hiệu ứng chuyển động'), '', sw('appearance.animations')),
      row(t('Trang web hiển thị ở chế độ'), '', select('appearance.pageScheme', [['theme', t('Theo theme')], ['system', t('Theo Windows')], ['light', t('Luôn sáng')], ['dark', t('Luôn tối')]]))
    )),
    ...cursorSection(),
    stitle(t('Sao lưu')),
    section_(
      row(
        t('Theme của bạn'),
        '',
        button(t('Xuất'), async () => (await api.invoke('settings:export')) && toast(t('Đã xuất theme')), { ic: 'upload' }),
        button(t('Nhập'), async () => {
          try {
            if (await api.invoke('settings:import')) toast(t('Đã nhập theme ✿'));
          } catch (e) {
            toast(e.message.replace(/^.*Error: /, ''));
          }
        }, { ic: 'download' })
      ),
      row(t('Khôi phục giao diện mặc định'), '', button(t('Khôi phục'), () => api.invoke('settings:reset', 'appearance').then(() => api.invoke('settings:reset', 'wallpaper')), { ic: 'reload' }))
    ),
  ];
}

// ---------------------------------------------------------------- wallpaper
const ANIME_CHIPS = ['Suzumiya Haruhi', 'K-ON!', 'Clannad', 'Lucky Star', 'Kanon', 'Air', 'Toradora', 'Aria', 'Spice and Wolf', 'Full Metal Panic', 'Code Geass', 'Fullmetal Alchemist', 'Death Note', 'Gurren Lagann', 'Bakemonogatari', 'Higurashi', 'Shakugan no Shana', 'Zero no Tsukaima', 'Mushishi', 'Nodame Cantabile', 'Toki wo Kakeru Shoujo', '5 Centimeters per Second', 'Ouran', 'Angel Beats'];

function wpTile(w, { removable = false } = {}) {
  const tile = h('div', { class: 'wp-item', title: `${w.anime || w.title || ''}${w.year ? ` (${w.year})` : ''}` });
  tile.innerHTML = `<img src="${esc(w.thumb)}" loading="lazy" alt=""><span class="wp-cap">${esc(w.anime || w.title || t('Ảnh'))}${w.year ? ` · ${w.year}` : ''}</span>
    <span class="wp-check">${icon('check', 14)}</span>${w.kind === 'linked' ? `<span class="wp-linked" title="${t('Từ thư mục liên kết')}">${icon('link', 12)}</span>` : ''}
    <button class="wp-heart" title="${t('Thêm vào trình chiếu')}">${icon('heart', 14)}</button>
    ${removable ? `<button class="wp-del" title="${t('Xóa ảnh')}">${icon('trash', 14)}</button>` : ''}`;
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.wp-heart')) {
      const list = new Set(S.wallpaper.slideshow || []);
      list.has(w.url) ? list.delete(w.url) : list.add(w.url);
      set('wallpaper.slideshow', [...list]);
      tile.classList.toggle('fav', list.has(w.url));
      return;
    }
    if (e.target.closest('.wp-del')) {
      api.invoke('wallpapers:remove', w.file).then(loadWallpapers).then(() => render());
      return;
    }
    set('wallpaper.type', 'image');
    set('wallpaper.image', w.url);
    refresh();
  });
  return bind(tile, () => {
    tile.classList.toggle('on', S.wallpaper.type === 'image' && S.wallpaper.image === w.url);
    tile.classList.toggle('fav', (S.wallpaper.slideshow || []).includes(w.url));
  });
}

async function loadWallpapers() {
  wallpapers = await api.invoke('wallpapers:list');
}

const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// the desktop's picture (Nền desktop), asked for once it is the wallpaper
let desktopPic = null;
let desktopAsked = false;

function wallpaperSection() {
  const w = S.wallpaper;
  const preview = h('div', { class: 'wp-preview' }, h('div', { class: 'wp-preview-img' }), h('div', { class: 'wp-preview-dim' }), h('div', { class: 'wp-preview-ui' }, h('i'), h('i'), h('div', { class: 'wp-preview-card' })));
  bind(preview, () => {
    const W = S.wallpaper;
    if (W.type === 'desktop' && !desktopAsked) {
      desktopAsked = true;
      api.invoke('desktop:wallpaper').then((p) => ((desktopPic = p), refresh()), () => {});
    }
    const img = preview.querySelector('.wp-preview-img');
    img.style.background =
      W.type === 'image' ? `${frameCss(W).position}/cover url("${W.image}")`
      : W.type === 'gradient' ? `linear-gradient(${W.gradientAngle}deg, ${W.gradientFrom}, ${W.gradientTo})`
      : W.type === 'color' ? W.color
      : W.type === 'web' && W.web?.preset === 'bluearchive' && W.web.baMode === 'normal' && baInfo(W.web.model)?.portrait ? `center top 12%/auto 160% no-repeat url("${baInfo(W.web.model).portrait}"), linear-gradient(160deg, #e8f2fa, #b9d3ea)`
      : W.type === 'web' && W.web?.preset === 'bluearchive' && (baInfo(W.web.model)?.preview || baInfo(W.web.model)?.thumb) ? `center/cover url("${baInfo(W.web.model).preview || baInfo(W.web.model).thumb}")`
      : W.type === 'web' && gameOf(W.web?.preset) && charShown(W)?.preview ? `center/cover url("${charShown(W).preview}")`
      : W.type === 'web' ? 'linear-gradient(135deg, rgba(var(--accent-rgb), .35), rgba(var(--accent-rgb), .08))'
      : W.type === 'video' ? '#000'
      : W.type === 'desktop' && desktopPic ? `center/cover url("${desktopPic.url}")`
      : 'repeating-conic-gradient(var(--hover) 0 25%, transparent 0 50%) 0 0/16px 16px';
    img.style.filter = `blur(${W.blur / 3}px) saturate(${W.saturate})`;
    const framed = W.type === 'image' || W.type === 'video';
    img.style.transform = framed ? frameCss(W).transform : '';
    img.style.transformOrigin = frameCss(W).position;
    let video = img.querySelector('video');
    if (W.type === 'video' && W.video) {
      if (!video) img.append((video = h('video', { muted: true, loop: true, autoplay: true, playsinline: true })));
      video.muted = true;
      if (video.getAttribute('src') !== W.video) video.src = W.video;
      video.playbackRate = W.videoRate || 1;
      video.style.objectPosition = frameCss(W).position;
    } else video?.remove();
    if (W.type === 'web' && W.web?.preset === 'bluearchive' && !baList) loadBaList().catch(() => {});
    const G = W.type === 'web' && gameOf(W.web?.preset);
    if (G && !G.list) loadChars(G);
    const nk = G ? charShown(W) : null;
    img.dataset.label = nk ? (nk.preview ? '' : `${{ nikke: 'NIKKE', azurlane: 'Azur Lane', sekai: 'Project SEKAI' }[G.preset]} · ${nk.name}`)
      : W.type === 'web' && W.web?.preset === 'bluearchive' && W.web.baMode === 'normal' ? `Blue Archive · ${baInfo(W.web.model)?.name || t('Sảnh thường')}`
      : W.type === 'web' && !(W.web?.preset === 'bluearchive' && baInfo(W.web.model)) ? (W.web?.preset === 'bluearchive' ? 'Blue Archive · Memorial Lobby' : t('Nền web động')) : '';
    const dim = preview.querySelector('.wp-preview-dim');
    dim.style.background = S.appearance.bg;
    dim.style.opacity = W.type === 'mica' || W.type === 'acrylic' ? 0 : W.dim;
  });

  const look = [
    row(t('Làm dịu'), '', range('wallpaper.dim', 0, 0.85, 0.01, fmt.pct)),
    row(t('Làm mờ'), '', range('wallpaper.blur', 0, 40, 1, fmt.px)),
    row(t('Độ bão hòa màu'), '', range('wallpaper.saturate', 0, 2, 0.05, fmt.x)),
  ];
  const position = row(t('Căn hình'), '', select('wallpaper.position', [['center', t('Giữa')], ['top', t('Trên')], ['bottom', t('Dưới')], ['left', t('Trái')], ['right', t('Phải')]]));
  const motion = row(t('Chuyển động'), '', select('wallpaper.motion', [['focus', t('Khi đang dùng TyranWeb')], ['newtab', t('Chỉ ở trang Tab mới')], ['always', t('Luôn luôn')]]));
  const lobby = row(t('Chế độ Lobby'), '', button(t('Vào Lobby'), () => host('command', 'wallpaper.lobby'), { ic: 'tv' }));

  const typeRows = [];
  const extra = [];
  if (w.type === 'image') {
    typeRows.push(...look, position, frameRow(), lobby);
    extra.push(...imageLibrary());
  } else if (w.type === 'video') {
    typeRows.push(row(t('Tốc độ phát'), '', range('wallpaper.videoRate', 0.25, 2, 0.05, fmt.x)), motion, ...look, position, frameRow(), lobby);
    extra.push(...videoLibrary());
  } else if (w.type === 'web') {
    typeRows.push(row(t('Nguồn'), '', sourceSeg()));
    const preset = w.web?.preset || 'bluearchive';
    const volume = row(t('Âm lượng'), '', range('wallpaper.web.volume', 0, 1, 0.05, fmt.pct));
    if (preset === 'bluearchive')
      typeRows.push(
        row(t('Âm thanh'), '', sw('wallpaper.web.audio')),
        row(t('Chọn sảnh khi mở app'), '', seg('wallpaper.web.lobbyPick', [['fixed', t('Cố định')], ['random', t('Ngẫu nhiên')], ['season', t('Theo mùa và giờ')]], () => render())),
        w.web?.lobbyPick && w.web.lobbyPick !== 'fixed' ? row(t('Chỉ sảnh yêu thích'), '', sw('wallpaper.web.pickFavorites')) : null,
        row(t('Sinh nhật Sensei'), '', text('wallpaper.web.senseiBirthday', '3/14', { width: 120, validate: (v) => !v || /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/.test(v.trim()) })),
        row(t('Âm lượng chung'), '', range('wallpaper.web.volume', 0, 1, 0.05, fmt.pct)),
        row(t('Âm lượng nhạc'), '', range('wallpaper.web.musicVolume', 0, 1, 0.05, fmt.pct)),
        row(t('Âm lượng giọng nói'), '', range('wallpaper.web.voiceVolume', 0, 1, 0.05, fmt.pct))
      );
    else if (preset === 'nikke')
      typeRows.push(
        row(t('Âm thanh'), '', sw('wallpaper.web.audio')),
        volume,
        row(t('Tư thế'), '', seg('wallpaper.web.nikkeStance', [['lobby', t('Sảnh')], ['battle', t('Chiến đấu')]])),
        row(t('Màu nền'), '', seg('wallpaper.web.nikkeTint', [['auto', t('Theo nhân vật')], ['own', t('Tự chọn')]], () => render()), ...(w.web?.nikkeTint === 'own' ? [color('wallpaper.web.nikkeColor')] : [])),
        nikkeImageRow()
      );
    else if (preset === 'azurlane')
      typeRows.push(
        row(t('Âm thanh'), '', sw('wallpaper.web.audio')),
        row(t('Âm lượng chung'), '', range('wallpaper.web.volume', 0, 1, 0.05, fmt.pct)),
        row(t('Âm lượng nhạc'), '', range('wallpaper.web.musicVolume', 0, 1, 0.05, fmt.pct)),
        row(t('Âm lượng giọng nói'), '', range('wallpaper.web.voiceVolume', 0, 1, 0.05, fmt.pct)),
        row(t('Nhạc sảnh'), '', azurMusic()),
        row(t('Tự nói khi để yên'), '', sw('wallpaper.web.azurChatter'))
      );
    else if (preset === 'sekai') typeRows.push(row(t('Màu nền'), '', color('wallpaper.web.nikkeColor')), nikkeImageRow());
    else if (preset === 'url') typeRows.push(row(t('Địa chỉ trang'), '', text('wallpaper.web.url', 'https://…', { width: 320, validate: (v) => !v || /^https:\/\/\S+$/i.test(v) })), row(t('Âm thanh'), '', sw('wallpaper.web.audio')), volume);
    else typeRows.push(row(t('Âm thanh'), '', sw('wallpaper.web.audio')), volume);
    typeRows.push(motion, row(t('Làm dịu'), '', range('wallpaper.dim', 0, 0.85, 0.01, fmt.pct)), lobby);
    if (preset === 'bluearchive') {
      extra.push(...nextLobbySection(), stitle(t('Học sinh')), baPicker());
    }
    if (preset === 'package') extra.push(...liveLibrary());
    if (preset === 'nikke') extra.push(stitle(t('Nhân vật')), charPicker(GAMES.nikke));
    if (preset === 'azurlane') extra.push(stitle(t('Tàu')), charPicker(GAMES.azurlane));
    if (preset === 'sekai') extra.push(stitle(t('Nhân vật')), charPicker(GAMES.sekai));
  } else if (w.type === 'color') {
    typeRows.push(row(t('Màu nền'), '', color('wallpaper.color')), row(t('Làm dịu'), '', range('wallpaper.dim', 0, 0.85, 0.01, fmt.pct)));
  } else if (w.type === 'gradient') {
    typeRows.push(row(t('Màu bắt đầu'), '', color('wallpaper.gradientFrom')), row(t('Màu kết thúc'), '', color('wallpaper.gradientTo')), row(t('Góc'), '', range('wallpaper.gradientAngle', 0, 360, 5, fmt.deg)), row(t('Làm dịu'), '', range('wallpaper.dim', 0, 0.85, 0.01, fmt.pct)));
  } else {
    typeRows.push(row(t('Chất liệu Windows 11'), '', h('span', { class: 'faint', text: t('Cần Windows 11') })));
  }

  return [
    ...head(t('Hình nền'), t('Ảnh anime 2000–2010 bản 4K gốc (không AI, không upscale), video của bạn, trang web động như sảnh Blue Archive, hoặc màu trơn / Mica.')),
    preview,
    section_(
      row(t('Loại hình nền'), '', seg('wallpaper.type', [['image', t('Ảnh')], ['video', t('Video')], ['web', t('Web động')], ['color', t('Màu trơn')], ['gradient', t('Gradient')], ['mica', t('Mica')], ['acrylic', t('Acrylic')], ['transparent', t('Trong suốt')], ['desktop', t('Nền desktop')]], () => render())),
      ...typeRows
    ),
    musicSection(),
    ...extra,
  ];
}

// ---------------------------------------------------------------- a wallpaper's own music
// One song or playlist per wallpaper: audio files, or a YouTube / SoundCloud / Spotify link. It
// plays while the new tab page (the lobby) is open, from the sidebar's Nhạc nền panel.
const MUSIC_KINDS = { files: t('File nhạc'), youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };

function musicSection() {
  const box = h('div', { class: 'music-box' });
  let sig = null;
  return bind(box, () => {
    const W = S.wallpaper;
    const key = musicKey(W);
    const mine = ownMusic(W);
    const now = JSON.stringify([key, mine, W.type, W.web?.preset]);
    if (now === sig) return;
    sig = now;
    box.innerHTML = '';
    if (!key) return;
    const ba = W.type === 'web' && W.web?.preset === 'bluearchive';
    const setMusic = (entry) => api.invoke('wallpapers:setMusic', key, entry).catch((err) => toast(errText(err) || t('Không lưu được')));
    const state = !mine
      ? ba
        ? t('OST của sảnh')
        : t('Chưa có')
      : mine.kind === 'files'
        ? t('{0} bài: {1}{2}', mine.files.length, mine.files.slice(0, 4).map((f) => f.title).join(', '), mine.files.length > 4 ? '…' : '')
        : `${MUSIC_KINDS[mine.kind]}: ${mine.title}`;
    const linkInput = h('input', { type: 'url', class: 'input', placeholder: t('Dán link YouTube, SoundCloud hoặc Spotify'), style: { width: '360px' } });
    const linkRow = row(t('Link nhạc'), '', linkInput, button(t('Dùng'), async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const entry = await api.invoke('wallpapers:musicLink', linkInput.value);
        await setMusic(entry);
        toast(t('Đã đặt nhạc: {0}', entry.title));
      } catch (err) {
        toast(errText(err) || t('Không dùng được link này'));
      } finally {
        b.disabled = false;
      }
    }, { cls: 'small primary' }));
    linkRow.hidden = true;
    linkInput.addEventListener('keydown', (e) => e.key === 'Enter' && linkRow.querySelector('.btn.primary').click());
    const rows = [
      row(
        t('Nhạc của hình nền này'),
        state,
        button(t('File nhạc…'), async () => {
          const files = await api.invoke('wallpapers:importMusic').catch(() => []);
          if (files.length) setMusic({ kind: 'files', files, shuffle: false });
        }, { ic: 'music', cls: 'small' }),
        button(t('Dán link…'), () => {
          linkRow.hidden = !linkRow.hidden;
          if (!linkRow.hidden) linkInput.focus();
        }, { ic: 'link', cls: 'small' }),
        mine ? button(ba ? t('Về nhạc OST') : t('Bỏ nhạc'), () => setMusic(null), { cls: 'small ghost' }) : null
      ),
      linkRow,
    ];
    if (mine?.kind === 'files') {
      const shuffle = h('input', { type: 'checkbox', checked: !!mine.shuffle });
      shuffle.addEventListener('change', () => setMusic({ ...mine, shuffle: shuffle.checked }));
      rows.push(row(t('Phát ngẫu nhiên'), '', h('label', { class: 'switch' }, shuffle, h('span'))));
    }
    if (!ba && mine) {
      rows.push(
        row(t('Phát nhạc nền'), '', sw('wallpaper.musicOn')),
        row(t('Âm lượng nhạc nền'), '', range('wallpaper.musicVolume', 0, 1, 0.05, fmt.pct))
      );
    }
    box.append(stitle(t('Nhạc nền')), section_(...rows));
  });
}

// Adding many pictures / videos at once (files, a folder, a zip), linking folders that are used in
// place, and where TyranWeb keeps the ones it copies.
function mediaTools() {
  const add = (kind, label, ic) =>
    button(label, async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const r = await api.invoke('wallpapers:importMany', kind);
        if (!r.added.length && !r.skipped) return;
        toast(t('Đã thêm {0} hình nền{1}', r.added.length, r.skipped ? t(' · bỏ qua {0} file trùng tên', r.skipped) : ''));
        await loadWallpapers();
        render();
      } catch (err) {
        toast(errText(err) || t('Không thêm được'));
      } finally {
        b.disabled = false;
      }
    }, { ic, cls: 'small' });
  const link = button(t('Liên kết thư mục'), async () => {
    try {
      if (await api.invoke('wallpapers:linkFolder')) {
        await loadWallpapers();
        render();
        toast(t('Đã liên kết: ảnh và video trong thư mục được dùng tại chỗ, tự cập nhật khi bạn thêm hay xoá'));
      }
    } catch (err) {
      toast(errText(err) || t('Không liên kết được'));
    }
  }, { ic: 'link', cls: 'small' });
  const folders = (wallpapers.folders || []).map((f) =>
    h(
      'span',
      { class: 'wp-folder' + (f.missing ? ' missing' : ''), title: f.path },
      h('span', { html: icon('folder', 14) }),
      h('span', { text: `${f.title} · ${f.missing ? t('không tìm thấy') : f.count + ' file'}` }),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: t('Bỏ liên kết (không xoá file nào)'),
        html: icon('x', 13),
        onclick: () => api.invoke('wallpapers:unlinkFolder', f.id).then(loadWallpapers).then(() => render()),
      })
    )
  );
  return [
    h('div', { class: 'toolbar-row wp-tools' }, add('files', t('Thêm ảnh / video…'), 'plus'), add('folder', t('Thêm cả thư mục'), 'folder'), add('zip', t('Thêm file zip'), 'download'), link),
    folders.length ? h('div', { class: 'wp-folders' }, ...folders) : null,
  ].filter(Boolean);
}

function storageRow() {
  return section_(
    row(
      t('Thư mục lưu hình nền'),
      wallpapers.folder || '',
      button(t('Mở'), () => api.invoke('wallpapers:openFolder'), { ic: 'external', cls: 'small ghost' }),
      confirmButton(t('Chuyển chỗ…'), t('Chọn nơi mới (app sẽ khởi động lại)'), async () => {
        try {
          await api.invoke('wallpapers:moveFolder');
        } catch (err) {
          toast(errText(err) || t('Không chuyển được'));
        }
      })
    )
  );
}

// ---------------------------------------------------------------- Chrome extensions
// Installed from the Chrome Web Store (its pages get a "Thêm vào TyranWeb" bar) or from a folder.
function extensionsSection() {
  const list = h('div', { class: 'ext-list' });
  (async () => {
    const items = await api.invoke('ext:list').catch(() => []);
    if (!items.length) return list.append(h('p', { class: 'muted small', text: t('Chưa có tiện ích nào.') }));
    list.append(
      section_(
        ...items.map((x) => {
          const on = h('input', { type: 'checkbox', checked: x.enabled !== false });
          on.addEventListener('change', () => api.invoke('ext:setEnabled', x.id, on.checked).catch((err) => toast(errText(err) || t('Không bật được tiện ích này'))));
          const state = t('Phiên bản {0}{1}{2}', x.version || '?', x.storeId ? '' : t(' · từ thư mục trên máy'), x.enabled !== false && !x.loaded ? t(' · không nạp được') : '');
          // (only for one that has an options page, as Chrome shows it)
          const options = button(t('Tùy chọn'), async () => {
            const p = await api.invoke('ext:pages', x.id).catch(() => null);
            if (p?.options) openUrl(p.options, true);
          }, { cls: 'small ghost' });
          options.hidden = true;
          api.invoke('ext:pages', x.id).then((p) => (options.hidden = !p?.options), () => {});
          const r = row(
            x.name,
            state,
            options,
            confirmButton(t('Gỡ'), t('Gỡ thật?'), () => api.invoke('ext:remove', x.id)),
            h('label', { class: 'switch', title: t('Bật / tắt') }, on, h('span'))
          );
          if (x.icon) r.querySelector('.row-text b').prepend(h('img', { class: 'ext-icon', src: x.icon, width: 18, height: 18, alt: '' }));
          return r;
        })
      )
    );
  })();
  const link = h('input', { type: 'url', class: 'input', placeholder: t('Link trang tiện ích hoặc mã 32 chữ'), style: { width: '300px' } });
  const add = () => link.value.trim() && host('ext-install', link.value.trim());
  link.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return [
    ...head(t('Tiện ích'), t('Tiện ích của Chrome, cài từ Chrome Web Store. Chạy ở các tab thường (tab ẩn danh không có tiện ích, như Chrome).')),
    section_(
      row(t('Thêm tiện ích'), '', button(t('Mở Chrome Web Store'), () => openUrl('https://chromewebstore.google.com/', true), { ic: 'external', cls: 'small' })),
      row(t('Cài từ link'), '', link, button(t('Cài'), add, { cls: 'small primary' })),
      row(t('Cập nhật'), '', button(t('Kiểm tra cập nhật'), async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          const ups = await api.invoke('ext:checkUpdates');
          for (const u of ups) await api.invoke('ext:update', u.id);
          toast(ups.length ? t('Đã cập nhật {0} tiện ích', ups.length) : t('Tất cả đã là bản mới nhất'));
        } catch (err) {
          toast(errText(err) || t('Không kiểm tra được'));
        } finally {
          b.disabled = false;
        }
      }, { ic: 'reload', cls: 'small' })),
      row(t('Tiện ích đã giải nén'), '', button(t('Chọn thư mục…'), () => api.invoke('ext:addFolder').catch((err) => toast(errText(err) || t('Không nạp được thư mục này'))), { ic: 'folder', cls: 'small ghost' }))
    ),
    stitle(t('Đã cài')),
    list,
  ];
}

// ---------------------------------------------------------------- mouse cursor
const CURSOR_SLOTS = [
  ['arrow', t('Con trỏ thường')],
  ['hand', t('Khi trỏ vào liên kết, nút bấm')],
  ['text', t('Khi trỏ vào ô nhập chữ')],
];

// The user's own fonts: listed (each in itself), removed, added from a file dialog...
function ownFonts() {
  const families = [...new Set((S.appearance.customFonts || []).map((f) => f.family))];
  const chips = h(
    'span',
    { class: 'font-chips' },
    ...families.map((f) => h('span', { class: 'font-chip', style: { fontFamily: `"${f}"` } }, h('span', { text: f }), h('button', { type: 'button', class: 'chip-x', title: t('Xóa'), html: icon('x', 12), onclick: () => api.invoke('fonts:remove', f).then(() => render(), (e) => toast(errText(e))) })))
  );
  return row(t('Phông chữ của bạn'), '', chips, button(t('Thêm phông chữ…'), () => api.invoke('fonts:pick').then(fontsAdded, (e) => toast(errText(e))), { ic: 'plus', cls: 'small' }));
}
function fontsAdded(names) {
  if (!names?.length) return;
  toast(t('Đã thêm {0}', names.join(', ')), { icon: 'check' });
  render();
}
// ...or dropped on their section
function fontDrop(el) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.add('drop-on');
  });
  el.addEventListener('dragleave', (e) => !el.contains(e.relatedTarget) && el.classList.remove('drop-on'));
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.remove('drop-on');
    const files = [...e.dataTransfer.files].map((f) => window.tyran.pathOf(f)).filter(Boolean);
    if (files.length) api.invoke('fonts:add', files).then(fontsAdded, (err) => toast(errText(err)));
  });
  return el;
}

function cursorSection() {
  const box = h('div');
  let sig = null;
  const update = () => {
    const c = S.appearance.cursor || {};
    const now = JSON.stringify(c);
    if (now === sig) return;
    sig = now;
    box.innerHTML = '';
    const setCursor = (patch) => api.invoke('settings:set', { appearance: { cursor: patch } });
    const rows = [
      row(t('Kiểu con trỏ'), '', seg('appearance.cursor.set', [['system', 'Windows'], ['sakura', 'Sakura'], ['night', t('Đêm')], ['mint', t('Bạc hà')], ['custom', t('Tự chọn')]])),
    ];
    if (c.set === 'custom') {
      for (const [slot, label] of CURSOR_SLOTS) {
        const pickFile = button(t('Chọn file…'), async () => {
          try {
            const f = await api.invoke('cursor:import');
            if (f) setCursor({ [slot]: f });
          } catch (err) {
            toast(errText(err) || t('Không dùng được file này'));
          }
        }, { cls: 'small' });
        rows.push(row(label, c[slot]?.name || t('Chưa chọn'), pickFile, c[slot] ? button(t('Bỏ'), () => setCursor({ [slot]: null }), { cls: 'small ghost' }) : null));
      }
    }
    if (c.set && c.set !== 'system') rows.push(row(t('Dùng cả trên trang web'), '', sw('appearance.cursor.pages')));
    rows.push(
      row(
        t('Tìm con trỏ miễn phí'),
        '',
        button('RW Designer', () => openUrl('https://www.rw-designer.com/cursor-library', true), { ic: 'external', cls: 'small ghost' }),
        button('Cursors-4U', () => openUrl('https://www.cursors-4u.com/', true), { ic: 'external', cls: 'small ghost' }),
        button('DeviantArt', () => openUrl('https://www.deviantart.com/search?q=anime+cursor', true), { ic: 'external', cls: 'small ghost' })
      )
    );
    box.append(section_(...rows));
  };
  return [stitle(t('Con trỏ chuột')), bind(box, update)];
}

// ---------------------------------------------------------------- crop / zoom
const urlOf = (W) => (W.type === 'video' ? W.video : W.image);

function frameRow() {
  const reset = button(t('Bỏ khung'), () => saveFrame(urlOf(S.wallpaper), null), { cls: 'small ghost' });
  const r = row(
    t('Cắt / phóng to'),
    '',
    button(t('Chỉnh khung…'), () => frameEditor(), { ic: 'crop', cls: 'small' }),
    reset
  );
  return bind(r, () => (reset.hidden = !frameOf(S.wallpaper)));
}

function saveFrame(url, frame) {
  if (!url) return;
  S.wallpaper.frames = { ...S.wallpaper.frames, [url]: frame };
  api.invoke('settings:set', { wallpaper: { frames: { [url]: frame } } });
  refresh();
}

// The box has the window's shape: drag it to move it, drag a corner or scroll to zoom. Near an
// edge or a centre line of the picture it snaps there.
async function frameEditor() {
  const W = S.wallpaper;
  const url = urlOf(W);
  if (!url) return;
  const video = W.type === 'video';
  const aspect = (await api.invoke('wallpapers:frameAspect').catch(() => 0)) || 16 / 9;
  const media = video ? h('video', { muted: true, preload: 'auto' }) : h('img', { alt: '', draggable: false });
  await new Promise((done) => {
    media.addEventListener(video ? 'loadeddata' : 'load', done, { once: true });
    media.addEventListener('error', done, { once: true });
    media.src = video ? url + '#t=1' : url;
  });
  const iw = video ? media.videoWidth : media.naturalWidth;
  const ih = video ? media.videoHeight : media.naturalHeight;
  if (!iw || !ih) return toast(t('Không đọc được hình này'));

  // the picture, fitted into the editor (all the maths below is in these display pixels)
  const k = Math.min(Math.min(860, innerWidth - 96) / iw, Math.max(220, innerHeight - 170) / ih);
  const dw = iw * k;
  const dh = ih * k;
  const bw = Math.min(dw, dh * aspect); // the box at zoom 1: just covering the window
  const MAX_ZOOM = 8;
  const SNAP = 10;
  const old = frameOf(W);
  const start = old || { z: 1, ...({ top: { x: 0.5, y: 0 }, bottom: { x: 0.5, y: 1 }, left: { x: 0, y: 0.5 }, right: { x: 1, y: 0.5 } }[W.position] || { x: 0.5, y: 0.5 }) };
  const box = { w: bw / start.z };
  box.x = start.x * (dw - box.w);
  box.y = start.y * (dh - box.w / aspect);

  media.className = 'crop-media';
  const rect = h('div', { class: 'crop-box' }, ...['nw', 'ne', 'sw', 'se'].map((c) => h('i', { class: 'crop-handle', dataset: { c } })));
  const guideX = h('div', { class: 'crop-guide x' });
  const guideY = h('div', { class: 'crop-guide y' });
  const stage = h('div', { class: 'crop-stage', style: { width: dw + 'px', height: dh + 'px' } }, media, guideX, guideY, rect);
  const zoom = h('input', { type: 'range', min: '1', max: String(MAX_ZOOM), step: '0.01', class: 'crop-zoom' });
  const zoomText = h('span', { class: 'crop-zoom-text' });
  const close = () => scrim.remove();
  const scrim = h(
    'div',
    { class: 'crop-scrim' },
    h(
      'div',
      { class: 'crop-card' },
      h('div', { class: 'crop-head' }, h('b', { text: t('Cắt / phóng to hình nền') })),
      stage,
      h(
        'div',
        { class: 'crop-bar' },
        h('span', { html: icon('zoomOut', 15) }),
        zoom,
        h('span', { html: icon('zoomIn', 15) }),
        zoomText,
        h('span', { class: 'crop-spacer' }),
        button(t('Vừa khung'), () => {
          box.w = bw;
          box.x = (dw - bw) / 2;
          box.y = (dh - bw / aspect) / 2;
          draw();
        }, { cls: 'small ghost' }),
        button(t('Huỷ'), close, { cls: 'small ghost' }),
        button(t('Lưu'), () => {
          const bh = box.w / aspect;
          const fx = dw - box.w > 0.5 ? box.x / (dw - box.w) : 0.5;
          const fy = dh - bh > 0.5 ? box.y / (dh - bh) : 0.5;
          saveFrame(url, { z: +(bw / box.w).toFixed(4), x: +fx.toFixed(4), y: +fy.toFixed(4) });
          close();
          toast(t('Đã lưu khung hình'));
        }, { ic: 'check', cls: 'small primary' })
      )
    )
  );

  // keep the box inside the picture; `snap` pulls its edges and centre to the picture's
  function place(snap) {
    const bh = box.w / aspect;
    box.x = Math.max(0, Math.min(dw - box.w, box.x));
    box.y = Math.max(0, Math.min(dh - bh, box.y));
    let cx = false;
    let cy = false;
    if (snap) {
      for (const [v, centre] of [[0], [dw - box.w], [(dw - box.w) / 2, true]]) if (Math.abs(box.x - v) < SNAP) ((box.x = v), (cx = !!centre));
      for (const [v, centre] of [[0], [dh - bh], [(dh - bh) / 2, true]]) if (Math.abs(box.y - v) < SNAP) ((box.y = v), (cy = !!centre));
    }
    guideX.classList.toggle('on', cx && dw - box.w > 1);
    guideY.classList.toggle('on', cy && dh - bh > 1);
  }
  function draw() {
    Object.assign(rect.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.w / aspect + 'px' });
    const z = bw / box.w;
    zoom.value = String(z);
    zoomText.textContent = `${z.toFixed(2)}×`;
  }
  // zoom to box width `w`, keeping the box's centre where it is
  function zoomTo(w) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.w / aspect / 2;
    box.w = Math.max(bw / MAX_ZOOM, Math.min(bw, w));
    if (bw - box.w < bw * 0.015) box.w = bw; // (sticks to "just covering")
    box.x = cx - box.w / 2;
    box.y = cy - box.w / aspect / 2;
    place(false);
    draw();
  }
  zoom.addEventListener('input', () => zoomTo(bw / Number(zoom.value)));
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomTo(box.w * Math.exp(e.deltaY * 0.0015));
  }, { passive: false });

  stage.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.crop-handle')?.dataset.c;
    if (!handle && !e.target.closest('.crop-box')) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const s0 = stage.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY, bx: box.x, by: box.y };
    // a corner resizes around the opposite one
    const sx = handle?.includes('e') ? 1 : -1;
    const sy = handle?.includes('s') ? 1 : -1;
    const ax = sx > 0 ? box.x : box.x + box.w;
    const ay = sy > 0 ? box.y : box.y + box.w / aspect;
    const move = (ev) => {
      if (!handle) {
        box.x = from.bx + ev.clientX - from.x;
        box.y = from.by + ev.clientY - from.y;
        place(true);
        return draw();
      }
      const px = ev.clientX - s0.left;
      const py = ev.clientY - s0.top;
      const room = Math.min(bw, sx > 0 ? dw - ax : ax, (sy > 0 ? dh - ay : ay) * aspect);
      let w = Math.max(sx * (px - ax), sy * (py - ay) * aspect, bw / MAX_ZOOM);
      if (w > room - SNAP) w = room; // (the moving corner sticks to the picture's edge)
      box.w = Math.min(w, room);
      box.x = sx > 0 ? ax : ax - box.w;
      box.y = sy > 0 ? ay : ay - box.w / aspect;
      place(false);
      draw();
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      guideX.classList.remove('on');
      guideY.classList.remove('on');
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up, { once: true });
    stage.addEventListener('pointercancel', up, { once: true });
  });
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());
  scrim.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), close()));
  scrim.tabIndex = -1;
  place(false);
  draw();
  document.body.append(scrim);
  scrim.focus();
}

function imageLibrary() {
  const gallery = h('div', { class: 'wp-grid' }, ...wallpapers.bundled.map((x) => wpTile(x)));
  // (a linked folder's pictures are the user's own files: never deleted from here)
  const mine = h('div', { class: 'wp-grid' }, ...wallpapers.user.map((x) => wpTile(x, { removable: x.kind === 'user' })));
  const addLocal = h('button', { type: 'button', class: 'wp-item wp-add', html: `${icon('plus', 22)}<span>${t('Thêm ảnh từ máy')}</span>` });
  addLocal.addEventListener('click', async () => {
    const added = await api.invoke('wallpapers:import');
    if (added.length) {
      await loadWallpapers();
      set('wallpaper.type', 'image');
      set('wallpaper.image', added[0].url);
      render();
    }
  });
  mine.prepend(addLocal);
  return [
    stitle(t('Bộ sưu tập anime 2000–2010 · 4K')),
    gallery,
    stitle(t('Ảnh của bạn')),
    ...mediaTools(),
    mine,
    storageRow(),
    stitle(t('Thư viện trực tuyến · Wallhaven')),
    onlineSearch(),
    stitle(t('Trình chiếu')),
    section_(
      row(t('Tự đổi hình nền'), '', select('wallpaper.slideshowMinutes', [[0, t('Tắt')], [1, t('Mỗi 1 phút')], [5, t('Mỗi 5 phút')], [15, t('Mỗi 15 phút')], [30, t('Mỗi 30 phút')], [60, t('Mỗi giờ')], [180, t('Mỗi 3 giờ')]])),
      row(t('Ảnh trong trình chiếu'), '', slideshowCount(), button(t('Bỏ chọn tất cả'), () => (set('wallpaper.slideshow', []), refresh()), { cls: 'small ghost' }))
    ),
  ];
}

function useVideo(url) {
  set('wallpaper.type', 'video');
  set('wallpaper.video', url);
}

function videoTile(v) {
  const tile = h('div', { class: 'wp-item', title: v.title || '' });
  tile.innerHTML = `${v.thumb ? `<img src="${esc(v.thumb)}" loading="lazy" alt="">` : `<video src="${esc(v.url)}#t=1" muted preload="metadata"></video>`}
    <span class="wp-cap">${esc(v.title || t('Video'))}</span>
    <span class="wp-check">${icon('check', 14)}</span>${v.kind === 'linked' ? `<span class="wp-linked" title="${t('Từ thư mục liên kết')}">${icon('link', 12)}</span>` : ''}
    ${v.kind === 'user' ? `<button class="wp-del solo" title="${t('Xóa video')}">${icon('trash', 14)}</button>` : ''}`;
  // short muted preview on hover
  let hover = null;
  tile.addEventListener('mouseenter', () => {
    hover = h('video', { class: 'wp-hover', muted: true, loop: true, autoplay: true, playsinline: true });
    hover.muted = true;
    hover.src = v.url;
    tile.prepend(hover);
  });
  tile.addEventListener('mouseleave', () => {
    hover?.remove();
    hover = null;
  });
  tile.addEventListener('click', async (e) => {
    if (e.target.closest('.wp-del')) {
      await api.invoke('wallpapers:remove', v.file);
      if (S.wallpaper.video === v.url) set('wallpaper.video', '');
      await loadWallpapers();
      return render();
    }
    useVideo(v.url);
    refresh();
  });
  return bind(tile, () => tile.classList.toggle('on', S.wallpaper.type === 'video' && S.wallpaper.video === v.url));
}

function videoLibrary() {
  const grid = h('div', { class: 'wp-grid' }, ...wallpapers.videos.map(videoTile));
  const tools = mediaTools();
  const add = h('button', { type: 'button', class: 'wp-item wp-add', html: `${icon('plus', 22)}<span>${t('Thêm video từ máy')}</span>` });
  add.addEventListener('click', async () => {
    add.classList.add('busy');
    try {
      const added = await api.invoke('wallpapers:importVideo');
      if (added.length) {
        await loadWallpapers();
        useVideo(added[0].url);
        render();
      }
    } finally {
      add.classList.remove('busy');
    }
  });
  grid.prepend(add);
  const input = h('input', { type: 'url', class: 'input', placeholder: 'https://…/video.mp4', style: { flex: '1' } });
  const go = h('button', { type: 'button', class: 'btn', html: `${icon('download', 15)}<span>${t('Tải về & dùng')}</span>` });
  const fetchIt = async () => {
    const url = input.value.trim();
    if (!/^https:\/\/\S+$/i.test(url)) return toast(t('Dán link https tới file .mp4 hoặc .webm'));
    go.disabled = true;
    toast(t('Đang tải video…'));
    try {
      const v = await api.invoke('wallpapers:videoFromUrl', url);
      await loadWallpapers();
      useVideo(v.url);
      input.value = '';
      render();
      toast(t('Đã đặt video làm hình nền ✿'));
    } catch (e) {
      toast(errText(e) || t('Không tải được video'));
    } finally {
      go.disabled = false;
    }
  };
  go.addEventListener('click', fetchIt);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && fetchIt());
  return [
    stitle(t('Video của bạn')),
    ...tools,
    grid,
    h('div', { class: 'toolbar-row' }, input, go),
    storageRow(),
  ];
}

// Blue Archive students: a big picture of the chosen lobby, a search box and a grid of lobbies.
// Small pictures come from SchaleDB; the big one is a picture TyranWeb takes of the real lobby the
// first time it shows it (until then the small one stands in).
// ---------------------------------------------------------------- NIKKE and Azur Lane
// A character is downloaded before she can be shown (nothing of the games comes with TyranWeb): the
// gallery says so, with her size, and downloads her (all her outfits) on request. The two games share
// it: each keeps its own list (from its IPC channels) and its own settings (who, which outfit).
const GAMES = {
  nikke: { api: 'nikke', preset: 'nikke', who: 'nikke', outfit: 'nikkeOutfit', first: 'c010', base: t('Mặc định'), find: t('Tìm nhân vật…'), drop: t('Gỡ nhân vật này (cả trang phục)'), list: null, progress: {}, query: '', only: 'all', showing: {}, ask: '', gone: '' },
  azurlane: { api: 'azur', preset: 'azurlane', who: 'azur', outfit: 'azurSkin', first: '', base: '', find: t('Tìm tàu…'), drop: t('Gỡ tàu này (cả trang phục)'), list: null, progress: {}, query: '', only: 'all', showing: {}, ask: '', gone: '' },
  sekai: { api: 'sekai', preset: 'sekai', who: 'sekai', outfit: 'sekaiOutfit', first: '', base: '', find: t('Tìm nhân vật…'), drop: t('Gỡ nhân vật này (cả trang phục)'), list: null, progress: {}, query: '', only: 'all', showing: {}, ask: '', gone: '' },
};
const gameOf = (preset) => GAMES[preset] || null;
const charInfo = (G, id) => G.list?.find((c) => c.id === (id || G.first)) || (!id && G.list?.[0]) || null;
// what the wallpaper shows: her, or the outfit she wears (its picture, its name)
const charShown = (W) => {
  const G = gameOf(W.web?.preset);
  if (!G) return null;
  const c = charInfo(G, W.web?.[G.who]);
  const o = c?.outfits.find((x) => x.id === W.web?.[G.outfit] && x.installed);
  return c && (o ? { ...o, name: `${c.name} · ${o.name}` } : c);
};
const mb = (n) => `${(n / 1e6).toFixed(1).replace('.', ',')} MB`;
async function loadChars(G) {
  G.list = await api.invoke(G.api + ':list').catch(() => []);
  refresh();
  return G.list;
}
for (const G of Object.values(GAMES)) {
  api.on(G.api + ':changed', () => loadChars(G));
  api.on(G.api + ':cards', debounce(() => loadChars(G), 400)); // (a card's picture made)
  api.on(G.api + ':progress', (p) => {
    G.progress[p.id] = p.finished ? null : p;
    refresh();
  });
}

// A card per character, like a gallery: her picture, the outfit's name over hers, how many outfits
// she has (the button turns the card through them). A press wears the look the card shows, or, not
// downloaded yet, says she must be downloaded first, with its size: she comes whole, every outfit.
function charPicker(G) {
  const search = h('input', { type: 'search', class: 'input', placeholder: G.find, value: G.query });
  const only = h('div', { class: 'seg' }, ...[['all', t('Tất cả')], ['got', t('Đã tải')]].map(([v, label]) => {
    const btn = h('button', { type: 'button', text: label, class: v === G.only ? 'on' : '' });
    btn.addEventListener('click', () => {
      G.only = v;
      only.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
      sig = null;
      draw();
    });
    return btn;
  }));
  const grid = h('div', { class: 'nk-grid' });
  let sig = null;
  search.addEventListener('input', () => {
    G.query = search.value;
    sig = null;
    draw();
  });
  api.invoke(G.api + ':cards').catch(() => {}); // (their pictures still missing)
  const pct = (p) => Math.min(99, Math.round((100 * p.done) / Math.max(1, p.total)));
  const use = (c, outfit) => api.invoke('settings:set', { wallpaper: { type: 'web', web: { preset: G.preset, [G.who]: c.id, [G.outfit]: outfit } } });
  // what a look takes: her whole (or what is still missing of her), or, for a game whose outfits come
  // one at a time (c.each), her first download and that outfit
  const need = (c, look) => (!c.each ? c.missing : !c.installed ? c.missing + (look.id ? look.need || 0 : 0) : look.installed ? 0 : look.need || 0);
  // that, then the look the card showed
  const download = async (c, look) => {
    G.ask = '';
    G.progress[c.id] = { done: 0, total: need(c, look) };
    refresh();
    const outfit = look.id;
    try {
      await api.invoke(G.api + ':install', c.id, outfit);
      await use(c, outfit);
      toast(t('Đã tải {0} ✿', c.name));
    } catch (err) {
      toast(errText(err) || t('Không tải được'));
    } finally {
      G.progress[c.id] = null;
      loadChars(G);
    }
  };
  const card = (c, W) => {
    const looks = [{ ...c, id: '', name: c.look || G.base }, ...c.outfits];
    const mine = (W[G.who] || G.first || G.list[0]?.id) === c.id;
    const wearing = mine && c.installed ? (c.outfits.find((o) => o.id === W[G.outfit] && o.installed)?.id ?? '') : null;
    let i = looks.findIndex((l) => l.id === (G.showing[c.id] ?? wearing ?? ''));
    if (i < 0) i = 0;
    const look = looks[i];
    const p = G.progress[c.id] || c.installing;
    const on = wearing === look.id;
    const el = h('div', { class: `nk-card${on ? ' on' : ''}`, role: 'button', tabindex: '0' });
    const art = h('div', { class: 'nk-art' });
    const pic = h('img', { src: look.card || c.card, alt: '', loading: 'lazy', draggable: false });
    pic.addEventListener('error', () => pic.src !== look.thumb && ((pic.src = look.thumb || c.thumb), (pic.className = 'nk-face')), { once: true });
    if (/\/sprite\//.test(pic.src)) pic.className = 'nk-face'; // (only her small portrait so far)
    art.append(pic, h('span', { class: 'nk-badge', html: `${icon('play', 10)}Live2D` }));
    if (looks.length > 1) {
      const turn = h('button', { type: 'button', class: 'nk-outfits', title: t('Đổi trang phục'), html: `${icon('layers', 13)}<span>${i + 1}/${looks.length}</span>` });
      turn.addEventListener('click', (e) => {
        e.stopPropagation();
        G.showing[c.id] = looks[(i + 1) % looks.length].id;
        G.ask = '';
        sig = null;
        draw();
      });
      art.append(turn);
    }
    if (p) {
      art.append(h('span', { class: 'nk-size', text: t('Đang tải… {0}%', pct(p)) }), h('div', { class: 'nk-bar' }, h('i', { style: { width: `${pct(p)}%` } })));
    } else if (c.each ? !look.installed : !c.complete) art.append(h('span', { class: 'nk-size', html: `${icon('download', 11)}${c.installed ? '+' : ''}${mb(need(c, look))}` }));
    if (c.installed && !p) {
      // remove her (all of her): a second press within a few seconds
      const gone = h('button', { type: 'button', class: 'nk-remove' + (G.gone === c.id ? ' armed' : ''), title: G.drop, html: G.gone === c.id ? t('<span>Gỡ thật?</span>') : icon('trash', 13) });
      gone.addEventListener('click', (e) => {
        e.stopPropagation();
        if (G.gone !== c.id) {
          G.gone = c.id;
          sig = null;
          draw();
          setTimeout(() => G.gone === c.id && ((G.gone = ''), (sig = null), draw()), 3000);
          return;
        }
        G.gone = '';
        api.invoke(G.api + ':remove', c.id).catch((err) => toast(errText(err)));
      });
      art.append(gone);
    }
    el.append(art, h('div', { class: 'nk-foot' }, h('b', { text: look.name }), h('span', { text: c.name })));
    // not downloaded: the card says so, with what it takes, and downloads on a yes
    if (G.ask === c.id && !look.installed && !p) {
      const all = c.outfits.length && !c.each ? t(' (cả {0} trang phục)', c.outfits.length + 1) : '';
      const text = c.each
        ? c.installed
          ? t('Trang phục này chưa có trên máy: tải về, {0}.', mb(need(c, look)))
          : t('Cần tải về trước để TyranWeb tự cài đặt hình nền này{0}: tải {1}, chiếm {2} trên máy.', '', mb(need(c, look)), mb(need(c, look)))
        : c.installed
          ? t('Trang phục này chưa có trên máy: tải nốt các trang phục còn thiếu, {0}.', mb(c.missing))
          : t('Cần tải về trước để TyranWeb tự cài đặt hình nền này{0}: tải {1}, chiếm {2} trên máy.', all, mb(c.download), mb(c.bytes));
      const no = button(t('Hủy'), (e) => (e.stopPropagation(), (G.ask = ''), (sig = null), draw()), { cls: 'small' });
      const yes = button(t('Tải về'), (e) => (e.stopPropagation(), download(c, look)), { ic: 'download', cls: 'small primary' });
      el.append(h('div', { class: 'nk-ask' }, h('p', { text }), h('div', { class: 'nk-ask-btns' }, no, yes)));
    }
    const press = () => {
      if (look.installed) return on || use(c, look.id);
      if (p) return;
      G.ask = c.id;
      sig = null;
      draw();
    };
    el.addEventListener('click', press);
    el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), press()));
    return el;
  };
  const draw = () => {
    if (!G.list) return void loadChars(G);
    const W = S.wallpaper.web || {};
    const now = JSON.stringify([G.list, G.progress, W[G.who], W[G.outfit], G.showing, G.ask, G.gone, G.query, G.only]);
    if (now === sig) return;
    sig = now;
    const q = G.query.trim().toLowerCase();
    const shown = G.list.filter((c) => (G.only === 'all' || c.installed) && (!q || [c.name, c.look || '', ...c.outfits.map((o) => o.name)].some((n) => n.toLowerCase().includes(q))));
    grid.replaceChildren(...shown.map((c) => card(c, W)));
  };
  bind(grid, draw);
  return h('div', { class: 'nk-wrap' }, h('div', { class: 'nk-tools' }, search, only), grid);
}

// her backdrop: the colour above, or a picture of the user's
function nikkeImageRow() {
  const remove = button(t('Bỏ ảnh'), () => api.invoke('nikke:backdrop', false).catch((e) => toast(errText(e))), { cls: 'small' });
  const r = row(t('Ảnh nền'), '', button(t('Chọn ảnh…'), () => api.invoke('nikke:backdrop', true).catch((e) => toast(errText(e))), { ic: 'image', cls: 'small' }), remove);
  return bind(r, () => (remove.hidden = !S.wallpaper.web?.nikkeImage));
}

let baList = null;
let baLoading = null;
const baInfo = (key) => baList?.find((m) => m.key === key);
function loadBaList() {
  baLoading ||= api.invoke('wallpapers:baModels').then(
    (list) => ((baList = list), refresh(), list),
    (e) => ((baLoading = null), Promise.reject(e))
  );
  return baLoading;
}
api.on('ba:preview', ({ key, url }) => {
  if (String(key).startsWith('nikke_')) return void loadChars(GAMES.nikke);
  if (String(key).startsWith('azur_')) return void loadChars(GAMES.azurlane);
  if (String(key).startsWith('sekai_')) return void loadChars(GAMES.sekai);
  const m = baInfo(key);
  if (m) m.preview = url;
  refresh();
});

function baPicker() {
  const big = h('div', { class: 'ba-preview' }, h('img', { alt: '' }), h('div', { class: 'ba-preview-cap' }), h('div', { class: 'ba-preview-note' }));
  bind(big, () => {
    const m = baInfo(S.wallpaper.web.model);
    const img = big.querySelector('img');
    const src = m?.preview || m?.thumb || '';
    if (img.getAttribute('src') !== src) src ? img.setAttribute('src', src) : img.removeAttribute('src');
    big.classList.toggle('low', !m?.preview);
    big.querySelector('.ba-preview-cap').textContent = m ? m.name + (m.jp && m.jp !== m.name ? ' · ' + m.jp : '') : t('Đang tải danh sách…');
    big.querySelector('.ba-preview-note').textContent = m && !m.preview ? t('Ảnh rõ nét sẽ có sau khi sảnh này hiện lần đầu (xem phía sau trang này)') : '';
  });
  // filters: any part of a name, the school, the student, the outfit
  const find = h('input', { type: 'search', class: 'input ba-find', placeholder: t('Tìm theo tên (Aru, shiro, suối…)') });
  const school = h('select', { class: 'ba-filter', title: t('Trường') });
  const student = h('select', { class: 'ba-filter', title: t('Học sinh') });
  const outfit = h('select', { class: 'ba-filter', title: t('Trang phục') });
  const count = h('span', { class: 'muted small ba-count' });
  const clear = h('button', { type: 'button', class: 'btn ghost small', text: t('Bỏ lọc') });
  // favourites: a heart on each lobby, and this to show only them
  const favs = () => new Set(S.wallpaper.web.favorites || []);
  let onlyFav = false;
  const favFilter = h('button', { type: 'button', class: 'btn ghost small ba-fav-filter', title: t('Chỉ sảnh yêu thích'), html: icon('heart', 15) });
  favFilter.addEventListener('click', () => {
    onlyFav = !onlyFav;
    favFilter.classList.toggle('on', onlyFav);
    draw();
  });
  clear.addEventListener('click', () => {
    find.value = school.value = student.value = outfit.value = '';
    onlyFav = false;
    favFilter.classList.remove('on');
    draw();
  });
  const grid = h('div', { class: 'ba-grid' }, h('div', { class: 'empty-note', text: t('Đang tải danh sách học sinh…') }));
  // a select's options from the lobbies the other filters leave, keeping its choice when still there
  const fill = (sel, all, values, label) => {
    const keep = sel.value;
    // usual outfit first, other schools last
    const rank = (v) => (v === '_default' ? 0 : !v || v === 'ETC' ? 2 : 1);
    const list = [...new Set(values)].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
    sel.innerHTML = '';
    sel.append(h('option', { value: '', text: all }), ...list.map((v) => h('option', { value: v, text: label(v) })));
    sel.value = list.includes(keep) ? keep : '';
  };
  const draw = () => {
    if (!baList) return;
    const q = fold(find.value.trim());
    const lobbies = baList.filter((m) => !m.hidden); // (a lobby listed twice shows once)
    const bySchool = lobbies.filter((m) => !school.value || m.school === school.value);
    fill(school, t('Mọi trường'), lobbies.map((m) => m.school), schoolLabel);
    fill(student, t('Mọi học sinh'), bySchool.map((m) => m.student), (v) => v);
    fill(outfit, t('Mọi trang phục'), bySchool.filter((m) => !student.value || m.student === student.value).map(outfitOf), outfitLabel);
    grid.innerHTML = '';
    let shown = 0;
    const fav = favs();
    for (const m of lobbies) {
      if (onlyFav && !fav.has(m.key)) continue;
      if (school.value && m.school !== school.value) continue;
      if (student.value && m.student !== student.value) continue;
      if (outfit.value && outfitOf(m) !== outfit.value) continue;
      if (q && !fold(`${m.name} ${m.jp} ${m.key} ${m.search} ${schoolLabel(m.school)} ${outfitLabel(outfitOf(m))}`).includes(q)) continue;
      shown++;
      const tile = h('button', { type: 'button', class: 'ba-tile' + (m.broken ? ' broken' : ''), title: m.name + (m.jp ? ` · ${m.jp}` : '') + (m.broken ? t(' — trình xem Blue Archive không hiển thị được sảnh này') : '') });
      tile.innerHTML = `${m.thumb ? `<img src="${esc(m.thumb)}" loading="lazy" alt="">` : `<span class="wp-ph">${icon('image', 22)}</span>`}<span class="ba-name">${esc(m.name)}</span>${m.broken ? `<span class="ba-broken">${t('Lỗi dữ liệu')}</span>` : ''}<span class="wp-check">${icon('check', 14)}</span><span class="ba-fav" title="${esc(t('Yêu thích'))}">${icon('heart', 15)}</span>`;
      tile.classList.toggle('fav', fav.has(m.key));
      tile.querySelector('.ba-fav').addEventListener('click', (e) => {
        e.stopPropagation();
        const f = favs();
        if (f.has(m.key)) f.delete(m.key);
        else f.add(m.key);
        set('wallpaper.web.favorites', [...f]);
        tile.classList.toggle('fav', f.has(m.key));
        if (onlyFav) draw();
      });
      tile.addEventListener('click', () => {
        set('wallpaper.web.model', m.key);
        // a lobby chosen by hand stays (no more picks by the season and the time)
        if (S.wallpaper.web.lobbyPick === 'season') set('wallpaper.web.lobbyPick', 'fixed');
        refresh();
      });
      grid.append(bind(tile, () => tile.classList.toggle('on', S.wallpaper.web.model === m.key)));
    }
    if (!grid.children.length) grid.append(h('div', { class: 'empty-note', text: t('Không tìm thấy học sinh nào') }));
    count.textContent = t('{0} / {1} sảnh', shown, lobbies.length);
    clear.hidden = !(find.value || school.value || student.value || outfit.value || onlyFav);
  };
  find.addEventListener('input', debounce(draw, 120));
  for (const sel of [school, student, outfit]) sel.addEventListener('change', draw);
  loadBaList().then(draw, () => (grid.innerHTML = t('<div class="empty-note">Không kết nối được trình xem Blue Archive.</div>')));
  return h('div', { class: 'ba-picker' }, big, h('div', { class: 'ba-filters' }, find, school, student, outfit, favFilter, count, clear), grid);
}

// Khi hết nhạc (sidebar.js nextLobby): another lobby when the song ends, among a school's, a
// student's, an outfit's (the picker's filters), in the list's order or at random, and whether a
// round that has played them all starts over.
function nextLobbySection() {
  const path = 'wallpaper.web.nextLobby';
  const on = row(t('Đổi sang sảnh khác'), '', sw('wallpaper.web.nextOnSongEnd', () => render()));
  if (!S.wallpaper.web.nextOnSongEnd) return [stitle(t('Khi hết nhạc')), section_(on)];
  const desc = h('span');
  on.querySelector('.row-text').append(desc);
  const sels = { school: h('select', {}), student: h('select', {}), outfit: h('select', {}) };
  const choice = (k) => S.wallpaper.web.nextLobby?.[k] ?? '';
  // each choice's options from the lobbies the others leave; one no longer there falls back to "any"
  const fill = (k, all, values, label) => {
    const rank = (v) => (v === '_default' ? 0 : !v || v === 'ETC' ? 2 : 1);
    const list = [...new Set(values)].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
    const sel = sels[k];
    sel.innerHTML = '';
    sel.append(h('option', { value: '', text: all }), ...list.map((v) => h('option', { value: v, text: label(v) })));
    sel.value = list.includes(choice(k)) ? choice(k) : '';
    if (baList && sel.value !== choice(k)) set(`${path}.${k}`, sel.value);
  };
  const draw = () => {
    const lobbies = (baList || []).filter((m) => !m.hidden && !m.broken);
    const school = (m) => !sels.school.value || m.school === sels.school.value;
    const student = (m) => !sels.student.value || m.student === sels.student.value;
    fill('school', t('Mọi trường'), lobbies.map((m) => m.school), schoolLabel);
    fill('student', t('Mọi học sinh'), lobbies.filter(school).map((m) => m.student), (v) => v);
    fill('outfit', t('Mọi trang phục'), lobbies.filter(school).filter(student).map(outfitOf), outfitLabel);
    const favs = new Set(S.wallpaper.web.favorites || []);
    const fav = (m) => !S.wallpaper.web.nextLobby?.favorites || favs.has(m.key);
    const n = lobbies.filter((m) => school(m) && student(m) && fav(m) && (!sels.outfit.value || outfitOf(m) === sels.outfit.value)).length;
    desc.textContent = baList ? t('{0} sảnh', n) : '';
  };
  for (const [k, sel] of Object.entries(sels)) {
    sel.addEventListener('change', () => {
      set(`${path}.${k}`, sel.value);
      draw();
    });
  }
  draw();
  loadBaList().then(draw, () => {});
  return [
    stitle(t('Khi hết nhạc')),
    section_(
      on,
      row(t('Trường'), '', sels.school),
      row(t('Học sinh'), '', sels.student),
      row(t('Trang phục'), '', sels.outfit),
      row(t('Chỉ sảnh yêu thích'), '', sw(`${path}.favorites`, draw)),
      row(t('Thứ tự'), '', seg(`${path}.order`, [['list', t('Lần lượt')], ['shuffle', t('Ngẫu nhiên')]])),
      row(t('Phát hết thì lặp lại từ đầu'), '', sw(`${path}.repeat`))
    ),
  ];
}

// search without caring about case or Vietnamese accents ("suoi" finds "Suối nước nóng")
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

const SCHOOLS = { RedWinter: 'Red Winter', WildHunt: 'Wild Hunt', Tokiwadai: 'Tokiwadai (Railgun)', Sakugawa: 'Sakugawa (Railgun)', ETC: t('Khác') };
const schoolLabel = (s) => (s ? SCHOOLS[s] || s : t('Khác'));

// SchaleDB's outfit names, in Vietnamese first
const OUTFITS = {
  _default: t('Mặc định (thường ngày)'),
  Swimsuit: t('Đồ bơi'),
  'Hot Spring': t('Suối nước nóng'),
  'New Year': t('Năm mới'),
  Christmas: t('Giáng sinh'),
  Bunny: 'Bunny girl',
  'Cheer Squad': t('Đội cổ vũ'),
  Track: t('Đồ thể thao'),
  Maid: t('Hầu gái'),
  Camp: t('Cắm trại'),
  Dress: t('Váy dạ hội'),
  Band: t('Ban nhạc'),
  Armed: t('Vũ trang'),
  Qipao: t('Sườn xám'),
  'Pop Idol': t('Thần tượng'),
  Pajamas: t('Đồ ngủ'),
  School: t('Đồng phục'),
  Casual: t('Thường phục'),
  'Part-Timer': t('Làm thêm'),
  Magical: t('Phép thuật'),
  Guide: t('Hướng dẫn viên'),
  Cycling: t('Đạp xe'),
  Riding: t('Đua xe'),
  Small: t('Lúc nhỏ'),
  'Lobby 2': t('Sảnh 2 (Abydos)'),
};
const outfitOf = (m) => m.outfit || '_default'; // (the select's '' means every outfit)
const outfitLabel = (o) => (OUTFITS[o] ? (o === '_default' || o === 'Lobby 2' ? OUTFITS[o] : `${OUTFITS[o]} (${o})`) : o);

function liveTile(p) {
  const tile = h('div', { class: 'wp-item', title: p.title });
  tile.innerHTML = `${p.thumb ? `<img src="${esc(p.thumb)}" loading="lazy" alt="">` : `<span class="wp-ph">${icon('globe', 28)}</span>`}
    <span class="wp-cap">${esc(p.title)}</span>
    <span class="wp-check">${icon('check', 14)}</span>
    <button class="wp-del solo" title="${t('Xóa')}">${icon('trash', 14)}</button>`;
  tile.addEventListener('click', async (e) => {
    if (e.target.closest('.wp-del')) {
      await api.invoke('wallpapers:removeWeb', p.id);
      if (S.wallpaper.web.package === p.id) set('wallpaper.web.package', '');
      await loadWallpapers();
      return render();
    }
    set('wallpaper.type', 'web');
    set('wallpaper.web.preset', 'package');
    set('wallpaper.web.package', p.id);
    refresh();
  });
  return bind(tile, () => tile.classList.toggle('on', S.wallpaper.type === 'web' && S.wallpaper.web.preset === 'package' && S.wallpaper.web.package === p.id));
}

function liveLibrary() {
  const grid = h('div', { class: 'wp-grid' }, ...wallpapers.live.map(liveTile));
  const add = h('button', { type: 'button', class: 'wp-item wp-add', html: `${icon('plus', 22)}<span>${t('Thêm thư mục nền web')}</span>` });
  add.addEventListener('click', async () => {
    try {
      const p = await api.invoke('wallpapers:importWeb');
      if (!p) return;
      await loadWallpapers();
      set('wallpaper.web.package', p.id);
      render();
      toast(t('Đã thêm “{0}” ✿', p.title));
    } catch (e) {
      toast(errText(e) || t('Không thêm được thư mục này'));
    }
  });
  grid.prepend(add);
  return [
    stitle(t('Gói nền web')),
    grid,
  ];
}

function slideshowCount() {
  const el = h('span', { class: 'muted' });
  return bind(el, () => {
    const n = (S.wallpaper.slideshow || []).length;
    el.textContent = n ? t('{0} ảnh đã ♡', n) : t('Chưa ♡ ảnh nào — dùng cả thư viện');
  });
}

function onlineSearch() {
  const input = h('input', { type: 'search', class: 'input', placeholder: t('Tên anime, nhân vật… (tiếng Anh/Romaji)'), style: { flex: '1' } });
  const preAI = h('input', { type: 'checkbox', checked: true });
  const resolution = h('select', { title: t('Độ phân giải tối thiểu') }, h('option', { value: '4k', text: t('4K trở lên') }), h('option', { value: '1440p', text: t('1440p trở lên') }), h('option', { value: '1080p', text: t('1080p trở lên') }));
  const sorting = h('select', { title: t('Sắp xếp') }, h('option', { value: 'favorites', text: t('Được thích nhiều') }), h('option', { value: 'relevance', text: t('Liên quan nhất') }), h('option', { value: 'views', text: t('Xem nhiều') }), h('option', { value: 'date_added', text: t('Mới tải lên') }), h('option', { value: 'random', text: t('Ngẫu nhiên') }));
  const count = h('span', { class: 'muted small' });
  const results = h('div', { class: 'wp-grid' });
  const more = h('button', { type: 'button', class: 'btn', text: t('Xem thêm'), hidden: true });
  let page = 1;
  let q = '';
  const run = async (reset) => {
    if (reset) {
      page = 1;
      results.innerHTML = t('<div class="empty-note">Đang tìm…</div>');
    }
    try {
      const r = await api.invoke('wallpapers:search', { query: q, page, preAI: preAI.checked, resolution: resolution.value, sorting: sorting.value });
      if (reset) results.innerHTML = '';
      count.textContent = r.total ? t('{0} ảnh trên Wallhaven{1}', r.total.toLocaleString(LOCALE), preAI.checked ? t(' (đang ẩn ảnh tải lên sau 08/2022)') : '') : '';
      for (const it of r.items) {
        const tile = h('div', { class: 'wp-item', title: t('{0} · tải lên {1}', it.resolution, it.uploaded) });
        tile.innerHTML = `<img src="${esc(it.thumb)}" loading="lazy" alt=""><span class="wp-cap">${esc(it.resolution)} · ${esc(it.uploaded.slice(0, 4))}</span>`;
        tile.addEventListener('click', async () => {
          tile.classList.add('busy');
          try {
            const saved = await api.invoke('wallpapers:wallhaven', it);
            await loadWallpapers();
            set('wallpaper.type', 'image');
            set('wallpaper.image', saved.url);
            toast(t('Đã đặt làm hình nền ✿'));
            refresh();
          } catch (e) {
            toast(errText(e) || t('Không tải được ảnh này'));
          } finally {
            tile.classList.remove('busy');
          }
        });
        results.append(tile);
      }
      if (!results.children.length) results.innerHTML = t('<div class="empty-note">Không có kết quả (；一_一) — thử tên khác hoặc bỏ lọc “trước 2022”.</div>');
      page = r.page; // the search may have read several pages
      more.hidden = page >= r.lastPage;
    } catch {
      results.innerHTML = t('<div class="empty-note">Không kết nối được Wallhaven.</div>');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      q = input.value.trim();
      run(true);
    }
  });
  for (const el of [resolution, sorting]) el.addEventListener('change', () => results.children.length && run(true));
  preAI.addEventListener('change', () => results.children.length && run(true));
  more.addEventListener('click', () => {
    page++;
    run(false);
  });
  const chips = h('div', { class: 'chips' });
  for (const c of ANIME_CHIPS) {
    const b = h('button', { type: 'button', class: 'chip', text: c });
    b.addEventListener('click', () => {
      input.value = c;
      q = c;
      run(true);
    });
    chips.append(b);
  }
  return h(
    'div',
    { class: 'online' },
    h('div', { class: 'toolbar-row' }, input, resolution, sorting),
    h('div', { class: 'toolbar-row' }, h('label', { class: 'check' }, h('span', { class: 'switch' }, preAI, h('span')), h('span', { text: t('Chỉ ảnh trước 08/2022 (chắc chắn không AI)') })), count),
    chips,
    results,
    h('div', { class: 'center' }, more)
  );
}

// ---------------------------------------------------------------- layout
const TOOLBAR_ITEMS = {
  back: [t('Quay lại'), 'back'], forward: [t('Tiến tới'), 'forward'], reload: [t('Tải lại'), 'reload'], home: [t('Trang chủ'), 'home'],
  omnibox: [t('Thanh địa chỉ'), 'search'], adblock: [t('Chặn quảng cáo'), 'shieldCheck'], downloads: [t('Tải xuống'), 'download'],
  split: [t('Chia đôi màn hình'), 'split'], screenshot: [t('Chụp màn hình'), 'camera'], pip: [t('Hình trong hình'), 'pip'],
  sidebar: [t('Thanh bên'), 'sidebar'], palette: [t('Bảng lệnh'), 'command'], theme: [t('Đổi theme'), 'palette'], wallpaper: [t('Đổi hình nền'), 'shuffle'], lobby: [t('Chế độ Lobby'), 'tv'],
  zen: [t('Chế độ tập trung'), 'eye'], newtab: [t('Tab mới'), 'plus'], private: [t('Cửa sổ ẩn danh'), 'incognito'], settings: [t('Cài đặt'), 'sliders'], menu: [t('Menu'), 'more'],
};

function toolbarEditor() {
  const list = h('div', { class: 'tb-list' });
  const render_ = () => {
    const order = [...S.layout.toolbarItems];
    for (const id of Object.keys(TOOLBAR_ITEMS)) if (!order.includes(id)) order.push(id);
    const hidden = new Set(S.layout.hiddenToolbarItems || []);
    for (const id of Object.keys(TOOLBAR_ITEMS)) if (!S.layout.toolbarItems.includes(id)) hidden.add(id);
    list.innerHTML = '';
    for (const id of order) {
      const [label, ic] = TOOLBAR_ITEMS[id];
      const fixed = id === 'omnibox' || id === 'menu';
      const item = h('div', { class: `tb-item${hidden.has(id) && !fixed ? ' off' : ''}`, draggable: 'true', dataset: { id } });
      item.innerHTML = `<span class="grip">${icon('grip', 16)}</span><span class="tb-ico">${icon(ic, 17)}</span><span class="tb-label">${esc(label)}</span>`;
      if (!fixed) {
        const eye = h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !hidden.has(id) }), h('span'));
        eye.querySelector('input').addEventListener('change', (e) => {
          const hid = new Set(hidden);
          e.target.checked ? hid.delete(id) : hid.add(id);
          api.invoke('settings:set', { layout: { toolbarItems: order, hiddenToolbarItems: [...hid] } });
          S.layout.toolbarItems = order;
          S.layout.hiddenToolbarItems = [...hid];
          render_();
        });
        item.append(eye);
      } else item.append(h('span', { class: 'faint small', text: t('luôn hiện') }));
      list.append(item);
    }
  };
  let drag = null;
  list.addEventListener('dragstart', (e) => {
    drag = e.target.closest('.tb-item')?.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    $$('.tb-item', list).forEach((n) => n.classList.remove('drop'));
    e.target.closest('.tb-item')?.classList.add('drop');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.tb-item')?.dataset.id;
    if (!drag || !target || drag === target) return;
    const order = $$('.tb-item', list).map((n) => n.dataset.id);
    order.splice(order.indexOf(drag), 1);
    order.splice(order.indexOf(target), 0, drag);
    S.layout.toolbarItems = order;
    api.invoke('settings:set', { layout: { toolbarItems: order } });
    render_();
  });
  render_();
  return bind(list, render_);
}

function layout() {
  const L = S.layout;
  const vertical = L.tabsPosition !== 'top';
  return [
    ...head(t('Bố cục'), t('Sắp xếp tab, thanh công cụ, thanh bên và khung trang theo cách bạn thích.')),
    h('div', { class: 'layout-pick' }, ...[['top', t('Tab ở trên')], ['left', t('Tab dọc bên trái')], ['right', t('Tab dọc bên phải')]].map(([v, l]) => {
      const b = h('button', { type: 'button', class: `lp lp-${v}`, html: `<span class="lp-mock"><i class="t"></i><i class="b"></i><i class="c"></i></span><span>${l}</span>` });
      b.addEventListener('click', () => {
        set('layout.tabsPosition', v);
        render();
      });
      return bind(b, () => b.classList.toggle('on', S.layout.tabsPosition === v));
    })),
    section_(
      row(t('Thanh công cụ'), '', seg('layout.toolbarPosition', [['top', t('Trên')], ['bottom', t('Dưới')]])),
      vertical ? row(t('Độ rộng cột tab'), '', range('layout.verticalTabsWidth', 180, 400, 4, fmt.px)) : null,
      vertical ? row(t('Thu gọn cột tab'), '', sw('layout.verticalTabsCollapsed')) : null,
      row(t('Thanh dấu trang'), '', seg('layout.bookmarksBar', [['always', t('Luôn hiện')], ['newtab', t('Chỉ ở trang Tab mới')], ['off', t('Tắt')]])),
      row(t('Nút đóng tab'), '', seg('layout.tabCloseButton', [['hover', t('Khi rê chuột')], ['always', t('Luôn hiện')]])),
      row(t('Bong bóng địa chỉ liên kết'), '', sw('layout.showStatusBubble'))
    ),
    stitle(t('Khung trang web')),
    section_(
      row(t('Khoảng cách viền'), '', range('layout.contentInset', 0, 28, 1, fmt.px)),
      row(t('Bo góc khung trang'), '', range('layout.contentRadius', 0, 28, 1, fmt.px)),
      row(t('Đổ bóng khung trang'), '', sw('layout.contentShadow'))
    ),
    stitle(t('Thanh bên')),
    section_(
      row(t('Vị trí'), '', seg('layout.sidebarPosition', [['left', t('Trái')], ['right', t('Phải')]])),
      row(t('Độ rộng'), '', range('layout.sidebarWidth', 240, 720, 10, fmt.px)),
      row(t('Hiện thanh bên'), '', sw('layout.sidebarOpen'))
    ),
    stitle(t('Nút trên thanh công cụ')),
    toolbarEditor(),
  ];
}

function newtab() {
  return [
    ...head(t('Trang tab mới'), t('Trang hiện ra mỗi khi bạn mở tab mới.')),
    section_(
      row(t('Tên của bạn'), '', text('general.userName', 'VD: Kyon')),
      row(t('Đồng hồ'), '', sw('newtab.showClock')),
      row(t('Định dạng 24 giờ'), '', sw('newtab.clock24h')),
      row(t('Hiện giây'), '', sw('newtab.showSeconds')),
      row(t('Lời chào'), '', sw('newtab.showGreeting')),
      row(t('Nội dung lời chào'), '', text('newtab.greetingText', t('Theo giờ trong ngày'), { width: 300 })),
      row(t('Nền kính sau đồng hồ'), '', sw('newtab.heroGlass')),
      row(t('Cả khi không ẩn thanh tìm kiếm'), '', sw('newtab.heroGlassMid')),
      row(t('Ô tìm kiếm'), '', sw('newtab.showSearch')),
      row(t('Tên hình nền'), '', sw('newtab.showCredit')),
      row(t('Ẩn thanh tìm kiếm và lối tắt'), '', sw('newtab.hideTools'))
    ),
    stitle(t('Lối tắt')),
    section_(
      row(t('Hiện lối tắt (speed dial)'), '', sw('newtab.showSpeedDial')),
      row(t('Số cột'), '', range('newtab.speedDialColumns', 3, 10, 1, (v) => t('{0} cột', v)))
    ),
    stitle(t('Anime hôm nay')),
    section_(
      row(t('Gợi ý một anime 2000–2010 mỗi ngày'), '', sw('newtab.showAnime')),
      row(t('Thể loại'), '', select('newtab.animeGenre', [['Slice of Life', 'Slice of Life'], ['Romance', 'Romance'], ['Comedy', 'Comedy'], ['Drama', 'Drama'], ['Action', 'Action'], ['Mecha', 'Mecha'], ['Sci-Fi', 'Sci-Fi'], ['Fantasy', 'Fantasy'], ['Mystery', 'Mystery'], ['Music', 'Music'], ['all', t('Tất cả')]]))
    ),
  ];
}

function general() {
  const g = S.general;
  const engineOptions = Object.entries(engines).map(([k, v]) => [k, v.name]);
  const dirLabel = h('span', { class: 'muted dir-label' });
  bind(dirLabel, () => (dirLabel.textContent = S.general.downloadDir || t('Thư mục Downloads mặc định')));
  return [
    ...head(t('Chung'), t('Khởi động, tìm kiếm, tab và tải xuống.')),
    section_(
      // (each language in its own words; TyranWeb starts again in the new one, its tabs kept)
      row(t('Ngôn ngữ'), '', select('general.language', LANGS.map(([code, name]) => [code, name]))),
      row(t('Khi mở TyranWeb'), '', seg('general.startup', [['restore', t('Mở lại tab cũ')], ['newtab', t('Tab mới')], ['home', t('Trang chủ')]])),
      row(t('Trang chủ'), '', text('general.homepage', 'tyran://newtab', { validate: (v) => /^(https?|tyran):\/\//.test(v) })),
      row(t('Công cụ tìm kiếm'), '', select('general.searchEngine', engineOptions, () => render())),
      g.searchEngine === 'custom' ? row(t('URL tìm kiếm tùy chỉnh'), '', text('general.customSearchUrl', 'https://example.com/?q=%s', { width: 320, validate: (v) => v.includes('%s') })) : null,
      row(t('Gợi ý khi gõ'), '', sw('general.searchSuggestions'))
    ),
    stitle(t('Tab')),
    section_(
      row(t('Mở tab mới'), '', seg('general.newTabPosition', [['afterActive', t('Cạnh tab hiện tại')], ['end', t('Cuối danh sách')]])),
      row(t('Cho tab ngủ sau'), '', select('general.tabSleepMinutes', [[0, t('Không bao giờ')], [5, t('5 phút')], [10, t('10 phút')], [15, t('15 phút')], [30, t('30 phút')], [60, t('1 giờ')], [120, t('2 giờ')]]))
    ),
    stitle(t('Tải xuống')),
    section_(
      row(t('Lưu vào'), '', dirLabel, button(t('Đổi…'), async () => {
        const d = await api.invoke('downloads:pickDir');
        if (d) set('general.downloadDir', d).then(refresh);
      }, { cls: 'small' })),
      row(t('Hỏi nơi lưu mỗi lần tải'), '', sw('general.askDownloadLocation'))
    ),
    stitle(t('Khác')),
    section_(row(t('Cuộn mượt'), '', sw('general.smoothScrolling'))),
  ];
}

// The ad-block engine: Ghostery's lists, Brave's lists, or Brave's engine itself, built on this
// computer the first time it is picked, after a warning of what that takes (main/brave-build.js).
const BRAVE_STAGES = {
  rustup: t('Đang tải trình biên dịch Rust…'),
  toolchain: t('Đang cài trình biên dịch Rust…'),
  source: t('Đang tải mã nguồn bộ máy của Brave…'),
  compile: t('Đang biên dịch bộ máy của Brave…'),
  lists: t('Đang tải danh sách lọc của Brave…'),
  cleanup: t('Đang dọn tệp tạm…'),
};
const BRAVE_DOWNLOAD_MB = 400;
let brave = { installed: false, building: false, stage: '', pct: 0 };
let paintBrave = () => {};
api.on('adblock:braveProgress', async (p) => {
  if (p.finished) brave = await api.invoke('adblock:brave').catch(() => ({ ...brave, building: false }));
  else Object.assign(brave, p, { building: true });
  paintBrave();
});

function adblockEngine() {
  const el = seg('privacy.adblockEngine', [['ghostery', t('Thông thường')], ['brave', 'Brave'], ['brave-full', t('Brave đầy đủ')]]);
  const full = [...el.querySelectorAll('button')].find((b) => b._value === 'brave-full');
  const wrap = h('span', { class: 'ask-wrap' }, el);
  const stop = button(t('Huỷ'), () => api.invoke('adblock:braveCancel'), { cls: 'small ghost' });
  const r = row(t('Bộ lọc quảng cáo'), '', wrap, stop);
  const desc = h('span');
  r.querySelector('.row-text').append(desc);
  paintBrave = () => {
    if (!r.isConnected) return;
    desc.textContent = brave.building ? `${BRAVE_STAGES[brave.stage] || ''} ${brave.pct}%` : '';
    desc.hidden = stop.hidden = !brave.building;
  };
  paintBrave();
  api.invoke('adblock:brave').then((s) => ((brave = s), paintBrave()), () => {});

  let ask = null;
  const close = () => {
    ask?.remove();
    ask = null;
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => ask && !wrap.contains(e.target) && close();
  const go = async () => {
    close();
    Object.assign(brave, { building: true, stage: 'rustup', pct: 0 });
    paintBrave();
    try {
      await api.invoke('adblock:braveInstall');
      toast(t('Đã bật bộ máy chặn quảng cáo của Brave ✿'));
    } catch (err) {
      const msg = errText(err);
      if (msg !== t('Đã hủy')) toast(msg);
    }
  };
  // (before the button's own handler, which would switch at once)
  full.addEventListener(
    'click',
    (e) => {
      if (brave.installed) return;
      e.stopImmediatePropagation();
      if (brave.building) return;
      if (ask) return close();
      ask = h(
        'div',
        { class: 'labs-ask' },
        h('p', { text: t('Chế độ này cần tải và tự biên dịch đúng bộ máy chặn quảng cáo của Brave (adblock-rust) trên máy. Sẽ tải khoảng {0} MB và có thể tạm chiếm tới {1} GB ổ đĩa, mất khoảng 5–15 phút. Xong việc, các tệp tạm tự xoá, chỉ giữ lại khoảng {2} MB.', BRAVE_DOWNLOAD_MB, 2, 25) }),
        h('div', { class: 'labs-btns' }, button(t('Huỷ'), close, { cls: 'small ghost' }), button(t('Tải về'), go, { cls: 'small primary', ic: 'download' }))
      );
      wrap.append(ask);
      document.addEventListener('pointerdown', outside, true);
    },
    true
  );
  return r;
}

const PERM_NAMES = { media: 'Camera/micro', geolocation: t('Vị trí'), notifications: t('Thông báo'), midi: 'MIDI', midiSysex: 'MIDI', 'clipboard-read': t('Đọc clipboard'), 'idle-detection': t('Phát hiện rảnh'), 'storage-access': t('Cookie nhúng'), 'top-level-storage-access': t('Cookie nhúng'), 'speaker-selection': t('Chọn loa'), 'window-management': t('Quản lý cửa sổ') };

function privacy() {
  const boxes = {
    history: h('input', { type: 'checkbox', checked: true }),
    cookies: h('input', { type: 'checkbox' }),
    cache: h('input', { type: 'checkbox', checked: true }),
    downloads: h('input', { type: 'checkbox' }),
  };
  const labels = { history: t('Lịch sử duyệt web'), cookies: t('Cookie & dữ liệu trang (đăng xuất khỏi các trang)'), cache: t('Ảnh & tệp đã lưu trong bộ nhớ đệm'), downloads: t('Danh sách tải xuống') };
  const perms = Object.entries(S.sitePermissions || {}).filter(([, v]) => v && Object.keys(v).length);
  return [
    ...head(t('Quyền riêng tư & bảo mật'), t('Chặn quảng cáo, theo dõi và quản lý dữ liệu duyệt web.')),
    section_(
      row(t('Chặn quảng cáo & trình theo dõi'), '', sw('privacy.adblock')),
      adblockEngine(),
      row(t('Gửi tín hiệu “Không theo dõi”'), '', sw('privacy.doNotTrack')),
      row(t('Chặn cookie bên thứ ba'), '', sw('privacy.blockThirdPartyCookies')),
      row(t('Chỉ dùng HTTPS'), '', sw('privacy.httpsOnly')),
      row(t('Xóa dữ liệu khi thoát'), '', sw('privacy.clearOnExit'))
    ),
    stitle(t('Xóa dữ liệu duyệt web')),
    h(
      'div',
      { class: 'section clear-box' },
      ...Object.entries(boxes).map(([k, el]) => h('label', { class: 'check-row' }, el, h('span', { text: labels[k] }))),
      h('div', { class: 'clear-actions' }, button(t('Xóa dữ liệu'), async () => {
        const opts = Object.fromEntries(Object.entries(boxes).map(([k, el]) => [k, el.checked]));
        await api.invoke('data:clear', opts);
        toast(t('Đã xóa dữ liệu ✿'));
      }, { ic: 'trash', cls: 'primary' }))
    ),
    stitle(t('Quyền đã cấp cho trang web')),
    perms.length
      ? h('div', { class: 'section' }, ...perms.map(([origin, p]) => row(hostOf(origin) || origin, Object.entries(p).map(([k, v]) => `${PERM_NAMES[k] || k}: ${v === 'allow' ? t('cho phép') : t('chặn')}`).join(' · '), button(t('Đặt lại'), async () => {
          await api.invoke('perm:reset', origin);
          delete S.sitePermissions[origin];
          render();
        }, { cls: 'small' }))))
      : h('p', { class: 'muted', text: t('Chưa có trang nào được cấp hoặc bị chặn quyền.') }),
  ];
}

// ---------------------------------------------------------------- shortcuts
function toAccelerator(e) {
  const CODE = { Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Insert: 'Insert', Delete: 'Delete', NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract', Numpad0: 'Numpad0' };
  const c = e.code || '';
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c : CODE[c];
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return null;
  return [...mods, key].join('+');
}

function shortcutsSection() {
  const list = h('div', { class: 'section sc-list' });
  const filter = h('input', { type: 'search', class: 'input search-big', placeholder: t('Tìm lệnh…') });
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    list.innerHTML = '';
    for (const [id, def] of Object.entries(shortcuts)) {
      if (q && !def.label.toLowerCase().includes(q) && !def.keys.join(' ').toLowerCase().includes(q)) continue;
      const changed = JSON.stringify(def.keys) !== JSON.stringify(def.defaultKeys);
      const keys = h('span', { class: 'sc-keys', html: def.keys.length ? def.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('') : '<span class="faint">—</span>' });
      const rec = button(t('Đổi'), () => record(id, keys), { cls: 'small' });
      const reset = changed ? button(t('Mặc định'), () => saveKeys(id, def.defaultKeys), { cls: 'small ghost' }) : null;
      list.append(row(def.label, '', keys, reset, rec));
    }
  };
  filter.addEventListener('input', draw);
  draw();
  return [
    ...head(t('Phím tắt'), t('Bấm “Đổi” rồi nhấn tổ hợp phím mới. Esc để hủy, Backspace để xóa phím tắt.')),
    h('div', { class: 'toolbar-row' }, filter, button(t('Khôi phục tất cả'), () => api.invoke('settings:reset', 'shortcuts'), { ic: 'reload' })),
    list,
  ];
}

function saveKeys(id, keys) {
  const all = { ...(S.shortcuts || {}) };
  all[id] = keys;
  set('shortcuts', all);
}

function record(id, keysEl) {
  keysEl.innerHTML = t('<span class="recording">Nhấn tổ hợp phím…</span>');
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    window.removeEventListener('keydown', onKey, true);
    if (e.key === 'Escape') return render();
    if (e.key === 'Backspace') return saveKeys(id, []);
    const acc = toAccelerator(e);
    if (!acc) return render();
    const clash = Object.entries(shortcuts).find(([other, d]) => other !== id && d.keys.includes(acc));
    if (clash) toast(t('{0} đang dùng cho “{1}” — đã gỡ khỏi lệnh đó', acc, clash[1].label));
    if (clash) {
      const all = { ...(S.shortcuts || {}) };
      all[clash[0]] = clash[1].keys.filter((k) => k !== acc);
      all[id] = [acc];
      set('shortcuts', all);
    } else saveKeys(id, [acc]);
  };
  window.addEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------- custom CSS
const SNIPPETS = [
  [t('Ẩn nút đóng tab'), '.tab-close { display: none !important; }'],
  [t('Thanh địa chỉ vuông vức'), '.omnibox { border-radius: 6px !important; }'],
  [t('Tab cao hơn'), ':root { --tab-h: 38px !important; }'],
  [t('URL dạng chữ đơn cách'), '.omni-input, .omni-display { font-family: Consolas, monospace !important; }'],
  [t('Viền phát sáng màu nhấn quanh trang'), '#views { box-shadow: 0 0 0 2px var(--accent), 0 0 30px rgba(var(--accent-rgb), .45) !important; }'],
  [t('Tab đang chọn tô màu nhấn'), '.tab.active { background: var(--accent) !important; color: var(--on-accent) !important; }'],
];

function cssSection() {
  const area = h('textarea', { class: 'css-area', spellcheck: 'false', placeholder: t('/* CSS áp dụng cho giao diện trình duyệt (thanh tab, thanh công cụ, menu…) */') });
  const save = debounce(() => set('appearance.customCSS', area.value), 350);
  area.addEventListener('input', save);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const p = area.selectionStart;
      area.setRangeText('  ', p, area.selectionEnd, 'end');
      save();
    }
  });
  bind(area, () => (area.value = S.appearance.customCSS || ''));
  const chips = h('div', { class: 'chips' });
  for (const [label, css] of SNIPPETS) {
    const b = h('button', { type: 'button', class: 'chip', html: `${icon('plus', 12)} ${esc(label)}` });
    b.addEventListener('click', () => {
      area.value = (area.value.trim() ? area.value.trimEnd() + '\n\n' : '') + `/* ${label} */\n${css}\n`;
      save();
    });
    chips.append(b);
  }
  return [
    ...head(t('CSS tùy chỉnh'), t('Tự do tối đa: viết CSS để thay đổi bất cứ thứ gì trên giao diện trình duyệt. Áp dụng ngay khi gõ.')),
    chips,
    area,
    h('div', { class: 'toolbar-row' }, button(t('Mở DevTools của giao diện'), () => host('command', 'ui.devtools'), { ic: 'terminal' }), h('span', { class: 'grow' }), button(t('Xóa hết'), () => ((area.value = ''), save()), { cls: 'ghost danger' })),
  ];
}

// ---------------------------------------------------------------- about
// Where TyranWeb's data is, and moving all of it elsewhere (not the browser's sign-ins): its path
// shows the copying as it goes; the app restarts when it is done.
function dataRow() {
  const r = row(
    t('Thư mục dữ liệu'),
    info.userData || '',
    button(t('Mở'), () => api.invoke('app:openPath', 'userData'), { cls: 'small', ic: 'folder' }),
    confirmButton(t('Chuyển chỗ…'), t('Chọn nơi mới (app sẽ khởi động lại)'), async () => {
      try {
        await api.invoke('data:move');
      } catch (err) {
        toast(errText(err) || t('Không chuyển được'));
        desc.textContent = info.userData || '';
      }
    })
  );
  let desc = r.querySelector('.row-text span');
  if (!desc) r.querySelector('.row-text').append((desc = h('span', { text: '' })));
  api.on('data:progress', (p) => {
    if (!r.isConnected) return;
    const gb = (n) => (n / 1e9).toFixed(n < 1e9 ? 2 : 1);
    desc.textContent = p.finished ? t('Đã chép xong, đang khởi động lại…') : t('Đang chép… {0}% ({1} / {2} GB)', Math.floor((100 * p.done) / Math.max(1, p.total)), gb(p.done), gb(p.total));
  });
  return r;
}

// TyranWeb's updates from GitHub (main/updates.js): where they stand, and the step that comes next
let upd = null;
let paintUpdate = () => {};
api.on('update:state', (u) => {
  upd = u;
  paintUpdate();
});
function updateRow() {
  const desc = h('span');
  const btn = h('button', { type: 'button', class: 'btn small' });
  const r = row(t('Cập nhật'), '', btn);
  r.querySelector('.row-text').append(desc);
  paintUpdate = () => {
    if (!r.isConnected) return;
    const u = upd || {};
    const [text, label, step] =
      u.stage === 'checking'
        ? [t('Đang kiểm tra…'), '', '']
        : u.stage === 'available'
          ? [t('Có bản {0} mới', u.latest) + (u.error ? ` · ${u.error}` : ''), t('Tải bản {0}', u.latest), 'update:download']
          : u.stage === 'downloading'
            ? [t('Đang tải bản {0}… {1}%', u.latest, u.pct), '', '']
            : u.stage === 'ready'
              ? [t('Đã tải xong bản {0}', u.latest), t('Khởi động lại để cập nhật'), 'update:install']
              : u.stage === 'latest'
                ? [t('Đang dùng bản mới nhất'), t('Kiểm tra'), 'update:check']
                : u.stage === 'error'
                  ? [t('Không kiểm tra được ({0})', u.error), t('Kiểm tra'), 'update:check']
                  : ['', t('Kiểm tra'), 'update:check'];
    desc.textContent = text;
    desc.hidden = !text;
    btn.textContent = label;
    btn.hidden = !step;
    btn.onclick = step ? () => api.invoke(step).catch((err) => toast(errText(err) || t('Không cập nhật được'))) : null;
  };
  api.invoke('update:status').then((u) => ((upd = u), paintUpdate()), () => {});
  paintUpdate();
  return r;
}

// a backup of TyranWeb's data (main/backup.js): where it went, once made
function backupRow() {
  const desc = h('span');
  const r = row(t('Sao lưu dữ liệu'), '', button(t('Sao lưu…'), async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    desc.textContent = t('Đang sao lưu…');
    try {
      const file = await api.invoke('backup:make');
      desc.textContent = file || '';
      if (file) toast(t('Đã sao lưu ✿'));
    } catch (err) {
      desc.textContent = '';
      toast(errText(err) || t('Không sao lưu được'));
    } finally {
      b.disabled = false;
    }
  }, { cls: 'small', ic: 'save' }));
  r.querySelector('.row-text').append(desc);
  return r;
}

function about() {
  const credits = h('div', { class: 'list credits' });
  for (const w of wallpapers.bundled) {
    const item = h('div', { class: 'list-item' });
    item.innerHTML = `<img class="credit-thumb" src="${esc(w.thumb)}" alt=""><span class="li-text"><span class="li-title">${esc(w.anime)} (${esc(w.year)})</span><span class="li-sub">${t('Wallhaven · tải lên')} ${esc(w.uploaded)}${w.source ? t(' · nguồn gốc: ') + esc(hostOf(w.source)) : ''}</span></span>`;
    item.addEventListener('click', () => openUrl(w.wallhaven, true));
    credits.append(item);
  }
  return [
    h('div', { class: 'about-hero' }, h('img', { src: 'tyran://shared/logo.svg', alt: '' }), h('div', {}, h('h1', { class: 'page-title', text: 'TyranWeb' }), h('p', { class: 'muted', text: t('Phiên bản {0} · Electron {1} · Chromium {2}', info.version, info.electron, info.chrome) }))),
    section_(
      dataRow(),
      row(t('Ảnh chụp màn hình'), '', button(t('Mở'), () => api.invoke('app:openPath', 'screenshots'), { cls: 'small', ic: 'folder' })),
      row(t('Khôi phục toàn bộ cài đặt'), '', confirmButton(t('Khôi phục'), t('Bấm lần nữa để xác nhận'), () => api.invoke('settings:reset')))
    ),
    stitle(t('Cập nhật')),
    section_(updateRow(), row(t('Tự kiểm tra bản mới'), '', sw('general.checkUpdates'))),
    stitle(t('Sao lưu')),
    section_(backupRow(), row(t('Kèm ảnh, video, nhạc đã thêm'), '', sw('general.backupMedia')), row(t('Khôi phục từ bản sao lưu'), '', confirmButton(t('Khôi phục…'), t('Bấm lần nữa để chọn file'), () => api.invoke('backup:restore').catch((err) => toast(errText(err) || t('Không khôi phục được')))))),
    stitle(t('Nguồn ảnh nền')),
    credits,
  ];
}

// ---------------------------------------------------------------- navigation & render
function buildNav() {
  const nav = $('#nav');
  for (const [id, label, ic] of SECTIONS) {
    const a = h('a', { class: 'nav-item', href: `#${id}`, dataset: { id }, html: `${icon(ic, 17)}<span>${esc(label)}</span>` });
    nav.append(a);
  }
  $('#find').addEventListener('input', debounce(render, 120));
}

function render() {
  const main = $('#main');
  const q = $('#find').value.trim().toLowerCase();
  bindings = [];
  main.innerHTML = '';
  $$('.nav-item').forEach((n) => n.classList.toggle('on', !q && n.dataset.id === section));
  if (q) {
    for (const [id, label, , fn] of SECTIONS) {
      if (id === 'about' || id === 'css') continue;
      const wrap = h('div', { class: 'search-group' }, h('div', { class: 'section-title', text: label }));
      const nodes = fn().filter(Boolean);
      for (const n of nodes) {
        if (!(n instanceof Node)) continue;
        $$('.row', n).forEach((r) => !r.dataset.search?.toLowerCase().includes(q) && r.remove());
        if ($$('.row', n).length) wrap.append(n);
      }
      if (wrap.children.length > 1) main.append(wrap);
    }
    if (!main.children.length) main.append(h('div', { class: 'empty', html: t('<span class="kao">(・_・;)</span>Không tìm thấy cài đặt nào') }));
    return;
  }
  const def = SECTIONS.find((s) => s[0] === section) || SECTIONS[0];
  for (const n of def[3]()) if (n) main.append(n);
  main.scrollTop = 0;
}

function route() {
  const id = location.hash.slice(1);
  section = SECTIONS.some((s) => s[0] === id) ? id : 'appearance';
  $('#find').value = '';
  render();
  window.scrollTo(0, 0);
}

S = await boot();
[wallpapers, shortcuts, engines, info] = await Promise.all([api.invoke('wallpapers:list'), api.invoke('shortcuts:get'), api.invoke('search:engines'), api.invoke('app:info')]);
buildNav();
window.addEventListener('hashchange', route);
// X (or Esc outside a text field) closes Settings and goes back to the previous tab
const closePage = () => host('command', 'tab.close');
$('#close-page').addEventListener('click', closePage);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  closePage();
});
route();

let structure = '';
onSettings((s) => {
  S = s;
  for (const [path, value] of pending) put(S, path, value); // (still on their way: see set())
  // re-render when a setting that changes which controls exist was changed elsewhere
  const key = JSON.stringify([s.wallpaper.type, s.wallpaper.web?.preset, s.layout.tabsPosition, s.general.searchEngine, !!s.general.labsUnlocked]);
  if (structure && key !== structure) render();
  else refresh();
  structure = key;
});
api.on('extensions:changed', () => section === 'extensions' && render());
api.on('wallpapers:changed', async () => {
  await loadWallpapers();
  if (section === 'wallpaper') render();
});
api.on('shortcuts:changed', (sc) => {
  shortcuts = sc;
  if (section === 'shortcuts') render();
});
