'use strict';
// Tải từ đường dẫn: the videos of a post (or its GIF, or its pictures on Pixiv) from its link on
// YouTube, X, Facebook, Reddit, Instagram, TikTok, Bilibili, Niconico and the many other sites yt-dlp
// reads (Pixiv: main/pixiv.js). What it holds: each video with its picture, length and the qualities
// it comes in (size in pixels, frame rate, codec, file size), its sound alone, a GIF of a short one;
// the one picked is downloaded into Tải xuống. yt-dlp runs YouTube's JavaScript on TyranWeb's own
// Node (Electron as Node); the user's login on that site in TyranWeb goes with it as a cookie file
// of that site's cookies only, which exists only while yt-dlp runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { session } = require('electron');
const tools = require('./tools');
const dljobs = require('./dljobs');
const pixiv = require('./pixiv');
const { imageData, snap, probe } = require('./mediaprobe');

const results = new Map(); // token → { at, url, ses, result (its choices with their yt-dlp formats), view }
const TMP = path.join(tools.DIR, 'tmp');
const ENV = { ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', TEMP: TMP, TMP };
let running = 0;

// yt-dlp run with its temporary files (it unpacks itself there each time) in a folder of TyranWeb's,
// emptied whenever none is running: one stopped midway leaves its unpacked copy behind
async function ytdlpRun(exe, args, opts = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  running++;
  try {
    return await tools.run(exe, args, { ...opts, env: ENV });
  } finally {
    if (--running === 0) setTimeout(() => running === 0 && fs.rm(TMP, { recursive: true, force: true }, () => {}), 2000);
  }
}
const ALIAS = { 'x.com': ['twitter.com'], 'twitter.com': ['x.com'], 'youtu.be': ['youtube.com'], 'redd.it': ['reddit.com'], 'fb.watch': ['facebook.com'], 'b23.tv': ['bilibili.com'], 'nico.ms': ['nicovideo.jp'], 'vm.tiktok.com': ['tiktok.com'], 'vt.tiktok.com': ['tiktok.com'] };

function normal(s) {
  s = String(s || '').trim();
  if (!/^https?:\/\//i.test(s)) s = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s) ? 'https://' + s : '';
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function domains(host) {
  host = host.replace(/^www\./, '');
  let d = '';
  try {
    d = require('tldts-experimental').getDomain(host) || '';
  } catch {
    /* (its last two labels then) */
  }
  d ||= host.split('.').slice(-2).join('.');
  return [d, ...(ALIAS[host] || ALIAS[d] || [])];
}

// that site's cookies in TyranWeb, as a Netscape cookie file for yt-dlp ('' when it has none)
async function cookieFile(ses, url) {
  const doms = domains(new URL(url).hostname);
  const mine = (await ses.cookies.get({})).filter((c) => {
    const d = c.domain.replace(/^\./, '');
    return doms.some((x) => d === x || d.endsWith('.' + x));
  });
  if (!mine.length) return '';
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of mine) {
    const d = c.domain.replace(/^\./, '');
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + (c.hostOnly ? d : '.' + d), c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', Math.round(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  const file = path.join(os.tmpdir(), `tyranweb-ck-${crypto.randomBytes(8).toString('hex')}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

// (through the WARP proxy when TyranWeb's pages go through it; socks5h: names are looked up by WARP too)
const viaWarp = () => require('./warp').proxy().replace(/^socks5:/, 'socks5h:');
const common = (ck, ff) => [
  '--color', 'never',
  '--encoding', 'utf-8',
  '--no-playlist',
  '--playlist-items', '1:20',
  '--js-runtimes', `node:${process.execPath}`,
  '--cache-dir', path.join(tools.DIR, 'cache'),
  ...(ck ? ['--cookies', ck] : []),
  ...(ff ? ['--ffmpeg-location', ff] : []),
  ...(viaWarp() ? ['--proxy', viaWarp()] : []),
];

// what went wrong, from yt-dlp's last error line
function reason(err) {
  const line = (String(err).match(/ERROR: .*/g) || []).pop() || '';
  const detail = line.replace(/^ERROR:\s*/, '').slice(0, 300);
  if (/Unsupported URL/i.test(line)) return { error: 'unsupported', detail };
  if (/sign in|log ?in|login|cookies|authenticat|age.?restrict|confirm your age|NSFW|sensitive|not a bot/i.test(line)) return { error: 'login', detail };
  if (/private|unavailable|removed|deleted|does not exist|not found|404|no longer|suspended/i.test(line)) return { error: 'gone', detail };
  if (/no video|no media|there's no video|not contain/i.test(line)) return { error: 'novideo', detail };
  return { error: 'failed', detail };
}

// ---- reading a link's formats into choices
const CODEC = (v = '') => (/^(avc|h264)/i.test(v) ? 'H.264' : /^(hev|hvc|h265)/i.test(v) ? 'H.265' : /^av01/i.test(v) ? 'AV1' : /^vp0?9/i.test(v) ? 'VP9' : /^vp0?8/i.test(v) ? 'VP8' : '');
const RANK = { 'H.264': 4, AV1: 3, VP9: 2, 'H.265': 1 }; // (what plays most everywhere first)
const sizeOf = (f, dur) => f.filesize || f.filesize_approx || (f.tbr && dur ? ((f.tbr * 1000) / 8) * dur : 0);
const isAudio = (f) => f.vcodec === 'none' && !!f.acodec && f.acodec !== 'none';
const isVideo = (f) => f.vcodec !== 'none' && f.ext !== 'mhtml' && !/storyboard/i.test(f.format_note || '') && !!(f.vcodec || f.width || f.height || /^(mp4|webm|mov|m4v|flv|mkv|gif)$/.test(f.ext || ''));
const withSound = (f) => f.acodec !== 'none';
const better = (a, b) => {
  const k = (f) => [f.filesize || f.filesize_approx ? 1 : 0, Math.round(f.fps || 0), RANK[CODEC(f.vcodec)] || 0, withSound(f) ? 1 : 0, f.tbr || 0];
  const x = k(a);
  const y = k(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function entryOf(e, index) {
  const fmts = e.formats?.length ? e.formats : e.url ? [e] : [];
  const dur = e.duration || 0;
  const audio = fmts
    .filter((f) => isAudio(f) && !/iamf/i.test(f.acodec))
    .sort((a, b) => /^mp4a/.test(b.acodec) - /^mp4a/.test(a.acodec) || /drc/.test(a.format_id) - /drc/.test(b.format_id) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const byHeight = new Map();
  for (const f of fmts.filter(isVideo)) {
    const h = f.height || 'id:' + f.format_id; // (one of unknown size stays a choice of its own: "HD", "SD")
    if (!byHeight.has(h) || better(f, byHeight.get(h))) byHeight.set(h, f);
  }
  const hd = (f) => (/hd|high|best/i.test(f.format_id + ' ' + (f.format_note || '')) ? 1 : 0);
  const vids = [...byHeight.values()].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0) || hd(b) - hd(a));
  const choices = vids.map((f) => {
    const needs = !withSound(f) && !!audio;
    return {
      key: 'v' + f.format_id,
      kind: 'video',
      ext: needs ? 'mp4' : f.ext || 'mp4',
      width: f.width || 0,
      height: f.height || 0,
      note: f.height ? '' : String(f.format_note || f.format_id || '').toUpperCase().slice(0, 12),
      fps: snap(f.fps || 0),
      codec: CODEC(f.vcodec),
      size: Math.round(sizeOf(f, dur) + (needs ? sizeOf(audio, dur) : 0)),
      approx: !f.filesize || (needs && !audio.filesize),
      sel: needs ? `${f.format_id}+${audio.format_id}` : f.format_id,
      merge: needs,
      src: /^https?$/.test(f.protocol || '') ? f.url : '',
      protocol: [f.protocol, needs ? audio.protocol : ''].join(' '),
    };
  });
  if (audio) choices.push({ key: 'a', kind: 'audio', ext: audio.ext, size: Math.round(sizeOf(audio, dur)), approx: !audio.filesize, abr: Math.round(audio.abr || audio.tbr || 0), sel: audio.format_id, protocol: audio.protocol || '' });
  // (a short one also as a GIF, from its quality nearest 480p)
  if (vids.length && dur > 0 && dur <= 60) {
    const f = vids.find((v) => (v.height || 0) <= 480) || vids[vids.length - 1];
    const scale = Math.min(1, 480 / (f.width || 480));
    choices.push({ key: 'gif', kind: 'gif', ext: 'gif', width: Math.round((f.width || 0) * scale), height: Math.round((f.height || 0) * scale), fps: Math.min(15, snap(f.fps || 0) || 15), sel: f.format_id, protocol: f.protocol || '' });
  }
  const top = vids[0] || {};
  const pics = (e.thumbnails || []).filter((t) => t.url && !/\.webp(\?|$)/i.test(t.url) && (!t.width || t.width <= 1400));
  const thumbUrl = (pics.sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (b.width || 0) - (a.width || 0))[0] || {}).url || e.thumbnail || '';
  return { index: e.playlist_index || index, title: e.title || e.id || '', thumbUrl, duration: dur, width: top.width || 0, height: top.height || 0, fps: snap(top.fps || 0), choices, page: e.webpage_url || '' };
}

async function shape(info, ses, url) {
  const list = info._type === 'playlist' ? (info.entries || []).filter(Boolean) : [info];
  const entries = list.map((e, i) => entryOf(e, i + 1)).filter((e) => e.choices.length);
  if (!entries.length) return { error: 'novideo' };
  await Promise.all(
    entries.map(async (e) => {
      e.thumb = e.thumbUrl ? await imageData(ses, e.thumbUrl, e.page || url, 480).catch(() => '') : '';
      delete e.thumbUrl;
    })
  );
  // (a site that does not say its frame rate, X's: read from its best file played for a moment, as
  // Truy tìm video does; the same for its other qualities)
  for (const e of entries.slice(0, 4)) {
    const vids = e.choices.filter((c) => c.kind === 'video');
    const top = vids.find((c) => c.src);
    if (!top || vids.some((c) => c.fps)) continue;
    const facts = await probe(ses, { kind: 'file', url: top.src, referrer: e.page || url }).catch(() => null);
    if (!facts?.fps) continue;
    for (const c of e.choices) if (c.kind === 'video' || c.kind === 'gif') c.fps = c.kind === 'gif' ? Math.min(15, facts.fps) : facts.fps;
    if (!top.height && facts.height) Object.assign(top, { width: facts.width, height: facts.height });
    if (!e.height) Object.assign(e, { width: top.width, height: top.height });
    e.fps = facts.fps;
    if (!e.thumb) e.thumb = facts.thumb;
  }
  return { site: info.extractor_key || info.extractor || '', title: info.title || '', uploader: info.uploader || info.channel || '', list: info._type === 'playlist', entries };
}

async function viaYtdlp(url, ses) {
  let exe;
  try {
    exe = await tools.ytdlp();
  } catch {
    return { error: 'tool-yt-dlp' };
  }
  await tools.update(false);
  const ck = await cookieFile(ses, url).catch(() => '');
  try {
    const args = [...common(ck, tools.ffmpegHere()), '-J', '--', url];
    let r = await ytdlpRun(exe, args);
    // (a failure that is not about the link itself: maybe the site changed and a newer yt-dlp reads it)
    if (r.code !== 0 && reason(r.err).error === 'failed' && (await tools.update(true))) r = await ytdlpRun(exe, args);
    if (r.code !== 0 || !r.out.trim()) return reason(r.err);
    return await shape(JSON.parse(r.out), ses, url);
  } finally {
    if (ck) fs.rmSync(ck, { force: true });
  }
}

// → { token, url, site, title, uploader, entries: [{ index, title, thumb, duration, width, height,
// fps, choices: [{ key, kind: video|audio|gif|image, ext, width, height, fps, codec, size, approx }] }] }
// | { error, detail }
async function analyze(raw, ses) {
  const url = normal(raw);
  if (!url) return { error: 'url' };
  for (const [k, r] of results) if (Date.now() - r.at > 30 * 60e3) results.delete(k);
  const kept = [...results.values()].find((r) => r.url === url && r.ses === ses && Date.now() - r.at < 10 * 60e3);
  if (kept) return kept.view;
  const result = pixiv.handles(url) ? await pixiv.analyze(url, ses).catch(() => ({ error: 'failed' })) : await viaYtdlp(url, ses).catch(() => ({ error: 'failed' }));
  if (result.error) return result;
  const token = crypto.randomBytes(8).toString('hex');
  const view = {
    token,
    url,
    site: result.site,
    title: result.title,
    uploader: result.uploader,
    entries: result.entries.map((e) => ({ ...e, page: undefined, choices: e.choices.map(({ sel, src, frames, protocol, merge, ...shown }) => shown) })),
  };
  results.set(token, { at: Date.now(), url, ses, result, view });
  return view;
}

// ---- downloading one
function leftovers(dest) {
  if (!dest) return;
  const dir = path.dirname(dest);
  const stem = path.basename(dest).replace(/\.[^.]+$/, '');
  try {
    for (const n of fs.readdirSync(dir)) if (n.startsWith(stem) && /\.(part|ytdl)$|\.f[\w-]+\.\w+(\.part)?$|\.temp\.\w+$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
  } catch {
    /* (its folder went) */
  }
}

async function toGif(ff, file, c, signal) {
  const out = dljobs.unique(file.replace(/\.[^.\\/]+$/, '') + '.gif');
  const vf = `fps=${c.fps || 15},scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
  const r = await tools.run(ff, ['-y', '-v', 'error', '-i', file, '-vf', vf, '-loop', '0', '-f', 'gif', out + '.part'], { signal });
  if (r.code !== 0) {
    fs.rmSync(out + '.part', { force: true });
    throw new Error(r.err.trim().split('\n').pop() || 'gif');
  }
  fs.renameSync(out + '.part', out);
  fs.rmSync(file, { force: true });
  return out;
}

function viaYtdlpDownload(r, entry, c, isPrivate) {
  const ctrl = new AbortController();
  const mime = c.kind === 'audio' ? 'audio/mp4' : c.kind === 'gif' ? 'image/gif' : 'video/mp4';
  const job = dljobs.start({ url: entry.page || r.url, filename: `${dljobs.safe(entry.title)}.${c.ext}`, mime, totalBytes: c.size || 0, private: isPrivate, cancel: () => ctrl.abort() });
  (async () => {
    let ck = '';
    let dest = '';
    try {
      const exe = await tools.ytdlp();
      const ff = c.merge || c.kind === 'gif' || /m3u8|dash|ism|f4m/.test(c.protocol || '') ? await tools.ffmpeg() : tools.ffmpegHere();
      ck = await cookieFile(r.ses, r.url).catch(() => '');
      let base = 0;
      let last = 0;
      let lastTotal = 0;
      let final = '';
      const args = [
        ...common(ck, ff),
        '-f', c.sel,
        '-P', dljobs.dir(),
        '-o', '%(title).80B [%(id)s].%(ext)s',
        '--windows-filenames',
        '--no-mtime',
        '--no-simulate',
        '--newline',
        '--progress',
        '--progress-template', 'download:TYDL|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
        '--print', 'before_dl:TYDEST|%(filename)s',
        '--print', 'after_move:TYFILE|%(filepath)s',
        ...(c.merge ? ['--merge-output-format', 'mp4'] : []),
        ...(r.result.list ? ['--playlist-items', String(entry.index)] : []),
        '--', r.url,
      ];
      const res = await ytdlpRun(exe, args, {
        signal: ctrl.signal,
        onLine: (line) => {
          if (line.startsWith('TYDL|')) {
            // (a video and its sound come one after the other: their bytes add up)
            const [, a, b, e] = line.split('|');
            const got = Number(a) || 0;
            const total = Number(b) || Number(e) || 0;
            if (got < last) base += lastTotal || last;
            last = got;
            lastTotal = total || lastTotal;
            job.update({ receivedBytes: base + got, totalBytes: Math.max(c.size || 0, base + total) });
          } else if (line.startsWith('TYDEST|')) {
            dest = line.slice(7).trim();
            job.update({ path: dest }, true);
          } else if (line.startsWith('TYFILE|')) final = line.slice(7).trim();
        },
      });
      if (ctrl.signal.aborted) throw new Error('aborted');
      if (res.code !== 0 || !final || !fs.existsSync(final)) throw new Error(reason(res.err).detail || 'yt-dlp');
      if (c.kind === 'gif') final = await toGif(ff, final, c, ctrl.signal);
      const size = fs.statSync(final).size;
      job.finish('completed', { path: final, receivedBytes: size, totalBytes: size });
    } catch (err) {
      if (ctrl.signal.aborted) leftovers(dest);
      job.finish(ctrl.signal.aborted ? 'cancelled' : 'interrupted', { error: String(err?.message || err) });
    } finally {
      if (ck) fs.rmSync(ck, { force: true });
    }
  })();
  return { kind: 'job', id: job.rec.id };
}

// downloads choice `key` of entry `index` of an analyze() result
async function download(token, index, key) {
  const r = results.get(token);
  const entry = r?.result.entries.find((e) => e.index === index);
  const c = entry?.choices.find((x) => x.key === key);
  if (!c) throw new Error('gone');
  const isPrivate = r.ses === session.fromPartition(require('./sessions').PRIVATE_PARTITION);
  if (pixiv.handles(r.url)) return pixiv.download(r.ses, r.result, entry, c, isPrivate);
  return viaYtdlpDownload(r, entry, c, isPrivate);
}

module.exports = { analyze, download };
