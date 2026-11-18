'use strict';
// Kiểm tra tệp tải về (general.scanDownloads): every finished download, Chromium's or TyranWeb's own
// (dljobs.js), is scanned by Windows Defender (MpCmdRun: a custom scan of that one file, which looks
// into archives too: zip, rar, 7z...), programs and scripts (.exe, .bat, .cmd, .msi, .ps1...) first,
// then archives, then the rest. The result goes on the download's record (`scan`):
//   { state: 'queued' | 'scanning' | 'clean' | 'threat' | 'removed' | 'unavailable' | 'error',
//     threat (Defender's name for it), sha256 }
// 'removed': Defender's own real-time protection took the file away first (its name read from
// Defender's history), or it was quarantined from Tải xuống. A file with a threat is not opened from
// TyranWeb; a program still being scanned is opened once it is found clean. Its SHA-256 is kept
// for VirusTotal's page about it, opened only when asked (the address carries the hash, not the file).
// Every download is also marked as coming from the internet (Zone.Identifier, as Chrome does), so
// Windows' SmartScreen checks a program when it is run and Office opens documents in Protected View.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { shell } = require('electron');
const data = require('./data');

const RISKY = /\.(exe|bat|cmd|com|scr|pif|msi|msix|msp|appx|appxbundle|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|dll|cpl|ocx|sys|jar|reg|inf|application|gadget|chm)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|cab|iso|img|vhd|vhdx|arj|lzh|lha|z)$/i;
const priorityOf = (file) => (RISKY.test(file) ? 0 : ARCHIVE.test(file) ? 1 : 2);
const SCAN_TIMEOUT = 20 * 60e3;

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
  if (scan.state && !['queued', 'scanning'].includes(scan.state)) {
    for (const ok of waiting.get(id) || []) ok(rec.scan);
    waiting.delete(id);
  }
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
    }
  } catch (err) {
    console.warn('[scan]', err.message);
    setScan(job.id, { state: 'error' });
  } finally {
    busy = false;
    next();
  }
}

// a finished download (its record, as just kept or sent): marked, and scanned when that is on
function add(rec) {
  if (!rec?.id || !rec.path) return;
  markOfTheWeb(rec.path, rec.url, rec.private);
  if (data.settings.data.general.scanDownloads === false) return;
  if (rec.private || !data.downloadStore.data.items.some((d) => d.id === rec.id)) kept.set(rec.id, { ...rec });
  queue.push({ id: rec.id, file: rec.path, priority: priorityOf(rec.path) });
  setScan(rec.id, { state: 'queued' });
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
  const scan = recordOf(id)?.scan;
  if (!scan) return true;
  if (['queued', 'scanning'].includes(scan.state) && priorityOf(file || '') < 2) return !['threat', 'removed'].includes((await result(id))?.state);
  return !['threat', 'removed'].includes(scan.state);
}

// A threat found in a download handed to Defender to deal with (quarantined: Windows Security can
// give it back); if it is still there, it goes to the Recycle Bin.
async function quarantine(id) {
  const rec = recordOf(id);
  if (!rec?.path || rec.scan?.state !== 'threat') return false;
  if (fs.existsSync(rec.path)) await defender(rec.path, true);
  for (let i = 0; i < 10 && fs.existsSync(rec.path); i++) await new Promise((ok) => setTimeout(ok, 500));
  if (fs.existsSync(rec.path)) await shell.trashItem(rec.path).catch(() => {});
  if (fs.existsSync(rec.path)) return false;
  setScan(id, { state: 'removed' });
  return true;
}

function init(b) {
  broadcast = b;
  // (scans TyranWeb was closed in the middle of: done again, once it has settled)
  setTimeout(() => {
    for (const d of data.downloadStore.data.items) if (['queued', 'scanning'].includes(d.scan?.state) && d.path) queue.push({ id: d.id, file: d.path, priority: priorityOf(d.path) });
    next();
  }, 15000);
}

// what is known of a download's scan (for its record while it is still Chromium's)
const scanOf = (id) => recordOf(id)?.scan;

module.exports = { init, add, interrupted, scanOf, result, mayOpen, quarantine, priorityOf };
