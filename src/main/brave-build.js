'use strict';
// Builds Brave's ad-block engine for "Brave đầy đủ" (brave-adblock.js) on this computer: Brave
// publishes adblock-rust's Node module (npm "adblock-rs") only as source, and TyranWeb ships no copy.
// A Rust toolchain of TyranWeb's own (rustup with the GNU host: no Visual Studio, no admin rights;
// PATH and any Rust of the user's left alone) is fetched into <data>/brave-adblock/b, compiles the
// pinned source there, and is deleted with the rest of that folder; only the engine (~9 MB), its
// lists and resources stay. Measured on 2026-10-21: ~1.2 GB on disk while building, 3 minutes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const brave = require('./brave-adblock');
const { t } = require('./i18n');

// Where it is built: in the data folder, or in the temporary one when the data folder lies so deep
// that the toolchain's own programs (~120 characters below the build folder) would pass Windows'
// 260-character limit on paths (rustc then cannot start its linker). Short names below it for that.
const SPOTS = [path.join(brave.HOME, 'b'), path.join(os.tmpdir(), 'tyranweb-brave')];
const DEEPEST = 125;
let BUILD = SPOTS[0];
const RUSTUP = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe';
const TOOLCHAIN = '1.97'; // adblock-rs 0.13.3's rust-toolchain.toml
const HOST = 'x86_64-pc-windows-gnu';
const SOURCE = {
  url: `https://registry.npmjs.org/adblock-rs/-/adblock-rs-${brave.VERSION}.tgz`,
  integrity: 'sha512-HX1Jjo1wyB1x/NSGAW37grXhcyIB1taAoUHsqodCn2hdQiQmgcVLzU5pvpcQ7B5PWEtL2xU2iO/DPr2f1Aq4ZQ==',
};
const NEED = 2.5e9; // free space asked for before starting
const CRATES = 89; // packages cargo compiles for it (for the progress)
const TOOLCHAIN_BYTES = 865e6; // the toolchain installed (for the progress)
// each stage's share of the progress bar
const STAGES = { rustup: [0, 3], toolchain: [3, 25], source: [25, 38], compile: [38, 94], lists: [94, 99], cleanup: [99, 100] };

let job = null; // { stage, pct, child, abort, cancelled, promise }
let onProgress = () => {};

function progress(stage, frac = 0) {
  if (!job) return;
  const [a, b] = STAGES[stage];
  job.stage = stage;
  job.pct = Math.round(a + (b - a) * Math.min(1, Math.max(0, frac)));
  onProgress({ stage, pct: job.pct });
}

async function download(url, onFrac) {
  const res = await brave.fetchOk(url, { signal: job.abort.signal });
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  for await (const c of res.body) {
    chunks.push(Buffer.from(c));
    got += c.length;
    if (total) onFrac?.(got / total);
  }
  return Buffer.concat(chunks);
}

// the environment of the toolchain: its own homes, the pinned toolchain, nothing of the user's Rust
function envOf() {
  const env = { ...process.env };
  // (a start from a shell may leave both "Path" and "PATH", each with part of it)
  const win = process.env.SystemRoot || 'C:\\Windows';
  const dirs = [path.join(BUILD, 'c', 'bin')];
  for (const k of Object.keys(env)) {
    if (/^path$/i.test(k)) dirs.push(...String(env[k]).split(path.delimiter));
    if (/^path$/i.test(k) || /^(rust|cargo)/i.test(k)) delete env[k];
  }
  dirs.push(path.join(win, 'System32'), win);
  return Object.assign(env, {
    Path: [...new Set(dirs.filter(Boolean))].join(path.delimiter),
    RUSTUP_HOME: path.join(BUILD, 'r'),
    CARGO_HOME: path.join(BUILD, 'c'),
    CARGO_TARGET_DIR: path.join(BUILD, 't'),
    RUSTUP_TOOLCHAIN: `${TOOLCHAIN}-${HOST}`,
    RUSTUP_INIT_SKIP_PATH_CHECK: 'yes',
    CARGO_TERM_COLOR: 'never',
    CARGO_TERM_PROGRESS_WHEN: 'never',
  });
}

// a program of the build, its output read line by line
function run(file, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { ...opts, windowsHide: true });
    job.child = p;
    const tail = [];
    let rest = '';
    const feed = (buf) => {
      const lines = (rest + buf).split(/[\r\n]+/);
      rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!/^\s*Downloaded /.test(line)) tail.push(line);
        if (tail.length > 20) tail.shift();
        onLine?.(line);
      }
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => {
      job.child = null;
      feed('\n');
      if (code === 0) return resolve();
      if (!job.cancelled) console.warn(`[brave-build] ${path.basename(file)} exited ${code}:\n${tail.join('\n')}`);
      reject(new Error(t('Không biên dịch được bộ máy của Brave')));
    });
  });
}

async function bytesIn(dir) {
  let n = 0;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await bytesIn(p) : await fs.promises.stat(p).then((s) => s.size, () => 0);
  }
  return n;
}

const removeBuild = (dir = BUILD) => !dir ? Promise.resolve() : fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 }).catch((err) => console.warn('[brave-build] cleanup:', err.message));

async function build() {
  BUILD = SPOTS.find((d) => d.length <= DEEPEST);
  if (!BUILD) throw new Error(t('Đường dẫn thư mục dữ liệu quá dài'));
  fs.mkdirSync(BUILD, { recursive: true });
  const disk = await fs.promises.statfs(BUILD);
  if (disk.bavail * disk.bsize < NEED) throw new Error(t('Không đủ dung lượng ổ đĩa (cần trống khoảng {0} GB)', (NEED / 1e9).toLocaleString()));
  // Rust: rustup (checked against its published sum), then the toolchain into the build folder
  progress('rustup');
  const init = await download(RUSTUP, (f) => progress('rustup', f));
  const sum = (await (await brave.fetchOk(RUSTUP + '.sha256', { signal: job.abort.signal })).text()).trim().split(/\s+/)[0];
  if (crypto.createHash('sha256').update(init).digest('hex') !== sum) throw new Error(t('Tệp tải về bị hỏng'));
  const rustup = path.join(BUILD, 'rustup-init.exe');
  fs.writeFileSync(rustup, init);
  const env = envOf();
  // (rustup shows no progress unless in a console: its folder's size tells it instead)
  progress('toolchain');
  const timer = setInterval(() => bytesIn(path.join(BUILD, 'r')).then((n) => job?.stage === 'toolchain' && progress('toolchain', n / TOOLCHAIN_BYTES)), 2000);
  try {
    await run(rustup, ['-y', '--default-host', HOST, '--default-toolchain', TOOLCHAIN, '--profile', 'minimal', '--no-modify-path'], { env, cwd: BUILD });
  } finally {
    clearInterval(timer);
  }
  // adblock-rs's source, as published on npm (checked against the sum pinned here)
  progress('source');
  const tgz = await download(SOURCE.url);
  if ('sha512-' + crypto.createHash('sha512').update(tgz).digest('base64') !== SOURCE.integrity) throw new Error(t('Tệp tải về bị hỏng'));
  const src = path.join(BUILD, 's');
  fs.writeFileSync(path.join(BUILD, 'adblock-rs.tgz'), tgz);
  await brave.untar(path.join(BUILD, 'adblock-rs.tgz'), src);
  progress('source', 0.1);
  // compiled with the crate versions of its own lockfile (cargo first downloads them)
  let fetched = 0;
  let crates = 0;
  await run(path.join(BUILD, 'c', 'bin', 'cargo.exe'), ['build', '--release', '--locked', '-p', 'adblock-rs'], { env, cwd: src }, (line) => {
    if (/^\s*Downloaded /.test(line)) progress('source', 0.1 + (0.9 * ++fetched) / CRATES);
    else if (/^\s*Compiling /.test(line)) progress('compile', ++crates / CRATES);
  });
  const dll = path.join(BUILD, 't', 'release', 'adblock_rs.dll');
  await brave.worker({ task: 'probe', file: dll });
  fs.mkdirSync(brave.HOME, { recursive: true });
  fs.copyFileSync(dll, brave.ENGINE + '.tmp');
  fs.renameSync(brave.ENGINE + '.tmp', brave.ENGINE);
  fs.writeFileSync(brave.META, JSON.stringify({ version: brave.VERSION, built: new Date().toISOString(), rust: `${TOOLCHAIN}-${HOST}` }));
  // Brave's lists and resources, compiled
  progress('lists');
  if (!(await brave.load())) throw new Error(t('Không tải được danh sách lọc của Brave'));
}

function install(onProgressFn) {
  if (onProgressFn) onProgress = onProgressFn;
  if (job) return job.promise;
  if (process.platform !== 'win32' || process.arch !== 'x64') return Promise.reject(new Error(t('Chỉ dùng được trên Windows 64-bit')));
  job = { stage: 'rustup', pct: 0, child: null, abort: new AbortController(), cancelled: false };
  const me = job;
  job.promise = build()
    .catch((err) => {
      throw me.cancelled ? new Error(t('Đã hủy')) : err;
    })
    .finally(async () => {
      progress('cleanup');
      await removeBuild();
      job = null;
      onProgress({ finished: true });
    });
  return job.promise;
}

function cancel() {
  if (!job) return false;
  job.cancelled = true;
  job.abort.abort();
  // (cargo's rustc processes too)
  if (job.child) execFile('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  return true;
}

// what Settings shows
const status = () => ({ installed: brave.installed(), building: !!job, stage: job?.stage || '', pct: job?.pct || 0 });

// a build cut short by quitting TyranWeb leaves its folder behind
function cleanup() {
  if (!job) for (const d of SPOTS) if (fs.existsSync(d)) removeBuild(d);
}

module.exports = { install, cancel, status, cleanup };
