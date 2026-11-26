'use strict';
// Lịch sử tab ẩn danh (Settings → Ẩn danh; off until switched on): the pages incognito tabs and
// windows open, kept in private-history.dat in a form nothing can read:
//  - its first line (the keys) is sealed by safeStorage, with the profile's key that Windows keeps
//    for this Windows account (DPAPI): copied to another account or computer, nothing in it opens;
//  - each line after it holds visits encrypted for a key pair (X25519, a new exchange per line,
//    then AES-256-GCM), so pages are written down without the key that reads them;
//  - that reading key is encrypted too: with the PIN when one is set (4 or 6 digits, stretched by
//    scrypt), else with a key kept in the sealed first line.
// Lịch sử → Ẩn danh asks for the PIN; the reading key then stays in memory for that page only,
// until it is closed, goes elsewhere or is left alone for 5 minutes (the page locks itself when
// hidden too). Each time it is read, what was written since joins the rest in one line again.
// Five wrong PINs in a row and it waits (30 s, then twice as long each time). Changing or removing
// the PIN takes the one set; a forgotten PIN cannot be got back: the history can only be deleted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage, webContents } = require('electron');
const data = require('./data');
const histquery = require('./histquery');

const FILE = path.join(data.dir, 'private-history.dat');
const INFO = Buffer.from('TyranWeb private history 1');
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 288 * 1024 * 1024 };
const IDLE = 5 * 60 * 1000;
const MERGE_WINDOW = 10 * 60 * 1000;
const MAX_VISITS = 20000;
const PIN = /^(\d{4}|\d{6})$/;
const TRIES = 5;

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');
const uid = () => 'p' + crypto.randomBytes(6).toString('hex');
const iconOf = (f) => (typeof f === 'string' && f.length <= 20000 ? f : '');

let head = null; // the first line, unsealed: { v, pub, pin, iv, tag, key, salt | plain }
let headLine = ''; // ...as it is in the file
let broken = false; // the first line does not open (another Windows account or computer)
let pub = null; // the key pair's public half, the lines are encrypted for
let visits = null; // the history read, while a page has it open...
let index = null; // ...by id
const open = new Map(); // the pages that have it open (webContents id) -> when last used
let recent = []; // visits written this run: { id, url, time } (repeats merged, titles and icons)
let pending = []; // records not written yet (titles and icons come in bursts)
let timer = null;
let fails = 0;
let waitUntil = 0;
let onChange = () => {};

const recording = () => !!data.settings.data.privacy.privateHistory;
function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the file's first line
function firstLine() {
  let fd;
  try {
    fd = fs.openSync(FILE, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const s = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    const i = s.indexOf('\n');
    return i < 0 ? s : s.slice(0, i);
  } finally {
    fs.closeSync(fd);
  }
}

const publicKey = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });

function loadHead() {
  if (head || broken) return head;
  const line = firstLine();
  if (!line || !line.trim()) return null; // (nothing kept yet)
  try {
    head = JSON.parse(safeStorage.decryptString(unb64(line)));
    headLine = line;
    pub = publicKey(head.pub);
  } catch {
    head = null;
    broken = true;
  }
  return head;
}

const sealHead = (h) => b64(safeStorage.encryptString(JSON.stringify(h)));

function scrypt(pin, salt) {
  return new Promise((ok, no) => crypto.scrypt(String(pin), salt, 32, SCRYPT, (err, k) => (err ? no(err) : ok(k))));
}

// The reading key encrypted with k (from the PIN, or a key kept beside it in the sealed line).
function wrapWith(key, k, extra) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(key.export({ format: 'der', type: 'pkcs8' })), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), key: b64(enc), ...extra };
}
async function wrap(key, pin) {
  if (!pin) {
    const plain = crypto.randomBytes(32);
    return wrapWith(key, plain, { pin: 0, plain: b64(plain) });
  }
  const salt = crypto.randomBytes(16);
  return wrapWith(key, await scrypt(pin, salt), { pin: pin.length, salt: b64(salt) });
}
// (throws for a wrong PIN: the tag does not match)
async function unwrap(h, pin) {
  const k = h.pin ? await scrypt(pin, unb64(h.salt)) : unb64(h.plain);
  const d = crypto.createDecipheriv('aes-256-gcm', k, unb64(h.iv));
  d.setAuthTag(unb64(h.tag));
  const der = Buffer.concat([d.update(unb64(h.key)), d.final()]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// A first line for a new key pair, no PIN yet.
function createHead() {
  const pair = crypto.generateKeyPairSync('x25519');
  const plain = crypto.randomBytes(32);
  const h = { v: 1, pub: pair.publicKey.export({ format: 'jwk' }).x, ...wrapWith(pair.privateKey, plain, { pin: 0, plain: b64(plain) }) };
  const line = sealHead(h);
  fs.writeFileSync(FILE, line + '\n');
  head = h;
  headLine = line;
  pub = pair.publicKey;
  return h;
}

function ensureHead() {
  if (loadHead()) return head;
  if (broken || !available()) return null;
  try {
    return createHead();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the lines of visits
function lineKey(secret, epk) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.concat([epk, Buffer.from(head.pub, 'base64url')]), INFO, 32));
}

// Records encrypted for the key pair: written without the key that reads them.
function seal(records) {
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const k = lineKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), epk);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(records), 'utf8'), c.final()]);
  return b64(Buffer.concat([epk, iv, c.getAuthTag(), ct]));
}

function unseal(line, key) {
  const b = unb64(line);
  if (b.length < 61) throw new Error('short');
  const epk = b.subarray(0, 32);
  const k = lineKey(crypto.diffieHellman({ privateKey: key, publicKey: publicKey(epk.toString('base64url')) }), epk);
  const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(32, 44));
  d.setAuthTag(b.subarray(44, 60));
  return JSON.parse(Buffer.concat([d.update(b.subarray(60)), d.final()]).toString('utf8'));
}

// A record into the list read: a visit ('v') or what changed in one ('u': a title, an icon, a time).
function apply(r) {
  if (!r || typeof r !== 'object') return;
  if (r.k === 'v' && r.id && r.url) {
    if (index.has(r.id)) return;
    const v = { id: r.id, url: String(r.url), title: String(r.title || r.url), favicon: iconOf(r.favicon), time: Number(r.time) || 0 };
    visits.push(v);
    index.set(v.id, v);
  } else if (r.k === 'u') {
    const v = index.get(r.id);
    if (!v) return;
    if (r.title) v.title = String(r.title);
    if (r.favicon) v.favicon = iconOf(r.favicon);
    if (r.time) v.time = Number(r.time);
  }
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!pending.length || !head) return;
  const records = pending;
  pending = [];
  try {
    fs.appendFileSync(FILE, seal(records) + '\n');
  } catch {
    /* (not written: lost, as an incognito page is anyway) */
  }
}

function queue(rec) {
  if (rec.k === 'u') {
    const p = pending.find((x) => x.id === rec.id);
    if (p) {
      const { k, id, ...rest } = rec;
      Object.assign(p, rest);
    } else pending.push(rec);
  } else pending.push(rec);
  if (visits) {
    apply(rec);
    onChange();
  }
  if (!timer) timer = setTimeout(flush, 1500);
}

// Every visit read, in one line again (after deleting some, or when read and there were more lines).
function writeAll() {
  if (!head) return;
  clearTimeout(timer);
  timer = null;
  pending = []; // (already in the list)
  visits.sort((a, b) => a.time - b.time);
  if (visits.length > MAX_VISITS) {
    for (const v of visits.splice(0, visits.length - MAX_VISITS)) index.delete(v.id);
  }
  const body = visits.length ? seal(visits.map((v) => ({ k: 'v', ...v }))) + '\n' : '';
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, headLine + '\n' + body);
  fs.renameSync(tmp, FILE);
}

function read(key) {
  flush();
  let text = '';
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch {
    /* nothing yet */
  }
  const lines = text.split('\n').slice(1).filter((l) => l.trim());
  visits = [];
  index = new Map();
  let bad = 0;
  for (const line of lines) {
    let records;
    try {
      records = unseal(line, key);
    } catch {
      bad++;
      continue;
    }
    for (const r of Array.isArray(records) ? records : [records]) apply(r);
  }
  visits.sort((a, b) => a.time - b.time);
  if (lines.length > 1 || bad) writeAll();
}

// ---------------------------------------------------------------- written by the tabs
function add({ url, title, favicon } = {}) {
  if (!recording() || !/^https?:\/\//i.test(url || '') || !ensureHead()) return false;
  const now = Date.now();
  const last = recent[recent.length - 1];
  if (last && last.url === url && now - last.time < MERGE_WINDOW) {
    last.time = now;
    queue({ k: 'u', id: last.id, time: now, ...(title ? { title: String(title).slice(0, 500) } : {}), ...(favicon ? { favicon: iconOf(favicon) } : {}) });
  } else {
    const id = uid();
    recent.push({ id, url, time: now });
    if (recent.length > 300) recent.shift();
    queue({ k: 'v', id, url: url.slice(0, 8192), title: String(title || url).slice(0, 500), favicon: iconOf(favicon), time: now });
  }
  return true;
}

function update({ url, title, favicon } = {}) {
  if (!recording() || !head || (!title && !favicon)) return false;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].url !== url) continue;
    queue({ k: 'u', id: recent[i].id, ...(title ? { title: String(title).slice(0, 500) } : {}), ...(favicon ? { favicon: iconOf(favicon) } : {}) });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- the PIN
// The reading key for the PIN given, or why not: { ok, key } | { ok: false, wait, left }
async function verify(pin) {
  const h = loadHead();
  if (!h) return { ok: true, key: null };
  if (!h.pin) return { ok: true, key: await unwrap(h) };
  if (waitUntil > Date.now()) return { ok: false, wait: waitUntil - Date.now(), left: 0 };
  try {
    if (typeof pin !== 'string' || pin.length !== h.pin || !PIN.test(pin)) throw new Error('pin');
    const key = await unwrap(h, pin);
    fails = 0;
    waitUntil = 0;
    return { ok: true, key };
  } catch {
    fails++;
    if (fails >= TRIES) waitUntil = Date.now() + Math.min(15 * 60000, 30000 * 2 ** (fails - TRIES));
    return { ok: false, wait: Math.max(0, waitUntil - Date.now()), left: Math.max(0, TRIES - fails) };
  }
}

const answer = (r) => (r.ok ? { ok: true } : { ok: false, wait: r.wait || 0, left: r.left ?? 0 });

// Settings → Ẩn danh: the PIN set is right (before a new one is asked for)
const check = async (pin) => answer(await verify(pin));

// A new PIN (null: none), the one set given first. Pages that have the history open lock.
async function setPin(current, next) {
  if (next !== null && (typeof next !== 'string' || !PIN.test(next))) return { ok: false, bad: true };
  if (broken) return { ok: false, broken: true };
  if (!available()) return { ok: false, unavailable: true };
  const r = await verify(current);
  if (!r.ok) return answer(r);
  const h = head || createHead();
  const key = r.key || (await unwrap(h));
  const nh = { v: 1, pub: h.pub, ...(await wrap(key, next)) };
  flush();
  const line = sealHead(nh);
  let rest = '';
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    const i = text.indexOf('\n');
    rest = i < 0 ? '' : text.slice(i + 1);
  } catch {
    /* only the first line then */
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, line + '\n' + rest);
  fs.renameSync(tmp, FILE);
  head = nh;
  headLine = line;
  lockAll();
  return { ok: true, pin: nh.pin };
}

// Forgotten PIN (or a file that does not open here): the history and the PIN deleted.
function reset() {
  lockAll();
  clearTimeout(timer);
  timer = null;
  pending = [];
  recent = [];
  head = null;
  headLine = '';
  pub = null;
  broken = false;
  fails = 0;
  waitUntil = 0;
  for (const f of [FILE, FILE + '.tmp']) fs.rmSync(f, { force: true });
  onChange();
  return true;
}

// ---------------------------------------------------------------- Lịch sử → Ẩn danh
function status(wcId) {
  const h = loadHead();
  return { recording: recording(), available: available(), kept: !!h, broken, pin: h?.pin || 0, open: open.has(wcId), wait: Math.max(0, waitUntil - Date.now()) };
}

function lock(wcId) {
  open.delete(wcId);
  if (!open.size) {
    visits = null;
    index = null;
  }
}

// (a page that has it open, out of sight: locked when a PIN is set, and told so)
function hide(wcId) {
  if (!open.has(wcId) || !head?.pin) return false;
  lock(wcId);
  const wc = webContents.fromId(wcId);
  if (wc && !wc.isDestroyed()) wc.send('privhistory:locked');
  return true;
}

function lockAll() {
  for (const id of open.keys()) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('privhistory:locked');
  }
  open.clear();
  visits = null;
  index = null;
}

const watched = new WeakSet();
function watch(wcId) {
  const wc = webContents.fromId(wcId);
  if (!wc || watched.has(wc)) return;
  watched.add(wc);
  wc.once('destroyed', () => lock(wcId));
  // (another page in that tab, or the page loaded again)
  wc.on('did-start-navigation', (e, url, inPlace, mainFrame) => {
    if ((e?.isMainFrame ?? mainFrame) && !(e?.isSameDocument ?? inPlace)) lock(wcId);
  });
}

async function unlock(wcId, pin) {
  if (broken) return { ok: false, broken: true };
  const r = await verify(pin);
  if (!r.ok) return answer(r);
  if (!visits) {
    if (r.key) read(r.key);
    else {
      visits = [];
      index = new Map();
    }
  }
  open.set(wcId, Date.now());
  watch(wcId);
  return { ok: true };
}

function need(wcId) {
  if (!open.has(wcId) || !visits) throw new Error('locked');
  open.set(wcId, Date.now());
}

const find = (wcId, f) => (need(wcId), histquery.find(visits, f));
const domains = (wcId, f) => (need(wcId), histquery.domains(visits, f));

function removeWhere(wcId, f) {
  need(wcId);
  const { keep, removed } = histquery.without(visits, f);
  if (removed) {
    visits = keep;
    index = new Map(keep.map((v) => [v.id, v]));
    writeAll();
    onChange();
  }
  return removed;
}

function remove(wcId, ids) {
  need(wcId);
  const set = new Set(ids);
  const before = visits.length;
  visits = visits.filter((v) => !set.has(v.id));
  for (const id of set) index.delete(id);
  if (visits.length !== before) {
    writeAll();
    onChange();
  }
  return before - visits.length;
}

// (pages left open and alone lock)
setInterval(() => {
  for (const [id, at] of open) {
    if (Date.now() - at < IDLE) continue;
    lock(id);
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('privhistory:locked');
  }
}, 30000).unref?.();

app.on('will-quit', flush);

module.exports = {
  FILE,
  add,
  update,
  flush,
  status,
  check,
  setPin,
  reset,
  unlock,
  lock,
  hide,
  find,
  domains,
  remove,
  removeWhere,
  set onChange(fn) {
    onChange = fn;
  },
};
