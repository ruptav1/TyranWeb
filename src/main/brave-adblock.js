'use strict';
// Brave's ad blocking, for the two Brave choices of Settings → Quyền riêng tư (adblock.js):
//  - the filter lists Brave turns on by default on the desktop, read from Brave's own catalog
//    (brave/adblock-resources, list_catalog.json), used by both choices;
//  - "Brave đầy đủ": Brave's engine itself, adblock-rust (MPL-2.0, npm "adblock-rs"), with the
//    resources Brave gives it, put together the way Brave's packager does (uBlock Origin's redirects
//    and scriptlets, then brave/adblock-resources). No copy of the engine ships with TyranWeb:
//    brave-build.js builds it on this computer when asked, into <data>/brave-adblock/. The pages get
//    its element hiding and scriptlets through src/preload/brave-adblock.js.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { net, ipcMain, utilityProcess } = require('electron');
const { dir } = require('./data');
const { t } = require('./i18n');

const HOME = path.join(dir, 'brave-adblock');
const ENGINE = path.join(HOME, 'adblock-rs.node');
const META = path.join(HOME, 'engine.json'); // { version, built } of the engine there
const CACHE = path.join(HOME, 'filters.dat'); // the lists, compiled (adblock-rust's own format)
const RESOURCES = path.join(HOME, 'resources.json');
const PRELOAD = path.join(__dirname, '..', 'preload', 'brave-adblock.js');
const WORKER = path.join(__dirname, 'brave-worker.js');
const VERSION = '0.13.3'; // of adblock-rs, as brave-build.js builds it
const REFRESH = 4 * 864e5; // lists older than this are fetched again (Brave's change every day)

const CATALOG = 'https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json';
const BRAVE_RESOURCES = 'https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json';
const UBO_RELEASE = 'https://api.github.com/repos/gorhill/uBlock/releases/latest';
const UBO_SOURCE = (tag) => `https://codeload.github.com/gorhill/uBlock/tar.gz/refs/tags/${encodeURIComponent(tag)}`;
// Brave's catalog as it was on 2026-10-21, for when it cannot be read
const UAS = 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/';
const BAL = 'https://raw.githubusercontent.com/brave/adblock-lists/master/';
const FALLBACK = [
  ...['filters', 'filters-2020', 'filters-2021', 'filters-2022', 'filters-2023', 'filters-2024', 'filters-2025', 'filters-2026', 'filters-general', 'badware', 'resource-abuse', 'unbreak', 'quick-fixes', 'ubo-link-shorteners', 'privacy', 'annoyances-cookies'].map((n) => `${UAS}${n}.txt`),
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh-online.txt',
  'https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt',
  'https://secure.fanboy.co.nz/fanboy-mobile-notifications.txt',
  ...['brave-unbreak', 'brave-lists/brave-specific', 'brave-lists/brave-social', 'brave-lists/brave-unbreak', 'brave-lists/brave-android-specific', 'brave-lists/brave-sugarcoat', 'brave-lists/brave-firstparty', 'brave-lists/brave-firstparty-regional', 'brave-lists/brave-cookie-specific'].map((n) => `${BAL}${n}.txt`),
];

async function fetchOk(url, opts) {
  const res = await net.fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res;
}

// ---------------------------------------------------------------- the lists
async function listUrls() {
  try {
    const catalog = await (await fetchOk(CATALOG)).json();
    const mobile = (l) => l.platforms?.length && l.platforms.every((p) => /^(ios|android)$/i.test(p));
    const urls = catalog.filter((l) => l.default_enabled && !mobile(l)).flatMap((l) => l.sources.map((s) => s.url));
    if (urls.length > 10) return [...new Set(urls)];
  } catch (err) {
    console.warn('[brave] list catalog:', err.message);
  }
  return FALLBACK;
}

// Brave's default lists as one text; one that cannot be fetched now is left out (unless most are).
async function listsText() {
  const urls = await listUrls();
  const texts = await Promise.all(
    urls.map(async (u) => {
      try {
        return await (await fetchOk(u)).text();
      } catch (err) {
        console.warn('[brave] list:', err.message);
        return null;
      }
    })
  );
  const got = texts.filter((x) => x != null);
  if (got.length < urls.length * 0.8) throw new Error(t('Không tải được danh sách lọc của Brave'));
  return got.join('\n');
}

// ---------------------------------------------------------------- helpers shared with brave-build.js
// A .tgz unpacked by Windows' own tar (its top folder dropped), only `only` of it when given.
function untar(file, into, only = []) {
  fs.mkdirSync(into, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xzf', file, '--strip-components', '1', ...only], { cwd: into, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || 'tar ' + code))));
  });
}

// One task done apart from the browser by brave-worker.js (a utility process).
function worker(task, timeout = 120e3) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(WORKER, [], { serviceName: 'TyranWeb Brave adblock' });
    let done = false;
    const end = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn(v);
    };
    const timer = setTimeout(() => end(reject, new Error('worker timed out')), timeout);
    child.once('message', (m) => (m?.error ? end(reject, new Error(m.error)) : end(resolve, m?.result)));
    child.once('exit', (code) => end(reject, new Error('worker exited ' + code)));
    child.postMessage(task);
  });
}

// ---------------------------------------------------------------- the engine
let native = null; // adblock-rs's functions
let engine = null; // its Engine, with Brave's lists and resources
let active = false; // the engine adblock.js uses now
let refreshing = null;
let onBlocked = () => {};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const installed = () => readJson(META)?.version === VERSION && fs.existsSync(ENGINE);
const arrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const writeAtomic = (file, data) => {
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
};

// Brave's resources: uBlock Origin's redirects (read by the engine from uBO's source) and scriptlets
// (read by brave-worker.js), then Brave's own.
async function resources() {
  const tmp = path.join(HOME, 'ubo');
  try {
    const rel = await (await fetchOk(UBO_RELEASE, { headers: { accept: 'application/vnd.github+json' } })).json();
    const tgz = Buffer.from(await (await fetchOk(UBO_SOURCE(rel.tag_name))).arrayBuffer());
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ubo.tgz'), tgz);
    await untar(path.join(tmp, 'ubo.tgz'), tmp, ['*/src/js', '*/src/lib', '*/src/web_accessible_resources']);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
    const scriptlets = await worker({ task: 'scriptlets', file: path.join(tmp, 'src', 'js', 'resources', 'scriptlets.js') });
    const redirects = native.uBlockResources(path.join(tmp, 'src', 'web_accessible_resources'), path.join(tmp, 'src', 'js', 'redirect-resources.js'));
    const own = await (await fetchOk(BRAVE_RESOURCES)).json();
    return [...redirects.filter((r) => r.name !== 'google-ima-dai.js'), ...own, ...scriptlets];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Brave's lists and resources fetched again, compiled, kept for the next start.
function refresh() {
  refreshing ??= (async () => {
    const [text, res] = await Promise.all([
      listsText(),
      resources().catch((err) => {
        console.warn('[brave] resources:', err.message);
        return readJson(RESOURCES) || [];
      }),
    ]);
    const set = native.FilterSet_constructor(false);
    native.FilterSet_addFilters(set, text, {});
    const next = native.Engine_constructor(set);
    native.Engine_useResources(next, res);
    writeAtomic(CACHE, Buffer.from(native.Engine_serialize(next)));
    writeAtomic(RESOURCES, JSON.stringify(res));
    engine = next;
  })().finally(() => (refreshing = null));
  return refreshing;
}

// The engine with its lists as compiled last time (fetched again in the background once old), or
// fetched now. False when it is not built here or cannot be loaded.
async function load() {
  if (engine) return true;
  if (!installed()) return false;
  try {
    native ??= require(ENGINE);
  } catch (err) {
    console.warn('[brave] engine:', err.message);
    return false;
  }
  let age = Infinity;
  try {
    const e = native.Engine_constructor(native.FilterSet_constructor(false));
    native.Engine_deserialize(e, arrayBuffer(fs.readFileSync(CACHE)));
    native.Engine_useResources(e, JSON.parse(fs.readFileSync(RESOURCES, 'utf8')));
    age = Date.now() - fs.statSync(CACHE).mtimeMs;
    engine = e;
  } catch {
    /* not compiled yet */
  }
  if (!engine) {
    try {
      await refresh();
    } catch (err) {
      console.warn('[brave] lists:', err.message);
      return false;
    }
  } else if (age > REFRESH) refresh().catch((err) => console.warn('[brave] refresh:', err.message));
  return !!engine;
}

// ---------------------------------------------------------------- requests
const TYPES = { subFrame: 'sub_frame', xhr: 'xmlhttprequest', cspReport: 'csp_report', webSocket: 'websocket' };

// the page asking (for a frame, the page it is in)
function sourceOf(d) {
  try {
    const f = d.resourceType === 'subFrame' ? d.frame?.parent : d.frame;
    if (f && /^https?:/.test(f.url)) return f.url;
  } catch {
    /* frame gone */
  }
  return d.referrer || d.url;
}

function onBeforeRequest(d, cb) {
  if (!engine || d.resourceType === 'mainFrame' || !/^(https?|wss?):/i.test(d.url)) return cb({});
  try {
    const source = sourceOf(d);
    const type = TYPES[d.resourceType] || d.resourceType || 'other';
    if (!native.Engine_check(engine, d.url, source, type, d.method || '')) return cb({});
    const r = native.Engine_check(engine, d.url, source, type, d.method || '', true);
    if (typeof d.webContentsId === 'number') onBlocked(d.webContentsId);
    cb(r.redirect ? { redirectURL: r.redirect } : { cancel: true });
  } catch {
    cb({});
  }
}

// ---------------------------------------------------------------- what the pages ask (the preload)
// hiding rules, a few hundred selectors per stylesheet (one bad selector would void a whole sheet)
function sheets(selectors) {
  const out = [];
  for (let i = 0; i < selectors.length; i += 300) out.push(selectors.slice(i, i + 300).join(',') + '{display:none!important}');
  return out;
}
const strings = (a, max) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.length < 512).slice(0, max) : []);

let ipcReady = false;
function ipc() {
  if (ipcReady) return;
  ipcReady = true;
  // (synchronous: the scriptlets must run before the page's own scripts)
  ipcMain.on('brave-adblock:page', (e, url) => {
    try {
      if (!active || !engine || typeof url !== 'string' || !/^https?:/.test(url)) return void (e.returnValue = null);
      const r = native.Engine_urlCosmeticResources(engine, url);
      e.returnValue = { css: sheets(r.hide_selectors), script: r.injected_script, procedural: r.procedural_actions, exceptions: r.exceptions, generic: !r.generichide };
    } catch {
      e.returnValue = null;
    }
  });
  ipcMain.handle('brave-adblock:more', (e, classes, ids, exceptions) => {
    if (!active || !engine) return [];
    return sheets(native.Engine_hiddenClassIdSelectors(engine, strings(classes, 5000), strings(ids, 5000), strings(exceptions, 5000)));
  });
}

module.exports = {
  HOME,
  ENGINE,
  META,
  VERSION,
  PRELOAD,
  fetchOk,
  untar,
  worker,
  installed,
  load,
  listsText,
  onBeforeRequest,
  ipc,
  setActive: (on) => (active = on),
  setOnBlocked: (fn) => (onBlocked = fn),
};
