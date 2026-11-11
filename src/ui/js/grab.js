// Tải video: the toolbar's video button.
//  - Tải từ đường dẫn (main/grab.js): a link pasted (or the tab's own, on a post of a site it knows)
//    is read, its site named as it is typed; each of its videos shown with its picture, facts and the
//    qualities it comes in, and downloaded into Tải xuống;
//  - Truy tìm video (main/sniffer.js): the videos the page plays, each with its picture and facts
//    (size in pixels, frame rate, length, file size: main/mediaprobe.js) as they come.
import { api, h } from './util.js';
import { active } from './tabs.js';
import { openPopover, toast } from './menus.js';
import { icon } from 'tyran://shared/icons.js';
import { t } from 'tyran://shared/i18n.js';

// the sites it names as a link is typed (yt-dlp reads many more), and what of theirs is a post
const SITES = [
  ['YouTube', '#ff0033', ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], /\/(watch|shorts\/|live\/|embed\/)|youtu\.be\/./],
  ['X', '#1d1d1f', ['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com'], /\/status(es)?\/\d+/],
  ['Facebook', '#1877f2', ['facebook.com', 'fb.watch', 'fb.com'], /\/(videos|reel|watch|share\/[vr]|posts|permalink)|fb\.watch\/./],
  ['Instagram', '#e1306c', ['instagram.com'], /\/(p|reels?|tv)\/[\w-]+/],
  ['Reddit', '#ff4500', ['reddit.com', 'redd.it'], /\/comments\/\w+|redd\.it\/./],
  ['Pixiv', '#0096fa', ['pixiv.net'], /\/artworks\/\d+|illust_id=\d+/],
  ['TikTok', '#1d1d1f', ['tiktok.com'], /\/video\/\d+|\/\/(vm|vt)\.tiktok\.com\/./],
  ['Bilibili', '#00a1d6', ['bilibili.com', 'b23.tv', 'bilibili.tv'], /\/video\/\w+|b23\.tv\/./],
  ['Niconico', '#5a5a5a', ['nicovideo.jp', 'nico.ms'], /\/watch\/\w+|nico\.ms\/./],
  ['Twitch', '#9146ff', ['twitch.tv'], /\/videos\/\d+|\/clip\/|clips\.twitch\.tv\/./],
  ['Vimeo', '#1ab7ea', ['vimeo.com'], /vimeo\.com\/(\d+|.+\/\d+)/],
  ['Dailymotion', '#0a6cff', ['dailymotion.com', 'dai.ly'], /\/video\/\w+|dai\.ly\/./],
  ['SoundCloud', '#ff5500', ['soundcloud.com'], /soundcloud\.com\/[^/]+\/[^/?#]+/],
  ['Bluesky', '#0085ff', ['bsky.app'], /\/post\/\w+/],
  ['Threads', '#1d1d1f', ['threads.net', 'threads.com'], /\/post\/[\w-]+/],
  ['Tumblr', '#36465d', ['tumblr.com'], /\/post\/\d+|tumblr\.com\/[^/]+\/\d+/],
  ['Imgur', '#1bb76e', ['imgur.com'], /\/(a|gallery)\/\w+|imgur\.com\/\w+\.(gifv|mp4)/],
  ['Streamable', '#0f90fa', ['streamable.com'], /streamable\.com\/\w+/],
  ['Kick', '#3ec90f', ['kick.com'], /\/(videos|clips?)\//],
  ['9GAG', '#1d1d1f', ['9gag.com'], /\/gag\/\w+/],
];

function siteOf(text) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(text.trim()) ? text.trim() : 'https://' + text.trim());
  } catch {
    return null;
  }
  if (!/\.[a-z]{2,}$/i.test(u.hostname)) return null;
  const host = u.hostname.replace(/^(www|m|mobile|music)\./, '');
  const s = SITES.find(([, , hosts]) => hosts.some((x) => host === x || host.endsWith('.' + x)));
  return s ? { name: s[0], color: s[1], known: true, post: s[3].test(u.href) } : { name: host, color: '', known: false, post: u.pathname.length > 1 };
}

const fmtSize = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n ? `${Math.max(1, Math.round(n / 1024))} KB` : '');
const fmtTime = (s) => {
  s = Math.round(s || 0);
  if (!s) return '';
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return `${hh ? hh + ':' : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtFps = (f) => (f ? `${Number.isInteger(f) ? f : f.toFixed(2)} fps` : '');
const kindOf = (m) => (m.kind === 'hls' ? 'HLS' : (/\.(\w{2,4})(?:$|[?#])/.exec(new URL(m.url).pathname)?.[1] || 'video').toUpperCase());
const fileOf = (m) => {
  try {
    const u = new URL(m.url);
    return u.hostname.replace(/^www\./, '') + ' · ' + decodeURIComponent(u.pathname.split('/').pop() || '');
  } catch {
    return m.url;
  }
};

// a picture with its length on it; set(src, duration) fills it in later
function thumbBox(src, duration, ico = 'video') {
  const box = h('div', { class: 'media-thumb' + (src === undefined ? ' loading' : '') });
  const set = (pic, dur) => {
    box.classList.remove('loading');
    box.replaceChildren(pic ? h('img', { src: pic, alt: '', draggable: 'false' }) : h('span', { class: 'media-thumb-ico', html: icon(ico, 22) }), dur ? h('span', { class: 'media-dur', text: fmtTime(dur) }) : '');
  };
  if (src !== undefined) set(src, duration);
  return { box, set };
}

// ---- Tải từ đường dẫn
let toolLine = null; // (the line showing yt-dlp / FFmpeg being fetched, while one is)
api.on('grab:tool', ({ name, at }) => {
  if (toolLine?.isConnected) toolLine.textContent = at >= 1 ? '' : `${name} · ${Math.round(at * 100)}%`;
});

const ERRORS = {
  url: 'Đường dẫn không hợp lệ',
  unsupported: 'Chưa đọc được trang này',
  login: 'Cần đăng nhập trang này trong TyranWeb',
  gone: 'Bài này không còn hoặc ở chế độ riêng tư',
  novideo: 'Không thấy video trong bài này',
  'tool-yt-dlp': 'Không tải được yt-dlp',
  failed: 'Không phân tích được đường dẫn này',
};

function choiceText(c) {
  const size = c.size ? ` · ${c.approx ? '~' : ''}${fmtSize(c.size)}` : '';
  if (c.kind === 'audio') return `${t('Âm thanh')} · ${String(c.ext || '').toUpperCase()}${size}`;
  if (c.kind === 'gif') return `GIF · ${c.height ? c.height + 'p' : ''}`;
  if (c.kind === 'image') return `${t('Ảnh gốc')} · ${String(c.ext || '').toUpperCase()}${size}`;
  return `${c.height ? `${c.height}p${c.fps > 30 ? Math.round(c.fps) : ''}` : c.note || t('Video')}${size}`;
}
function choiceFacts(c, e) {
  const dim = c.width && c.height ? `${c.width}×${c.height}` : '';
  const size = c.size ? `${c.approx ? '~' : ''}${fmtSize(c.size)}` : '';
  if (c.kind === 'audio') return [String(c.ext || '').toUpperCase(), c.abr ? `${c.abr} kb/s` : '', fmtTime(e.duration), size];
  if (c.kind === 'image') return [dim, String(c.ext || '').toUpperCase(), size];
  return [dim, fmtFps(c.fps), c.kind === 'gif' ? 'GIF' : c.codec, fmtTime(e.duration), size];
}

function card(res, e, site) {
  const choices = e.choices;
  const pick = choices.length > 1 ? h('select', { class: 'input small' }, ...choices.map((c, i) => h('option', { value: String(i), text: choiceText(c) }))) : null;
  const facts = h('div', { class: 'grab-facts' });
  const chosen = () => choices[pick ? Number(pick.value) : 0];
  const show = () => facts.replaceChildren(...choiceFacts(chosen(), e).filter(Boolean).map((x) => h('span', { text: x })));
  pick?.addEventListener('change', show);
  show();
  const get = h('button', { class: 'btn small primary', html: `${icon('download', 14)}<span>${t('Tải')}</span>` });
  get.addEventListener('click', async () => {
    get.disabled = true;
    try {
      await api.invoke('grab:download', res.token, e.index, chosen().key);
      toast(t('Đang tải: {0}', e.title || site), { icon: 'download' });
    } catch {
      toast(t('Không tải được video này'), { icon: 'info' });
    }
    setTimeout(() => (get.disabled = false), 1500);
  });
  const pic = thumbBox(e.thumb || '', e.duration, choices[0]?.kind === 'image' ? 'image' : choices[0]?.kind === 'audio' ? 'music' : 'video');
  return h(
    'div',
    { class: 'grab-card' },
    pic.box,
    h('div', { class: 'grab-info' }, h('b', { class: 'grab-title', text: e.title || res.title || site, title: e.title || '' }), h('span', { class: 'muted small grab-by', text: [res.uploader, site].filter(Boolean).join(' · ') }), facts, h('div', { class: 'grab-act' }, pick, get))
  );
}

function linkBox(wcId, tabUrl, reposition) {
  const field = h('input', { type: 'url', class: 'grab-input', placeholder: t('Dán đường dẫn video, bài đăng hoặc GIF'), spellcheck: 'false', autocomplete: 'off' });
  const chip = h('span', { class: 'grab-site' });
  const clear = h('button', { class: 'icon-btn grab-clear', html: icon('x', 14), title: t('Xóa') });
  const out = h('div', { class: 'grab-out' });
  let seq = 0;
  let done = '';
  const showChip = () => {
    const s = field.value.trim() ? siteOf(field.value) : null;
    chip.hidden = !s;
    clear.hidden = !field.value;
    if (s) chip.replaceChildren(h('i', { style: s.color ? { background: s.color } : {} }), s.name);
    return s;
  };
  const read = async (force = false) => {
    const url = field.value.trim();
    if (!url || (url === done && !force)) return;
    done = url;
    const my = ++seq;
    const site = siteOf(url);
    toolLine = h('span', { class: 'muted small' });
    out.replaceChildren(h('div', { class: 'grab-card wait' }, thumbBox(undefined).box, h('div', { class: 'grab-info' }, h('i', { class: 'grab-bar' }), h('i', { class: 'grab-bar short' }), toolLine)));
    reposition();
    const res = await api.invoke('grab:analyze', url, wcId).catch(() => ({ error: 'failed' }));
    if (my !== seq || !out.isConnected) return;
    if (res.error) {
      done = ''; // (Enter tries again)
      out.replaceChildren(h('div', { class: 'grab-err small', html: `${icon('info', 14)}<span></span>`, title: res.detail || '' }));
      out.querySelector('span').textContent = t(ERRORS[res.error] || ERRORS.failed);
    } else out.replaceChildren(...res.entries.map((e) => card(res, e, site?.known ? site.name : res.site)));
    reposition();
  };
  let wait = 0;
  field.addEventListener('input', () => {
    const s = showChip();
    clearTimeout(wait);
    if (!field.value.trim()) {
      seq++;
      done = '';
      out.replaceChildren();
      reposition();
    } else if (s?.post) wait = setTimeout(() => read(), 700);
  });
  field.addEventListener('paste', () => setTimeout(() => (showChip(), clearTimeout(wait), read()), 0));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(wait);
      read(true);
    }
  });
  clear.addEventListener('click', () => {
    field.value = '';
    field.dispatchEvent(new Event('input'));
    field.focus();
  });
  // (on a post of a site it knows, the tab's own link is there already; read at once when yt-dlp is
  // here, or for Pixiv, which needs no tool)
  const s = tabUrl ? siteOf(tabUrl) : null;
  const prefilled = !!(s?.known && s.post);
  if (prefilled) field.value = tabUrl;
  showChip();
  if (prefilled) api.invoke('grab:ready').then((ready) => (ready || s.name === 'Pixiv') && read()).catch(() => {});
  return { node: h('div', { class: 'grab-box' }, h('label', { class: 'grab-field' }, h('span', { class: 'grab-ico', html: icon('link', 16) }), field, chip, clear), out), prefilled, field };
}

// ---- Truy tìm video: a video the page plays
function pageRow(m, wcId, tab) {
  const variants = [...(m.variants || [])].map((v, i) => [v, i]).sort(([a], [b]) => b.height - a.height || b.bandwidth - a.bandwidth);
  const sizeOfVariant = (v) => (v?.bandwidth && m.duration ? (v.bandwidth / 8) * m.duration : 0);
  const optText = (v) => [v.height ? `${v.height}p${v.fps > 30 ? Math.round(v.fps) : ''}` : '', sizeOfVariant(v) ? `~${fmtSize(sizeOfVariant(v))}` : '', v.audioApart ? t('tiếng riêng') : ''].filter(Boolean).join(' · ');
  const pick = variants.length > 1 ? h('select', { class: 'input small' }, ...variants.map(([v, i]) => h('option', { value: String(i), text: optText(v) }))) : null;
  const pic = thumbBox(m.meta ? m.meta.thumb || '' : undefined, m.meta?.duration || m.duration);
  const top = h('b');
  const mid = h('span', { class: 'small' });
  const chosen = () => (variants.length ? (pick ? variants.find(([, i]) => i === Number(pick.value)) : variants[0])[0] : null);
  const paint = () => {
    const meta = m.meta || {};
    const v = chosen();
    const w = v?.width || meta.width;
    const hh = v?.height || meta.height;
    const dur = m.duration || meta.duration;
    const size = m.kind === 'file' ? m.size : sizeOfVariant(v);
    top.textContent = [w && hh ? `${w}×${hh}` : '', fmtFps(v?.fps || meta.fps)].filter(Boolean).join(' · ') || kindOf(m);
    mid.textContent = [kindOf(m), size ? `${m.kind === 'file' ? '' : '~'}${fmtSize(size)}` : '', fmtTime(dur)].filter(Boolean).join(' · ');
    if (pick) [...pick.options].forEach((o) => (o.textContent = optText(variants.find(([, i]) => i === Number(o.value))[0])));
  };
  pick?.addEventListener('change', paint);
  paint();
  const blocked = m.drm ? 'DRM' : m.live ? t('Trực tiếp') : '';
  const get = h('button', { class: 'btn small primary', disabled: !!blocked, html: blocked ? `<span>${blocked}</span>` : `${icon('download', 14)}<span>${t('Tải')}</span>` });
  get.addEventListener('click', async () => {
    get.disabled = true;
    try {
      await api.invoke('media:download', wcId, m.id, pick ? Number(pick.value) : variants[0] ? variants[0][1] : undefined);
      toast(t('Đang tải: {0}', m.title || fileOf(m)), { icon: 'download' });
    } catch {
      toast(t('Không tải được video này'), { icon: 'info' });
    }
    setTimeout(() => (get.disabled = !!blocked), 1500);
  });
  const node = h('div', { class: 'media-row' }, pic.box, h('div', { class: 'media-what' }, top, mid, h('span', { class: 'muted small', text: fileOf(m), title: m.url })), h('div', { class: 'grab-act' }, pick, get));
  // its picture and facts, when it has none yet
  if (!m.meta)
    api
      .invoke('media:probe', wcId, m.id)
      .then(({ meta, variants: rates }) => {
        m.meta = meta;
        rates?.forEach((r, i) => m.variants[i] && (m.variants[i].fps = r.fps));
        pic.set(meta.thumb || '', meta.duration || m.duration);
        if (node.isConnected) paint();
      })
      .catch(() => pic.set('', m.duration));
  return node;
}

export async function mediaPopover(anchor) {
  const tab = active();
  const wcId = tab?.wcId || null;
  const list = wcId ? await api.invoke('media:list', wcId).catch(() => []) : [];
  let pop = null;
  const reposition = () => pop?.reposition();
  const link = linkBox(wcId, tab?.url || '', reposition);
  const body = h(
    'div',
    { class: 'site-pop media-pop' },
    h('div', { class: 'pop-head' }, h('span', { class: 'pop-head-ico ok', html: icon('video', 18) }), h('div', { class: 'grab-head' }, h('b', { text: t('Tải video') }), h('div', { class: 'muted small', text: tab?.title || '' }))),
    link.node,
    list.length ? h('div', { class: 'media-sec' }, h('b', { text: t('Video trên trang') }), h('span', { class: 'muted small', text: String(list.length) })) : '',
    ...list.map((m) => pageRow(m, wcId, tab))
  );
  pop = openPopover(body, anchor, { align: 'end', focus: false, className: 'media-popover' });
  if (!link.prefilled) requestAnimationFrame(() => link.field.focus());
}
