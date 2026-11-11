'use strict';
// Downloads TyranWeb makes itself rather than Chromium's own downloader: a stream joined piece by
// piece (Truy tìm video), a post through yt-dlp, a Pixiv animation (Tải từ đường dẫn). Where their
// files go and how they are named, and their records in Tải xuống: sent to the downloads panel as
// Electron's own downloads are, kept in its list when done (unless they come from a private tab),
// cancelled from it.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const data = require('./data');

const jobs = new Map(); // record id → its cancel
let broadcast = () => {};

function dir() {
  const g = data.settings.data.general;
  return g.downloadDir && fs.existsSync(g.downloadDir) ? g.downloadDir : app.getPath('downloads');
}

const safe = (s) =>
  String(s || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120) || 'video';

// a name not taken yet in its folder (a part file of one being written counts too)
function unique(file) {
  const { dir: d, name, ext } = path.parse(file);
  let out = file;
  for (let i = 1; fs.existsSync(out) || fs.existsSync(out + '.part'); i++) out = path.join(d, `${name} (${i})${ext}`);
  return out;
}

// start({ url, filename, path, mime, totalBytes, private, cancel }) → { rec, update(fields), finish(state, fields) }
function start(o) {
  const rec = {
    id: data.uid('d'),
    url: o.url,
    filename: o.filename || path.basename(o.path || '') || 'video',
    path: o.path || '',
    mime: o.mime || 'video/mp4',
    totalBytes: o.totalBytes || 0,
    receivedBytes: 0,
    state: 'progressing',
    paused: false,
    canResume: false,
    startTime: Date.now(),
    private: !!o.private,
  };
  let told = 0;
  if (o.cancel) jobs.set(rec.id, o.cancel);
  broadcast('downloads:update', { ...rec });
  return {
    rec,
    update(fields, now = false) {
      Object.assign(rec, fields);
      if (rec.path) rec.filename = path.basename(rec.path);
      if (now || Date.now() - told > 300) {
        told = Date.now();
        broadcast('downloads:update', { ...rec });
      }
    },
    finish(state, fields = {}) {
      jobs.delete(rec.id);
      Object.assign(rec, fields, { state, endTime: Date.now() });
      if (rec.path) rec.filename = path.basename(rec.path);
      if (state === 'completed' && !rec.totalBytes) rec.totalBytes = rec.receivedBytes;
      if (!rec.private) {
        data.downloadStore.data.items.unshift({ ...rec });
        data.downloadStore.data.items.splice(500);
        data.downloadStore.save();
      }
      broadcast('downloads:update', { ...rec });
      if (state === 'completed') broadcast('downloads:done', { ...rec });
    },
  };
}

function cancel(id) {
  const c = jobs.get(id);
  if (!c) return false;
  c();
  return true;
}

function init(b) {
  broadcast = b;
}

module.exports = { init, dir, safe, unique, start, cancel };
