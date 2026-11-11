'use strict';
// The programs Tải từ đường dẫn runs, fetched on first use into TyranWeb's data folder:
//  - yt-dlp (github.com/yt-dlp/yt-dlp, Unlicense): its official Windows build from its latest
//    release, checked against that release's SHA2-256SUMS, then kept current by its own updater
//    (sites change often), at most every 3 days or when it fails on a link;
//  - FFmpeg, to join a video with its separate sound, turn Pixiv animations into videos and make
//    GIFs: one already on this PC (in PATH or winget's links), else ffmpeg.exe 6.1.1 from
//    github.com/eugeneware/ffmpeg-static (GPL-3.0), its SHA-256 fixed here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { net } = require('electron');
const data = require('./data');

const DIR = path.join(data.dir, 'tools');
const YTDLP = path.join(DIR, 'yt-dlp.exe');
const FFMPEG = path.join(DIR, 'ffmpeg.exe');
const STAMP = path.join(DIR, 'yt-dlp.checked');
const YTDLP_FROM = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const FFMPEG_FROM = {
  url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz',
  gz: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  exe: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
};

let tell = () => {}; // (name, fraction done) while one is being fetched
const busy = new Map();
const once = (key, fn) => {
  if (!busy.has(key)) busy.set(key, fn().finally(() => busy.delete(key)));
  return busy.get(key);
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function bytes(url, name) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    got += value.length;
    if (total && Date.now() - last > 250) {
      last = Date.now();
      tell(name, got / total);
    }
  }
  return Buffer.concat(parts);
}

function place(file, buf) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file + '.part', buf);
  fs.renameSync(file + '.part', file);
}

const haveYtdlp = () => fs.existsSync(YTDLP);

function ytdlp() {
  if (haveYtdlp()) return Promise.resolve(YTDLP);
  return once('yt-dlp', async () => {
    try {
      tell('yt-dlp', 0);
      const sums = await (await net.fetch(YTDLP_FROM + 'SHA2-256SUMS')).text();
      const want = /^([0-9a-f]{64})\s+\*?yt-dlp\.exe\s*$/m.exec(sums)?.[1];
      const exe = want && (await bytes(YTDLP_FROM + 'yt-dlp.exe', 'yt-dlp'));
      if (!exe || sha(exe) !== want) throw new Error('tool:yt-dlp');
      place(YTDLP, exe);
      fs.writeFileSync(STAMP, String(Date.now()));
      return YTDLP;
    } catch (err) {
      throw new Error(String(err.message).startsWith('tool:') ? err.message : 'tool:yt-dlp');
    } finally {
      tell('yt-dlp', 1);
    }
  });
}

// yt-dlp's own update (it checks what it fetches): every 3 days, or (force) when it failed on a link
// and was not checked within the hour. → whether it changed
function update(force = false) {
  if (!haveYtdlp()) return Promise.resolve(false);
  let at = 0;
  try {
    at = Number(fs.readFileSync(STAMP, 'utf8')) || 0;
  } catch {
    /* (never checked) */
  }
  if (Date.now() - at < (force ? 3600e3 : 3 * 86400e3)) return Promise.resolve(false);
  return once('yt-dlp-U', () => new Promise((ok) => {
    execFile(YTDLP, ['-U'], { windowsHide: true, timeout: 120000 }, (err, out) => {
      try {
        fs.writeFileSync(STAMP, String(Date.now()));
      } catch {
        /* (read-only data folder) */
      }
      ok(/Updated yt-dlp to/i.test(String(out || '')));
    });
  }));
}

// FFmpeg already here: TyranWeb's own, else one in PATH or winget's links folder
function ffmpegHere() {
  if (fs.existsSync(FFMPEG)) return FFMPEG;
  const dirs = (process.env.PATH || '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  dirs.push(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'));
  for (const d of dirs) {
    const f = path.join(d, 'ffmpeg.exe');
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* (not there) */
    }
  }
  return '';
}

function ffmpeg() {
  const here = ffmpegHere();
  if (here) return Promise.resolve(here);
  return once('ffmpeg', async () => {
    try {
      tell('FFmpeg', 0);
      const gz = await bytes(FFMPEG_FROM.url, 'FFmpeg');
      if (sha(gz) !== FFMPEG_FROM.gz) throw new Error('tool:ffmpeg');
      const exe = zlib.gunzipSync(gz);
      if (sha(exe) !== FFMPEG_FROM.exe) throw new Error('tool:ffmpeg');
      place(FFMPEG, exe);
      return FFMPEG;
    } catch (err) {
      throw new Error(String(err.message).startsWith('tool:') ? err.message : 'tool:ffmpeg');
    } finally {
      tell('FFmpeg', 1);
    }
  });
}

// runs a program: → { code, out, err }; onLine(line) for each line it prints; stopped (with what it
// started) when signal aborts
function run(exe, args, { signal, onLine, env } = {}) {
  return new Promise((ok) => {
    if (signal?.aborted) return ok({ code: -1, out: '', err: 'aborted' });
    const p = spawn(exe, args, { windowsHide: true, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    let rest = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      out += chunk;
      if (!onLine) return;
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const l of lines) onLine(l);
    });
    p.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-200000);
    });
    const stop = () => execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {});
    signal?.addEventListener('abort', stop, { once: true });
    p.on('error', (e) => ok({ code: -1, out, err: String(e) }));
    p.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (onLine && rest) onLine(rest);
      ok({ code, out, err });
    });
  });
}

function init(fn) {
  tell = fn;
}

module.exports = { init, DIR, haveYtdlp, ytdlp, update, ffmpegHere, ffmpeg, run };
