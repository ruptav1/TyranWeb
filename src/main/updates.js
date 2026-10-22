'use strict';
// Updates from GitHub Releases (package.json "updates.github": owner/repo). A release is tagged
// vX.Y.Z and carries the share zip (TyranWeb-X.Y.Z-win-x64.zip) and its SHA-256
// (…zip.sha256, both made by scripts/release.js). TyranWeb looks for a newer one at start and twice
// a day, says so, and only on the user's word downloads it, checks its sum, unpacks it beside, and
// starts again: a small PowerShell script waits for TyranWeb to close, copies the new files over the
// app folder and opens it. The user's data is elsewhere (data.js) and is not touched. Only for the
// built app, and only where its folder can be written (else the release page opens instead).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { app, net, shell } = require('electron');
const { t } = require('./i18n');
const data = require('./data');

const REPO = (() => {
  try {
    return String(require('../../package.json').updates?.github || '');
  } catch {
    return '';
  }
})();
// (TYRAN_UPDATE_API: a stand-in release for the headless tests only)
const API = (process.env.TYRAN_SHOT && process.env.TYRAN_UPDATE_API) || `https://api.github.com/repos/${REPO}/releases/latest`;
const UA = { 'User-Agent': 'TyranWeb-updater', Accept: 'application/vnd.github+json' };
const appDir = () => path.dirname(process.execPath);

// 1.10.0 > 1.9.2
const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

let state = { stage: 'idle', current: app.getVersion(), latest: '', notes: '', page: '', pct: 0, error: '' };
let release = null; // { zip, sum } download addresses of the newer release
let onChange = () => {};
const set = (patch) => {
  state = { ...state, ...patch };
  onChange(state);
};

// (manual: asked for in Settings; the regular checks only with general.checkUpdates on)
async function check(manual = false) {
  if (!app.isPackaged || !REPO || (!manual && data.settings.data.general.checkUpdates === false)) return state;
  if (['downloading', 'ready'].includes(state.stage)) return state;
  set({ stage: 'checking', error: '' });
  try {
    const res = await net.fetch(API, { headers: UA });
    if (res.status === 404) return set({ stage: 'latest' }), state; // (no release yet)
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    const version = String(r.tag_name || '').replace(/^v/, '');
    const zip = (r.assets || []).find((a) => /-win-x64\.zip$/i.test(a.name));
    const sum = zip && (r.assets || []).find((a) => a.name === zip.name + '.sha256');
    if (!newer(version, app.getVersion()) || !zip || !sum) return set({ stage: 'latest', latest: version }), state;
    release = { zip: zip.browser_download_url, sum: sum.browser_download_url, size: zip.size };
    set({ stage: 'available', latest: version, notes: String(r.body || '').slice(0, 2000), page: String(r.html_url || '') });
  } catch (err) {
    set({ stage: 'error', error: err.message });
  }
  return state;
}

// (the app's folder takes new files: an unpacked zip yes, Program Files usually not)
function writable(dir) {
  try {
    const probe = path.join(dir, `.tyranweb-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

function untar(file, into) {
  return new Promise((ok, no) => {
    const p = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-x', '-f', file, '-C', into], { windowsHide: true });
    p.on('error', no);
    p.on('close', (code) => (code === 0 ? ok() : no(new Error('tar ' + code))));
  });
}

let staged = '';
async function download() {
  if (state.stage !== 'available' || !release) return state;
  if (!writable(appDir())) {
    shell.openExternal(state.page || `https://github.com/${REPO}/releases/latest`);
    throw new Error(t('Không ghi được vào thư mục của TyranWeb: hãy tải bản mới từ trang vừa mở'));
  }
  set({ stage: 'downloading', pct: 0, error: '' });
  try {
    const want = (await (await net.fetch(release.sum, { headers: UA })).text()).trim().split(/\s+/)[0].toLowerCase();
    const res = await net.fetch(release.zip, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || release.size || 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyranweb-update-'));
    const file = path.join(dir, 'update.zip');
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash('sha256');
    let got = 0;
    let shown = -1;
    for await (const c of res.body) {
      const b = Buffer.from(c);
      hash.update(b);
      if (!out.write(b)) await new Promise((r) => out.once('drain', r));
      got += b.length;
      const pct = total ? Math.floor((100 * got) / total) : 0;
      if (pct !== shown) set({ pct: (shown = pct) });
    }
    await new Promise((r) => out.end(r));
    if (hash.digest('hex') !== want) throw new Error(t('Tệp tải về bị hỏng'));
    await untar(file, dir);
    fs.rmSync(file, { force: true });
    const root = path.join(dir, 'TyranWeb');
    if (!fs.existsSync(path.join(root, 'TyranWeb.exe'))) throw new Error(t('Gói cập nhật không đúng'));
    staged = root;
    set({ stage: 'ready', pct: 100 });
  } catch (err) {
    set({ stage: 'available', error: err.message });
    throw err;
  }
  return state;
}

// TyranWeb closes; the script copies the new files over it once it is gone, and opens it again
function install() {
  if (state.stage !== 'ready' || !staged) return false;
  const exe = process.execPath;
  const script = path.join(path.dirname(staged), 'apply.ps1');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  fs.writeFileSync(
    script,
    [
      `$p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
      'if ($p) { $p.WaitForExit(60000) | Out-Null }',
      'Start-Sleep -Milliseconds 500',
      `robocopy ${q(staged)} ${q(appDir())} /E /R:5 /W:1 /NFL /NDL /NJH /NJS | Out-Null`,
      process.env.TYRAN_SHOT ? "" : `Start-Process -FilePath ${q(exe)}`,
      `Remove-Item -LiteralPath ${q(path.dirname(staged))} -Recurse -Force -ErrorAction SilentlyContinue`,
    ].join('\r\n'),
    'utf8'
  );
  // Started by Windows' WMI service rather than as TyranWeb's own child: a launcher that ends every
  // process it started along with it (a job object) would end the script too, before it copies.
  const line = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  execFile('powershell.exe', ['-NoProfile', '-Command', `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(line)} }; exit $r.ReturnValue`], { windowsHide: true }, (err) => {
    if (err) spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
  });
  return true;
}

// at start (after a while) and twice a day; `changed` hears every step
function init(changed) {
  if (changed) onChange = changed;
  if (!app.isPackaged || !REPO) return;
  setTimeout(check, 30e3);
  setInterval(check, 12 * 3600e3);
}

module.exports = { init, check, download, install, status: () => state };
