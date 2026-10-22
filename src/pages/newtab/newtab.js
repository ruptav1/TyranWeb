import { api, boot, onSettings, h, $, esc, hostOf, host, openUrl } from 'tyran://shared/page.js';
import { icon } from 'tyran://shared/icons.js';
import { t, LANG } from 'tyran://shared/i18n.js';

let S = null;
const DAYS = [t('Chủ nhật'), t('Thứ hai'), t('Thứ ba'), t('Thứ tư'), t('Thứ năm'), t('Thứ sáu'), t('Thứ bảy')];

// ---------------------------------------------------------------- clock & greeting
let clockTimer;
function tick() {
  const n = S.newtab;
  const d = new Date();
  let hh = d.getHours();
  let suffix = '';
  if (!n.clock24h) {
    suffix = hh >= 12 ? ' PM' : ' AM';
    hh = hh % 12 || 12;
  }
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  $('#clock').innerHTML = `${String(hh).padStart(2, '0')}:${mm}${n.showSeconds ? `<span class="sec">${ss}</span>` : ''}${suffix ? `<span class="sec">${suffix}</span>` : ''}`;
  $('#date').textContent = t('{0}, {1} tháng {2}, {3}', DAYS[d.getDay()], d.getDate(), d.getMonth() + 1, d.getFullYear());
  const h24 = d.getHours();
  const [vi, jp] =
    h24 >= 5 && h24 < 11 ? [t('Chào buổi sáng'), 'おはよう'] :
    h24 < 13 && h24 >= 11 ? [t('Chào buổi trưa'), 'こんにちは'] :
    h24 >= 13 && h24 < 18 ? [t('Chào buổi chiều'), 'こんにちは'] :
    h24 >= 18 && h24 < 23 ? [t('Chào buổi tối'), 'こんばんは'] : [t('Khuya rồi, nghỉ sớm nhé'), 'おやすみ'];
  const name = S.general.userName?.trim();
  $('#greeting').innerHTML = `${esc(vi)}${name ? `, ${esc(name)}` : ''} ✿${LANG === 'ja' ? '' : `<span class="jp">${jp}</span>`}`; // (the Japanese echo, unless it is the language)
  clearTimeout(clockTimer);
  clockTimer = setTimeout(tick, n.showSeconds ? 1000 - d.getMilliseconds() : (60 - d.getSeconds()) * 1000);
}

// ---------------------------------------------------------------- search
function setupSearch() {
  const q = $('#q');
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    if (q.value.trim()) host('search', q.value.trim());
  });
}

// ---------------------------------------------------------------- speed dial
const favicon = (url) => `https://${new URL(url).host}/favicon.ico`;

function saveDial(list) {
  S.newtab.speedDial = list;
  api.invoke('settings:set', { newtab: { speedDial: list } });
}

function renderDial() {
  const box = $('#dial');
  box.hidden = !S.newtab.showSpeedDial;
  box.style.setProperty('--cols', String(Math.max(3, Math.min(10, S.newtab.speedDialColumns || 6))));
  box.innerHTML = '';
  S.newtab.speedDial.forEach((d, i) => {
    const letter = esc((hostOf(d.url) || d.title || '?').charAt(0).toUpperCase());
    const tile = h('a', { class: 'tile', href: d.url, draggable: 'true', dataset: { i: String(i) }, title: `${d.title}\n${d.url}` });
    tile.innerHTML = `<span class="tile-ico"><img class="favicon" src="${esc(favicon(d.url))}" alt="" data-letter="${letter}"></span><span class="tile-name">${esc(d.title || hostOf(d.url))}</span>`;
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      tileMenu(i, e.clientX, e.clientY);
    });
    box.append(tile);
  });
  const add = h('button', { class: 'tile add', title: t('Thêm lối tắt'), html: `<span class="tile-ico">${icon('plus', 20)}</span><span class="tile-name">${t('Thêm')}</span>` });
  add.addEventListener('click', () => editTile(-1));
  box.append(add);
}

function setupDialDrag() {
  const box = $('#dial');
  let from = -1;
  box.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.tile[data-i]');
    if (!t) return;
    from = Number(t.dataset.i);
    t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  box.addEventListener('dragover', (e) => {
    if (from < 0) return;
    e.preventDefault();
    box.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
    e.target.closest('.tile[data-i]')?.classList.add('drop');
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = e.target.closest('.tile[data-i]');
    if (t && from >= 0) {
      const list = [...S.newtab.speedDial];
      const [item] = list.splice(from, 1);
      list.splice(Number(t.dataset.i), 0, item);
      saveDial(list);
      renderDial();
    }
    from = -1;
  });
  box.addEventListener('dragend', () => {
    from = -1;
    box.querySelectorAll('.drop, .dragging').forEach((n) => n.classList.remove('drop', 'dragging'));
  });
}

function closeCtx() {
  document.querySelector('.ctx')?.remove();
  document.querySelector('.ctx-scrim')?.remove();
}

function tileMenu(i, x, y) {
  closeCtx();
  const d = S.newtab.speedDial[i];
  const scrim = h('div', { class: 'ctx-scrim', style: { position: 'fixed', inset: '0' } });
  scrim.addEventListener('pointerdown', closeCtx);
  const item = (ic, label, fn, danger) => h('button', { class: `menu-item${danger ? ' danger' : ''}`, html: `${icon(ic, 16)}<span class="label">${label}</span>`, onclick: () => (closeCtx(), fn()) });
  const menu = h(
    'div',
    { class: 'menu ctx', style: { left: `${x}px`, top: `${y}px` } },
    item('external', t('Mở trong tab mới'), () => openUrl(d.url, true)),
    item('edit', t('Sửa…'), () => editTile(i)),
    h('div', { class: 'menu-sep' }),
    item('trash', t('Xóa'), () => {
      saveDial(S.newtab.speedDial.filter((_, k) => k !== i));
      renderDial();
    }, true)
  );
  document.body.append(scrim, menu);
}

function editTile(i) {
  const d = i >= 0 ? S.newtab.speedDial[i] : { title: '', url: 'https://' };
  const title = h('input', { type: 'text', class: 'input', placeholder: t('Tên'), value: d.title });
  const url = h('input', { type: 'text', class: 'input', placeholder: 'https://…', value: d.url });
  const close = () => scrim.remove();
  const form = h(
    'form',
    { class: 'dlg' },
    h('b', { text: i >= 0 ? t('Sửa lối tắt') : t('Thêm lối tắt') }),
    title,
    url,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn ghost', text: t('Hủy'), onclick: close }), h('button', { type: 'submit', class: 'btn primary', text: t('Lưu') }))
  );
  const scrim = h('div', { class: 'dlg-scrim' }, form);
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let u = url.value.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    try {
      new URL(u);
    } catch {
      url.focus();
      return;
    }
    const item = { title: title.value.trim() || hostOf(u), url: u };
    const list = [...S.newtab.speedDial];
    if (i >= 0) list[i] = item;
    else list.push(item);
    saveDial(list);
    renderDial();
    close();
  });
  document.body.append(scrim);
  (i >= 0 ? title : url).focus();
}

// ---------------------------------------------------------------- anime of the day
let animeKey = '';
async function renderAnime() {
  const box = $('#anime');
  const key = `${S.newtab.showAnime}|${S.newtab.animeGenre}`;
  if (key === animeKey) return;
  animeKey = key;
  if (!S.newtab.showAnime || sessionStorage.getItem('anime-hidden')) {
    box.hidden = true;
    return;
  }
  try {
    const a = await api.invoke('anime:today', S.newtab.animeGenre);
    const meta = [a.year, a.studio, a.episodes ? t('{0} tập', a.episodes) : '', a.score ? `★ ${(a.score / 10).toFixed(1)}` : ''].filter(Boolean).join(' · ');
    box.innerHTML = `
      <img class="an-cover" src="${esc(a.cover)}" alt="">
      <div class="an-body">
        <span class="an-label">${t('Anime hôm nay ·')} ${esc(a.year)}</span>
        <span class="an-title" title="${esc(a.native || '')}">${esc(a.title)}</span>
        <span class="an-meta">${esc(meta)}</span>
        <span class="an-genres">${a.genres.slice(0, 4).map((g) => `<span>${esc(g)}</span>`).join('')}</span>
        <span class="an-desc">${esc(a.description)}</span>
      </div>
      <button class="icon-btn an-close" title="${t('Ẩn')}">${icon('x', 14)}</button>`;
    box.querySelector('.an-title').onclick = () => openUrl(a.url, true);
    box.querySelector('.an-cover').onclick = () => openUrl(a.url, true);
    box.querySelector('.an-close').onclick = () => {
      sessionStorage.setItem('anime-hidden', '1');
      box.hidden = true;
    };
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

// ---------------------------------------------------------------- wallpaper credit
let wallpapers = null;
async function renderCredit() {
  const el = $('#credit');
  const w = S.wallpaper;
  if (!S.newtab.showCredit) return (el.innerHTML = '');
  if (w.type === 'web' && w.web?.preset === 'bluearchive') {
    el.innerHTML = `${icon('tv', 13)}<span>${w.web.baMode === 'normal' ? t('Hình nền: Blue Archive · Sảnh chính (© NEXON Games / Yostar)') : t('Hình nền: Blue Archive · Memorial Lobby (© NEXON Games / Yostar)')}</span>`;
    return;
  }
  if (w.type === 'web' && w.web?.preset === 'nikke') {
    const c = (await api.invoke('nikke:list').catch(() => [])).find((x) => x.id === (w.web.nikke || 'c010'));
    const o = c?.outfits.find((x) => x.id === w.web.nikkeOutfit && x.installed);
    el.innerHTML = `${icon('tv', 13)}<span>${t('Hình nền: GODDESS OF VICTORY: NIKKE ·')} ${esc(c ? c.name + (o ? ' · ' + o.name : '') : 'NIKKE')} (© SHIFT UP)</span>`;
    return;
  }
  if (w.type === 'web' && w.web?.preset === 'azurlane') {
    const list = await api.invoke('azur:list').catch(() => []);
    const c = list.find((x) => x.id === w.web.azur) || (!w.web.azur && list.find((x) => x.installed));
    const o = c?.outfits.find((x) => x.id === w.web.azurSkin && x.installed);
    el.innerHTML = `${icon('tv', 13)}<span>${t('Hình nền: Azur Lane ·')} ${esc(c ? c.name + ' · ' + (o ? o.name : c.look) : 'Azur Lane')} (© Manjuu / Yongshi / Yostar)</span>`;
    return;
  }
  if (w.type === 'web' && w.web?.preset === 'sekai') {
    const list = await api.invoke('sekai:list').catch(() => []);
    const c = list.find((x) => x.id === w.web.sekai) || (!w.web.sekai && list.find((x) => x.installed));
    const o = c?.outfits.find((x) => x.id === w.web.sekaiOutfit && x.installed);
    el.innerHTML = `${icon('tv', 13)}<span>${t('Hình nền: Project SEKAI ·')} ${esc(c ? c.name + ' · ' + (o ? o.name : c.look) : 'Project SEKAI')} (© SEGA / Colorful Palette / Crypton Future Media)</span>`;
    return;
  }
  if (w.type !== 'image') return (el.innerHTML = '');
  wallpapers ||= await api.invoke('wallpapers:list');
  const all = [...wallpapers.bundled, ...wallpapers.user];
  const hit = all.find((x) => x.url === w.image);
  if (!hit) return (el.innerHTML = '');
  const name = hit.anime ? `${hit.anime}${hit.year ? ` (${hit.year})` : ''}` : hit.title || t('Ảnh của bạn');
  const link = hit.wallhaven || hit.page;
  el.innerHTML = `${icon('image', 13)}<span>${t('Hình nền:')} ${link ? `<a href="${esc(link)}">${esc(name)}</a>` : esc(name)}</span>`;
  const a = el.querySelector('a');
  if (a) a.onclick = (e) => (e.preventDefault(), openUrl(link, true));
}

// ---------------------------------------------------------------- boot
S = await boot();
setupSearch();
setupDialDrag();
$('#lobby').onclick = () => host('command', 'wallpaper.lobby');
$('#zones').onclick = () => api.invoke('settings:set', { wallpaper: { web: { touchZones: !S.wallpaper.web?.touchZones } } });
$('#spectrum').onclick = () => api.invoke('settings:set', { newtab: { visualizer: !S.newtab.visualizer } });
$('#outfit').onclick = () => host('command', 'wallpaper.nikkeOutfit');
$('#face').onclick = () => host('command', 'wallpaper.nikkeFace');
$('#stance').onclick = () => api.invoke('settings:set', { wallpaper: { web: { nikkeStance: S.wallpaper.web?.nikkeStance === 'battle' ? 'lobby' : 'battle' } } });
// Blue Archive: the game's lobby button, between the chosen student's memorial lobby and her normal one
let baLobbies = null; // (the lobbies, once: which have a normal lobby)
$('#ba-mode').onclick = () => api.invoke('settings:set', { wallpaper: { web: { baMode: S.wallpaper.web?.baMode === 'normal' ? 'memorial' : 'normal' } } });
$('#customize').onclick = () => openUrl('tyran://settings/#appearance');
// hide / show the search bar and the shortcuts from the page itself (remembered like a setting)
$('#toggle-dial').addEventListener('click', () => api.invoke('settings:set', { newtab: { hideTools: !S.newtab.hideTools } }));

// ---------------------------------------------------------------- arranging
// "Sắp xếp": the clock, the search bar and the shortcuts can be dragged anywhere. Each state (tools
// shown / hidden) keeps its own places, saved as the block's centre in fractions of the page so they
// hold when the window is resized; blocks never placed keep their usual spot.
const BLOCKS = { hero: '#hero', search: '#search', dial: '#dial' };
const stateKey = () => (S.newtab.hideTools ? 'hidden' : 'shown');
let arranging = false;

function placeBlocks() {
  if (!S) return; // (not booted yet)
  const pos = S.newtab.positions?.[stateKey()] || {};
  for (const [name, sel] of Object.entries(BLOCKS)) {
    const el = $(sel);
    const p = pos[name];
    el.classList.toggle('placed', !!p);
    if (!p) {
      el.style.left = el.style.top = '';
      continue;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.round(Math.min(innerWidth - w, Math.max(0, p.x * innerWidth - w / 2)))}px`;
    el.style.top = `${Math.round(Math.min(innerHeight - h, Math.max(0, p.y * innerHeight - h / 2)))}px`;
  }
}
addEventListener('resize', () => placeBlocks());
// a block that changes size (the clock's text, the shortcuts redrawn) stays centred on its place
const sizes = new ResizeObserver(() => !drag && placeBlocks());
for (const sel of Object.values(BLOCKS)) sizes.observe($(sel));

const arrangeBar = h(
  'div',
  { id: 'arrange-bar', hidden: true },
  h('span', { text: t('Kéo các khối tới chỗ bạn muốn · bấm nút con mắt để sắp cho lúc ẩn / hiện công cụ') }),
  h('button', { type: 'button', class: 'glass-btn wide', text: t('Về mặc định'), onclick: () => api.invoke('settings:set', { newtab: { positions: { [stateKey()]: null } } }) }),
  h('button', { type: 'button', class: 'glass-btn wide primary', text: t('Xong'), onclick: () => setArranging(false) })
);
document.body.append(arrangeBar);

function setArranging(on) {
  arranging = on;
  document.documentElement.classList.toggle('arranging', on);
  arrangeBar.hidden = !on;
}
$('#arrange').addEventListener('click', () => setArranging(!arranging));

// dragging a block; near the page's middle lines it snaps onto them
let drag = null;
addEventListener(
  'pointerdown',
  (e) => {
    if (!arranging || e.button !== 0) return;
    const entry = Object.entries(BLOCKS).find(([, sel]) => e.target.closest(sel));
    if (!entry) return;
    const el = $(entry[1]);
    if (getComputedStyle(el).visibility === 'hidden') return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    drag = { name: entry[0], el, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    el.classList.add('placed', 'dragging');
    el.setPointerCapture(e.pointerId);
  },
  true
);
addEventListener('pointermove', (e) => {
  if (!drag) return;
  let x = e.clientX - drag.dx;
  let y = e.clientY - drag.dy;
  if (Math.abs(x + drag.w / 2 - innerWidth / 2) < 14) x = innerWidth / 2 - drag.w / 2;
  if (Math.abs(y + drag.h / 2 - innerHeight / 2) < 14) y = innerHeight / 2 - drag.h / 2;
  x = Math.min(innerWidth - drag.w, Math.max(0, x));
  y = Math.min(innerHeight - drag.h, Math.max(0, y));
  drag.el.style.left = `${Math.round(x)}px`;
  drag.el.style.top = `${Math.round(y)}px`;
  drag.x = (x + drag.w / 2) / innerWidth;
  drag.y = (y + drag.h / 2) / innerHeight;
});
addEventListener('pointerup', () => {
  if (!drag) return;
  const { name, el, x, y } = drag;
  el.classList.remove('dragging');
  drag = null;
  if (x !== undefined) api.invoke('settings:set', { newtab: { positions: { [stateKey()]: { [name]: { x: +x.toFixed(4), y: +y.toFixed(4) } } } } });
});
// while arranging, clicks on the blocks only move them (no opening shortcuts, no glass toggle)
addEventListener(
  'click',
  (e) => {
    if (arranging && Object.values(BLOCKS).some((sel) => e.target.closest(sel))) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// The clock, date and greeting glide (and shrink) between the middle and the top-left corner:
// measured before and after the layout changes, then animated from the old place to the new:
// slow and smooth, easing all the way in without overshooting.
let booted = false;
function glideHero(change) {
  const el = $('#hero');
  const first = el.getBoundingClientRect();
  change();
  const last = el.getBoundingClientRect();
  // (played even with Windows animations off: it was asked for, and it is short)
  if (!first.width || !last.width) return;
  el.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width})` },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { duration: 1000, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
  );
}

// With the search bar and shortcuts hidden, the empty background belongs to the Blue Archive lobby
// on the wallpaper: presses there go on to the student (tap to talk, drag on her head to pat, drag
// elsewhere and she follows with her eyes). The browser passes them to the wallpaper.
const UI = 'button, a, input, select, textarea, label, [role="button"], [contenteditable], dialog, #hero';

// clicking the clock shows or hides the glass pane behind it (remembered): in the corner, or in the
// middle with the search bar and shortcuts shown
$('#hero').addEventListener('click', () => {
  const n = S.newtab;
  if (arranging) return;
  if (n.hideTools) api.invoke('settings:set', { newtab: { heroGlass: n.heroGlass === false } });
  else api.invoke('settings:set', { newtab: n.heroGlass !== false && n.heroGlassMid ? { heroGlassMid: false } : { heroGlass: true, heroGlassMid: true } });
});
const lobbyTouchable = () => !!S.newtab.hideTools && S.wallpaper.type === 'web' && ['bluearchive', 'nikke', 'azurlane', 'sekai'].includes(S.wallpaper.web?.preset);
// whole phrases per game, so each language can word them its own way
const TOUCH_HINT = {
  hidden: { nikke: t(' (đang ẩn: bấm vào nền để tương tác với nhân vật)'), sekai: t(' (đang ẩn: bấm vào nền để tương tác với nhân vật)'), azurlane: t(' (đang ẩn: bấm vào nền để tương tác với tàu)'), bluearchive: t(' (đang ẩn: bấm vào nền để tương tác với học sinh)') },
  then: { nikke: t(' (rồi bấm vào nền để tương tác với nhân vật)'), sekai: t(' (rồi bấm vào nền để tương tác với nhân vật)'), azurlane: t(' (rồi bấm vào nền để tương tác với tàu)'), bluearchive: t(' (rồi bấm vào nền để tương tác với học sinh)') },
};
const touchHint = (s, when) => TOUCH_HINT[when][s.wallpaper.web?.preset] || TOUCH_HINT[when].bluearchive;
// a downloaded character (NIKKE, Azur Lane, Project SEKAI): her game's channels and settings
const CHARS = { nikke: { api: 'nikke', who: 'nikke', first: 'c010' }, azurlane: { api: 'azur', who: 'azur', first: '' }, sekai: { api: 'sekai', who: 'sekai', first: '' } };
let touching = null;
const touch = (type, e) => host('lobby-touch', { type, x: e.clientX, y: e.clientY });
addEventListener('pointerdown', (e) => {
  if (arranging || e.button !== 0 || !e.isPrimary || !lobbyTouchable() || e.target.closest(UI)) return;
  e.preventDefault();
  touching = e.pointerId;
  document.documentElement.setPointerCapture(e.pointerId);
  touch('down', e);
});
addEventListener('pointermove', (e) => {
  if (e.pointerId === touching) touch('move', e);
});
const release = (e) => {
  if (e.pointerId !== touching) return;
  touching = null;
  touch('up', e);
};
addEventListener('pointerup', release);
addEventListener('pointercancel', release);

onSettings((s) => {
  S = s;
  const n = s.newtab;
  $('#clock-wrap').hidden = !n.showClock;
  $('#greeting').hidden = !n.showGreeting;
  $('#search').hidden = !n.showSearch;
  const engine = s.general.searchEngine;
  $('#engine').textContent = { google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo', brave: 'Brave', coccoc: t('Cốc Cốc'), custom: t('Tùy chỉnh') }[engine] || 'Google';
  $('#q').placeholder = t('Tìm kiếm hoặc nhập địa chỉ…');
  const hide = !!n.hideTools;
  if (hide !== document.documentElement.classList.contains('tools-hidden')) {
    const flip = () => {
      document.documentElement.classList.toggle('tools-hidden', hide);
      placeBlocks(); // (each state has its own places)
    };
    if (booted) glideHero(flip);
    else flip();
  }
  const toolsBtn = $('#toggle-dial');
  toolsBtn.innerHTML = icon(n.hideTools ? 'eye' : 'eyeOff', 16);
  document.documentElement.classList.toggle('lobby-touch', lobbyTouchable());
  // the lobby's touch areas, shown or not (only where they can be touched: tools hidden)
  const zonesBtn = $('#zones');
  zonesBtn.hidden = !lobbyTouchable();
  zonesBtn.classList.toggle('on', !!s.wallpaper.web?.touchZones);
  zonesBtn.title = s.wallpaper.web?.touchZones ? t('Ẩn vùng chạm') : t('Hiện vùng chạm');
  // the music's spectrum along the foot of the wallpaper
  $('#spectrum').classList.toggle('on', !!n.visualizer);
  $('#spectrum').title = n.visualizer ? t('Ẩn thanh nhạc') : t('Hiện thanh nhạc');
  // Blue Archive: memorial lobby (1/2) or normal lobby (2/2), for a student or outfit that has both
  const baBtn = $('#ba-mode');
  const ba = s.wallpaper.type === 'web' && s.wallpaper.web?.preset === 'bluearchive';
  const normal = ba && s.wallpaper.web.baMode === 'normal';
  baBtn.innerHTML = `${icon('cycle', 16)}<span>${normal ? '2/2' : '1/2'}</span>`;
  baBtn.title = normal ? t('Sảnh L2D') : t('Sảnh thường');
  if (!ba) baBtn.hidden = true;
  else (baLobbies ||= api.invoke('wallpapers:baModels')).then((list) => (baBtn.hidden = !list.find((m) => m.key === S.wallpaper.web?.model)?.normal), () => ((baBtn.hidden = true), (baLobbies = null)));
  // a NIKKE character: in the lobby or in battle
  const stanceBtn = $('#stance');
  const battle = s.wallpaper.web?.nikkeStance === 'battle';
  stanceBtn.hidden = !(lobbyTouchable() && s.wallpaper.web?.preset === 'nikke');
  stanceBtn.classList.toggle('on', battle);
  stanceBtn.title = battle ? t('Về sảnh') : t('Chiến đấu');
  const game = lobbyTouchable() && CHARS[s.wallpaper.web?.preset];
  $('#face').hidden = !game;
  // (outfits: only when she has another one downloaded)
  const nk = game && (s.wallpaper.web?.[game.who] || game.first);
  if (!game) $('#outfit').hidden = true;
  else
    api.invoke(game.api + ':list').then(
      (list) => ($('#outfit').hidden = !(list.find((c) => c.id === nk) || (!nk && list.find((c) => c.installed)))?.outfits?.some((o) => o.installed)),
      () => {}
    );
  document.documentElement.classList.toggle('hero-plain', n.heroGlass === false);
  const mid = !n.hideTools && n.heroGlass !== false && !!n.heroGlassMid;
  document.documentElement.classList.toggle('hero-mid', mid);
  document.documentElement.classList.toggle('hero-frost', s.appearance?.clearClock === false);
  const glass = n.hideTools ? n.heroGlass !== false : mid;
  $('#hero').title = glass ? t('Bấm để ẩn nền kính sau đồng hồ') : t('Bấm để hiện nền kính sau đồng hồ');
  toolsBtn.title = n.hideTools
    ? t('Hiện thanh tìm kiếm và lối tắt{0}', lobbyTouchable() ? touchHint(s, 'hidden') : '')
    : t('Ẩn thanh tìm kiếm và lối tắt{0}', s.wallpaper.type === 'web' && ['bluearchive', 'nikke', 'azurlane', 'sekai'].includes(s.wallpaper.web?.preset) ? touchHint(s, 'then') : '');
  tick();
  renderDial();
  renderAnime();
  renderCredit();
  placeBlocks(); // (once the clock and the shortcuts are drawn, at their real size)
  booted = true; // (the page opens already in place; later changes glide)
});
