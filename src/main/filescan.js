'use strict';
// Kiểm tra tệp tải về (general.scanDownloads): a finished download, Chromium's or TyranWeb's own
// (dljobs.js), is scanned when it is a program or a script Windows runs on a double click (.exe,
// .bat, .cmd, .msi, .ps1, .vbs, .lnk...), or an archive (zip, rar, 7z, tar, cab, iso) with one of
// those, or another archive, inside: its names are read by Windows' own tar (libarchive; nothing is
// unpacked), one that cannot be read is scanned too. Other files are left alone (the user's choice:
// no result tab for every picture or video). Scanned by Windows Defender (MpCmdRun: a custom scan of
// that one file, which looks into the archive too), programs first. The result goes on the
// download's record (`scan`):
//   { state: 'queued' | 'scanning' | 'clean' | 'threat' | 'removed' | 'unavailable' | 'error',
//     threat (Defender's name for it), sha256, inside (the programs an archive holds) }
// and in Lịch sử → Đã quét (data.scanHistoryStore), which keeps it after the download list is cleared.
// 'removed': Defender's own real-time protection took the file away first (its name read from
// Defender's history), or it was quarantined from Tải xuống. A file with a threat is not opened from
// TyranWeb; a program still being scanned is opened once it is found clean. Its SHA-256 is kept
// for VirusTotal's page about it, opened only when asked (the address carries the hash, not the file).
// Then VirusTotal's vendors (virustotal.js, with the user's own key), and the window in front opens
// the result page (tyran://scan/?id=<download id>) as soon as the download is done.
// Every download is also marked as coming from the internet (Zone.Identifier, as Chrome does), so
// Windows' SmartScreen checks a program when it is run and Office opens documents in Protected View.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { shell } = require('electron');
const data = require('./data');

// what Windows runs on a double click (not .js / .dll: every source folder and game mod has them)
const RISKY = /\.(exe|bat|cmd|com|scr|pif|msi|msix|msp|appx|appxbundle|ps1|psm1|vbs|vbe|wsf|wsh|hta|lnk|jar|cpl|reg|application|gadget)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|cab|iso)$/i;
const priorityOf = (file) => (RISKY.test(file) ? 0 : ARCHIVE.test(file) ? 1 : 2);
const SCAN_TIMEOUT = 20 * 60e3;
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

// Is it to be scanned? { inside: [programs and archives an archive holds] } | null (left alone)
async function worthScanning(file) {
  if (RISKY.test(file)) return { inside: [] };
  if (!ARCHIVE.test(file)) return null;
  const r = fs.existsSync(TAR) ? await run(TAR, ['-tf', file], 60e3) : { code: -1, out: '' };
  // (one whose names cannot be read: a password on them, a kind tar does not know: scanned)
  if (r.code !== 0) return { inside: [], unread: true };
  const names = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const inside = names.filter((n) => RISKY.test(n) || ARCHIVE.test(n));
  return inside.length ? { inside: inside.slice(0, 20), count: inside.length } : null;
}

let broadcast = () => {};
const queue = []; // { id, file, priority }
const waiting = new Map(); // id -> [resolve] of those waiting for its result (opening a program)
const kept = new Map(); // id -> record of a private download (not in the list kept on disk)
let busy = false;

// ---------------------------------------------------------------- Windows Defender
let scanner;
// MpCmdRun.exe of Defender's newest platform (where Windows updates it), else the one it came with
function mpCmdRun() {
  if (scanner !== undefined) return scanner;
  scanner = null;
  const platform = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
  try {
    const num = (v) => v.split(/[.-]/).map((x) => Number(x) || 0);
    const newer = (a, b) => {
      const x = num(a);
      const y = num(b);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    };
    for (const v of fs.readdirSync(platform).sort(newer)) {
      const exe = path.join(platform, v, 'MpCmdRun.exe');
      if (fs.existsSync(exe)) return (scanner = exe);
    }
  } catch {
    /* no platform folder */
  }
  const old = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
  if (fs.existsSync(old)) scanner = old;
  return scanner;
}

const run = (exe, args, timeout) =>
  new Promise((ok) => execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 4 << 20 }, (err, out, errOut) => ok({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${out || ''}${errOut || ''}` })));

// Defender's verdict on one file: { state, threat }
async function defender(file, remediate = false) {
  const exe = mpCmdRun();
  if (!exe) return { state: 'unavailable' };
  const r = await run(exe, ['-Scan', '-ScanType', '3', '-File', file, ...(remediate ? [] : ['-DisableRemediation'])], SCAN_TIMEOUT);
  const threat = /^\s*Threat\s*:\s*(.+)$/m.exec(r.out)?.[1]?.trim() || '';
  if (r.code === 2 || threat) return { state: 'threat', threat };
  if (r.code === 0 && /found no threats/i.test(r.out)) return { state: 'clean' };
  // (Defender turned off, or another antivirus in its place)
  if (/0x800106ba|0x80070422|service|not running|disabled/i.test(r.out)) return { state: 'unavailable' };
  return { state: 'error' };
}

// what Defender's history says it found in `file` (it took it away itself): its name, '' none
async function detectedIn(file) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const lit = file.replace(/'/g, "''");
  const script = `$f='${lit}'; $d = Get-MpThreatDetection | Where-Object { ($_.Resources -join '|').ToLower().Contains($f.ToLower()) } | Sort-Object InitialDetectionTime -Descending | Select-Object -First 1; if ($d) { (Get-MpThreat -ThreatID $d.ThreatID).ThreatName }`;
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 30e3);
  return r.code === 0 ? r.out.trim().split(/\r?\n/).pop() || '' : '';
}

// ---------------------------------------------------------------- the file itself
function sha256(file) {
  return new Promise((ok) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')))
      .on('error', () => ok(''));
  });
}

// marked as from the internet (unless something marked it already)
function markOfTheWeb(file, url, isPrivate) {
  try {
    const ads = file + ':Zone.Identifier';
    if (fs.existsSync(ads)) return;
    const host = !isPrivate && /^https?:/i.test(url || '') ? url : 'about:internet';
    fs.writeFileSync(ads, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${host}\r\n`);
  } catch {
    /* not NTFS (a FAT32 stick): no mark */
  }
}

// ---------------------------------------------------------------- records
function recordOf(id) {
  return data.downloadStore.data.items.find((d) => d.id === id) || kept.get(id) || null;
}
function setScan(id, scan) {
  const rec = recordOf(id);
  if (!rec) return;
  rec.scan = { ...(rec.scan || {}), ...scan };
  if (!kept.has(id)) data.downloadStore.save();
  broadcast('downloads:update', { ...rec });
  if (!rec.private) remember(rec);
  if (scan.state && !['queued', 'scanning'].includes(scan.state)) {
    for (const ok of waiting.get(id) || []) ok(rec.scan);
    waiting.delete(id);
  }
}

// ---------------------------------------------------------------- Lịch sử → Đã quét
// Every scanned file with its verdicts (not a private tab's), newest first, kept apart from the
// downloads list so that clearing that one keeps it.
const HISTORY_MAX = 500;
let told = null;
function remember(rec) {
  const store = data.scanHistoryStore;
  const items = (store.data.items ||= []);
  let e = items.find((x) => x.id === rec.id);
  if (!e) {
    e = { id: rec.id, at: Date.now() };
    items.unshift(e);
    items.splice(HISTORY_MAX);
  }
  Object.assign(e, { filename: rec.filename, path: rec.path, url: rec.url, size: rec.totalBytes || rec.receivedBytes || 0, state: rec.state, scan: rec.scan });
  store.save();
  told ??= setTimeout(() => {
    told = null;
    broadcast('scanhistory:changed');
  }, 300);
}
const historyOf = (id) => (data.scanHistoryStore.data.items || []).find((x) => x.id === id) || null;
async function historyList(text) {
  const q = String(text || '').toLowerCase();
  const items = (data.scanHistoryStore.data.items || []).filter((x) => !q || `${x.filename} ${x.scan?.threat || ''} ${x.url || ''}`.toLowerCase().includes(q));
  return Promise.all(items.map(async (x, i) => ({ ...x, icon: i < 200 ? await iconOf(x.path) : '' })));
}
function historyRemove(id) {
  const store = data.scanHistoryStore;
  store.data.items = (store.data.items || []).filter((x) => x.id !== id);
  store.save();
  broadcast('scanhistory:changed');
  return true;
}
function historyClear(since) {
  const store = data.scanHistoryStore;
  const from = Number(since) || 0;
  store.data.items = from ? (store.data.items || []).filter((x) => x.at < from) : [];
  store.save();
  broadcast('scanhistory:changed');
  return true;
}

// ---------------------------------------------------------------- the queue
async function next() {
  if (busy || !queue.length) return;
  busy = true;
  queue.sort((a, b) => a.priority - b.priority);
  const job = queue.shift();
  try {
    setScan(job.id, { state: 'scanning' });
    if (!fs.existsSync(job.file)) {
      // (gone straight away: Defender's real-time protection, most likely)
      const threat = await detectedIn(job.file);
      setScan(job.id, threat ? { state: 'removed', threat } : { state: 'error' });
    } else {
      const [hash, verdict] = await Promise.all([sha256(job.file), defender(job.file)]);
      if (verdict.state === 'clean' && !fs.existsSync(job.file)) {
        const threat = await detectedIn(job.file);
        if (threat) verdict.state = 'removed', (verdict.threat = threat);
      }
      setScan(job.id, { ...verdict, sha256: hash });
      if (verdict.state === 'threat' || verdict.state === 'removed') broadcast('downloads:threat', { ...recordOf(job.id) });
      if (hash) toVirusTotal({ id: job.id, file: job.file, sha: hash, priority: job.priority });
    }
  } catch (err) {
    console.warn('[scan]', err.message);
    setScan(job.id, { state: 'error' });
  } finally {
    busy = false;
    next();
  }
}

// ---------------------------------------------------------------- VirusTotal
// After Defender, what VirusTotal's vendors say (virustotal.js), one file at a time, programs first.
// Many of them calling it malicious counts as a threat too.
const vtQueue = [];
let vtBusy = false;
const VT_BAD = 3; // (one or two vendors alone are often wrong)
const vtBad = (scan) => (scan?.vt?.stats?.malicious || 0) >= VT_BAD;
const isThreat = (scan) => ['threat', 'removed'].includes(scan?.state) || vtBad(scan);

function toVirusTotal(job) {
  const vt = require('./virustotal');
  if (!vt.hasKey()) return setScan(job.id, { vt: { state: 'nokey' } });
  setScan(job.id, { vt: { state: 'queued' } });
  vtQueue.push(job);
  nextVt();
}
async function nextVt() {
  if (vtBusy || !vtQueue.length) return;
  vtBusy = true;
  vtQueue.sort((a, b) => a.priority - b.priority);
  const job = vtQueue.shift();
  try {
    await require('./virustotal').check(job.file, job.sha, true, (vt) => {
      const was = vtBad(recordOf(job.id)?.scan);
      setScan(job.id, { vt });
      if (!was && vtBad(recordOf(job.id)?.scan) && !['threat', 'removed'].includes(recordOf(job.id)?.scan?.state)) broadcast('downloads:threat', { ...recordOf(job.id) });
    });
  } catch (err) {
    console.warn('[virustotal]', err.message);
    setScan(job.id, { vt: { state: 'error' } });
  } finally {
    vtBusy = false;
    nextVt();
  }
}
// VirusTotal asked again about a download (from its result page: a key just given, a quota renewed)
function recheck(id) {
  const rec = recordOf(id);
  if (!rec?.scan?.sha256 || vtQueue.some((j) => j.id === id) || ['queued', 'looking', 'uploading', 'analyzing'].includes(rec.scan.vt?.state)) return false;
  toVirusTotal({ id, file: rec.path, sha: rec.scan.sha256, priority: priorityOf(rec.path || '') });
  return true;
}

// ---------------------------------------------------------------- the result tab
// The window in front opens tyran://scan for a download being scanned, unless general.scanTab is 'off'.
function showResult(rec) {
  if (data.settings.data.general.scanTab === 'off') return;
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
  if (win && !win.isDestroyed()) win.webContents.send('scan:open', rec.id);
}

// A finished download (its record, as just kept or sent): marked, and scanned when that is on and it
// is worth it (worthScanning: a program, or an archive with one inside).
const deciding = new Map(); // id -> the answer for an archive still being looked into
async function add(rec) {
  if (!rec?.id || !rec.path) return;
  markOfTheWeb(rec.path, rec.url, rec.private);
  if (data.settings.data.general.scanDownloads === false || priorityOf(rec.path) > 1) return;
  const answer = worthScanning(rec.path).catch(() => ({ inside: [], unread: true }));
  deciding.set(rec.id, answer);
  const worth = await answer;
  deciding.delete(rec.id);
  if (!worth) return;
  if (rec.private || !data.downloadStore.data.items.some((d) => d.id === rec.id)) kept.set(rec.id, { ...rec });
  queue.push({ id: rec.id, file: rec.path, priority: priorityOf(rec.path) });
  setScan(rec.id, { state: 'queued', inside: worth.inside, insideCount: worth.count || worth.inside.length, unread: !!worth.unread });
  showResult(rec);
  next();
}

// A download of Chromium's that broke off: when Defender took its temporary file away while it was
// being written (Chromium's "<uuid>.tmp" / ".crdownload", whose name is not told), the record says so,
// by Defender's history of what it found while the download ran.
async function interrupted(rec) {
  if (!rec?.id || data.settings.data.general.scanDownloads === false || !mpCmdRun()) return;
  if (rec.private || !data.downloadStore.data.items.some((d) => d.id === rec.id)) kept.set(rec.id, { ...rec });
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const since = Math.max(0, Number(rec.startTime) || Date.now() - 600e3) - 5000;
  const final = String(rec.path || '').replace(/'/g, "''").toLowerCase();
  const script = `$t=[DateTimeOffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime; $f='${final}'; $d = Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -ge $t -and (($r = ($_.Resources -join '|').ToLower()) -match '\\.(tmp|crdownload)(->|\\||$)' -or ($f -and $r.Contains($f))) } | Sort-Object InitialDetectionTime -Descending | Select-Object -First 1; if ($d) { (Get-MpThreat -ThreatID $d.ThreatID).ThreatName }`;
  for (let i = 0; i < 2; i++) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 30e3);
    const threat = r.code === 0 ? r.out.trim().split(/\r?\n/).pop() || '' : '';
    if (threat) {
      setScan(rec.id, { state: 'removed', threat });
      broadcast('downloads:threat', { ...recordOf(rec.id) });
      showResult(rec);
      return;
    }
  }
  kept.delete(rec.id);
}

// its scan's result, once there is one (null: not scanned)
function result(id) {
  const scan = recordOf(id)?.scan;
  if (!scan) return Promise.resolve(null);
  if (!['queued', 'scanning'].includes(scan.state)) return Promise.resolve(scan);
  return new Promise((ok) => waiting.set(id, [...(waiting.get(id) || []), ok]));
}

// May it be opened? A threat never; a program or an archive still being scanned once found clean.
async function mayOpen(id, file) {
  if (deciding.has(id)) await deciding.get(id); // (an archive still being looked into)
  const scan = recordOf(id)?.scan;
  if (!scan) return true;
  if (['queued', 'scanning'].includes(scan.state) && priorityOf(file || '') < 2) return !isThreat(await result(id));
  return !isThreat(scan);
}

// A threat found in a download handed to Defender to deal with (quarantined: Windows Security can
// give it back); if it is still there (one only VirusTotal's vendors flag), it goes to the Recycle Bin.
async function quarantine(id) {
  const rec = recordOf(id);
  if (!rec?.path || !(rec.scan?.state === 'threat' || vtBad(rec.scan))) return false;
  if (fs.existsSync(rec.path)) await defender(rec.path, true);
  for (let i = 0; i < 10 && fs.existsSync(rec.path); i++) await new Promise((ok) => setTimeout(ok, 500));
  if (fs.existsSync(rec.path)) await shell.trashItem(rec.path).catch(() => {});
  if (fs.existsSync(rec.path)) return false;
  setScan(id, { state: 'removed' });
  return true;
}

function init(b) {
  broadcast = b;
  // (the first time: the files scanned before there was this history, from the downloads list)
  const hist = data.scanHistoryStore;
  if (!hist.data.items?.length && !hist.data.filled) {
    hist.data.items = data.downloadStore.data.items
      .filter((d) => d.scan && !d.private && priorityOf(d.path || d.filename || '') < 2)
      .slice(0, HISTORY_MAX)
      .map((d) => ({ id: d.id, at: d.endTime || d.startTime || Date.now(), filename: d.filename, path: d.path, url: d.url, size: d.totalBytes || d.receivedBytes || 0, state: d.state, scan: d.scan }));
    hist.data.filled = true;
    hist.save();
  }
  // (scans TyranWeb was closed in the middle of: done again once it has settled; the list taken
  // now, before this run's own scans start)
  const scans = [];
  const asks = [];
  for (const d of data.downloadStore.data.items) {
    if (['queued', 'scanning'].includes(d.scan?.state) && d.path) scans.push({ id: d.id, file: d.path, priority: priorityOf(d.path) });
    else if (['queued', 'looking', 'uploading', 'analyzing'].includes(d.scan?.vt?.state) && d.scan.sha256) asks.push({ id: d.id, file: d.path, sha: d.scan.sha256, priority: priorityOf(d.path || '') });
  }
  if (scans.length || asks.length)
    setTimeout(() => {
      queue.push(...scans);
      vtQueue.push(...asks);
      next();
      nextVt();
    }, 15000);
}

// what is known of a download's scan (for its record while it is still Chromium's)
const scanOf = (id) => recordOf(id)?.scan;

// For the result page: the download's record and VirusTotal's report on it (null: none yet)
async function details(id) {
  // (from the downloads list, or from Đã quét once it was cleared from that list)
  const rec = recordOf(String(id || '')) || historyOf(String(id || ''));
  if (!rec) return null;
  return { rec: { ...rec }, report: rec.scan?.sha256 ? require('./virustotal').report(rec.scan.sha256) : null, hasKey: require('./virustotal').hasKey(), risky: priorityOf(rec.path || rec.filename || '') < 2, icon: await iconOf(rec.path) };
}

// A program's or a script's own icon, as Windows shows it (a data URL; '' none): the one inside an
// .exe, the one Windows gives .bat / .cmd files... (only read, never run)
const ICONIC = /\.(exe|bat|cmd|com|scr|msi)$/i;
const icons = new Map(); // path -> data URL
async function iconOf(file) {
  if (!file || !ICONIC.test(file) || !fs.existsSync(file)) return '';
  if (icons.has(file)) return icons.get(file);
  let url = '';
  try {
    const img = await require('electron').app.getFileIcon(file, { size: 'large' });
    url = img.isEmpty() ? '' : img.toDataURL();
  } catch {
    url = '';
  }
  icons.set(file, url);
  return url;
}

module.exports = { init, add, interrupted, scanOf, result, mayOpen, quarantine, recheck, details, historyList, historyRemove, historyClear, priorityOf };
