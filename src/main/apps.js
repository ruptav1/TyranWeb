'use strict';
// The computer's own apps, started from TyranWeb's sidebar (its Ứng dụng trên máy panel lists them,
// its rail keeps the pinned ones, settings.pinnedApps). Only signed apps are offered or
// started: a program from the Start menu whose file carries a valid Authenticode signature, or a
// Store / MSIX app whose package is signed. They are found the way the Start menu lists them (its
// shortcuts, Get-StartApps) by Windows' own tools (apps.ps1: WinVerifyTrust, Get-AppxPackage);
// signatures are remembered by file (apps-cache.json) and checked again whenever a file changes.
// An app is started only from that list (by id), never from a path handed over.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, shell } = require('electron');
const data = require('./data');
const { t } = require('./i18n');

const SCRIPT = path.join(__dirname, 'apps.ps1');
const CACHE = path.join(data.dir, 'apps-cache.json');
const START_MENUS = [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
// shortcuts that are not an app to open
const NOT_APPS = /uninstall|gỡ cài đặt|gỡ bỏ|readme|read me|release notes|help|manual|documentation|website|license|changelog/i;
// a package's signature: from the Store, Windows', a company's, or a publisher's own certificate trusted here ("None": unsigned)
const SIGNED_PACKAGE = new Set(['Store', 'System', 'Enterprise', 'Developer']);

// apps.ps1 in a mode, given stdin; its JSON back (the script is passed as a command, as it can sit
// inside the app's archive where PowerShell cannot open it as a file)
function ps(mode, input = '') {
  return new Promise((resolve, reject) => {
    const script = `$mode = '${mode}'\n` + fs.readFileSync(SCRIPT, 'utf8');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      try {
        const v = JSON.parse(out.trim() || '[]');
        resolve(Array.isArray(v) ? v : [v]);
      } catch {
        reject(new Error('apps.ps1 ' + mode));
      }
    });
    p.stdin.end(input);
  });
}

const readCache = () => {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
};
const stamp = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
};
const idOf = (s) => crypto.createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 16);

// the Start menu's shortcuts to programs: { id, name, lnk, exe }
function shortcuts() {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
        continue;
      }
      if (!/\.lnk$/i.test(n.name) || NOT_APPS.test(n.name)) continue;
      let target = '';
      try {
        target = shell.readShortcutLink(p).target || '';
      } catch {
        continue;
      }
      if (!/\.exe$/i.test(target) || !fs.existsSync(target)) continue;
      const name = n.name.replace(/\.lnk$/i, '');
      const key = (name + '|' + target).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: 'w' + idOf(p), kind: 'program', name, lnk: p, exe: target });
    }
  };
  for (const d of START_MENUS) walk(d, 0);
  return out;
}

// signatures of programs, by file: { [exe]: { stamp, ok, signer } }, checked in four PowerShells at once
async function verify(files, sigs) {
  const parts = [[], [], [], []];
  files.forEach((f, i) => parts[i % 4].push(f));
  const res = (await Promise.all(parts.filter((p) => p.length).map((p) => ps('verify', JSON.stringify(p)).catch(() => [])))).flat();
  for (const r of res) if (r?.path) sigs[r.path] = { stamp: stamp(r.path), ok: !!r.ok, signer: String(r.signer || '') };
}

// The signed apps: [{ id, kind, name, signer, ... }], remembered with the signatures (apps-cache.json:
// { sigs, list, at }) so the panel shows them at once while they are looked for again
let last = null; // { at, list }
let scanning = null;
let onChange = () => {};
function scan() {
  scanning ||= (async () => {
    const programs = shortcuts();
    const packages = await ps('packages').catch(() => null);
    const cache = readCache();
    const sigs = cache.sigs || {};
    // (only files new or changed since they were checked)
    const need = [...new Set(programs.map((p) => p.exe))].filter((exe) => sigs[exe]?.stamp !== stamp(exe));
    if (need.length) await verify(need, sigs);
    const pk = packages
      ? packages
          .filter((p) => p?.appid && SIGNED_PACKAGE.has(p.kind))
          .map((p) => ({ id: 'p' + idOf(p.appid), kind: 'package', name: String(p.name), appid: String(p.appid), signer: String(p.publisher || ''), location: String(p.location || ''), logo: String(p.logo || '') }))
      : (cache.list || []).filter((a) => a.kind === 'package'); // (PowerShell failed: the ones known before)
    const list = [...programs.filter((p) => sigs[p.exe]?.ok).map((p) => ({ ...p, signer: sigs[p.exe].signer })), ...pk].sort((a, b) => a.name.localeCompare(b.name));
    const changed = JSON.stringify(list) !== JSON.stringify(last?.list || cache.list || null);
    last = { at: Date.now(), list };
    try {
      fs.writeFileSync(CACHE, JSON.stringify({ sigs, list, at: last.at }));
    } catch {
      /* found again next time */
    }
    if (changed) onChange();
    return list;
  })().finally(() => (scanning = null));
  return scanning;
}
// the list as known now (from before, if need be), looked for again in the background when it is
// older than a few minutes or asked for (onChange tells when it changed)
async function known(fresh = false) {
  last ||= (() => {
    const c = readCache();
    return Array.isArray(c.list) ? { at: c.at || 0, list: c.list } : null;
  })();
  if (!last) return scan();
  if (fresh || Date.now() - last.at > 5 * 60000) scan().catch(() => {});
  return last.list;
}

// what the sidebar shows of them
const shown = (a) => ({ id: a.id, name: a.name, kind: a.kind, signer: a.signer });
const list = (fresh) => known(fresh).then((l) => l.map(shown));
// (the first time, the apps are looked for a while after the start, so the panel is ready)
function init(changed) {
  onChange = changed;
  if (!fs.existsSync(CACHE)) setTimeout(() => scan().catch(() => {}), 45000);
}

// an app's icon as a data: URL ('' when it has none to give)
const icons = new Map();
async function icon(id) {
  if (icons.has(id)) return icons.get(id);
  const a = (await known()).find((x) => x.id === id);
  let url = '';
  if (a?.kind === 'program') {
    url = await app.getFileIcon(a.exe, { size: 'large' }).then((img) => img.toDataURL(), () => '');
  } else if (a?.kind === 'package' && a.logo) {
    // its logo, in the size closest to a sidebar icon (the manifest names it without its scale)
    const rel = a.logo.replace(/\//g, '\\');
    const dir = path.join(a.location, path.dirname(rel));
    const base = path.basename(rel, path.extname(rel)).toLowerCase();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().startsWith(base) && /\.png$/i.test(f));
    } catch {
      /* the package's folder is closed to us */
    }
    const rank = (f) => {
      const m = /targetsize-(\d+)(_altform-unplated)?/i.exec(f);
      if (m) return Math.abs(Number(m[1]) - 48) - (m[2] ? 0.5 : 0);
      const s = /scale-(\d+)/i.exec(f);
      return s ? 30 + Math.abs(Number(s[1]) - 200) / 10 : 40;
    };
    const best = files.sort((x, y) => rank(x) - rank(y))[0];
    if (best) {
      try {
        url = 'data:image/png;base64,' + fs.readFileSync(path.join(dir, best)).toString('base64');
      } catch {
        /* unreadable */
      }
    }
  }
  icons.set(id, url);
  return url;
}

// Starts an app of the list: a program through its own shortcut (with its arguments and folder),
// once its file still carries its signature; a package through the Start menu's own entry.
async function launch(id) {
  let a = (await known()).find((x) => x.id === id);
  if (!a) a = (await scan()).find((x) => x.id === id);
  if (!a) throw new Error(t('Không tìm thấy ứng dụng này'));
  if (a.kind === 'program') {
    // (its file changed since it was checked: checked again first)
    const cache = readCache();
    const sigs = cache.sigs || {};
    if (sigs[a.exe]?.stamp !== stamp(a.exe)) {
      await verify([a.exe], sigs);
      try {
        fs.writeFileSync(CACHE, JSON.stringify({ ...cache, sigs }));
      } catch {
        /* checked again next time */
      }
    }
    if (!sigs[a.exe]?.ok) throw new Error(t('Ứng dụng này không còn chữ ký hợp lệ'));
    const err = await shell.openPath(a.lnk);
    if (err) throw new Error(err);
    return true;
  }
  if (!/^[\w.-]+_[a-z0-9]+![\w.-]+$/i.test(a.appid)) throw new Error(t('Không tìm thấy ứng dụng này'));
  spawn('explorer.exe', ['shell:AppsFolder\\' + a.appid], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

module.exports = { init, list, icon, launch };
