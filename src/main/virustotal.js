'use strict';
// VirusTotal, for Kiểm tra tệp tải về (filescan.js) and its result page (tyran://scan): with the
// user's own API key (Settings → Chung → Tải xuống; kept encrypted with Windows' keys by safeStorage
// in <data>/virustotal.key, never in settings.json), a scanned download's SHA-256 is looked up in
// VirusTotal's API v3: what some 70 security vendors said of it. A file it has not seen is sent to it
// as general.vtUpload says ('risky': programs, scripts and archives only, the user's choice;
// 'never'; 'all'), and its analysis waited for. A free key may ask 4 times a minute: the asks are
// spaced so. The reports are kept in <data>/scans/<sha256>.json for the page.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const data = require('./data');

// (a stand-in for VirusTotal in TyranWeb's own tests only)
const API = (process.env.TYRAN_SHOT && process.env.TYRAN_VT_API) || 'https://www.virustotal.com/api/v3';
const KEY_FILE = path.join(data.dir, 'virustotal.key');
const REPORTS = path.join(data.dir, 'scans');
const UPLOAD_MAX = 650 * 1024 * 1024; // (VirusTotal's own limit)
const DIRECT_MAX = 32 * 1024 * 1024; // (bigger ones go to an upload address asked for first)
const EICAR = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f'; // (a file it surely knows)
// (asks a minute, and the wait between looks at an analysis: faster in TyranWeb's own tests only)
const PER_MINUTE = (process.env.TYRAN_SHOT && Number(process.env.TYRAN_VT_RATE)) || 4;
const POLL = (process.env.TYRAN_SHOT && Number(process.env.TYRAN_VT_POLL)) || 15e3;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const fail = (code) => Object.assign(new Error(code), { code });

// ---------------------------------------------------------------- the key
let key = null;
function getKey() {
  if (key !== null) return key;
  key = '';
  try {
    if (fs.existsSync(KEY_FILE) && safeStorage.isEncryptionAvailable()) key = safeStorage.decryptString(fs.readFileSync(KEY_FILE));
  } catch {
    key = ''; // (made on another computer or by another Windows user)
  }
  return key;
}
const hasKey = () => !!getKey();

// a key the user gave, tried first: 'ok' | 'badkey' | 'error'
async function setKey(value) {
  const v = String(value || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(v) && !(process.env.TYRAN_SHOT && v)) return 'badkey';
  const was = key;
  key = v;
  try {
    await ask(`/files/${EICAR}`);
  } catch (err) {
    key = was;
    return err.code === 'badkey' ? 'badkey' : 'error';
  }
  fs.writeFileSync(KEY_FILE, safeStorage.encryptString(v));
  return 'ok';
}
function clearKey() {
  key = '';
  fs.rmSync(KEY_FILE, { force: true });
}

// ---------------------------------------------------------------- asking
const stamps = []; // when the last asks were made
let quotaUntil = 0;
let gate = Promise.resolve();
async function slot() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 61e3) stamps.shift();
    if (now < quotaUntil) await sleep(quotaUntil - now);
    else if (stamps.length >= PER_MINUTE) await sleep(61e3 - (now - stamps[0]) + 50);
    else return void stamps.push(now);
  }
}

// VirusTotal's answer (JSON), null for "not found"; throws 'nokey' | 'badkey' | 'quota' | 'error'
async function ask(where, opts = {}) {
  for (let tries = 0; ; tries++) {
    const k = getKey();
    if (!k) throw fail('nokey');
    gate = gate.then(slot, slot);
    await gate;
    let res;
    try {
      res = await fetch(/^https?:/.test(where) ? where : API + where, { ...opts, headers: { 'x-apikey': k, accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.body ? 30 * 60e3 : 60e3) });
    } catch {
      if (tries < 2) continue;
      throw fail('error');
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw fail('badkey');
    if (res.status === 429) {
      // (a minute's asks used up: wait; a day's: give up)
      quotaUntil = Date.now() + 61e3;
      if (tries < 3) continue;
      throw fail('quota');
    }
    if (!res.ok) {
      if (tries < 2 && res.status >= 500) continue;
      throw fail('error');
    }
    return res.json();
  }
}

// ---------------------------------------------------------------- reports
const reportFile = (sha) => path.join(REPORTS, `${sha}.json`);
function report(sha) {
  if (!/^[0-9a-f]{64}$/i.test(String(sha || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(reportFile(sha.toLowerCase()), 'utf8'));
  } catch {
    return null;
  }
}
const FIELDS = ['last_analysis_stats', 'last_analysis_results', 'last_analysis_date', 'type_description', 'type_tag', 'type_extension', 'size', 'tags', 'meaningful_name', 'names', 'reputation', 'total_votes', 'popular_threat_classification', 'first_submission_date', 'times_submitted'];
function keep(sha, attributes) {
  const a = {};
  for (const f of FIELDS) if (attributes?.[f] !== undefined) a[f] = attributes[f];
  if (Array.isArray(a.names)) a.names = a.names.slice(0, 8);
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(reportFile(sha), JSON.stringify({ sha256: sha, fetchedAt: Date.now(), attributes: a }));
  return a;
}
const summary = (a) => ({ state: 'done', stats: a.last_analysis_stats || {}, date: (a.last_analysis_date || 0) * 1000 });

// ---------------------------------------------------------------- one file
// What VirusTotal says of `file` (its `sha`); `risky`: a program, a script or an archive.
// `tell(vt)` is given each step: { state: 'looking' | 'uploading' | 'analyzing' | 'done' | 'unknown'
// | 'toobig' | 'nokey' | 'badkey' | 'quota' | 'error', stats?, date? }
async function check(file, sha, risky, tell) {
  if (!hasKey()) return tell({ state: 'nokey' });
  try {
    tell({ state: 'looking' });
    let found = await ask(`/files/${sha}`);
    if (!found) {
      const mode = data.settings.data.general.vtUpload || 'risky';
      if (!(mode === 'all' || (mode === 'risky' && risky)) || !fs.existsSync(file)) return tell({ state: 'unknown' });
      const size = fs.statSync(file).size;
      if (size > UPLOAD_MAX) return tell({ state: 'toobig' });
      tell({ state: 'uploading' });
      const to = size > DIRECT_MAX ? (await ask('/files/upload_url'))?.data : API + '/files';
      if (!to) throw fail('error');
      const form = new FormData();
      form.append('file', await fs.openAsBlob(file), path.basename(file));
      const sent = await ask(to, { method: 'POST', body: form });
      const analysis = sent?.data?.id;
      if (!analysis) throw fail('error');
      tell({ state: 'analyzing' });
      let done = null;
      for (let i = 0; i < 40 && !done; i++) {
        await sleep(POLL);
        const a = await ask(`/analyses/${encodeURIComponent(analysis)}`);
        if (a?.data?.attributes?.status === 'completed') done = a.data.attributes;
      }
      if (!done) return tell({ state: 'error' });
      found = await ask(`/files/${sha}`);
      // (its file report may lag behind the analysis just made: the analysis then stands for it)
      if (!found?.data?.attributes?.last_analysis_results) found = { data: { attributes: { ...(found?.data?.attributes || {}), last_analysis_stats: done.stats, last_analysis_results: done.results, last_analysis_date: done.date || Math.floor(Date.now() / 1000) } } };
    }
    tell(summary(keep(sha, found.data?.attributes || {})));
  } catch (err) {
    tell({ state: ['nokey', 'badkey', 'quota'].includes(err.code) ? err.code : 'error' });
  }
}

module.exports = { hasKey, setKey, clearKey, check, report };
