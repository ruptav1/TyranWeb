'use strict';
// Pixiv for Tải từ đường dẫn (yt-dlp does not read it), with the user's own Pixiv login in TyranWeb:
// a work's animation (ugoira: its frames and their timing, made into an .mp4 or a .gif by FFmpeg)
// or its pictures (the originals, each page of it). Pixiv's images only load with Pixiv as referrer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const dljobs = require('./dljobs');
const tools = require('./tools');
const { imageData, fetchFrom } = require('./mediaprobe');

const REF = 'https://www.pixiv.net/';
const idOf = (url) => /pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i.exec(url)?.[1] || /pixiv\.net\/member_illust\.php\?.*\billust_id=(\d+)/i.exec(url)?.[1] || '';
const handles = (url) => !!idOf(url);

async function json(ses, url) {
  const res = await fetchFrom(ses, url, REF, { headers: { accept: 'application/json' } });
  const j = await res.json().catch(() => null);
  if (!j || j.error) throw new Error(j?.message || `HTTP ${res.status}`);
  return j.body;
}
const loggedIn = async (ses) => (await ses.cookies.get({ url: REF, name: 'PHPSESSID' })).some((c) => c.value.includes('_'));
const sizeOf = (ses, url) =>
  fetchFrom(ses, url, REF, { method: 'HEAD' })
    .then((r) => (r.ok ? Number(r.headers.get('content-length')) || 0 : 0))
    .catch(() => 0);

// → { site, title, uploader, entries: [{ index, title, thumb, duration, width, height, fps,
// choices: [{ key, kind, ext, width, height, fps, size, src, frames }] }] }
async function analyze(url, ses) {
  const id = idOf(url);
  let w;
  try {
    w = await json(ses, `https://www.pixiv.net/ajax/illust/${id}`);
  } catch {
    return { error: (await loggedIn(ses)) ? 'gone' : 'login' };
  }
  const title = w.illustTitle || w.title || `pixiv ${id}`;
  const base = { site: 'Pixiv', title, uploader: w.userName || '', id };
  if (w.illustType === 2) {
    const m = await json(ses, `https://www.pixiv.net/ajax/illust/${id}/ugoira_meta`);
    const frames = (m.frames || []).map((f) => ({ file: String(f.file), delay: Number(f.delay) || 100 }));
    if (!frames.length) return { error: 'novideo' };
    const duration = frames.reduce((a, f) => a + f.delay, 0) / 1000;
    const fps = frames.length / duration;
    const small = Math.min(1, 600 / Math.max(w.width, w.height));
    const [full, light] = await Promise.all([sizeOf(ses, m.originalSrc), sizeOf(ses, m.src)]);
    const thumb = await imageData(ses, w.urls?.regular || w.urls?.small, REF, 480).catch(() => '');
    return {
      ...base,
      entries: [
        {
          index: 1,
          title,
          thumb,
          duration,
          width: w.width,
          height: w.height,
          fps,
          choices: [
            { key: 'mp4', kind: 'video', ext: 'mp4', width: w.width, height: w.height, fps, size: full, src: m.originalSrc || m.src, frames },
            { key: 'gif', kind: 'gif', ext: 'gif', width: Math.round(w.width * small), height: Math.round(w.height * small), fps, size: light, src: m.src || m.originalSrc, frames },
          ],
        },
      ],
    };
  }
  const pages = (await json(ses, `https://www.pixiv.net/ajax/illust/${id}/pages`)).slice(0, 30);
  const entries = await Promise.all(
    pages.map(async (p, i) => {
      const ext = (/\.(\w+)$/.exec(p.urls.original)?.[1] || 'jpg').toLowerCase();
      const [thumb, size] = await Promise.all([imageData(ses, p.urls.small || p.urls.regular, REF, 320).catch(() => ''), sizeOf(ses, p.urls.original)]);
      return {
        index: i + 1,
        title: pages.length > 1 ? `${title} (${i + 1}/${pages.length})` : title,
        thumb,
        width: p.width,
        height: p.height,
        choices: [{ key: 'img', kind: 'image', ext, width: p.width, height: p.height, size, src: p.urls.original }],
      };
    })
  );
  return { ...base, entries };
}

// the frames of an ugoira zip (its central directory read; stored or deflated)
function unzip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('zip');
  const files = new Map();
  for (let k = 0, p = buf.readUInt32LE(end + 16), n = buf.readUInt16LE(end + 10); k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    files.set(path.basename(name), method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}

// downloads a choice of an analyze() entry; → the record's id
async function download(ses, result, entry, c, isPrivate) {
  const dir = dljobs.dir();
  const file = dljobs.unique(path.join(dir, c.kind === 'image' ? path.basename(new URL(c.src).pathname) : `${dljobs.safe(result.title)} [pixiv ${result.id}].${c.ext}`));
  const ctrl = new AbortController();
  const mime = c.kind === 'image' ? `image/${c.ext === 'jpg' ? 'jpeg' : c.ext}` : c.kind === 'gif' ? 'image/gif' : 'video/mp4';
  const job = dljobs.start({ url: `https://www.pixiv.net/artworks/${result.id}`, path: file, mime, totalBytes: c.size, private: isPrivate, cancel: () => ctrl.abort() });
  (c.kind === 'image' ? picture(ses, c, job, ctrl.signal) : ugoira(ses, c, job, ctrl.signal)).catch((err) => job.finish(ctrl.signal.aborted ? 'cancelled' : 'interrupted', { error: String(err?.message || err) }));
  return { kind: 'job', id: job.rec.id };
}

// (a picture: fetched with Pixiv as referrer, which Chromium's own downloads cannot be given)
async function picture(ses, c, job, signal) {
  const res = await fetchFrom(ses, c.src, REF, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = fs.createWriteStream(job.rec.path + '.part');
  try {
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once('drain', ok));
      job.update({ receivedBytes: got });
    }
    await new Promise((ok, fail) => out.end((err) => (err ? fail(err) : ok())));
    fs.renameSync(job.rec.path + '.part', job.rec.path);
    job.finish('completed', { receivedBytes: got, totalBytes: got });
  } catch (err) {
    out.destroy();
    fs.rmSync(job.rec.path + '.part', { force: true });
    throw err;
  }
}

async function ugoira(ses, c, job, signal) {
  const res = await fetchFrom(ses, c.src, REF, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || c.size || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    got += value.length;
    job.update({ receivedBytes: Math.round(got * 0.9), totalBytes: total });
  }
  const files = unzip(Buffer.concat(parts));
  const ff = await tools.ffmpeg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tyranweb-ugoira-'));
  try {
    // (each frame for its own time; the last one listed again, as FFmpeg's concat reader wants)
    const list = ['ffconcat version 1.0'];
    for (const f of c.frames) {
      const name = path.basename(f.file);
      if (!/^[\w.-]+$/.test(name) || !files.has(name)) continue;
      fs.writeFileSync(path.join(tmp, name), files.get(name));
      list.push(`file '${name}'`, `duration ${(f.delay / 1000).toFixed(3)}`);
    }
    if (list.length < 3) throw new Error('empty');
    list.push(list[list.length - 2]);
    fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n') + '\n');
    const out = job.rec.path + '.part';
    const filter = c.kind === 'gif' ? 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4' : 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
    const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-vf', filter];
    if (c.kind === 'gif') args.push('-loop', '0', '-f', 'gif', out);
    else args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', '-fps_mode', 'vfr', '-f', 'mp4', out);
    const r = await tools.run(ff, args, { signal });
    if (signal.aborted) throw new Error('aborted');
    if (r.code !== 0) throw new Error(r.err.trim().split('\n').pop() || 'ffmpeg');
    fs.renameSync(out, job.rec.path);
    const size = fs.statSync(job.rec.path).size;
    job.finish('completed', { receivedBytes: size, totalBytes: size });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(job.rec.path + '.part', { force: true });
  }
}

module.exports = { handles, analyze, download };
