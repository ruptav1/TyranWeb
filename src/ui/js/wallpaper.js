// The layer behind the browser: image / colour / gradient, a looping video, or a live web page
// (a <webview> in its own locked-down session). Lobby mode hides the browser so the wallpaper
// can be looked at and played with.
import { api, $, h, on, emit, NEWTAB } from './util.js';
import { S } from './state.js';
import { active } from './tabs.js';
import { toast } from './menus.js';
import { wallpaperStyle, frameCss, colorsOf, rgbToHsl, ownMusic } from 'tyran://shared/theme.js';
import { icon } from 'tyran://shared/icons.js';
import { addSpectrumSource } from './visualizer.js';
import { t } from 'tyran://shared/i18n.js';

const WALLPAPER_PARTITION = 'persist:tyran-wallpaper';

let current = { key: '', el: null, kind: '', wcId: 0, frozen: false };
let slideTimer = null;
let slideIndex = -1;
let slideOverride = null;
let swapSeq = 0;

// ---------------------------------------------------------------- apply
export function applyWallpaper(override) {
  setupSlideshow();
  const w = { ...S.settings.wallpaper };
  if (override) slideOverride = override;
  if (slideOverride && w.type === 'image') w.image = slideOverride;
  const st = wallpaperStyle(w, S.settings.appearance);
  const root = $('#wallpaper');
  const dim = $('#wallpaper-dim');
  dim.style.opacity = String(S.lobby ? 0 : st.dim);
  const bg = colorsOf(S.settings.appearance).bg;
  dim.style.background = bg;
  root.style.backgroundColor = w.type === 'mica' || w.type === 'acrylic' || w.type === 'transparent' ? 'transparent' : bg;

  // (a Blue Archive lobby kept aside belongs to the student shown)
  if (spare && !(w.type === 'web' && w.web?.preset === 'bluearchive' && w.web.model === spare.model)) dropSpare();
  const key = keyOf(w, st);
  if (key !== current.key) {
    current.key = key;
    if (spare && spare.key === key) useSpare(w, st);
    else swap(w, st);
  } else restyle(w);
  if (!switching) syncLive(w);
  if (w.web?.lobbyPick === 'season' && !normalLobby(w)) setTimeout(measureLobbyLight, 5000);
  updateMotion();
  // the lobby's volumes are shared with Settings and the lobby music panel
  for (const vol of document.querySelectorAll('#lobby-bar .lobby-volume')) {
    if (document.activeElement !== vol) vol.value = String(w.web?.[vol.dataset.key] ?? 1);
  }
}

// What the page's own sounds play at: the lobby volume, and for a lobby with its own song (Blue
// Archive's plays in the sidebar, Azur Lane's in its page) its voice volume on top; the song's.
const SONG_LOBBIES = ['bluearchive', 'azurlane'];
function voiceVolume(web = {}) {
  const v = (web.volume ?? 0.6) * (SONG_LOBBIES.includes(web.preset) ? (web.voiceVolume ?? 1) : 1);
  return Math.max(0, Math.min(1, v));
}
const songVolume = (web = {}) => Math.max(0, Math.min(1, (web.volume ?? 0.6) * (web.musicVolume ?? 1)));

// Blue Archive's normal lobby (TyranWeb's own page, src/live/ba-lobby) rather than a memorial one
const normalLobby = (w) => w.type === 'web' && w.web?.preset === 'bluearchive' && w.web.baMode === 'normal';

function keyOf(w, st) {
  if (w.type === 'video') return JSON.stringify(['video', w.video]);
  if (w.type === 'desktop') return JSON.stringify(['desktop']);
  const G = w.type === 'web' && CHAR_GAMES[w.web?.preset];
  if (w.type === 'web') return JSON.stringify(['web', w.web?.preset, w.web?.url, w.web?.package, G ? [w.web?.[G.who], w.web?.[G.outfit]] : '', normalLobby(w) ? w.web.model : '']);
  return JSON.stringify([st.backgroundImage, st.backgroundColor, st.backgroundPosition, st.transform, st.filter]);
}

function frameVideo(v, w) {
  const f = frameCss(w);
  Object.assign(v.style, { objectPosition: f.position, transform: f.transform, transformOrigin: f.position });
}

function filterOf(w) {
  const f = [];
  if (w.blur) f.push(`blur(${w.blur}px)`);
  if (w.saturate !== 1) f.push(`saturate(${w.saturate})`);
  return f.join(' ') || 'none';
}

// Builds the new layer, fades it in once it has something to show, then drops the old one.
async function swap(w, st) {
  const seq = ++swapSeq;
  const root = $('#wallpaper');
  let layer;
  let ready;
  if (w.type === 'video' && w.video) [layer, ready] = buildVideo(w);
  else if (w.type === 'web') [layer, ready] = await buildWeb(w);
  else if (w.type === 'desktop') [layer, ready] = await buildDesktop(w);
  else [layer, ready] = buildStatic(st);
  if (w.type !== 'web') {
    loadingDone();
    emit('lobby-talk', false);
  }
  if (seq !== swapSeq) return layer?.remove();
  const kind = layer?.dataset.kind || (layer?.tagName === 'VIDEO' ? 'video' : layer?.tagName === 'WEBVIEW' ? 'web' : 'static');
  current = { ...current, el: layer, kind, wcId: 0, frozen: false };
  if (layer) {
    layer.style.zIndex = '1'; // (above a Blue Archive lobby kept out of sight)
    root.insertBefore(layer, $('#wallpaper-dim'));
  }
  await ready;
  if (seq !== swapSeq) return;
  requestAnimationFrame(() => layer?.classList.add('in'));
  // (a lobby gives its colours once it starts: setupBlueArchive; another web page once drawn)
  if (kind !== 'web') updateAutoColors();
  else if (w.web?.preset !== 'bluearchive') setTimeout(updateAutoColors, 3000);
  const old = [...root.querySelectorAll('.wp-layer')].filter((l) => l !== layer && l !== spare?.el);
  // (the same student's other lobby, just left, is kept)
  const left = old.find((l) => !spare && l.tagName === 'WEBVIEW' && l.dataset.started && l.dataset.model === w.web?.model && l.dataset.ba === otherMode(w));
  if (left) {
    old.splice(old.indexOf(left), 1);
    keepSpare(left, w, 'started');
  }
  setTimeout(() => old.forEach((l) => l.remove()), 700);
  updateMotion();
}

function buildStatic(st) {
  const layer = h('div', { class: 'wp-layer' });
  // a picture fills the window exactly; only a blurred one reaches past the edges, just enough that
  // the blur does not fade them
  const blur = Number(S.settings.wallpaper.blur) || 0;
  if (blur) layer.style.inset = `-${Math.ceil(blur * 2)}px`;
  Object.assign(layer.style, {
    backgroundImage: st.backgroundImage,
    backgroundColor: st.backgroundColor,
    backgroundSize: st.backgroundSize || 'cover',
    backgroundPosition: st.backgroundPosition || 'center',
    // (a picture framed by hand is zoomed around the point it is placed by)
    transform: st.transform || '',
    transformOrigin: st.backgroundPosition || 'center',
    filter: st.filter,
  });
  const m = /url\("(.+)"\)/.exec(st.backgroundImage || '');
  if (!m) return [layer, Promise.resolve()];
  return [
    layer,
    new Promise((resolve) => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = m[1];
    }),
  ];
}

// The desktop's own picture (Nền desktop), laid out as Windows lays it out on the screen the window
// is on, and seen through the window where it stands (it follows the window as it moves); blurred,
// dimmed and saturated as the user likes it (Làm mờ, Làm dịu, Độ bão hòa màu).
let desktopPic = null; // { url, style }
let desktopSeen = ''; // (its picture's version, to see when the desktop has another one)
let placed = null; // the window's page on the screen, the screen it is on, all screens
async function buildDesktop(w) {
  const [pic, place] = await Promise.all([api.invoke('desktop:wallpaper').catch(() => null), api.invoke('win:placement').catch(() => null)]);
  desktopPic = pic;
  desktopSeen = pic?.url || '';
  placed = place || placed;
  const layer = h('div', { class: 'wp-layer wp-desktop' });
  layer.dataset.kind = 'desktop';
  if (!pic) return [layer, Promise.resolve()];
  layer.dataset.url = pic.url;
  const img = h('div', { class: 'wp-desktop-pic' });
  img.style.backgroundImage = `url("${pic.url}")`;
  img.style.filter = filterOf(w);
  layer.append(img);
  placeDesktop(layer);
  return [
    layer,
    new Promise((resolve) => {
      const im = new Image();
      im.onload = im.onerror = resolve;
      im.src = pic.url;
    }),
  ];
}
function placeDesktop(layer = current.kind === 'desktop' ? current.el : null) {
  const img = layer?.firstElementChild;
  if (!img || !placed) return;
  const style = desktopPic?.style || 'fill';
  const all = placed.all?.length ? placed.all : [placed.display];
  const x0 = Math.min(...all.map((d) => d.x));
  const y0 = Math.min(...all.map((d) => d.y));
  const span = { x: x0, y: y0, width: Math.max(...all.map((d) => d.x + d.width)) - x0, height: Math.max(...all.map((d) => d.y + d.height)) - y0 };
  const area = style === 'span' ? span : placed.display;
  // (a blurred picture reaches past the screen's edges, just enough that the blur does not fade them)
  const m = Math.ceil((Number(S.settings.wallpaper.blur) || 0) * 2);
  Object.assign(img.style, {
    left: `${area.x - placed.content.x - m}px`,
    top: `${area.y - placed.content.y - m}px`,
    width: `${area.width + 2 * m}px`,
    height: `${area.height + 2 * m}px`,
    backgroundSize: { fill: 'cover', span: 'cover', fit: 'contain', stretch: '100% 100%' }[style] || 'auto',
    backgroundRepeat: style === 'tile' ? 'repeat' : 'no-repeat',
    backgroundPosition: style === 'tile' ? `${m}px ${m}px` : 'center',
  });
}
api.on('win:placement', (p) => {
  placed = p;
  placeDesktop();
});
// (another desktop picture, set while TyranWeb was out of sight)
window.addEventListener('focus', () => {
  if (S.settings.wallpaper.type !== 'desktop') return;
  api.invoke('desktop:wallpaper').then((pic) => pic && pic.url !== desktopSeen && ((current.key = ''), applyWallpaper()), () => {});
});

function buildVideo(w) {
  const v = h('video', { class: 'wp-layer wp-video', muted: true, loop: true, playsInline: true, preload: 'auto', disablePictureInPicture: true });
  v.muted = true;
  v.src = w.video;
  v.style.filter = filterOf(w);
  frameVideo(v, w);
  v.playbackRate = w.videoRate || 1;
  const ready = new Promise((resolve) => {
    v.addEventListener('loadeddata', resolve, { once: true });
    v.addEventListener(
      'error',
      () => {
        toast(t('Không phát được video này — thử file .mp4 (H.264) hoặc .webm'), { icon: 'info', timeout: 5000 });
        resolve();
      },
      { once: true }
    );
  });
  return [v, ready];
}

async function buildWeb(w) {
  const url = await api.invoke('wallpapers:liveUrl', w.web || {}).catch(() => null);
  if (!url && normalLobby(w)) loadingFail(t('Không tải được sảnh của học sinh này (mạng, hoặc SchaleDB / GitHub không phản hồi).'), t('Bấm Tải lại ở thanh Lobby để thử lại.'));
  if (!url) return [null, Promise.resolve()];
  const wv = document.createElement('webview');
  wv.className = 'wp-layer wp-web';
  wv.setAttribute('partition', WALLPAPER_PARTITION);
  wv.setAttribute('src', url);
  wv.style.filter = filterOf(w);
  markBa(wv, w);
  if (w.web?.preset === 'bluearchive' && !normalLobby(w)) loadingStart(w.web);
  else loadingDone();
  if (normalLobby(w)) emit('lobby-loading'); // (its song waits for her to be shown)
  // shown as soon as the page exists: a hidden (opacity 0) page would stop painting. Blue Archive's
  // normal lobby instead replaces the wallpaper at once, no fade, once it has its student ready.
  const instant = normalLobby(w);
  if (instant) wv.classList.add('instant');
  const ready = new Promise((resolve) => {
    const done = () => resolve();
    const drawn = async () => {
      for (let i = 0; i < 130 && wv.isConnected; i++) {
        if (await wv.executeJavaScript('!!(window.__tyran && (__tyran.ready || __tyran.failed))').catch(() => false)) break;
        await sleep(150);
      }
      done();
    };
    wv.addEventListener('dom-ready', instant ? drawn : done, { once: true });
    wv.addEventListener('did-fail-load', (e) => e.isMainFrame !== false && done(), { once: true });
    setTimeout(done, instant ? 20000 : 8000);
  });
  watchLive(wv);
  return [wv, ready];
}

// What a live page says and does while it is the one shown
function watchLive(wv) {
  // the Blue Archive page says when a student starts and stops talking (the lobby music dips meanwhile)
  wv.addEventListener('console-message', (e) => {
    const msg = String(e.message ?? '');
    if (current.el !== wv) return;
    const m = /^tyran:talk:([01])$/.exec(msg);
    if (m) emit('lobby-talk', m[1] === '1');
    // the intro started over after loading (a late layer): the song goes back to its start too
    else if (msg === 'tyran:intro' && !liveBusy) emit('lobby-start');
  });
  wv.addEventListener('dom-ready', () => {
    if (current.el !== wv) return; // (a lobby loaded ahead, out of sight: see preloadSpare)
    emit('lobby-talk', false); // a reloaded page is not talking
    current.wcId = wv.getWebContentsId();
    // a (re)loaded page starts running and visible
    current.frozen = false;
    wv.style.visibility = '';
    if (wv.previousElementSibling?.classList.contains('wp-snap')) wv.previousElementSibling.remove();
    syncLive(S.settings.wallpaper, true);
    updateMotion();
  });
}

function restyle(w) {
  const el = current.el;
  if (!el || current.kind === 'static') return;
  if (current.kind === 'desktop') {
    if (el.firstElementChild) el.firstElementChild.style.filter = filterOf(w);
    return placeDesktop();
  }
  el.style.filter = filterOf(w);
  if (current.kind === 'video') {
    frameVideo(el, w);
    el.playbackRate = w.videoRate || 1;
  }
}

// ---------------------------------------------------------------- live pages
let liveState = '';
// the touch areas on or off, the top of the part of the lobby the browser's bars leave visible, and
// where the address bar starts when it is above it (NIKKE: her head there, her face under it)
function zonesScript(on) {
  const views = $('#views')?.getBoundingClientRect();
  const wall = current.el?.getBoundingClientRect();
  const top = S.lobby || !views || !wall ? 0 : Math.max(0, Math.round(views.top - wall.top));
  const omni = top ? $('.omnibox')?.getBoundingClientRect() : null;
  const bar = omni && omni.height && omni.bottom <= views.top + 1 ? Math.max(0, Math.round(omni.top - wall.top)) : 0;
  return `__tyran.zones(${!!on}, ${top}, ${bar})`;
}
on('lobby-mode', () => {
  if (current.kind === 'web' && current.wcId) current.el.executeJavaScript(`window.__tyran && ${zonesScript(S.settings.wallpaper.web?.touchZones)}`).catch(() => {});
});

const liveKey = (w, web = w.web || {}) => JSON.stringify([web.audio, web.model, web.preset, voiceVolume(web), !!web.touchZones, web.nikkeStance, web.nikkeTint, web.nikkeColor, web.nikkeImage, songVolume(web), web.azurMusic, !!web.azurChatter, !!ownMusic(w), web.baMode, web.senseiBirthday]);
function syncLive(w, force = false) {
  if (current.kind !== 'web' || !current.wcId) return;
  const web = w.web || {};
  const state = liveKey(w);
  if (state === liveState && !force) return;
  const prev = force ? null : JSON.parse(liveState || 'null');
  liveState = state;
  const wv = current.el;
  try {
    wv.setAudioMuted(!web.audio);
  } catch {
    /* not attached yet */
  }
  wv.executeJavaScript(liveVolumeScript(voiceVolume(web))).catch(() => {});
  if (CHAR_GAMES[web.preset]) {
    // (a song of the game picked in Settings is fetched the first time; the page waits for it)
    if (web.preset === 'azurlane' && web.azurMusic && web.azurMusic !== 'game') api.invoke('azur:music', web.azurMusic).catch(() => {});
    wv.executeJavaScript(nikkeScript(web)).catch(() => {});
    if (force) afterNikke(wv, web);
    return;
  }
  if (normalLobby(w)) {
    wv.executeJavaScript(`window.__tyran && (__tyran.set(${JSON.stringify({ audio: !!web.audio, volume: voiceVolume(web), senseiBirthday: web.senseiBirthday || '' })}), ${zonesScript(web.touchZones)})`).catch(() => {});
    if (force) afterNormal(wv);
    return;
  }
  if (web.preset !== 'bluearchive') return;
  if (prev && prev[1] === web.model) wv.executeJavaScript(`window.__tyran && (__tyran.audio(${!!web.audio}), __tyran.volume(${voiceVolume(web)}), ${zonesScript(web.touchZones)})`).catch(() => {});
  else if (prev) {
    // a new student gets a fresh page: the viewer never frees the previous lobby's textures
    $('#wallpaper').classList.add('framing');
    loadingStart(web);
    markBa(wv, w);
    wv.reload();
  } else setupBlueArchive(wv, web);
}

// The games whose characters are downloaded (NIKKE, Azur Lane, Project SEKAI): their IPC channels and the settings
// that say who is shown and in which outfit; the first one when none is set ('' for any).
const CHAR_GAMES = {
  nikke: { api: 'nikke', who: 'nikke', outfit: 'nikkeOutfit', first: 'c010', key: 'nikke_' },
  azurlane: { api: 'azur', who: 'azur', outfit: 'azurSkin', first: '', key: 'azur_' },
  sekai: { api: 'sekai', who: 'sekai', outfit: 'sekaiOutfit', first: '', key: 'sekai_' },
};
// A downloaded character (TyranWeb's own page beside her files, src/live/<game>): all it needs in one
// call, whenever any of it changes (an Azur Lane page takes only what it uses).
function nikkeScript(web) {
  const o = { audio: !!web.audio, volume: voiceVolume(web), stance: web.nikkeStance === 'battle' ? 'battle' : 'lobby', tint: web.nikkeTint === 'own' ? 'own' : 'auto', color: web.nikkeColor || '#141b29', image: web.nikkeImage || '' };
  // (Azur Lane: the lobby's song, unless the wallpaper has music of the user's own; her idle chatter)
  if (web.preset === 'azurlane') Object.assign(o, { music: ownMusic(S.settings.wallpaper) ? '' : (web.azurMusic ?? 'game'), musicVolume: songVolume(web), chatter: !!web.azurChatter });
  return `window.__tyran && (__tyran.set(${JSON.stringify(o)}), ${zonesScript(web.touchZones)})`;
}
// The Đổi trang phục / Đổi biểu cảm buttons (Lobby bar, new tab): her next downloaded outfit;
// her next face (the rig's own, named in Vietnamese when TyranWeb knows the name).
export async function nextNikkeOutfit() {
  const web = S.settings.wallpaper.web || {};
  const G = CHAR_GAMES[web.preset];
  if (!G) return;
  const list = await api.invoke(G.api + ':list').catch(() => []);
  const c = list.find((x) => x.id === (web[G.who] || G.first)) || (!web[G.who] && list.find((x) => x.installed));
  if (!c?.installed) return;
  const looks = ['', ...c.outfits.filter((o) => o.installed).map((o) => o.id)];
  if (looks.length < 2) return;
  const next = looks[(looks.indexOf(web[G.outfit] || '') + 1) % looks.length];
  api.invoke('settings:set', { wallpaper: { web: { [G.outfit]: next } } });
  toast(next ? `${c.name} · ${c.outfits.find((o) => o.id === next).name}` : c.look ? `${c.name} · ${c.look}` : c.name, { icon: 'layers' });
}
const FACES = { idle: t('Bình thường'), angry: t('Giận'), rage: t('Giận dữ'), delight: 'Vui', smile: t('Cười'), good: t('Hài lòng'), shy: t('Ngại'), think: t('Suy nghĩ'), worry: t('Lo lắng'), no: t('Không chịu'), special: t('Đặc biệt'), surprise: t('Ngạc nhiên'), surprised: t('Ngạc nhiên'), panic: t('Hoảng'), pain: t('Đau'), sad: t('Buồn'), cry: t('Khóc') };
const faceName = (n) => {
  const m = /^(.*?)[-_]?0?(\d+)$/.exec(n);
  const base = m && FACES[m[1]] ? m[1] : n;
  return (FACES[base] || n) + (m && FACES[m[1]] ? ' ' + m[2] : '');
};
export async function nextNikkeExpression() {
  const w = S.settings.wallpaper;
  if (current.kind !== 'web' || !current.wcId || !CHAR_GAMES[w.web?.preset]) return;
  if (w.web.preset === 'nikke' && w.web.nikkeStance === 'battle') api.invoke('settings:set', { wallpaper: { web: { nikkeStance: 'lobby' } } });
  const r = await current.el.executeJavaScript('window.__tyran && __tyran.ready && __tyran.expression(1)').catch(() => null);
  // (an Azur Lane page names its motions in Vietnamese: shown in the user's language)
  if (r) toast(`${r.label ? t(r.label) : faceName(r.name)} (${r.index + 1}/${r.count})`, { icon: 'heart' });
}

// once she is drawn: the interface's colours from her, and (once a session) her picture for Settings
let nikkeRun = 0;
async function afterNikke(wv, web) {
  const run = ++nikkeRun;
  const js = (code) => wv.executeJavaScript(code);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (run !== nikkeRun || !wv.isConnected) return;
    if (await js('!!(window.__tyran && __tyran.idle())').catch(() => false)) break;
  }
  await sleep(1200);
  if (run !== nikkeRun || current.el !== wv || current.frozen) return;
  updateAutoColors();
  // (the outfit's own picture; an outfit not downloaded shows her own; an Azur Lane page names its skin)
  const G = CHAR_GAMES[web.preset];
  const skin = new URL(wv.getURL()).searchParams.get('s');
  const outfit = await js('__tyran.outfit').catch(() => '');
  const key = G.key + (skin || (outfit && web.nikkeOutfit) || web.nikke || 'c010');
  // (her picture for Settings is taken in the lobby, facing the viewer)
  if (previewed.has(key) || (await js("(__tyran.info().stance ?? 'lobby') !== 'lobby'").catch(() => true))) return;
  previewed.add(key);
  await zonesHidden(js, () => api.invoke('wallpaper:savePreview', wv.getWebContentsId(), key)).catch(() => previewed.delete(key));
}
// The game's lobby button (Lobby bar, new tab): the chosen student's or outfit's memorial lobby, or
// her normal one, whichever is not shown (only for one who has a normal lobby)
export async function toggleBaMode() {
  const web = S.settings.wallpaper.web || {};
  if (S.settings.wallpaper.type !== 'web' || web.preset !== 'bluearchive') return;
  const m = await lobbyInfo(web.model);
  if (!m?.normal) return;
  await api.invoke('settings:set', { wallpaper: { web: { baMode: web.baMode === 'normal' ? 'memorial' : 'normal' } } });
  if (S.lobby) $('#lobby-bar')?.replaceWith(lobbyBar());
}

// Blue Archive's normal lobby: once her page has her drawn, the lobby starts (its song with it) and
// she greets Sensei; the interface then takes its colours from it
let normalRun = 0;
async function afterNormal(wv) {
  const run = ++normalRun;
  const js = (code) => wv.executeJavaScript(code);
  for (let i = 0; i < 160; i++) {
    if (run !== normalRun || !wv.isConnected) return;
    if (await js('!!(window.__tyran && (__tyran.ready || __tyran.failed))').catch(() => false)) break;
    await sleep(250);
  }
  if (run !== normalRun || current.el !== wv) return;
  if (await js('!__tyran.ready').catch(() => true)) {
    loadingFail(t('Không tải được sảnh của học sinh này (mạng, hoặc SchaleDB / GitHub không phản hồi).'), t('Bấm Tải lại ở thanh Lobby để thử lại.'));
    return;
  }
  // (as a memorial lobby does: its song buffered at its start, at most 10 s, then started with her)
  const ask = (event, fallback, ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      emit(event, { resolve: (v) => (clearTimeout(timer), resolve(v)) });
    });
  if (await ask('lobby-music-prepare', false, 10000)) await ask('lobby-start-music', -1, 2000);
  if (run !== normalRun || current.el !== wv) return;
  emit('lobby-start');
  await js('__tyran.begin()').catch(() => {});
  wv.dataset.started = '1';
  await sleep(1500);
  if (run === normalRun && current.el === wv && !current.frozen) updateAutoColors();
  // (her memorial lobby, loaded ahead)
  if (run === normalRun) setTimeout(() => preloadSpare(wv), 1500);
}

// ---------------------------------------------------------------- Blue Archive: both lobbies
// A student with a normal lobby has two (memorial: Live2D; normal: TyranWeb's page). The one not
// shown is loaded beside the shown one once that has started (underneath it, then paused), and the
// one left on a switch is kept, paused, so that the game's lobby button switches at once: back in
// the memorial lobby without loading again and without its opening.
let spare = null; // { model, mode, key, el, state: 'loading' | 'prepared' | 'started', ready }
let switching = false; // (waiting for the spare to be ready)
const baModeOf = (w) => (normalLobby(w) ? 'normal' : 'memorial');
const otherMode = (w) => (normalLobby(w) ? 'memorial' : 'normal');
const inMode = (w, mode) => ({ ...w, web: { ...w.web, baMode: mode } });
function markBa(wv, w) {
  if (w.type !== 'web' || w.web?.preset !== 'bluearchive') return;
  wv.dataset.ba = baModeOf(w);
  wv.dataset.model = w.web.model;
}
// out of sight and silent (a hidden page draws nothing), under the shown one
function rest(wv) {
  try {
    wv.setAudioMuted(true);
  } catch {
    /* not attached yet */
  }
  wv.style.visibility = 'hidden';
  wv.style.zIndex = '';
  if (wv.previousElementSibling?.classList.contains('wp-snap')) wv.previousElementSibling.remove();
}
function keepSpare(wv, w, state) {
  dropSpare();
  rest(wv);
  const mode = wv.dataset.ba;
  spare = { model: w.web.model, mode, key: keyOf(inMode(w, mode)), el: wv, state, ready: Promise.resolve(true) };
}
function dropSpare() {
  spare?.el.remove();
  spare = null;
}

// the other lobby of the student shown, loaded out of sight
async function preloadSpare(shown) {
  const w = S.settings.wallpaper;
  if (spare || current.el !== shown || w.type !== 'web' || w.web?.preset !== 'bluearchive') return;
  const model = w.web.model;
  const info = await lobbyInfo(model);
  if (!info?.normal || info.hidden) return;
  const other = inMode(w, otherMode(w));
  const url = await api.invoke('wallpapers:liveUrl', other.web).catch(() => null);
  if (!url || spare || current.el !== shown || S.settings.wallpaper.web?.model !== model) return;
  const wv = document.createElement('webview');
  wv.className = 'wp-layer wp-web in instant';
  wv.setAttribute('partition', WALLPAPER_PARTITION);
  wv.setAttribute('src', url);
  wv.style.filter = filterOf(w);
  markBa(wv, other);
  watchLive(wv);
  const me = { model, mode: otherMode(w), key: keyOf(other), el: wv, state: 'loading' };
  const alive = () => spare === me || current.el === wv; // (the spare still, or shown by now)
  me.ready = new Promise((resolve) => {
    wv.addEventListener(
      'dom-ready',
      async () => {
        try {
          wv.setAudioMuted(true);
        } catch {
          /* gone */
        }
        let ok = false;
        try {
          if (me.mode === 'normal') {
            for (let i = 0; i < 160 && alive(); i++) {
              if (await wv.executeJavaScript('!!(window.__tyran && (__tyran.ready || __tyran.failed))').catch(() => false)) break;
              await sleep(250);
            }
            ok = await wv.executeJavaScript('!!__tyran.ready').catch(() => false);
          } else ok = (await prepareBlueArchive(wv, other.web, { ui: false, alive, info })) === 'ok';
        } catch {
          ok = false;
        }
        if (spare === me) {
          if (ok) {
            me.state = 'prepared';
            rest(wv);
          } else dropSpare();
        }
        resolve(ok);
      },
      { once: true }
    );
  });
  spare = me;
  // (drawn underneath everything while it loads: a hidden page would not get there)
  $('#wallpaper').prepend(wv);
}

// The game's lobby button with the other lobby at hand: shown at once; the one left kept aside
async function useSpare(w, st) {
  const next = spare;
  if (next.state === 'loading') {
    switching = true;
    if (next.mode === 'memorial') {
      $('#wallpaper').classList.add('framing');
      loadingStart(w.web);
    }
    const ok = await next.ready;
    switching = false;
    if (current.key !== next.key) return; // (switched again meanwhile)
    if (!ok || spare !== next) {
      current.key = '';
      return applyWallpaper();
    }
  }
  spare = null;
  const leaving = current.el;
  if (leaving?.tagName === 'WEBVIEW' && leaving.dataset.started && leaving.dataset.model === w.web.model && leaving.dataset.ba === otherMode(w)) keepSpare(leaving, w, 'started');
  else if (leaving) {
    // (a lobby left before it had started: dropped, its loading stopped)
    if (leaving.dataset.ba === 'memorial') ++baRun;
    liveBusy = false;
    if (leaving.previousElementSibling?.classList.contains('wp-snap')) leaving.previousElementSibling.remove();
    leaving.remove();
  }
  const wv = next.el;
  current = { ...current, el: wv, kind: 'web', wcId: wv.getWebContentsId(), frozen: false };
  wv.style.zIndex = '1';
  wv.style.visibility = '';
  $('#wallpaper').classList.remove('framing');
  loadingDone();
  emit('lobby-talk', false);
  const web = w.web;
  liveState = liveKey(w);
  try {
    wv.setAudioMuted(!web.audio);
  } catch {
    /* detached */
  }
  wv.executeJavaScript(liveVolumeScript(voiceVolume(web))).catch(() => {});
  if (next.mode === 'normal') {
    wv.executeJavaScript(`window.__tyran && (__tyran.set(${JSON.stringify({ audio: !!web.audio, volume: voiceVolume(web), senseiBirthday: web.senseiBirthday || '' })}), ${zonesScript(web.touchZones)})`).catch(() => {});
    if (next.state !== 'started') {
      emit('lobby-loading'); // (its song waits for her greeting)
      afterNormal(wv);
    }
  } else {
    wv.executeJavaScript(`window.__tyran && (__tyran.audio(${!!web.audio}), __tyran.volume(${voiceVolume(web)}), ${zonesScript(web.touchZones)})`).catch(() => {});
    if (next.state !== 'started') {
      emit('lobby-loading'); // (its song and its opening start together)
      startBlueArchive(wv, web, ++baRun).catch(() => {});
    }
  }
  updateMotion();
  setTimeout(() => current.el === wv && !current.frozen && updateAutoColors(), 800);
}

for (const [preset, G] of Object.entries(CHAR_GAMES)) {
  api.on(G.api + ':changed', () => {
    // a character just downloaded (or removed): the wallpaper shows her now
    const w = S.settings.wallpaper;
    if (w.type === 'web' && w.web?.preset === preset) {
      current.key = '';
      applyWallpaper();
    }
  });
}

// Volume for any live page: media elements as they start, and howler when the page uses it.
function liveVolumeScript(v) {
  return `(() => {
    const v = ${Math.max(0, Math.min(1, Number(v) || 0))};
    if (window.__tyran && window.__tyran.volume) return window.__tyran.volume(v), true;
    window.__tyranVol = v;
    if (!window.__tyranVolHook) {
      window.__tyranVolHook = true;
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...a) { this.volume = window.__tyranVol; return play.apply(this, a); };
    }
    document.querySelectorAll('audio, video').forEach((m) => (m.volume = v));
    if (window.Howler) window.Howler.volume(v);
    return true;
  })()`;
}

// Blue Archive memorial lobby through respectZ's viewer (ba.svdex.moe/jp/live2d). TyranWeb hides
// the viewer's menus, picks the student with its own form, then reaches the viewer's Spine objects
// to draw the scene at the window's size and to add the game's touch interactions.
const BA_CSS = `#setting, div:has(> #setting-button), div.w-screen.h-12.fixed.bottom-0 { display: none !important; }
html, body { overflow: hidden !important; background: #000 !important; user-select: none !important; }
* { -webkit-user-drag: none !important; }
canvas { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; touch-action: none; }`;

// Runs inside the viewer page (serialised with toString, so it must not use anything from this module).
function blueArchivePage() {
  if (window.__tyran) return true;
  const $ = (id) => document.getElementById(id);
  const setValue = (el, v) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const T = (window.__tyran = { viewer: null });

  // The page is a Next.js app: its webpack registry gives access to the viewer class, and wrapping
  // the class's methods hands us the live instance the next time the page calls one of them.
  try {
    let req = null;
    self.webpackChunk_N_E.push([[Symbol('tyran')], {}, (r) => (req = r)]);
    for (const id of Object.keys(req.m)) {
      const src = String(req.m[id]);
      if (!src.includes('loadModel') || !src.includes('fillScale')) continue;
      for (const C of Object.values(req(id))) {
        if (typeof C !== 'function' || !C.prototype?.loadModel || !C.prototype?.fillScale) continue;
        for (const k of Object.getOwnPropertyNames(C.prototype)) {
          const d = Object.getOwnPropertyDescriptor(C.prototype, k);
          if (k === 'constructor' || typeof d?.value !== 'function') continue;
          const orig = d.value;
          C.prototype[k] = function (...a) {
            T.viewer = this;
            const r = orig.apply(this, a);
            // remember which file each layer came from (to stack backgrounds under the student)
            if (k === 'addSpine') Promise.resolve(r).then((sp) => sp && (sp.__tyranSrc = String(a[0])), () => {});
            return r;
          };
        }
      }
    }
  } catch {
    /* page changed: interactions stay off, the scene still shows */
  }

  const spines = () => (T.viewer ? T.viewer.app.stage.children.filter((c) => c.skeleton && c.state) : []);
  const dataOf = (s) => s.spineData || s.skeleton.data;
  // the student (not a background layer): the skeleton with talk animations, else the biggest one
  const main = () => {
    const list = spines();
    return list.find((s) => dataOf(s).findAnimation('Talk_01_A')) || list.sort((a, b) => b.skeleton.bones.length - a.skeleton.bones.length)[0];
  };
  const has = (s, n) => !!n && !!dataOf(s).findAnimation(n); // (Spine 4.2 throws on an empty name)

  T.idle = () => {
    const s = main();
    const t = s && s.state.tracks[0];
    return !!t && !/^start/i.test(t.animation.name);
  };
  // loaded, but the viewer could not read the skeleton (nothing loaded yet is not empty)
  T.empty = () => {
    const list = spines();
    return list.length > 0 && list.every((s) => !s.skeleton.bones.length);
  };
  // every picture of every layer has loaded (a layer's atlas pages can arrive after the layer)
  T.texturesReady = () => {
    const seen = new Set();
    const walk = (o) => {
      const bt = o.texture?.baseTexture;
      if (bt) seen.add(bt);
      (o.children ?? []).forEach(walk);
    };
    spines().forEach(walk);
    return seen.size > 0 && [...seen].every((b) => b.valid);
  };
  T.ready = () => !!($('model') && $('model').options.length && $('animation') && $('animation').options.length && document.querySelector('canvas'));
  T.anims = () => [...$('animation').options].map((o) => o.value).join(',');
  // urls: a lobby from the second source (its own files: the viewer loads any list of skeletons,
  // given as the option's value); voices: where its voice lines are
  T.voiceBase = '';
  T.pick = (key, urls, voices) => {
    T.key = key;
    const sel = $('model');
    T.voiceBase = urls?.length ? voices || '' : '';
    let opt = [...sel.options].find((o) => o.text.trim().endsWith('(' + key + ')'));
    if (urls?.length) {
      const value = JSON.stringify(urls);
      opt = [...sel.options].find((o) => o.value === value) || sel.appendChild(new Option(key + ' (' + key + ')', value));
    }
    if (!opt) return -1;
    if (sel.value === opt.value) return 0;
    setValue(sel, opt.value);
    return 1;
  };
  // Voices are TyranWeb's own (see say() below): the viewer's voice player stays off, as it looks in
  // the wrong folder for some lobbies and would say lines twice next to ours. (Its lobby music
  // points at an expired game-server address, HTTP 403, so it stays off as well.)
  T.voiceOn = false;
  T.audio = (on) => {
    T.voiceOn = !!on;
    const c = $('play-voice');
    if (c && c.checked) c.click();
  };
  // one volume for the lobby's music (audio elements) and voices (howler)
  T.vol = 1;
  const mediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    this.volume = T.vol;
    return mediaPlay.apply(this, a);
  };
  T.volume = (v) => {
    T.vol = Math.max(0, Math.min(1, Number(v) || 0));
    if (window.Howler) window.Howler.volume(T.vol);
    document.querySelectorAll('audio, video').forEach((m) => (m.volume = T.vol));
    if (T.viewer) T.viewer.voiceVolume = T.vol;
  };
  // Voice lines. A "Talk" event names its file, which sits in the folder of the line's own prefix
  // (HoshinoSwimsuit_MemorialLobby_1 → JP_HoshinoSwimsuit/hoshinoswimsuit_memoriallobby_1.ogg, on
  // the viewer's server). Events in the animations being played (the opening, the shown talk
  // tracks) are heard as they fire, so they keep time with the animation; lobbies that keep them
  // only in Dev_Talk_NN_All get them scheduled from there by T.speak.
  let voices = [];
  const devOf = (s) => {
    const file = String(s.__tyranSrc || T.viewer?.devName || '').split('/').pop().split('.')[0];
    return (file.includes('_') ? file.split('_').slice(0, -1).join('_') : file) || T.viewer?.devName || '';
  };
  const voiceUrl = (line, s) => {
    const folder = (/^(.*?)_MemorialLobby/i.exec(line) || [])[1] || devOf(s);
    if (T.voiceBase) return `${T.voiceBase}/${folder.toLowerCase()}/${line.toLowerCase()}.ogg`;
    return `${location.origin}/data/jp/MediaResources/GameData/Audio/VOC_JP/JP_${folder}/${line.toLowerCase()}.ogg`;
  };
  let lastLine = { line: '', at: 0 };
  const say = (line, s) => {
    if (!T.voiceOn || !line) return;
    const now = performance.now();
    if (line === lastLine.line && now - lastLine.at < 400) return; // the same line fired twice at once
    lastLine = { line, at: now };
    const x = { audio: new Audio(voiceUrl(line, s)) };
    voices.push(x);
    x.audio.play().catch(() => {});
  };
  const listen = (s) => {
    if (s.__tyranVoice) return;
    s.__tyranVoice = true;
    s.state.addListener({ event: (entry, ev) => ev.data.name === 'Talk' && say(ev.stringValue, s) });
  };
  T.speak = (s, base) => {
    voices.forEach((x) => (clearTimeout(x.timer), x.audio?.pause()));
    voices = [];
    if (!T.voiceOn) return;
    const shown = ['_A', '_M', '_M2', '_M3'].map((x) => dataOf(s).findAnimation(base + x)).filter(Boolean);
    const talks = (a) => a.timelines.some((tl) => tl.events?.some((ev) => ev.data.name === 'Talk'));
    if (shown.some(talks)) return; // heard as they fire
    // otherwise from the hidden twin of the line: Dev_Talk_NN_All, _M, or plain (whichever has them)
    const dev = dataOf(s)
      .animations.filter((a) => a.name.startsWith('Dev_' + base) && talks(a))
      .sort((a, b) => Number(b.name.endsWith('_All')) - Number(a.name.endsWith('_All')))[0];
    for (const tl of dev?.timelines ?? []) {
      for (const ev of tl.events ?? []) {
        if (ev.data.name !== 'Talk' || !ev.stringValue) continue;
        const x = {};
        x.timer = setTimeout(() => {
          voices.splice(voices.indexOf(x), 1);
          say(ev.stringValue, s);
        }, ev.time * 1000);
        voices.push(x);
      }
    }
  };
  // A line lasts as long as its talk animation and every voice file in it (still to come, or
  // playing). TyranWeb hears about it through the console (this page has no other way out) to
  // lower the lobby music meanwhile.
  let talkEnd = 0;
  let talkWatch = 0;
  // (the viewer's own voice files play through howler)
  const viewerHowls = () => (window.Howler?._howls ?? []).filter((h) => /VOC_/i.test(String(h._src)));
  const viewerVoice = () => viewerHowls().some((h) => h.playing());
  // silences every voice, said or about to be: posing a lobby for measuring jumps its animations
  // and fires their voice events at once, and an opening that starts over must not overlap itself
  T.hush = () => {
    voices.forEach((x) => (clearTimeout(x.timer), x.audio?.pause()));
    voices = [];
    viewerHowls().forEach((h) => h.stop());
    talkEnd = 0;
  };
  T.talking = () => performance.now() < talkEnd || viewerVoice() || voices.some((x) => !x.audio || (!x.audio.paused && !x.audio.ended && !x.audio.error));
  const talkStarted = (seconds) => {
    talkEnd = performance.now() + seconds * 1000;
    console.debug('tyran:talk:1');
    clearInterval(talkWatch);
    talkWatch = setInterval(() => {
      if (T.talking()) return;
      clearInterval(talkWatch);
      T.calm(600);
      console.debug('tyran:talk:0');
    }, 200);
  };
  // after a line or a touch, a short pause before the student reacts to the next one
  let calmUntil = 0;
  T.calm = (ms) => (calmUntil = Math.max(calmUntil, performance.now() + ms));
  // the lobby's opening is still playing on some layer (a layer with no idle loop counts as done
  // once its opening has played through, as it then stays on the last frame)
  T.inIntro = () =>
    spines().some((s) => {
      const t = s.state.tracks[0];
      return !!t && /^Start_/i.test(t.animation.name) && t.trackTime < t.animationEnd;
    });
  // (the opening still showing: see T.introGate)
  T.introLocked = () =>
    spines().some((s) => {
      const t = s.state.tracks[0];
      if (!t || !/^Start_/i.test(t.animation.name) || t.trackTime >= t.animationEnd) return false;
      return !(T.introGate > 0 && t.trackTime >= T.introGate);
    });
  T.busy = () => T.introLocked() || T.talking() || performance.now() < calmUntil;
  // make the page call a viewer method if we have not seen the instance yet
  T.attach = () => {
    if (!T.viewer) $('scale-fill')?.click();
    const v = T.viewer;
    if (v && !T.watch) {
      // layers of a lobby arrive one after another (and a new student replaces them): refit then;
      // pictures that were still loading at the last fit: measure again once they are in, and
      // start the intro over (it was playing with pieces missing)
      T.watch = () => {
        // an opening's own scene, played through: gone (the lobby is under it)
        for (const s of spines()) {
          const e = s.visible && sceneOf(s) && s.state.tracks[0];
          if (e && /^Start_/.test(e.animation.name) && e.trackTime >= e.animationEnd) s.visible = false;
        }
        const kids = v.app.stage.children;
        if (T.fitted && (kids.length !== T.fitted.length || kids.some((k, i) => k !== T.fitted[i]))) T.fit();
        // the game's view in a window of another shape, measured during the opening: again at rest
        else if (T.camera && T.gapZoom?.size !== innerWidth + 'x' + innerHeight && !T.inIntro()) place();
        else if (T.waitTextures && T.texturesReady()) {
          T.waitTextures = false;
          T.settle();
          T.measureIntro(); // (the opening's framing too, now with every picture in)
          if (!T.loading) T.animate();
        }
        // the picture could not be measured from its pixels yet (still on its way to the graphics card, a
        // hidden window): try again for a while instead of keeping the rig's own, much larger, bounds.
        // Only in the resting pose: a frame of the opening (a wide shot, a close-up) is not the lobby's
        // picture, and framing by it drew Anna and Erina at a fraction of their size.
        else if (T.measured && !T.measured.drawn && T.drawTries < 20 && performance.now() - T.drawAt > 700 && T.idle() && !T.inIntro()) {
          T.drawAt = performance.now();
          T.drawTries++;
          const d = measureDrawn();
          if (d) {
            T.measured.drawn = d;
            T.scene = d;
            place();
          }
        }
      };
      v.app.ticker.add(T.watch);
      v.app.ticker.add(() => T.zoomTick());
    }
    return !!v && spines().length > 0;
  };

  // The pose a layer keeps once the intro is over: its idle loop, or for a layer that only has an
  // intro (Momoi's street scrolls by and stops) the intro's last frame. An opening's own scene is
  // gone by then (sceneOf).
  // The fixes of 21 October only for the lobbies they were made for and checked against the game.
  // Every other lobby is drawn as before them: framed by its picture, its added light at full
  // strength, its opening Start_Idle_01 alone with all its layers together (made for every lobby,
  // they framed many too close, and Dev_Start_Idle_01 left its faces on many after their opening:
  // Fuuka (New Year)'s among others).
  // Dev_Start_Idle_01 over the opening (T.animate)
  const DEV_TRACK = new Set(['momoi_home']);
  // the opening's own scene played first, then hidden (T.animate): drawn with the lobby as before,
  // Wakamo's city covered her and her picture framing took it in (drawn at a fraction of her size)
  const SCENE_FIRST = new Set(['momoi_home', 'wakamo_home']);
  // the game's camera (place)
  const GAME_CAMERA = new Set(['momoi_home', 'ch0086_home', 'wakamo_home']);
  // added light softened (soften): Saori (Dress), Atsuko (Swimsuit), Eimi (Armed)
  const SOFT_LIGHT = new Set(['ch0259_home', 'ch0267_home', 'ch0337_home']);
  const only = (set) => set.has(String(T.key).toLowerCase());
  const sceneOf = (s) => only(SCENE_FIRST) && /_scene/i.test(s.__tyranSrc || '');
  const restPose = (s) => {
    const d = dataOf(s);
    s.state.clearTrack(DEV);
    if (has(s, 'Idle_01')) s.state.setAnimation(0, 'Idle_01', true);
    else if (has(s, 'Start_Idle_01')) s.state.setAnimation(0, 'Start_Idle_01', false).trackTime = d.findAnimation('Start_Idle_01').duration;
    else if (d.animations[0]) s.state.setAnimation(0, d.animations[0].name, true);
    s.update(0);
    if (sceneOf(s)) s.visible = false;
  };
  T.rest = () => {
    spines().forEach(restPose);
    T.hush();
    T.flash(false);
  };

  // Where the lobby's background actually is, in the shared skeleton space: the biggest opaque
  // pieces drawn in the idle pose. A rig's own bounds also count props outside the picture (Hikari's
  // hands, Shigure's train), which left black bars.
  const measureScene = () => {
    const list = spines();
    T.rest();
    const rects = [];
    const drawn = (slot) => slot && slot.attachment && slot.color.a >= 0.6 && slot.data.blendMode === 0;
    for (const s of list) {
      if (s.slotContainers) {
        // pixi-spine (Spine 3.8–4.1) draws one container per slot
        const k = s.scale.x;
        s.slotContainers.forEach((c, i) => {
          const slot = s.skeleton.slots[i];
          if (!drawn(slot) || !c.visible) return;
          const b = c.getBounds();
          if (!(b.width > 0 && b.height > 0)) return;
          rects.push({ x0: (b.x - s.x) / k, y0: (b.y - s.y) / k, x1: (b.x + b.width - s.x) / k, y1: (b.y + b.height - s.y) / k });
        });
        continue;
      }
      // official spine-pixi (Spine 4.2): ask each visible image or mesh for its corners
      for (const slot of s.skeleton.slots) {
        const att = slot.attachment;
        if (!drawn(slot) || !att.region || typeof att.computeWorldVertices !== 'function') continue;
        const mesh = 'worldVerticesLength' in att;
        const verts = new Float32Array(mesh ? att.worldVerticesLength : 8);
        try {
          if (mesh) att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
          else att.computeWorldVertices(slot, verts, 0, 2);
        } catch {
          continue;
        }
        const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        for (let i = 0; i < verts.length; i += 2) {
          r.x0 = Math.min(r.x0, verts[i]);
          r.x1 = Math.max(r.x1, verts[i]);
          r.y0 = Math.min(r.y0, verts[i + 1]);
          r.y1 = Math.max(r.y1, verts[i + 1]);
        }
        if (r.x1 > r.x0 && r.y1 > r.y0) rects.push(r);
      }
    }
    if (!rects.length) return null;
    const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
    rects.sort((a, b) => area(b) - area(a));
    const scene = { ...rects[0] };
    const gap = 0.05 * (scene.x1 - scene.x0);
    // backgrounds split into a few big pieces: join the large ones that touch the biggest
    for (const r of rects.slice(1)) {
      if (area(r) < 0.5 * area(rects[0])) break;
      if (r.x0 > scene.x1 + gap || r.x1 < scene.x0 - gap || r.y0 > scene.y1 + gap || r.y1 < scene.y0 - gap) continue;
      scene.x0 = Math.min(scene.x0, r.x0);
      scene.y0 = Math.min(scene.y0, r.y0);
      scene.x1 = Math.max(scene.x1, r.x1);
      scene.y1 = Math.max(scene.y1, r.y1);
    }
    return scene;
  };

  // Auto framing from the pixels: the scene (in the idle pose measureScene set) is drawn once,
  // small, off screen, and the lobby's picture is the filled block in it. Parts that stick out past
  // the picture (hands, a train, glow) fill only some of the rows and columns around it, so each
  // edge of the block moves inwards until its row or column is almost completely filled. The
  // result never shows an empty edge, whatever the rig's own sizes say (light rays above the
  // picture, a huge blurred prop waiting off screen for the intro).
  const measureDrawn = () => {
    const v = T.viewer;
    const list = spines();
    const r = v?.app.renderer;
    if (!list.length || !r?.extract?.pixels) return null;
    const saved = list.map((s) => [s.scale.x, s.scale.y, s.x, s.y]);
    try {
      for (const s of list) {
        s.scale.set(1);
        s.position.set(0, 0);
      }
      const b1 = v.app.stage.getLocalBounds();
      const k0 = Math.min(1, 640 / Math.max(b1.width, b1.height, 1));
      for (const s of list) s.scale.set(k0);
      const frame = v.app.stage.getLocalBounds().clone();
      const px = r.extract.pixels(v.app.stage, frame);
      const res = r.resolution || 1;
      const w = Math.round(frame.width * res);
      const h = Math.floor(px.length / 4 / w);
      if (w < 16 || h < 16) return null;
      // Some rigs hold more than one picture (an intro close-up beside the lobby): keep the filled
      // area joined to the point nearest the middle of the game's view, which every lobby centres
      // on its origin, a little above it.
      const opaque = (i) => px[i * 4 + 3] > 200;
      const sx = -frame.x * res; // local (0, -1000) in the picture's pixels
      const sy = (-1000 * k0 - frame.y) * res;
      let seed = -1;
      let best = Infinity;
      for (let i = 0; i < w * h; i++) {
        if (!opaque(i)) continue;
        const d = (i % w - sx) ** 2 + (Math.floor(i / w) - sy) ** 2;
        if (d < best) {
          best = d;
          seed = i;
        }
      }
      if (seed < 0) return null;
      const part = new Uint8Array(w * h);
      const queue = new Int32Array(w * h);
      let head = 0;
      let tail = 0;
      part[seed] = 1;
      queue[tail++] = seed;
      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j < 0 || j >= w * h || part[j] || !opaque(j)) continue;
          part[j] = 1;
          queue[tail++] = j;
        }
      }
      const solid = (x, y) => part[y * w + x] === 1;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!solid(x, y)) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      const row = (y) => {
        let n = 0;
        for (let x = x0; x <= x1; x++) n += solid(x, y);
        return n / (x1 - x0 + 1);
      };
      const col = (x) => {
        let n = 0;
        for (let y = y0; y <= y1; y++) n += solid(x, y);
        return n / (y1 - y0 + 1);
      };
      while (x1 - x0 > 16 && y1 - y0 > 16) {
        const edges = [
          [row(y0), 0],
          [row(y1), 1],
          [col(x0), 2],
          [col(x1), 3],
        ].sort((a, b) => a[0] - b[0]);
        if (edges[0][0] >= 0.985) break;
        const e = edges[0][1];
        if (e === 0) y0++;
        else if (e === 1) y1--;
        else if (e === 2) x0++;
        else x1--;
      }
      if (x1 - x0 <= 16 || y1 - y0 <= 16) return null;
      // pixels -> the spines' own space (they all share one position and scale)
      const at = (x, y) => ({ x: (frame.x + x / res) / k0, y: (frame.y + y / res) / k0 });
      const a = at(x0 + 1, y0 + 1);
      const c = at(x1, y1);
      return { x0: a.x, y0: a.y, x1: c.x, y1: c.y };
    } catch {
      return null;
    } finally {
      list.forEach((s, i) => {
        s.scale.set(saved[i][0], saved[i][1]);
        s.position.set(saved[i][2], saved[i][3]);
      });
    }
  };

  // Draw at the window's real size (so touches land where they look) and cover it with the scene,
  // cropping more from the bottom than the top: faces sit in the upper part of a lobby.
  T.fit = () => {
    const v = T.viewer;
    const s0 = main();
    if (!v || !s0) return false;
    spines().forEach(listen); // every layer's voice events (layers arrive one after another)
    if (only(SOFT_LIGHT)) spines().forEach(soften);
    const W = innerWidth;
    const H = innerHeight;
    if (v.app.renderer.width !== W || v.app.renderer.height !== H) v.app.renderer.resize(W, H);
    // drawing order: backgrounds, other layers, the student, then an opening's own scene (Momoi's
    // street: it plays over the lobby and leaves the view at its end). The viewer stacks a lobby's
    // first file on top, which hides the student when that file is the background.
    const rank = (s) => (sceneOf(s) ? 3 : s === s0 ? 2 : /bg|background/i.test(s.__tyranSrc || '') ? 0 : 1);
    spines()
      .sort((a, b) => rank(a) - rank(b))
      .forEach((s) => v.app.stage.addChild(s));
    const changed = !T.fitted || T.fitted.length !== v.app.stage.children.length || v.app.stage.children.some((c, i) => c !== T.fitted[i]);
    T.fitted = [...v.app.stage.children];
    if (changed || !T.scene) {
      const d = dataOf(s0); // last resort: the rig's bounds (spine data is y-up)
      const slots = measureScene();
      T.lead = sceneLead();
      const drawn = measureDrawn();
      T.measured = { slots, drawn };
      T.drawTries = 0;
      T.drawAt = performance.now();
      T.waitTextures = !T.texturesReady();
      T.scene = drawn || slots || { x0: d.x, x1: d.x + d.width, y0: -(d.y + d.height), y1: -d.y };
    }
    place();
    // while TyranWeb is still loading the lobby it rests (the opening, with its voice, plays once,
    // when the lobby is shown)
    if (changed && !T.loading) T.animate();
    return true;
  };
  // The game's camera. A lobby's rig hangs everything on one bone under its root (All_Layer,
  // All_Layer_F, Main_Camera; at 0, 961-962 in every rig seen), set up where the game's view is
  // centred; an opening's camera work (pans, close-ups)
  // moves that bone, the view itself stays. The view is GAME_VIEW units high and as wide as the
  // window's shape makes it (measured against a recording of Momoi's lobby in the game). Where the
  // window is wider than the game's screen and the view would pass the picture's edges, it is zoomed
  // in around its middle, just enough (gaps(), in the resting pose). Only for GAME_CAMERA; other
  // lobbies, and a rig without that bone, are framed by their picture (T.scene).
  const GAME_VIEW = 1570;
  const cameraOf = (s) => {
    const root = s?.skeleton.bones[0];
    const kids = root ? s.skeleton.bones.filter((x) => x.parent === root) : [];
    const b = kids.find((x) => /^(All_Layer|Main_Camera)/i.test(x.data.name)) ?? kids.find((x) => Math.abs(x.data.x) < 50 && Math.abs(x.data.y - 961) < 40);
    return b ? { x: b.data.x, y: b.data.y } : null;
  };
  const place = () => {
    const W = innerWidth;
    const H = innerHeight;
    const set = (k, x, y) => {
      for (const s of spines()) {
        s.scale.set(k);
        s.position.set(x, y);
      }
    };
    const cam = only(GAME_CAMERA) ? cameraOf(main()) : null;
    let k;
    let x;
    let y;
    if (cam) {
      k = H / GAME_VIEW;
      x = W / 2 - cam.x * k;
      y = H / 2 + cam.y * k;
      set(k, x, y);
      // (during the opening: the zoom found for the resting pose last time, until the opening is over)
      if (!T.inIntro()) T.gapZoom = { z: gaps(4), size: W + 'x' + H };
      const z = T.gapZoom?.z ?? 1;
      k *= z;
      x = W / 2 + (x - W / 2) * z;
      y = H / 2 + (y - H / 2) * z;
    } else {
      const r = T.scene;
      k = Math.max(W / (r.x1 - r.x0), H / (r.y1 - r.y0)) * 1.01;
      const extra = Math.max(0, (r.y1 - r.y0) * k - H);
      // a picture wider than the window is looked at where the game's camera is (x = 0)
      const half = W / k / 2;
      const cx = Math.min(r.x1 - half, Math.max(r.x0 + half, 0));
      x = W / 2 - cx * k;
      y = -0.25 * extra - r.y0 * k;
    }
    T.camera = !!cam;
    T.base = { k, x, y };
    T.zoomNow = 1;
    set(k, x, y);
  };

  // Added light (blooms, light rays, glows: the additive pieces) is drawn at LIGHT strength. The
  // game most likely draws its lobbies as Unity does in linear colour space, where light added to
  // a picture brightens it far less than added to the screen's own values as a browser does: at
  // full strength Saori (Dress), Eimi (Armed) and Atsuko (Swimsuit) came out washed in white
  // (SOFT_LIGHT: only those, as other lobbies looked right at full strength). 0.4
  // is the strength closest to the game's own pictures of them. White flashes over the whole view
  // (FX_Screen) keep their strength: white added is white in either.
  const LIGHT = 0.4;
  const soften = (s) => {
    const st = s.state;
    if (st.__tyranLight) return;
    st.__tyranLight = true;
    const add = s.skeleton.slots.filter((x) => x.data.blendMode === 1 && !/screen|flash|white|fade/i.test(x.data.name));
    if (!add.length) return;
    const apply = st.apply.bind(st);
    st.apply = (sk) => {
      // from the value the animation (or the setup pose) left, not last frame's softened one
      for (const x of add) if (x.__tyranSoft === x.color.a) x.color.a = x.__tyranA;
      const r = apply(sk);
      for (const x of add) {
        x.__tyranA = x.color.a;
        x.color.a *= LIGHT;
        x.__tyranSoft = x.color.a;
      }
      return r;
    };
  };

  // The zoom (around the middle) the frame drawn now needs: the window is drawn small, as it is framed
  // now, and from each edge the rows / columns that are mostly empty (black on screen) are counted;
  // just enough zoom to push them out, up to `most`. A frame that is mostly empty (a fade) is left
  // alone.
  const gaps = (most = 1.35) => {
    const v = T.viewer;
    const W = innerWidth;
    const H = innerHeight;
    const Rect = v.app.screen.constructor;
    let tex = null;
    try {
      tex = v.app.renderer.generateTexture(v.app.stage, { region: new Rect(0, 0, W, H), resolution: 0.25 });
      const px = v.app.renderer.extract.pixels(tex);
      const w = Math.round(Math.sqrt((px.length / 4) * (W / H)));
      const h = Math.floor(px.length / 4 / w);
      if (w < 8 || h < 8) return 1;
      const empty = (i) => px[i * 4 + 3] < 128;
      let all = 0;
      for (let i = 0; i < w * h; i++) all += empty(i);
      if (all > 0.5 * w * h) return 1;
      // the empty pixels reached from the window's edges (gaps past the picture: strips, corners of a
      // tilted shot; not the see-through parts inside it), and the least zoom that pushes each of
      // them out: around the middle, a point d away (dx, dy) leaves the window from a zoom of
      // min(w/2 / |dx|, h/2 / |dy|)
      const seen = new Uint8Array(w * h);
      const queue = new Int32Array(w * h);
      let head = 0;
      let tail = 0;
      const push = (i) => {
        if (!seen[i] && empty(i)) {
          seen[i] = 1;
          queue[tail++] = i;
        }
      };
      for (let x = 0; x < w; x++) {
        push(x);
        push((h - 1) * w + x);
      }
      for (let y = 0; y < h; y++) {
        push(y * w);
        push(y * w + w - 1);
      }
      let z = 1;
      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const y = (i - x) / w;
        const dx = Math.abs(x + 0.5 - w / 2);
        const dy = Math.abs(y + 0.5 - h / 2);
        z = Math.max(z, Math.min(dx > 0 ? w / 2 / dx : 99, dy > 0 ? h / 2 / dy : 99));
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (y > 0) push(i - w);
        if (y < h - 1) push(i + w);
      }
      if (z > 1) z = z * 1.01 + 2 / Math.min(w, h); // (a pixel of margin)
      return Math.min(most, z);
    } catch {
      return 1;
    } finally {
      tex?.destroy(true);
    }
  };

  // ---- the opening, framed. An opening moves the camera (a close-up, a pan), and in a window shaped
  // unlike the game's screen that can show past the picture's edges (black strips). Before it plays,
  // the picture is measured every half second along the opening; where it would not cover the window
  // the scene is zoomed in around the window's middle, just enough, easing in and out.
  T.introZoom = null; // [z at 0 s, 0.5 s, 1 s...]
  T.introGate = 0; // when touches are taken again during the opening (0: only once it is over)
  const STEP = 0.5;
  T.measureIntro = () => {
    T.introZoom = null;
    T.introGate = 0;
    const s0 = main();
    const start = s0 && dataOf(s0).findAnimation('Start_Idle_01');
    if (!start || !T.base || !T.scene) return 0;
    const { k, x, y } = T.base;
    const voice = T.voiceOn;
    T.voiceOn = false; // (the opening's voice events fire while it is stepped through)
    const zs = [];
    const rects = [];
    const poses = [];
    const idleMoves = [];
    const moveOf = (a, b) => Math.max(...b.map((p, j) => Math.hypot(p[0] - a[j][0], p[1] - a[j][1]) + Math.abs(((p[2] - a[j][2] + 540) % 360) - 180)));
    const median = (l) => [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)] ?? 0;
    try {
      for (let t = 0; t <= start.duration + 1e-6; t += STEP) {
        for (const s of spines()) {
          if (!has(s, 'Start_Idle_01')) continue;
          s.state.setAnimation(0, 'Start_Idle_01', false).trackTime = Math.min(t, dataOf(s).findAnimation('Start_Idle_01').duration);
          s.update(0);
        }
        for (const sp of spines()) {
          sp.scale.set(k);
          sp.position.set(x, y);
        }
        const z = gaps();
        const r = measureDrawn();
        zs.push(z > 1.002 ? z * 1.01 : 1);
        rects.push(r);
        poses.push(s0.skeleton.bones.map((b) => [b.x, b.y, b.rotation]));
      }
      // the idle loop's own motion, to tell the opening's last seconds from it
      if (has(s0, 'Idle_01')) {
        const idle = dataOf(s0).findAnimation('Idle_01');
        let prev = null;
        for (let t = 0; t <= idle.duration + 1e-6; t += STEP) {
          s0.state.setAnimation(0, 'Idle_01', true).trackTime = t;
          s0.update(0);
          const p = s0.skeleton.bones.map((b) => [b.x, b.y, b.rotation]);
          if (prev) idleMoves.push(moveOf(prev, p));
          prev = p;
        }
      }
    } catch {
      zs.length = 0;
    } finally {
      T.voiceOn = voice;
      T.rest();
    }
    // (each point covers its neighbours too, so the zoom is there before the camera gets there)
    const smooth = zs.map((z, i) => Math.max(z, zs[i - 1] ?? 1, zs[i + 1] ?? 1));
    if (smooth.some((z) => z > 1)) T.introZoom = smooth;
    // The opening as one sees it is over once she moves no more than in her idle loop and the picture
    // is framed as when she rests; what follows (a few seconds on most new lobbies) looks just like
    // the idle loop, and waiting through it felt like the lobby ignoring touches.
    const moves = poses.slice(1).map((p, i) => moveOf(poses[i], p));
    const limit = idleMoves.length ? Math.max(2.5 * median(idleMoves), 2) : 8 * median(moves);
    let last = -1;
    moves.forEach((m, i) => { if (m > limit) last = i + 1; });
    const sc = T.scene;
    const off = (r) => !r || Math.max(Math.abs(r.x0 - sc.x0), Math.abs(r.x1 - sc.x1)) / (sc.x1 - sc.x0) > 0.03 || Math.max(Math.abs(r.y0 - sc.y0), Math.abs(r.y1 - sc.y1)) / (sc.y1 - sc.y0) > 0.03;
    rects.forEach((r, i) => { if (off(r)) last = Math.max(last, i); });
    // (and never before the opening's own lines are said: a touch would talk over them)
    let talk = -1;
    for (const tl of start.timelines) for (const ev of tl.events ?? []) if (ev.data?.name === 'Talk') talk = Math.max(talk, ev.time);
    if (last >= 0) T.introGate = Math.min(start.duration, Math.max((last + 1) * STEP + 0.3, talk >= 0 ? talk + 3 : 0));
    return smooth.length ? Math.max(...smooth) : 0;
  };
  // every frame: the opening's zoom at its current time (none once it is over)
  T.zoomTick = () => {
    if (!T.base) return;
    const e = main()?.state.tracks[0];
    let z = 1;
    const zs = T.introZoom;
    if (zs && e && /^Start_/i.test(e.animation.name) && e.trackTime < e.animationEnd) {
      const f = e.trackTime / STEP;
      const i = Math.min(zs.length - 1, Math.floor(f));
      const j = Math.min(zs.length - 1, i + 1);
      const u = Math.min(1, f - i);
      z = zs[i] + (zs[j] - zs[i]) * (0.5 - Math.cos(u * Math.PI) / 2);
    }
    if (Math.abs(z - (T.zoomNow ?? 1)) < 1e-4) return;
    T.zoomNow = z;
    const { k, x, y } = T.base;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    for (const s of spines()) {
      s.scale.set(k * z);
      s.position.set(cx + (x - cx) * z, cy + (y - cy) * z);
    }
  };

  // Measure again (a layer's pictures may still have been on their way to the graphics card the
  // first time) and reframe if the picture moved. While loading, T.settle() does it in the idle
  // pose, then the intro starts over; T.recheck() does it once the intro is over, without
  // touching the animations.
  T.settle = () => {
    measureScene(); // the idle pose
    return T.recheck();
  };
  T.recheck = () => {
    if (T.inIntro()) return false; // (only the resting pose is the lobby's picture)
    const o = T.scene;
    const r = o && measureDrawn();
    if (!r) return false;
    const w = o.x1 - o.x0;
    const h = o.y1 - o.y0;
    const off = Math.max(Math.abs(r.x0 - o.x0) / w, Math.abs(r.x1 - o.x1) / w, Math.abs(r.y0 - o.y0) / h, Math.abs(r.y1 - o.y1) / h);
    if (off < 0.02) return false;
    T.scene = r;
    if (T.measured) {
      T.measured.drawn = r;
      T.measured.moves = (T.measured.moves ?? 0) + 1;
    }
    place();
    return true;
  };

  // The viewer only animates its first layer; in the game every layer of a lobby (background,
  // student, foreground) plays its intro and then idles, together. Lobbies of DEV_TRACK also play
  // their Dev_Start_Idle_01 over it on another track (DEV): that is where Momoi keeps her white
  // flash before she settles, seen in a recording of the game. In SCENE_FIRST lobbies the
  // opening's own scene (Momoi's street, Wakamo's city) plays first, over the lobby; the lobby's
  // layers start as it ends, through a white flash, and the scene is gone.
  // offset: seconds into the intro to start at (to match the lobby music, already playing)
  const DEV = 6;
  // seconds the scene plays before the lobby's own layers start (0: no scene)
  const sceneLead = () => {
    const sc = spines().find((s) => sceneOf(s) && has(s, 'Start_Idle_01'));
    return sc ? dataOf(sc).findAnimation('Start_Idle_01').duration : 0;
  };
  T.lead = 0;
  // the white flash between the scene and the lobby (the game's own, not in the rigs)
  let flashEl = null;
  let flashTimer = 0;
  T.flash = (at) => {
    clearTimeout(flashTimer);
    if (!flashEl) {
      flashEl = document.createElement('div');
      flashEl.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:2;transition:opacity 0.15s ease-in';
      document.body.append(flashEl);
    }
    flashEl.style.opacity = '0';
    if (at === false) return;
    flashTimer = setTimeout(() => {
      flashEl.style.transition = 'opacity 0.15s ease-in';
      flashEl.style.opacity = '1';
      flashTimer = setTimeout(() => {
        flashEl.style.transition = 'opacity 0.4s ease-out';
        flashEl.style.opacity = '0';
      }, 180);
    }, Math.max(0, at * 1000 - 150));
  };
  // plays `name` on `track` from `t` seconds, or after -t seconds (an empty animation meanwhile)
  const playAt = (s, track, name, t) => {
    if (t >= 0) {
      s.state.setAnimation(track, name, false).trackTime = t;
      return;
    }
    s.state.setEmptyAnimation(track, 0);
    s.state.addAnimation(track, name, false, -t);
  };
  T.animate = (offset = 0) => {
    T.hush();
    for (const s of spines()) {
      const start = has(s, 'Start_Idle_01');
      // a layer with an intro but no idle loop stays on the intro's last frame
      const idle = has(s, 'Idle_01') ? 'Idle_01' : start ? '' : dataOf(s).animations[0]?.name;
      s.__tyranLead = sceneOf(s) ? 0 : T.lead;
      if (sceneOf(s)) s.visible = true;
      if (start) {
        playAt(s, 0, 'Start_Idle_01', offset - s.__tyranLead);
        if (idle) s.state.addAnimation(0, idle, true, 0);
        if (only(DEV_TRACK) && has(s, 'Dev_Start_Idle_01')) {
          playAt(s, DEV, 'Dev_Start_Idle_01', offset - s.__tyranLead);
          s.state.addEmptyAnimation(DEV, 0.2, 0);
        } else s.state.clearTrack(DEV);
      } else if (idle) s.state.setAnimation(0, idle, true);
    }
    T.flash(T.lead > offset ? T.lead - offset : false);
    console.debug('tyran:intro'); // TyranWeb keeps the lobby music in step
  };
  // puts the intro at `t` seconds (the music's own clock), when it is more than a frame or two off
  T.seekIntro = (time) => {
    for (const s of spines()) {
      const t = time - (s.__tyranLead ?? 0);
      for (const e of [s.state.tracks[0], s.state.tracks[DEV]]) {
        if (t < 0 || !e || !/^(Dev_)?Start_/.test(e.animation.name) || Math.abs(e.trackTime - t) <= 0.03) continue;
        if (t > e.trackTime) {
          e.trackTime = t;
          continue;
        }
        // Going back: Spine takes it for a loop and fires every later voice event at once (the
        // opening line said early, then again on time), and events in between would come twice. So
        // step back only when none lies in between, telling the track it already was there.
        const from = e.trackTime;
        if (e.animation.timelines.some((tl) => tl.events?.some((ev) => ev.time > t && ev.time <= from))) continue;
        e.trackTime = e.trackLast = e.nextTrackLast = t;
        e.animationLast = e.nextAnimationLast = t;
      }
    }
  };

  // ---- touch, read from each student's own rig (every lobby places its touch points differently):
  // drag on the head to pat, drag on the cheeks to pinch (lobbies that have it), drag anywhere
  // else and she follows with her eyes, tap to talk.
  const touch = { mode: '', start: null, at: null, eye: { x: 0, y: 0 }, key: { x: 0, y: 0 }, cheek: null, pull: { x: 0, y: 0 }, down: 0 };
  // Can an animation repeat without a jump (its last pose is its first)? Some rigs' pat / look
  // animations are a one-way move into the pose (Tsumugi's head tilt): played in a loop they snap
  // back to the start every time. Those play once and hold their last frame. Measured on a spare
  // skeleton, so the one on screen is never touched.
  const seamless = (s, name) => {
    s.__tyranSeam ||= {};
    if (name in s.__tyranSeam) return s.__tyranSeam[name];
    let ok = true;
    try {
      const anim = dataOf(s).findAnimation(name);
      const sk = new s.skeleton.constructor(dataOf(s));
      const pose = (t) => {
        sk.setToSetupPose();
        anim.apply(sk, t, t, false, [], 1, 0, 0);
        return sk.bones.map((b) => [b.x, b.y, b.rotation, b.scaleX, b.scaleY]);
      };
      if (anim.duration > 0) {
        const a = pose(0);
        const b = pose(anim.duration);
        ok = a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) <= 2 && Math.abs(((p[2] - b[i][2] + 540) % 360) - 180) <= 1 && Math.abs(p[3] - b[i][3]) <= 0.01 && Math.abs(p[4] - b[i][4]) <= 0.01);
      }
    } catch {
      /* (could not measure: keep the loop) */
    }
    return (s.__tyranSeam[name] = ok);
  };
  // starts a pat / pinch / look animation, faded in over a few frames (no snap into the pose)
  const play = (s, a, m, loop) => {
    for (const [track, name] of [[1, a], [2, m]]) {
      if (!has(s, name)) continue;
      const cur = s.state.tracks[track];
      if (!cur) s.state.setEmptyAnimation(track, 0);
      const e = cur ? s.state.setAnimation(track, name, loop && seamless(s, name)) : s.state.addAnimation(track, name, loop && seamless(s, name), 0);
      e.mixDuration = 0.15;
    }
  };
  const finish = (s, a, m) => {
    play(s, a, m, false);
    s.state.addEmptyAnimation(1, 0.2, 0);
    s.state.addEmptyAnimation(2, 0.2, 0);
  };
  const world = (s, x, y) => s.toLocal({ x, y });
  const at = (b) => ({ x: b.worldX, y: b.worldY });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // bone names vary in case between lobbies (Touch_Point_Key / Touch_Point_key)
  const findBone = (s, ...names) => {
    for (const n of names) {
      const b = s.skeleton.bones.find((x) => x.data.name.toLowerCase() === n.toLowerCase());
      if (b) return b;
    }
    return null;
  };
  const rig = (s) => {
    if (s.__tyranRig) return s.__tyranRig;
    const point = findBone(s, 'Touch_Point');
    const eye = findBone(s, 'Touch_Eye');
    const chin = findBone(s, 'Chin_Con', 'Chin');
    const constrained = new Set([...s.skeleton.transformConstraints, ...s.skeleton.ikConstraints].flatMap((c) => c.bones));
    // the head-to-eyes distance sets the size of the touch areas, so they follow each lobby's framing
    const unit = point && eye ? Math.min(600, Math.max(120, dist(at(point), at(eye)))) : 250;
    return (s.__tyranRig = {
      point,
      eye,
      pointKey: findBone(s, 'Touch_Point_Key'),
      eyeKey: findBone(s, 'Touch_Eye_Key'),
      // a chin that no constraint moves is pulled directly (Hikari); otherwise it follows Touch_Point_Key
      chin: chin && !constrained.has(chin) ? chin : null,
      pinch: !!pinchAnim(s, 'A') || !!pinchAnim(s, 'M'),
      cheeks: cheeksOf(s),
      unit,
    });
  };
  // A rig's pinch animations go by a few names (Pinch_01_A / _M, or just Pinch_01 as Reisa's).
  const pinchAnim = (s, part) => ['Pinch_01_' + part, part === 'A' ? 'Pinch_01' : ''].find((n) => n && has(s, n)) || '';
  // The cheeks a finger pulls: the bones the rig's own pinch-release animation (PinchEnd) springs
  // back, which are what its cheek pictures hang on: both cheeks on some (Hikari), only one on others
  // (Fubuki, Hiyori, Kei). Middle bones (the chin) and bones hanging under another one of them
  // (a cheek's tip) are left out.
  const cheeksOf = (s) => {
    const d = dataOf(s);
    const end = d.findAnimation('PinchEnd_01_M') ?? d.findAnimation('PinchEnd_01_A') ?? d.animations.find((a) => /^PinchEnd/i.test(a.name));
    if (!end) return [];
    const set = new Set();
    for (const t of end.timelines) {
      const b = t.boneIndex !== undefined ? s.skeleton.bones[t.boneIndex] : null;
      if (!b) continue;
      const n = b.data.name;
      if (!/cheek|chin|hoho/i.test(n) || /^(m_)?chin(_con)?$/i.test(n)) continue;
      set.add(b);
    }
    const under = (b) => {
      for (let p = b.parent; p; p = p.parent) if (set.has(p)) return true;
      return false;
    };
    return [...set].filter((b) => !under(b));
  };
  // a slot's picture corners, in skeleton space (Spine 4.2 and the older runtimes)
  const vertsOf = (slot) => {
    const att = slot.attachment;
    if (!att || typeof att.computeWorldVertices !== 'function' || slot.color.a < 0.3) return null;
    const mesh = 'worldVerticesLength' in att;
    const verts = new Float32Array(mesh ? att.worldVerticesLength : 8);
    try {
      if (mesh) att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
      else att.computeWorldVertices(slot, verts, 0, 2);
    } catch {
      try {
        att.computeWorldVertices(slot.bone, verts, 0, 2); // (Spine 3.8 regions)
      } catch {
        return null;
      }
    }
    return verts;
  };
  // The face as the rig draws it, from its eye and brow pictures: where the two eyes are (the line
  // between them gives the head's tilt), how wide they span, and how high the brows reach. `up0`
  // (Touch_Eye towards Touch_Point) only says which side is the top of the head.
  const faceOf = (s, eye, up0, reach = 0) => {
    const parts = [];
    for (const slot of s.skeleton.slots) {
      const name = slot.data.name;
      const brow = /brow/i.test(name);
      if (!brow && !/eye/i.test(name)) continue;
      const v = vertsOf(slot);
      if (!v) continue;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < v.length; i += 2) {
        cx += v[i];
        cy += v[i + 1];
      }
      cx /= v.length / 2;
      cy /= v.length / 2;
      parts.push({ brow, v, c: { x: cx, y: cy }, d: Math.hypot(cx - eye.x, cy - eye.y) });
    }
    // only her own eyes: the pictures nearest Touch_Eye (a lobby can show a second face, in a
    // mirror or a photo, whose eyes would stretch the measure)
    const all = parts.filter((p) => !p.brow).sort((a, b) => a.d - b.d);
    if (!all.length) return null;
    const near = Math.max(all[Math.min(1, all.length - 1)].d, 1);
    // (reach: the eyes-to-head distance; Touch_Eye can sit close to one eye, the other one is further)
    const eyes = all.filter((p) => p.d <= Math.max(near * 2.6, reach));
    // the two eyes: the pictures split in two groups across the face
    const side0 = { x: -up0.y, y: up0.x };
    const across = (p) => (p.c.x - eye.x) * side0.x + (p.c.y - eye.y) * side0.y;
    let g1 = Math.min(...eyes.map(across));
    let g2 = Math.max(...eyes.map(across));
    let left = [];
    let right = [];
    for (let k = 0; k < 6; k++) {
      left = eyes.filter((p) => Math.abs(across(p) - g1) <= Math.abs(across(p) - g2));
      right = eyes.filter((p) => Math.abs(across(p) - g1) > Math.abs(across(p) - g2));
      if (!left.length || !right.length) break;
      g1 = left.reduce((n, p) => n + across(p), 0) / left.length;
      g2 = right.reduce((n, p) => n + across(p), 0) / right.length;
    }
    const centre = (list) => ({ x: list.reduce((n, p) => n + p.c.x, 0) / list.length, y: list.reduce((n, p) => n + p.c.y, 0) / list.length });
    let up = up0;
    let mid = eye;
    if (left.length && right.length) {
      const a = centre(left);
      const b = centre(right);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 10) {
        up = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
        if (up.x * up0.x + up.y * up0.y < 0) up = { x: -up.x, y: -up.y };
        mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    }
    const side = { x: -up.y, y: up.x };
    let a0 = Infinity;
    let a1 = -Infinity;
    for (const p of eyes) {
      for (let i = 0; i < p.v.length; i += 2) {
        const t = (p.v[i] - mid.x) * side.x + (p.v[i + 1] - mid.y) * side.y;
        a0 = Math.min(a0, t);
        a1 = Math.max(a1, t);
      }
    }
    if (!(a1 - a0 > 10)) return null;
    let browTop = -Infinity;
    for (const p of parts) {
      if (!p.brow || p.d > near * 3.2) continue;
      for (let i = 0; i < p.v.length; i += 2) browTop = Math.max(browTop, (p.v[i] - mid.x) * up.x + (p.v[i + 1] - mid.y) * up.y);
    }
    // (the eyes' middle, moved to the middle of their full width)
    const c = { x: mid.x + side.x * ((a0 + a1) / 2), y: mid.y + side.y * ((a0 + a1) / 2) };
    return { c, up, span: a1 - a0, brow: Number.isFinite(browTop) && browTop > 0 ? browTop : null };
  };
  // The touch areas. Each rig gives two points (Touch_Point on the head, Touch_Eye between the
  // eyes); the areas are sized by the rig's own face: the top of the head, above the brows, to
  // pat; the two cheeks, just below the eyes, to pinch (rigs that have it). Everywhere else, the
  // face included, a drag makes her eyes follow. (The Vùng chạm button draws exactly these.)
  const zonesOf = (s) => {
    const r = rig(s);
    const eye = r.eye && at(r.eye);
    const point = r.point && at(r.point);
    if (!eye && !point) return [];
    // which way the top of the head is: from the eyes to the head's touch point, then (faceOf) square
    // to the line between her eyes
    const len = eye && point ? dist(eye, point) : 0;
    const up0 = len > 1 ? { x: (point.x - eye.x) / len, y: (point.y - eye.y) / len } : { x: 0, y: -1 };
    const f = eye && faceOf(s, eye, up0, 0.9 * len);
    const up = f ? f.up : up0;
    const side = { x: -up.y, y: up.x };
    // the face's width (the eyes take about two thirds of it); without eye pictures, from the points
    const W = f ? f.span * 1.5 : 2.2 * r.unit;
    const c = f ? f.c : eye || point;
    const brow = f?.brow ?? 0.22 * W;
    const along = (d, across = 0) => ({ x: c.x + up.x * d + side.x * across, y: c.y + up.y * d + side.y * across });
    const out = [];
    if (point && (has(s, 'Pat_01_A') || has(s, 'Pat_01_M'))) {
      out.push({ kind: 'pat', ...along(brow + 0.42 * W), r: 0.55 * W, cut: eye ? { x: c.x, y: c.y, nx: up.x, ny: up.y, d: brow } : null });
    }
    // (each cheek with its way out of the face: from the middle of the face to it)
    const outOf = (p) => {
      const d = dist(p, c);
      return d > 1e-3 ? { x: (p.x - c.x) / d, y: (p.y - c.y) / d } : side;
    };
    if (r.pinch && r.cheeks.length) for (const b of r.cheeks) out.push({ kind: 'pinch', ...at(b), r: 0.12 * W, bone: b, out: outOf(at(b)) });
    else if (r.pinch && eye) for (const k of [-1, 1]) out.push({ kind: 'pinch', ...along(-0.13 * W, k * 0.27 * W), r: 0.1 * W, out: { x: side.x * k, y: side.y * k } });
    return out;
  };
  const inZone = (z, p) => dist(p, z) < z.r && (!z.cut || (p.x - z.cut.x) * z.cut.nx + (p.y - z.cut.y) * z.cut.ny >= z.cut.d);
  // which area a point (in skeleton space) falls in
  const areaOf = (s, p) => {
    const hit = zonesOf(s)
      .filter((z) => inZone(z, p))
      .sort((a, b) => dist(p, a) / a.r - dist(p, b) / b.r)[0];
    touch.cheek = hit?.bone ?? null;
    touch.cheekOut = hit?.out ?? null;
    return hit ? hit.kind : 'look';
  };
  // move a bone by a vector given in skeleton space, on top of whatever the animations did
  const nudge = (b, off) => {
    if (!b || !b.parent || (!off.x && !off.y)) return;
    const p = b.parent;
    const local = p.worldToLocal({ x: p.worldX + off.x, y: p.worldY + off.y });
    b.x += local.x;
    b.y += local.y;
  };
  const hook = (s) => {
    if (s.__tyranHook) return;
    s.__tyranHook = true;
    const st = s.state;
    const apply = st.apply.bind(st);
    st.apply = (skel) => {
      const r = rig(s);
      const moved = [r.pointKey, r.eyeKey, r.chin, ...r.cheeks].filter(Boolean);
      // start from the setup pose so the animation's own motion is kept and offsets never pile up
      for (const b of moved) {
        b.x = b.data.x;
        b.y = b.data.y;
      }
      const res = apply(skel);
      const u = r.unit;
      const want = (modes, from, limit, gain) => {
        if (!modes.includes(touch.mode) || !touch.at || !from) return { x: 0, y: 0 };
        let dx = (touch.at.x - from.x) * gain;
        let dy = (touch.at.y - from.y) * gain;
        const len = Math.hypot(dx, dy);
        if (len > limit) {
          dx *= limit / len;
          dy *= limit / len;
        }
        return { x: dx, y: dy };
      };
      const ease = (cur, target) => {
        cur.x += (target.x - cur.x) * 0.25;
        cur.y += (target.y - cur.y) * 0.25;
      };
      // A pinched cheek is pulled out of the face only: the part of the drag going back into the face
      // does nothing. Half the finger's way, as far as about a third of the head's size; Hikari's as
      // far as before (two thirds), as the user keeps it.
      const pk = T.key === 'ch0242_home' ? 1 : 0.5;
      const outward = (v) => {
        const o = touch.mode === 'pinch' && touch.cheekOut;
        if (!o) return v;
        const d = v.x * o.x + v.y * o.y;
        return d >= 0 ? v : { x: v.x - d * o.x, y: v.y - d * o.y };
      };
      ease(touch.eye, want(['look'], r.eye && at(r.eye), 0.35 * u, 0.12));
      ease(touch.key, touch.mode === 'pinch' ? outward(want(['pinch'], touch.start, 0.45 * pk * u, 0.6 * pk)) : want(['pat'], touch.start, 0.45 * u, 0.6));
      ease(touch.pull, outward(want(['pinch'], touch.start, 0.7 * pk * u, pk)));
      nudge(r.eyeKey, touch.eye);
      nudge(r.pointKey, touch.key);
      if (touch.keyFrom === 'pinch') {
        if (touch.pinched) nudge(touch.pinched, touch.pull);
        else nudge(r.chin, touch.key);
      }
      return res;
    };
  };

  // ---- the touch areas drawn over the lobby (the Vùng chạm button): the same ones areaOf reads, so
  // they follow each student's rig and move with her animations
  let zones = null; // { canvas, raf, hidden }
  T.zonesTop = 0;
  T.zones = (on, top) => {
    if (typeof top === 'number') T.zonesTop = top;
    if (zones) {
      cancelAnimationFrame(zones.raf);
      zones.canvas.remove();
      zones = null;
    }
    if (!on) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'tyran-zones';
    canvas.style.cssText = 'pointer-events:none;z-index:2147483647';
    document.body.appendChild(canvas);
    zones = { canvas, raf: 0, hidden: false };
    const z = zones;
    const draw = () => {
      z.raf = requestAnimationFrame(draw);
      const dpr = devicePixelRatio || 1;
      const w = Math.round(innerWidth * dpr);
      const hgt = Math.round(innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== hgt) [canvas.width, canvas.height] = [w, hgt];
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, innerWidth, innerHeight);
      const s = main();
      if (z.hidden || !s || !s.skeleton.bones.length || !s.worldTransform) return;
      const r = rig(s);
      // the same areas the touches are matched against (zonesOf), on the screen
      const zs = zonesOf(s);
      const scr = (p) => s.toGlobal(p);
      // a zone's outline as a path: its circle, and for the head the part above the cut only
      const shape = (z) => {
        const c = scr(z);
        const e = scr({ x: z.x + z.r, y: z.y });
        const rad = Math.hypot(e.x - c.x, e.y - c.y);
        return { c, rad };
      };
      const clipCut = (z) => {
        if (!z.cut) return;
        const k = z.cut;
        const big = 4 * z.r;
        const o = { x: k.x + k.nx * k.d, y: k.y + k.ny * k.d }; // a point on the cut line
        const side = { x: -k.ny, y: k.nx };
        const pts = [
          { x: o.x - side.x * big, y: o.y - side.y * big },
          { x: o.x + side.x * big, y: o.y + side.y * big },
          { x: o.x + side.x * big + k.nx * big, y: o.y + side.y * big + k.ny * big },
          { x: o.x - side.x * big + k.nx * big, y: o.y - side.y * big + k.ny * big },
        ].map(scr);
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.clip();
      };
      const fillZone = (z, style) => {
        const { c, rad } = shape(z);
        g.save();
        clipCut(z);
        g.beginPath();
        g.arc(c.x, c.y, rad, 0, Math.PI * 2);
        g.fillStyle = style;
        g.fill();
        g.restore();
      };
      const COLORS = { pat: '255, 105, 160', pinch: '255, 170, 60' };
      // everywhere else (the face too): a drag there and her eyes follow it, tinted lightly
      const look = !!r.eye && (has(s, 'Look_01_A') || has(s, 'Look_01_M'));
      if (look) {
        g.fillStyle = 'rgba(90, 190, 255, 0.10)';
        g.fillRect(0, 0, innerWidth, innerHeight);
        g.globalCompositeOperation = 'destination-out';
        for (const z of zs) fillZone(z, '#000');
        g.globalCompositeOperation = 'source-over';
      }
      for (const z of zs) {
        fillZone(z, `rgba(${COLORS[z.kind]}, 0.18)`);
        const { c, rad } = shape(z);
        g.save();
        clipCut(z);
        g.beginPath();
        g.arc(c.x, c.y, rad, 0, Math.PI * 2);
        g.lineWidth = 2;
        g.setLineDash([8, 6]);
        g.strokeStyle = `rgba(${COLORS[z.kind]}, 0.95)`;
        g.stroke();
        g.restore();
        // the cut, drawn inside the circle
        if (z.cut) {
          const k = z.cut;
          const o = { x: k.x + k.nx * k.d, y: k.y + k.ny * k.d };
          const a = scr({ x: o.x + k.ny * 1.2 * z.r, y: o.y - k.nx * 1.2 * z.r });
          const b = scr({ x: o.x - k.ny * 1.2 * z.r, y: o.y + k.nx * 1.2 * z.r });
          g.save();
          g.beginPath();
          g.arc(c.x, c.y, rad, 0, Math.PI * 2);
          g.clip();
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.lineWidth = 2;
          g.setLineDash([8, 6]);
          g.strokeStyle = `rgba(${COLORS[z.kind]}, 0.95)`;
          g.stroke();
          g.restore();
        }
      }
    };
    draw();
  };
  // the areas' centres on the screen (for checking them from outside)
  T.zonesNow = () => {
    const s = main();
    return s ? zonesOf(s).map((z) => ({ kind: z.kind, ...s.toGlobal(z) })) : [];
  };
  // what the areas were measured from (for checking them from outside)
  T.faceInfo = () => {
    const s = main();
    const r = s && rig(s);
    if (!r?.eye || !r.point) return null;
    const eye = at(r.eye);
    const point = at(r.point);
    const len = dist(eye, point);
    const up = { x: (point.x - eye.x) / len, y: (point.y - eye.y) / len };
    return { eye: s.toGlobal(eye), point: s.toGlobal(point), len, face: faceOf(s, eye, up), slots: s.skeleton.slots.filter((x) => /eye|brow/i.test(x.data.name) && vertsOf(x)).map((x) => x.data.name) };
  };
  // where a touch stands (for checking from outside)
  T.touchState = () => ({ mode: touch.mode, area: touch.area, cheek: touch.cheek?.data.name ?? '', pinched: touch.pinched?.data.name ?? '', from: touch.keyFrom ?? '' });
  // (kept out of the pictures TyranWeb takes of the lobby)
  T.zonesHide = (hide) => {
    if (zones) zones.hidden = !!hide;
  };

  T.talk = () => {
    const s = main();
    if (!s) return false;
    const talks = dataOf(s).animations.map((a) => a.name).filter((n) => /^Talk_\d+_A$/.test(n));
    if (!talks.length) return false;
    const a = talks[Math.floor(Math.random() * talks.length)];
    const base = a.replace(/_A$/, '');
    finish(s, a, base + '_M');
    T.speak(s, base);
    talkStarted(dataOf(s).findAnimation(a).duration);
    // lobbies with a second character give it its own mouth tracks
    for (const [track, suffix] of [[3, '_M2'], [4, '_M3']]) {
      if (has(s, base + suffix)) {
        s.state.setAnimation(track, base + suffix, false);
        s.state.addEmptyAnimation(track, 0.2, 0);
      }
    }
    return true;
  };

  const stop = (e) => {
    if (!e.isTrusted) return; // TyranWeb's own scripted clicks (voice / music switches) must reach the page
    e.stopImmediatePropagation();
    if (e.cancelable && e.type !== 'pointermove') e.preventDefault();
  };
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'contextmenu', 'selectstart']) {
    addEventListener(type, stop, { capture: true, passive: false });
  }
  addEventListener(
    'pointerdown',
    (e) => {
      stop(e);
      const s = main();
      // no touch during the lobby's opening, while she is still talking, or just after (no spamming)
      if (!s || e.button !== 0 || T.busy()) return;
      hook(s);
      touch.down = performance.now();
      touch.start = world(s, e.clientX, e.clientY);
      touch.at = touch.start;
      touch.mode = '';
      touch.client = [e.clientX, e.clientY];
      touch.moved = false;
      touch.area = areaOf(s, touch.start);
    },
    { capture: true }
  );
  addEventListener(
    'pointermove',
    (e) => {
      stop(e);
      const s = main();
      if (!s || !touch.start) return;
      touch.at = world(s, e.clientX, e.clientY);
      const far = Math.hypot(e.clientX - touch.client[0], e.clientY - touch.client[1]) > 6;
      if (far) touch.moved = true;
      // a cheek is pinched by pulling it out of the face: a drag into the face does nothing (not even a tap)
      const intoFace = touch.area === 'pinch' && touch.cheekOut && (touch.at.x - touch.start.x) * touch.cheekOut.x + (touch.at.y - touch.start.y) * touch.cheekOut.y <= 0;
      if (!touch.mode && far && !intoFace) {
        touch.mode = touch.area;
        if (touch.mode !== 'look') touch.keyFrom = touch.mode;
        if (touch.mode === 'pinch') touch.pinched = touch.cheek; // (it springs back with the key once let go)
        if (touch.mode === 'pat') play(s, 'Pat_01_A', 'Pat_01_M', true);
        else if (touch.mode === 'pinch') play(s, pinchAnim(s, 'A'), pinchAnim(s, 'M'), true);
        else play(s, 'Look_01_A', 'Look_01_M', true);
      }
    },
    { capture: true }
  );
  const release = (e) => {
    stop(e);
    const s = main();
    if (!s || !touch.start) return;
    if (touch.mode === 'pat') finish(s, 'PatEnd_01_A', 'PatEnd_01_M');
    else if (touch.mode === 'pinch') finish(s, 'PinchEnd_01_A', 'PinchEnd_01_M');
    else if (touch.mode === 'look') finish(s, 'LookEnd_01_A', 'LookEnd_01_M');
    else if (performance.now() - touch.down < 600 && !touch.moved) T.talk();
    if (touch.mode) T.calm(500); // let the pat / look settle before the next touch
    touch.mode = '';
    touch.start = touch.at = null;
  };
  addEventListener('pointerup', release, { capture: true });
  addEventListener('pointercancel', release, { capture: true });

  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(T.fit, 60);
  });
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let baRun = 0;
let namesSaved = false;
let liveBusy = false; // a paused (hidden) page cannot finish loading the scene

async function setupBlueArchive(wv, web) {
  const run = ++baRun;
  let failed = false;
  markBa(wv, { type: 'web', web });
  // cover the scene with the dim layer until it is loaded and sized
  $('#wallpaper').classList.add('framing');
  loadingStart(web); // (already showing for a new lobby; back from a failure after Tải lại)
  // a lobby listed twice is shown through the entry that works (Airi, Ibuki)
  const info = await lobbyInfo(web.model || 'shiroko_home');
  if (info?.hidden && info.alt) {
    api.invoke('settings:set', { wallpaper: { web: { model: info.alt } } });
    liveBusy = false;
    return; // (the loading screen stays on for the other entry)
  }
  liveBusy = true;
  updateMotion();
  try {
    const r = await prepareBlueArchive(wv, web, { ui: true, alive: () => run === baRun, info });
    failed = r !== 'ok';
    if (r === 'ok') await startBlueArchive(wv, web, run);
  } catch {
    /* viewer changed or went away */
  } finally {
    if (run === baRun) {
      $('#wallpaper').classList.remove('framing');
      if (!failed) loadingDone();
      liveBusy = false;
      updateMotion();
    }
  }
}

// The memorial lobby made ready to show: the viewer opened, the student picked and loaded, the scene
// framed and its opening measured, waiting at its first frame (__tyran.loading). With `ui` the
// loading screen tells how far it is and why it failed (a lobby the viewer cannot read is counted,
// and may switch to its working twin); without (loaded ahead, out of sight) it only answers.
// 'ok', 'failed', or 'gone' (not wanted any more, or handed on).
async function prepareBlueArchive(wv, web, { ui, alive, info }) {
  const js = (code) => wv.executeJavaScript(code);
  const step = (p, text) => ui && loadingStep(p, text);
  const broken = async (why) => {
    if (!ui) return 'failed';
    const next = await brokenLobby(web.model);
    if (next === 'retry') {
      setTimeout(() => setupBlueArchive(wv, web)); // (the same lobby, from the other source)
      return 'gone';
    }
    if (next === true) return 'gone';
    loadingFail(why, next === 'later' ? t('Bấm Tải lại ở thanh Lobby để thử lại.') : t('Hãy chọn học sinh khác ở thanh Lobby hoặc Cài đặt → Hình nền.'));
    return 'failed';
  };
  await wv.insertCSS(BA_CSS);
  step(0.2, t('Đang mở trình xem…'));
  for (let i = 0; i < 150 && !(await js(`(${blueArchivePage})() && __tyran.ready()`)); i++) {
    // a lobby the viewer cannot read never lists any animation
    if (i > 25 && (await js('__tyran.attach() && __tyran.empty()'))) break;
    await sleep(150);
  }
  if (!alive()) return 'gone';
  if (!namesSaved) {
    namesSaved = true;
    api.invoke('wallpapers:baNames', await js('[...document.getElementById("model").options].map((o) => o.text)')).catch(() => {});
  }
  step(0.4, t('Đang tải học sinh…'));
  const before = await js('__tyran.anims()');
  const pick = JSON.stringify([web.model || 'shiroko_home', info?.urls || null, info?.voices || '']).slice(1, -1);
  const changed = (await js(`((r) => (r < 0 ? __tyran.pick('shiroko_home') : r))(__tyran.pick(${pick}))`)) > 0;
  // wait for the new student's animations to replace the old list
  for (let i = 0; changed && i < 100 && (await js('__tyran.anims()')) === before; i++) await sleep(150);
  await js(`__tyran.audio(${!!web.audio}); ${zonesScript(S.settings.wallpaper.web?.touchZones)}; __tyran.loading = true`); // no opening until it is shown
  step(0.7, t('Đang dựng cảnh…'));
  // wait for the student; a slow connection only makes this longer (up to about a minute)
  for (let i = 0; i < 400 && !(await js('__tyran.attach()')); i++) {
    if (!alive()) return 'gone';
    if (i === 60) step(0.72, t('Mạng chậm, vẫn đang tải…'));
    await sleep(150);
  }
  // a few lobbies use files the viewer cannot read (their skeleton comes out empty)
  if (await js('__tyran.empty()')) return broken(t('Trình xem Blue Archive chưa đọc được dữ liệu của sảnh này.'));
  if (!(await js('__tyran.attach()'))) {
    if (ui) loadingFail(t('Sảnh chưa tải xong sau một phút (mạng chậm hoặc trang ba.svdex.moe không phản hồi).'), t('Bấm Tải lại ở thanh Lobby để thử lại.'));
    return 'failed';
  }
  await js(`__tyran.volume(${voiceVolume(web)})`);
  await sleep(300); // extra layers (backgrounds) are added right after the student
  // their pictures (the framing is measured from them) may take a little longer
  for (let i = 0; i < 33 && !(await js('__tyran.texturesReady()')); i++) await sleep(150);
  step(0.9, t('Đang căn khung hình…'));
  await js('__tyran.fit()');
  // measure until the picture holds still (at most ~3 s), then play the intro from its start
  for (let i = 0, still = 0; i < 10 && still < 2; i++) {
    await sleep(300);
    still = (await js('__tyran.settle()')) ? 0 : still + 1;
  }
  step(0.93, t('Đang chuẩn bị đoạn mở đầu…'));
  await js('__tyran.measureIntro()').catch(() => 0);
  // some lobbies load without drawing anything (missing pictures in the viewer's data)
  if (await js('!(__tyran.measured && (__tyran.measured.drawn ?? __tyran.measured.slots))')) return broken(t('Trình xem Blue Archive không vẽ được hình nào của sảnh này.'));
  return alive() ? 'ok' : 'gone';
}

// The memorial lobby started: its song buffered at its start (at most 10 s), started, and the intro
// started at the point the song has really reached.
async function startBlueArchive(wv, web, run) {
  const js = (code) => wv.executeJavaScript(code);
  loadingStep(0.95, t('Đang tải nhạc sảnh…'));
  const ask = (event, fallback, ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      emit(event, { resolve: (v) => (clearTimeout(timer), resolve(v)) });
    });
  const ready = await ask('lobby-music-prepare', false, 10000);
  if (run !== baRun) return;
  const at = ready ? await ask('lobby-start-music', -1, 2000) : -1;
  await js(`__tyran.loading = false; __tyran.animate(${at > 0 ? at + 0.015 : 0})`); // + the trip from the music to here
  wv.dataset.started = '1';
  emit('lobby-start');
  updateAutoColors();
  // YouTube's clock only really gets going a moment after it says it plays: line the intro up with
  // where the music actually is, a few times while its clock settles (moving the picture never
  // stalls, seeking the music does); within about 10 ms after the last one
  if (ready) {
    for (const ms of [1000, 2000, 3500]) {
      setTimeout(async () => {
        const m = run === baRun ? await ask('lobby-music-time', null, 600) : null;
        if (m && m.t > 0) js(`__tyran.seekIntro(${m.t + (performance.now() - m.when) / 1000 + 0.008})`).catch(() => {});
      }, ms);
    }
  }
  loadingStep(1, '');
  api.invoke('wallpapers:baWorks', web.model || 'shiroko_home').catch(() => {}); // (its failures, if any, forgotten)
  // (her normal lobby loaded ahead once the opening is over)
  afterIntro(wv, js, web.model || 'shiroko_home', run).finally(() => run === baRun && preloadSpare(wv));
}

// ---------------------------------------------------------------- loading screen
// Like the game's: the lobby's own picture (blurred) while it loads, "Now Loading" with a turning
// halo in the corner and a progress line along the bottom.
let baList = null;
async function lobbyInfo(key) {
  baList ||= await api.invoke('wallpapers:baModels').catch(() => null);
  return baList?.find((m) => m.key === key) || null;
}

// A lobby the viewer could not show: TyranWeb counts it (not while offline or out of sight), and
// once it has failed often enough to be taken for broken (the picker marks it) switches to its
// working twin when there is one (then true). 'later': not taken for broken, it may be tried again;
// 'retry': the same lobby, from the other source.
async function brokenLobby(key) {
  const counts = document.visibilityState === 'visible' && navigator.onLine;
  const r = await api.invoke('wallpapers:baBroken', key, counts).catch(() => null);
  baList = null;
  if (!r?.broken) return 'later';
  const alt = r.alt;
  if (!alt) return false;
  if (alt === key) return 'retry';
  loadingStep(0.3, t('Đang chuyển sang bản dùng được của sảnh này…'));
  api.invoke('settings:set', { wallpaper: { web: { model: alt } } });
  return true;
}

function loadingEl() {
  let el = $('#wp-loading');
  if (!el) {
    el = h('div', { id: 'wp-loading', 'aria-hidden': 'true' });
    el.innerHTML = `<div class="wpl-bg"></div><div class="wpl-corner"><div class="wpl-halo"><i></i><i></i><i></i></div><div class="wpl-text"><b>Now Loading<em>.</em><em>.</em><em>.</em></b><span class="wpl-name"></span><span class="wpl-step"></span></div></div><div class="wpl-bar"><i></i></div>`;
    $('#wallpaper').append(el);
  }
  return el;
}

function loadingStart(web) {
  const el = loadingEl();
  const key = web.model || 'shiroko_home';
  emit('lobby-loading'); // the lobby music waits for this lobby to start
  if (el.classList.contains('on') && el.dataset.key === key && !el.classList.contains('failed')) return;
  el.dataset.key = key;
  el.classList.remove('failed');
  el.querySelector('.wpl-text b').innerHTML = 'Now Loading<em>.</em><em>.</em><em>.</em>';
  el.querySelector('.wpl-name').textContent = '';
  el.querySelector('.wpl-bg').style.backgroundImage = '';
  loadingStep(0.06, t('Đang kết nối…'));
  el.classList.add('on');
  lobbyInfo(key).then((m) => {
    if (!m || el.dataset.key !== key) return;
    el.querySelector('.wpl-name').textContent = m.name;
    // the lobby's own picture when TyranWeb has shown it before, else SchaleDB's small one
    const pics = [m.preview, m.thumb].filter(Boolean);
    const next = (i) => {
      if (i >= pics.length) return;
      const img = new Image();
      img.onload = () => el.dataset.key === key && (el.querySelector('.wpl-bg').style.backgroundImage = `url("${pics[i]}")`);
      img.onerror = () => next(i + 1);
      img.src = pics[i];
    };
    next(0);
  });
}

function loadingStep(p, text) {
  const el = $('#wp-loading');
  if (!el) return;
  el.style.setProperty('--p', String(p));
  if (text) el.querySelector('.wpl-step').textContent = text;
}

function loadingDone() {
  $('#wp-loading')?.classList.remove('on', 'failed');
}

// the screen stays, saying why, instead of an empty wallpaper
function loadingFail(why, hint) {
  emit('lobby-failed'); // the lobby music stops waiting for it
  const el = loadingEl();
  el.classList.add('on', 'failed');
  el.querySelector('.wpl-text b').textContent = t('Không tải được sảnh');
  el.querySelector('.wpl-step').textContent = `${why} ${hint}`;
  el.style.setProperty('--p', '1');
}

// A picture of each lobby for the Settings picker, taken once per session after the intro.
// Before it, a second framing check in the idle pose.
const previewed = new Set();
// runs `take` (a picture of the lobby) with the touch areas off the screen
async function zonesHidden(js, take) {
  await js('window.__tyran && __tyran.zonesHide(true)').catch(() => {});
  await sleep(60); // (one frame drawn without them)
  try {
    return await take();
  } finally {
    js('window.__tyran && __tyran.zonesHide(false)').catch(() => {});
  }
}

async function afterIntro(wv, js, key, run) {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (run !== baRun || !wv.isConnected) return;
    if (await js('__tyran.idle()').catch(() => false)) break;
  }
  if (await js('__tyran.recheck()').catch(() => false)) previewed.delete(key);
  if (previewed.has(key)) return;
  await sleep(1500);
  if (run !== baRun || current.frozen || wv.style.visibility === 'hidden') return;
  previewed.add(key);
  await zonesHidden(js, () => api.invoke('wallpaper:savePreview', wv.getWebContentsId(), key)).then(
    () => ((baList = null), updateAutoColors()), // (the lobby's resting look, for its colours)
    () => previewed.delete(key)
  );
}

// Presses on the new tab's empty background (once its search bar and shortcuts are hidden) reach
// the Blue Archive lobby as real mouse input: tap to talk, drag on the head to pat, drag
// elsewhere and she follows with her eyes.
export function lobbyTouch(tab, { type, x, y } = {}) {
  const ev = { down: 'mouseDown', move: 'mouseMove', up: 'mouseUp' }[type];
  const w = S.settings.wallpaper;
  if (!ev || current.kind !== 'web' || !current.wcId || current.frozen || !['bluearchive', 'nikke', 'azurlane', 'sekai'].includes(w.web?.preset)) return;
  const page = tab.webview?.getBoundingClientRect();
  const wall = current.el.getBoundingClientRect();
  if (!page || !Number.isFinite(x) || !Number.isFinite(y)) return;
  let zoom = 1;
  try {
    zoom = tab.webview.getZoomFactor();
  } catch {
    /* not attached */
  }
  current.el.sendInputEvent({
    type: ev,
    x: Math.round(page.left + x * zoom - wall.left),
    y: Math.round(page.top + y * zoom - wall.top),
    button: 'left',
    clickCount: 1,
    modifiers: type === 'move' ? ['leftButtonDown'] : [],
  });
}

// ---------------------------------------------------------------- motion
// Videos and live pages only run while they can be seen (Settings → Hình nền → Chuyển động).
export function updateMotion() {
  if (current.kind !== 'video' && current.kind !== 'web') return;
  const motion = S.settings.wallpaper.motion || 'focus';
  const onNewtab = (active()?.url || '').startsWith(NEWTAB);
  const visible = document.visibilityState === 'visible' && !S.htmlFullscreen;
  const focused = S.window.focused !== false;
  const run = S.lobby || liveBusy || (visible && (motion === 'always' || (motion === 'focus' && focused) || (motion === 'newtab' && focused && onNewtab)));
  if (current.kind === 'video') {
    const v = current.el;
    if (run && v.paused) v.play().catch(() => {});
    else if (!run && !v.paused) v.pause();
  } else if (current.wcId && current.frozen === run) {
    current.frozen = !run;
    pauseLive(current.el, !run);
  }
}

// A hidden page stops drawing (no animation frames) and resumes cleanly when shown again, so a
// paused live wallpaper is hidden behind a snapshot of its last frame.
let pauseSeq = 0;
async function pauseLive(wv, paused) {
  const seq = ++pauseSeq;
  try {
    wv.setAudioMuted(paused || !S.settings.wallpaper.web?.audio);
  } catch {
    /* detached */
  }
  const old = wv.previousElementSibling?.classList.contains('wp-snap') ? wv.previousElementSibling : null;
  if (!paused) {
    wv.style.visibility = '';
    setTimeout(() => old?.remove(), 120);
    return;
  }
  const url = await api.invoke('wallpaper:snapshot', wv.getWebContentsId()).catch(() => null);
  if (seq !== pauseSeq || !wv.isConnected) return;
  if (url) {
    const snap = h('div', { class: 'wp-layer wp-snap in' });
    snap.style.backgroundImage = `url("${url}")`;
    snap.style.filter = wv.style.filter;
    wv.before(snap);
    old?.remove();
  }
  wv.style.visibility = 'hidden';
}

// ---------------------------------------------------------------- lobby
export function toggleLobby(force) {
  const want = force ?? !S.lobby;
  if (want === !!S.lobby) return;
  S.lobby = want;
  emit('lobby-mode', want);
  document.body.classList.toggle('lobby', want);
  $('#lobby-bar')?.remove();
  if (want) {
    const bar = lobbyBar();
    document.body.append(bar);
    // take focus away from the (now hidden) page so Esc reaches us
    if (current.kind === 'web') current.el.focus();
    else bar.querySelector('.primary').focus();
  }
  applyWallpaper();
}

function lobbyBar() {
  const w = S.settings.wallpaper;
  const btn = (label, ic, run, extra = {}) => {
    const b = h('button', { type: 'button', class: 'lobby-btn', title: label, html: `${icon(ic, 16)}<span>${label}</span>`, ...extra });
    b.addEventListener('click', run);
    return b;
  };
  const bar = h('div', { id: 'lobby-bar', role: 'toolbar', 'aria-label': t('Lobby') });
  if (w.type === 'web' && w.web?.preset === 'bluearchive') {
    const sel = h('select', { class: 'lobby-select', title: t('Học sinh') }, h('option', { value: w.web.model, text: t('Đang tải…') }));
    // the game's lobby button: her memorial lobby (1/2) or her normal one (2/2)
    const normal = normalLobby(w);
    const swap = btn(normal ? '2/2' : '1/2', 'cycle', () => toggleBaMode(), { class: 'lobby-btn lobby-ba-mode', title: normal ? t('Sảnh L2D') : t('Sảnh thường'), disabled: true });
    api.invoke('wallpapers:baModels').then((list) => {
      sel.innerHTML = '';
      // (a lobby listed twice shows once; the ones the viewer cannot show say so; the normal lobby
      // lists the students and outfits that have one)
      for (const m of list.filter((x) => !x.hidden && (!normal || x.normal))) sel.append(h('option', { value: m.key, text: m.name + (m.broken && !normal ? t(' (lỗi dữ liệu)') : ''), selected: m.key === S.settings.wallpaper.web.model }));
      swap.disabled = !list.find((x) => x.key === S.settings.wallpaper.web.model)?.normal;
    }, () => (sel.firstChild.textContent = t('Không tải được danh sách')));
    sel.addEventListener('change', () => api.invoke('settings:set', { wallpaper: { web: { model: sel.value } } }));
    bar.append(sel, swap);
  }
  if (w.type === 'web') {
    const sound = btn(w.web?.audio ? t('Tắt tiếng') : t('Bật tiếng'), w.web?.audio ? 'volume' : 'muted', () => {
      api.invoke('settings:set', { wallpaper: { web: { audio: !S.settings.wallpaper.web.audio } } }).then(() => {
        $('#lobby-bar')?.replaceWith(lobbyBar());
      });
    });
    // the lobby's overall volume, then (Blue Archive) its song and its voices on their own
    const slider = (key, ic, label) => {
      const vol = h('input', { type: 'range', class: 'lobby-volume', min: '0', max: '1', step: '0.05', title: label, 'aria-label': label, dataset: { key } });
      vol.value = String(w.web?.[key] ?? (key === 'volume' ? 0.6 : 1));
      vol.addEventListener('input', () => api.invoke('settings:set', { wallpaper: { web: { [key]: Number(vol.value) } } }));
      return h('label', { class: 'lobby-vol', title: label }, h('span', { html: icon(ic, 15) }), vol);
    };
    bar.append(sound, slider('volume', 'sliders', t('Âm lượng chung (nhạc và giọng nói)')));
    if (SONG_LOBBIES.includes(w.web?.preset)) bar.append(slider('musicVolume', 'music', t('Âm lượng nhạc')), slider('voiceVolume', 'mic', t('Âm lượng giọng nói')));
    const G = CHAR_GAMES[w.web?.preset];
    if (G) {
      // the characters downloaded so far, and buttons for her outfits and her faces
      api.invoke(G.api + ':list').then((list) => {
        const got = list.filter((c) => c.installed);
        const web = S.settings.wallpaper.web;
        const cur = got.find((c) => c.id === (web[G.who] || G.first)) || (!web[G.who] && got[0]);
        if (!bar.isConnected) return;
        if (cur?.outfits.some((o) => o.installed)) bar.querySelector('.lobby-face')?.before(btn(t('Đổi trang phục'), 'layers', () => nextNikkeOutfit()));
        if (got.length < 2) return;
        const sel = h('select', { class: 'lobby-select', title: G.api === 'azur' ? t('Tàu') : t('Nhân vật') }, ...got.map((c) => h('option', { value: c.id, text: c.name, selected: c.id === cur?.id })));
        sel.addEventListener('change', () => api.invoke('settings:set', { wallpaper: { web: { [G.who]: sel.value, [G.outfit]: '' } } }));
        bar.prepend(sel);
      }, () => {});
      bar.append(btn(t('Đổi biểu cảm'), 'heart', () => nextNikkeExpression(), { class: 'lobby-btn lobby-face' }));
      if (w.web.preset === 'nikke') {
        const battle = w.web.nikkeStance === 'battle';
        bar.append(btn(battle ? t('Về sảnh') : t('Chiến đấu'), battle ? 'home' : 'shield', () => api.invoke('settings:set', { wallpaper: { web: { nikkeStance: battle ? 'lobby' : 'battle' } } }).then(() => $('#lobby-bar')?.replaceWith(lobbyBar()))));
      }
    }
    if (['bluearchive', 'nikke', 'azurlane', 'sekai'].includes(w.web?.preset)) {
      const on = !!w.web.touchZones;
      bar.append(btn(t('Vùng chạm'), 'target', () => api.invoke('settings:set', { wallpaper: { web: { touchZones: !on } } }).then(() => $('#lobby-bar')?.replaceWith(lobbyBar())), { class: 'lobby-btn' + (on ? ' on' : ''), 'aria-pressed': String(on) }));
    }
    bar.append(btn(t('Tải lại'), 'reload', () => current.kind === 'web' && current.el.reload()));
  }
  if (w.type === 'image') bar.append(btn(t('Ảnh khác'), 'shuffle', () => nextWallpaper(true)));
  bar.append(btn(t('Thoát (Esc)'), 'x', () => toggleLobby(false), { class: 'lobby-btn primary' }));
  return bar;
}

// ---------------------------------------------------------------- automatic colours
// Chọn sảnh khi mở app → Theo mùa và giờ picks dark lobbies by night: each lobby's picture
// (TyranWeb's own, else SchaleDB's) is measured once, small, and its mean brightness kept by the main
// process (services.pickLobby). In the background, one at a time.
let lightBusy = false;
let lightDone = false; // (every lobby measured, this session)
async function measureLobbyLight() {
  if (lightBusy || lightDone || S.settings.wallpaper.web?.lobbyPick !== 'season') return;
  lightBusy = true;
  try {
    const known = await api.invoke('wallpapers:baBrightness');
    const todo = (await api.invoke('wallpapers:baModels')).filter((m) => !m.hidden && !m.broken && !(m.key in known) && (m.preview || m.thumb));
    if (!todo.length) lightDone = true;
    let found = {};
    for (const m of todo) {
      const bytes = await api.invoke('wallpapers:baPicture', m.key).catch(() => null);
      const bmp = bytes && (await createImageBitmap(new Blob([bytes])).catch(() => null));
      if (bmp) {
        const g = new OffscreenCanvas(24, 24).getContext('2d');
        g.drawImage(bmp, 0, 0, 24, 24);
        bmp.close();
        const px = g.getImageData(0, 0, 24, 24).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 128) continue; // (SchaleDB's pictures have cut corners)
          sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          n++;
        }
        if (n) found[m.key] = Math.round((1000 * sum) / n / 255) / 1000;
      }
      if (Object.keys(found).length >= 20) {
        await api.invoke('wallpapers:baSaveBrightness', found);
        found = {};
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    if (Object.keys(found).length) await api.invoke('wallpapers:baSaveBrightness', found);
  } catch {
    /* tried again with the next change */
  } finally {
    lightBusy = false;
  }
}

// With "automatic colours" on, the interface takes its colours from the wallpaper: a small copy of
// what is shown (the picture, a frame of the video, the Blue Archive lobby as drawn) gives its main
// tone and its liveliest colour, and theme.js makes light or dark colours from them.
let autoSeq = 0;
export async function updateAutoColors() {
  if (!S.settings.appearance.autoColor) return;
  const seq = ++autoSeq;
  const pal = await wallpaperPicture()
    .then((src) => (src && typeof src === 'object' ? src : src ? paletteOf(src) : null))
    .catch(() => null);
  if (!pal || seq !== autoSeq) return;
  const cur = S.settings.appearance.auto;
  if (cur?.base === pal.base && cur?.accent === pal.accent) return;
  api.invoke('settings:set', { appearance: { auto: pal } });
}

async function wallpaperPicture() {
  const w = S.settings.wallpaper;
  if (current.kind === 'web' && current.wcId) {
    // a lobby: its picture from the picker when there is one (its resting look), else as drawn now
    const m = w.web?.preset === 'bluearchive' && !normalLobby(w) ? await lobbyInfo(w.web.model) : null;
    return m?.preview || zonesHidden((code) => current.el.executeJavaScript(code), () => api.invoke('wallpaper:snapshot', current.wcId));
  }
  if (current.kind === 'video') return videoFrame(current.el.currentSrc || current.el.src);
  if (current.kind === 'desktop') return current.el.dataset.url || null;
  if (current.kind === 'static') {
    const url = /url\("(.+)"\)/.exec(current.el?.style.backgroundImage || '')?.[1];
    if (url) return url;
  }
  if (w.type === 'gradient') return { base: w.gradientFrom, accent: w.gradientTo };
  if (w.type === 'color') return { base: w.color, accent: S.settings.appearance.accent };
  return null;
}

function videoFrame(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    v.onloadeddata = () => (v.currentTime = Math.min(1, (v.duration || 2) / 2));
    v.onseeked = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 48;
      c.getContext('2d').drawImage(v, 0, 0, 48, 48);
      resolve(c.toDataURL());
      v.removeAttribute('src');
      v.load();
    };
    v.onerror = reject;
    setTimeout(() => reject(new Error('timeout')), 8000);
    v.src = url;
  });
}

async function paletteOf(url) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 48, 48);
  const px = g.getImageData(0, 0, 48, 48).data;
  // colours grouped coarsely (16 steps a channel): the biggest group that is neither near black nor
  // near white is the main tone; the liveliest, weighted by how much of it there is, the accent
  const groups = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    const e = groups.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += px[i];
    e.g += px[i + 1];
    e.b += px[i + 2];
    groups.set(key, e);
  }
  const hex = (e) => '#' + [e.r, e.g, e.b].map((v) => Math.round(v / e.n).toString(16).padStart(2, '0')).join('');
  const list = [...groups.values()].map((e) => {
    const h = hex(e);
    const [, s, l] = rgbToHsl(h);
    return { hex: h, n: e.n, s, l };
  });
  const byCount = [...list].sort((a, b) => b.n - a.n);
  const base = (byCount.find((x) => x.l > 0.12 && x.l < 0.9) || byCount[0]).hex;
  const lively = list.filter((x) => x.s > 0.3 && x.l > 0.25 && x.l < 0.8).sort((a, b) => b.n * b.s - a.n * a.s)[0];
  return { base, accent: lively ? lively.hex : base };
}

let autoWas = false;
on('settings', () => {
  const on = !!S.settings.appearance.autoColor;
  if (on && !autoWas) updateAutoColors();
  autoWas = on;
});

// ---------------------------------------------------------------- slideshow
let slideKey = '';
function setupSlideshow() {
  const w = S.settings.wallpaper;
  const key = `${w.type}|${w.slideshowMinutes}|${(w.slideshow || []).join(',')}`;
  if (key === slideKey) return;
  slideKey = key;
  clearInterval(slideTimer);
  slideOverride = null;
  if (w.type !== 'image' || !w.slideshowMinutes) return;
  slideTimer = setInterval(() => nextWallpaper(false), w.slideshowMinutes * 60000);
}

// Next wallpaper: from the slideshow list, or all bundled wallpapers.
export async function nextWallpaper(save = true) {
  const w = S.settings.wallpaper;
  let list = w.slideshow?.length ? w.slideshow : null;
  if (!list) {
    const all = await api.invoke('wallpapers:list');
    list = [...all.bundled, ...all.user].map((x) => x.url);
  }
  if (!list.length) return;
  const cur = slideOverride || w.image;
  slideIndex = (list.indexOf(cur) + 1) % list.length;
  if (save) {
    slideOverride = null;
    api.invoke('settings:set', { wallpaper: { type: 'image', image: list[slideIndex] } });
  } else applyWallpaper(list[slideIndex]);
}

// ---------------------------------------------------------------- wiring
document.addEventListener('visibilitychange', updateMotion);
on('active', updateMotion);
on('tab:update', (t) => t.id === active()?.id && updateMotion());
on('html-fullscreen', () => setTimeout(updateMotion));
window.addEventListener(
  'keydown',
  (e) => {
    if (S.lobby && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      toggleLobby(false);
    }
  },
  true
);

// the spectrum bar's music when it is the Azur Lane lobby's song, played in the wallpaper's page
addSpectrumSource((n) => {
  const w = S.settings.wallpaper;
  if (w.type !== 'web' || w.web?.preset !== 'azurlane' || current.kind !== 'web' || !current.wcId) return undefined;
  return current.el.executeJavaScript(`window.__tyran && __tyran.spectrum ? __tyran.spectrum(${Number(n) || 48}) : null`);
}, 2);
