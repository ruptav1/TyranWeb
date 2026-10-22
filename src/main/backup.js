'use strict';
// Settings → Giới thiệu → Sao lưu / Khôi phục: TyranWeb's own data in one .zip: settings, bookmarks,
// history, notes, the downloads list, the open tabs, its cursors; with "Kèm ảnh, video, nhạc đã
// thêm" also the wallpapers, videos and music added by hand and the imported web wallpapers. Not in
// it: sign-ins and site data (the browser profile), downloaded game characters (downloaded again on
// request) and lobby previews (taken again). Restoring puts the backup's in place of the current
// ones and starts TyranWeb again. The zips are made and read by Windows' own tar.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');
const data = require('./data');
const { USER_WALLPAPERS, LIVE_WALLPAPERS } = require('./protocol');
const { t } = require('./i18n');

const CORE = ['settings.json', 'bookmarks.json', 'history.json', 'notes.json', 'downloads.json', 'session.json'];
const MANIFEST = 'tyranweb-backup.json';
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function tar(args, cwd) {
  return new Promise((ok, no) => {
    const p = spawn(TAR, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', no);
    p.on('close', (code) => (code === 0 ? ok() : no(new Error(err.trim() || 'tar ' + code))));
  });
}
const temp = (what) => fs.mkdtempSync(path.join(os.tmpdir(), `tyranweb-${what}-`));
// the imported web wallpapers: their list and their folders (not the game characters there)
const livePackages = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(LIVE_WALLPAPERS, 'index.json'), 'utf8'))
      .map((w) => path.basename(String(w.id || '')))
      .filter((id) => id && fs.existsSync(path.join(LIVE_WALLPAPERS, id)));
  } catch {
    return [];
  }
};

let busy = false;
// (file: only for the headless tests, TYRAN_SHOT, which cannot answer a dialog)
async function make(win, media, file) {
  if (busy) throw new Error(t('Đang sao lưu hoặc khôi phục'));
  const day = new Date().toISOString().slice(0, 10);
  const r = file ? { filePath: file } : await dialog.showSaveDialog(win, { title: t('Lưu bản sao lưu'), defaultPath: path.join(app.getPath('documents'), `TyranWeb-${day}.zip`), filters: [{ name: 'Zip', extensions: ['zip'] }] });
  if (r.canceled || !r.filePath) return null;
  busy = true;
  const stage = temp('backup');
  try {
    data.flushAll();
    const wallpapers = path.basename(USER_WALLPAPERS);
    fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify({ app: 'TyranWeb', version: app.getVersion(), created: new Date().toISOString(), media: !!media, wallpapers }, null, 1));
    for (const f of CORE) if (fs.existsSync(path.join(data.dir, f))) fs.copyFileSync(path.join(data.dir, f), path.join(stage, f));
    if (fs.existsSync(path.join(data.dir, 'cursors'))) fs.cpSync(path.join(data.dir, 'cursors'), path.join(stage, 'cursors'), { recursive: true });
    // (tar takes its options before the first file only)
    const args = ['-a', '-c', '-f', r.filePath, '--exclude', `${wallpapers}/ba-previews`, '-C', stage, '.'];
    if (media) {
      if (fs.existsSync(USER_WALLPAPERS)) args.push('-C', path.dirname(USER_WALLPAPERS), wallpapers);
      const live = livePackages();
      if (live.length) args.push('-C', path.dirname(LIVE_WALLPAPERS), 'live/index.json', ...live.map((id) => `live/${id}`));
    }
    fs.rmSync(r.filePath, { force: true });
    await tar(args);
    return r.filePath;
  } finally {
    busy = false;
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function restore(win, file) {
  if (busy) throw new Error(t('Đang sao lưu hoặc khôi phục'));
  const r = file ? { filePaths: [file] } : await dialog.showOpenDialog(win, { title: t('Chọn bản sao lưu'), properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] });
  if (r.canceled || !r.filePaths[0]) return false;
  busy = true;
  const stage = temp('restore');
  try {
    await tar(['-x', '-f', r.filePaths[0], '-C', stage]);
    let m = null;
    try {
      m = JSON.parse(fs.readFileSync(path.join(stage, MANIFEST), 'utf8'));
    } catch {
      /* not one */
    }
    if (m?.app !== 'TyranWeb') throw new Error(t('Đây không phải bản sao lưu của TyranWeb'));
    data.flushAll();
    for (const f of CORE) if (fs.existsSync(path.join(stage, f))) fs.copyFileSync(path.join(stage, f), path.join(data.dir, f));
    if (fs.existsSync(path.join(stage, 'cursors'))) fs.cpSync(path.join(stage, 'cursors'), path.join(data.dir, 'cursors'), { recursive: true });
    const wallpapers = path.join(stage, path.basename(String(m.wallpapers || 'wallpapers')));
    if (m.media && fs.existsSync(wallpapers)) fs.cpSync(wallpapers, USER_WALLPAPERS, { recursive: true });
    const live = path.join(stage, 'live');
    if (m.media && fs.existsSync(live)) {
      // the imported web wallpapers: the backup's added to the ones here
      const read = (f) => {
        try {
          return JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch {
          return [];
        }
      };
      const mine = read(path.join(LIVE_WALLPAPERS, 'index.json'));
      const theirs = read(path.join(live, 'index.json')).filter((w) => !mine.some((x) => x.id === w.id));
      for (const w of theirs) {
        const id = path.basename(String(w.id || ''));
        if (id && fs.existsSync(path.join(live, id))) fs.cpSync(path.join(live, id), path.join(LIVE_WALLPAPERS, id), { recursive: true });
      }
      fs.mkdirSync(LIVE_WALLPAPERS, { recursive: true });
      fs.writeFileSync(path.join(LIVE_WALLPAPERS, 'index.json'), JSON.stringify([...theirs, ...mine], null, 2));
    }
    // (at once: nothing of the running app may write the old data back over it)
    if (!process.env.TYRAN_SHOT) app.relaunch();
    app.exit(0);
    return true;
  } finally {
    busy = false;
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { make, restore };
